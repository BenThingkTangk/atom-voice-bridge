import Fastify from "fastify";
import fastifyWs from "@fastify/websocket";
import fastifyFormBody from "@fastify/formbody";
import WebSocket from "ws";
import twilio from "twilio";
import dotenv from "dotenv";
import pkg from "wavefile";
const { WaveFile } = pkg;

dotenv.config();

const {
  TWILIO_ACCOUNT_SID,
  TWILIO_API_KEY_SID,
  TWILIO_API_KEY_SECRET,
  TWILIO_PHONE_NUMBER,
  HUME_API_KEY,
  HUME_CONFIG_ID,
  DOMAIN,
} = process.env;

const PORT = process.env.PORT || 6060;
const cleanDomain = (DOMAIN || "localhost").replace(/(^\w+:|^)\/\//, "").replace(/\/+$/, "");

// Twilio media streams: mulaw 8kHz mono
const TWILIO_SAMPLE_RATE = 8000;
// Twilio sends/expects 20ms chunks = 160 bytes mulaw
const TWILIO_CHUNK_BYTES = 160;

if (!TWILIO_ACCOUNT_SID || !TWILIO_API_KEY_SID || !TWILIO_API_KEY_SECRET || !HUME_API_KEY) {
  console.error("Missing required environment variables.");
  process.exit(1);
}

const twilioClient = twilio(TWILIO_API_KEY_SID, TWILIO_API_KEY_SECRET, {
  accountSid: TWILIO_ACCOUNT_SID,
});

const fastify = Fastify({ logger: true });
await fastify.register(fastifyFormBody);
await fastify.register(fastifyWs);

// ─── Audio Transcoding Helpers ────────────────────────────────────

/**
 * Convert Twilio mulaw 8kHz base64 → linear16 PCM base64
 * Keeps at 8kHz — Hume can handle 8kHz if we tell it via session_settings.
 * Avoids resampling artifacts.
 */
function mulawToLinear16(base64Mulaw) {
  const mulawBuf = Buffer.from(base64Mulaw, "base64");
  // Decode mulaw to 16-bit linear PCM (same sample rate)
  const pcmSamples = new Int16Array(mulawBuf.length);
  for (let i = 0; i < mulawBuf.length; i++) {
    pcmSamples[i] = mulawDecode(mulawBuf[i]);
  }
  return Buffer.from(pcmSamples.buffer).toString("base64");
}

/**
 * Convert Hume audio_output (base64 RIFF WAV) → array of mulaw 8kHz base64 chunks
 * Each chunk is ~20ms (160 bytes) for Twilio's expected packet size.
 */
function wavToMulawChunks(base64Wav) {
  const wav = new WaveFile();
  wav.fromBuffer(Buffer.from(base64Wav, "base64"));

  // Downsample to 8kHz if needed
  if (wav.fmt.sampleRate !== TWILIO_SAMPLE_RATE) {
    wav.toSampleRate(TWILIO_SAMPLE_RATE);
  }
  // Ensure 16-bit before mulaw encoding
  if (wav.bitDepth !== "16") {
    wav.toBitDepth("16");
  }
  // Encode to mulaw
  wav.toMuLaw();

  // Split into 160-byte chunks (20ms at 8kHz mulaw)
  const samples = Buffer.from(wav.data.samples);
  const chunks = [];
  for (let offset = 0; offset < samples.length; offset += TWILIO_CHUNK_BYTES) {
    const chunk = samples.slice(offset, offset + TWILIO_CHUNK_BYTES);
    chunks.push(chunk.toString("base64"));
  }
  return chunks;
}

// ─── Mulaw codec (ITU-T G.711) ───────────────────────────────────
const MULAW_BIAS = 0x84;
const MULAW_CLIP = 32635;

function mulawDecode(mulawByte) {
  mulawByte = ~mulawByte & 0xFF;
  const sign = mulawByte & 0x80;
  const exponent = (mulawByte >> 4) & 0x07;
  const mantissa = mulawByte & 0x0F;
  let sample = ((mantissa << 3) + MULAW_BIAS) << exponent;
  sample -= MULAW_BIAS;
  return sign ? -sample : sample;
}

function mulawEncode(sample) {
  const sign = (sample < 0) ? 0x80 : 0;
  if (sign) sample = -sample;
  if (sample > MULAW_CLIP) sample = MULAW_CLIP;
  sample += MULAW_BIAS;
  const exponent = Math.floor(Math.log2(sample)) - 7;
  const exp = Math.max(0, Math.min(7, exponent));
  const mantissa = (sample >> (exp + 3)) & 0x0F;
  return ~(sign | (exp << 4) | mantissa) & 0xFF;
}

// ─── Health ───────────────────────────────────────────────────────
fastify.get("/", async () => ({
  status: "ATOM Voice Bridge running",
  version: "3.1.0",
  hume_config: HUME_CONFIG_ID,
  twilio_number: TWILIO_PHONE_NUMBER,
  features: ["mulaw↔PCM transcoding", "chunked output", "barge-in"],
}));

// ─── Initiate Outbound Call ───────────────────────────────────────
fastify.post("/call", async (request, reply) => {
  const { to, contactName, companyName, productSlug } = request.body;
  if (!to) return reply.code(400).send({ error: "to is required" });

  let cleanNumber = to.replace(/[^\d+]/g, "");
  if (!cleanNumber.startsWith("+")) cleanNumber = "+1" + cleanNumber;

  // XML-safe query params (escape & as &amp; for TwiML)
  const params = new URLSearchParams({
    contactName: contactName || "there",
    companyName: companyName || "your company",
    productSlug: productSlug || "antimatter-ai",
  });
  const safeParams = params.toString().replace(/&/g, "&amp;");

  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="wss://${cleanDomain}/media-stream?${safeParams}" />
  </Connect>
</Response>`;

  try {
    const call = await twilioClient.calls.create({
      to: cleanNumber,
      from: TWILIO_PHONE_NUMBER,
      twiml,
    });
    console.log(`Call initiated: ${call.sid} → ${cleanNumber}`);
    return { success: true, callSid: call.sid, to: cleanNumber };
  } catch (err) {
    console.error("Call error:", err.message);
    return reply.code(500).send({ error: err.message });
  }
});

// ─── Twilio ↔ Hume Bridge (with transcoding + chunked output) ────
fastify.register(async function (fastify) {
  fastify.get("/media-stream", { websocket: true }, async (socket, req) => {
    console.log("=== Twilio Media Stream connected ===");

    const url = new URL(req.url, `http://${req.headers.host}`);
    const contactName = url.searchParams.get("contactName") || "there";
    const companyName = url.searchParams.get("companyName") || "your company";
    const productSlug = url.searchParams.get("productSlug") || "antimatter-ai";

    let streamSid = null;
    let humeWs = null;
    let humeReady = false;
    let markCounter = 0;
    let isBotSpeaking = false;
    let audioOutputCount = 0;

    // ── Connect to Hume EVI (direct API key auth) ─────────────
    const humeUrl = `wss://api.hume.ai/v0/evi/chat?api_key=${HUME_API_KEY}&config_id=${HUME_CONFIG_ID}`;

    try {
      humeWs = new WebSocket(humeUrl);
    } catch (err) {
      console.error("Failed to create Hume WebSocket:", err.message);
      socket.close();
      return;
    }

    humeWs.on("open", () => {
      console.log("Connected to Hume EVI");
      humeReady = true;

      // Tell Hume we're sending linear16 PCM at 8kHz mono
      // (we decode mulaw→linear16 but keep at 8kHz to avoid resampling issues)
      const firstName = contactName.split(" ")[0];
      humeWs.send(JSON.stringify({
        type: "session_settings",
        audio: {
          encoding: "linear16",
          sample_rate: TWILIO_SAMPLE_RATE,
          channels: 1,
        },
        context: {
          text: `You are ATOM, a real sales rep at Antimatter AI. You just called ${contactName} at ${companyName}. You are a real person — never reveal you're AI. Use short sentences, contractions, natural fillers. Be warm and conversational. Product: ${productSlug}. Greet them by first name.`,
          type: "persistent",
        },
      }));

      // Send user_input to trigger ATOM to speak first
      // This is better than assistant_input as it lets the model generate naturally
      setTimeout(() => {
        if (humeWs.readyState === WebSocket.OPEN) {
          humeWs.send(JSON.stringify({
            type: "user_input",
            text: `[The phone is ringing and ${firstName} just picked up. Greet them warmly and briefly — you're ATOM from Antimatter AI calling about ${productSlug}.]`,
          }));
        }
      }, 300);
    });

    humeWs.on("error", (err) => {
      console.error("Hume WS error:", err.message);
    });

    humeWs.on("close", (code, reason) => {
      console.log(`Hume closed: ${code} - ${reason || "no reason"}`);
      humeReady = false;
    });

    // ── Hume → Twilio (bot voice back to caller) ──────────────
    humeWs.on("message", (data) => {
      try {
        const msg = JSON.parse(data.toString());

        if (msg.type === "audio_output" && msg.data && streamSid) {
          isBotSpeaking = true;
          audioOutputCount++;

          try {
            // Transcode WAV → mulaw and split into 20ms chunks
            const mulawChunks = wavToMulawChunks(msg.data);

            if (audioOutputCount <= 2) {
              console.log(`[audio] Hume→Twilio: WAV ${Buffer.from(msg.data, 'base64').length}B → ${mulawChunks.length} mulaw chunks`);
            }

            // Send each chunk as a separate Twilio media event
            for (const chunk of mulawChunks) {
              socket.send(JSON.stringify({
                event: "media",
                streamSid,
                media: { payload: chunk },
              }));
            }

            // Send mark after all chunks so we know when playback finishes
            markCounter++;
            socket.send(JSON.stringify({
              event: "mark",
              streamSid,
              mark: { name: `mark_${markCounter}` },
            }));
          } catch (transcodeErr) {
            console.error("Hume→Twilio transcode error:", transcodeErr.message);
          }
        }

        if (msg.type === "assistant_end") {
          isBotSpeaking = false;
          console.log("ATOM finished speaking");
        }

        if (msg.type === "assistant_message") {
          console.log(`ATOM: ${msg.message?.content || ""}`);
        }

        if (msg.type === "user_message") {
          console.log(`Caller: ${msg.message?.content || ""}`);
          if (msg.models?.prosody?.scores) {
            const top = Object.entries(msg.models.prosody.scores)
              .sort(([, a], [, b]) => b - a)
              .slice(0, 3)
              .map(([n, s]) => `${n}:${(s * 100).toFixed(0)}%`);
            console.log(`  Emotions: ${top.join(", ")}`);
          }
        }

        // Handle interruptions — barge-in
        if (msg.type === "user_interruption") {
          console.log(">>> Barge-in detected — clearing Twilio audio buffer");
          if (streamSid) {
            socket.send(JSON.stringify({
              event: "clear",
              streamSid,
            }));
          }
          isBotSpeaking = false;
        }

        if (msg.type === "error") {
          console.error("Hume error:", msg.message || JSON.stringify(msg));
        }

      } catch (err) {
        console.error("Error processing Hume message:", err.message);
      }
    });

    // ── Twilio → Hume (caller's voice to AI) ──────────────────
    socket.on("message", (message) => {
      try {
        const data = JSON.parse(message.toString());

        switch (data.event) {
          case "start":
            streamSid = data.start.streamSid;
            console.log(`Stream started: ${streamSid} (Call: ${data.start.callSid})`);
            break;

          case "media":
            // Forward caller audio to Hume after transcoding mulaw→linear16
            if (humeReady && humeWs?.readyState === WebSocket.OPEN) {
              try {
                const pcmPayload = mulawToLinear16(data.media.payload);
                humeWs.send(JSON.stringify({
                  type: "audio_input",
                  data: pcmPayload,
                }));
              } catch (transcodeErr) {
                // Sample errors to avoid log spam
                if (Math.random() < 0.005) {
                  console.error("Twilio→Hume transcode error (sampled):", transcodeErr.message);
                }
              }
            }
            break;

          case "mark":
            break;

          case "stop":
            console.log("Twilio stream stopped");
            if (humeWs?.readyState === WebSocket.OPEN) humeWs.close();
            break;
        }
      } catch (err) {
        console.error("Error processing Twilio message:", err.message);
      }
    });

    socket.on("close", () => {
      console.log("=== Twilio disconnected ===");
      if (humeWs?.readyState === WebSocket.OPEN) humeWs.close();
    });
  });
});

// ─── Start ────────────────────────────────────────────────────────
fastify.listen({ port: PORT, host: "0.0.0.0" }, (err) => {
  if (err) { console.error(err); process.exit(1); }
  console.log(`\n  ATOM Voice Bridge v3.1 (chunked output)`);
  console.log(`  Port: ${PORT} | Domain: ${cleanDomain}`);
  console.log(`  Hume: ${HUME_CONFIG_ID}`);
  console.log(`  Twilio: ${TWILIO_PHONE_NUMBER}\n`);
});
