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

// Hume EVI accepts linear16 PCM — we'll send at 24kHz mono
const HUME_SAMPLE_RATE = 24000;
// Twilio media streams are always mulaw 8kHz mono
const TWILIO_SAMPLE_RATE = 8000;

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
 * Convert Twilio mulaw 8kHz base64 → linear16 PCM 24kHz base64
 * Twilio sends: 8-bit mulaw, 8kHz, mono
 * Hume wants: 16-bit linear PCM, 24kHz, mono
 */
function mulawToLinear16(base64Mulaw) {
  const wav = new WaveFile();
  // Create a WAV from the raw mulaw samples
  wav.fromScratch(1, TWILIO_SAMPLE_RATE, "8m", Buffer.from(base64Mulaw, "base64"));
  // Decode mulaw → 16-bit linear PCM
  wav.fromMuLaw();
  // Upsample 8kHz → 24kHz
  wav.toSampleRate(HUME_SAMPLE_RATE);
  // Extract raw PCM samples (no WAV header) as base64
  const samples = wav.data.samples;
  return Buffer.from(samples).toString("base64");
}

/**
 * Convert Hume audio_output (base64 WAV) → mulaw 8kHz base64
 * Hume sends: base64-encoded WAV file (typically 24kHz linear16)
 * Twilio expects: 8-bit mulaw, 8kHz, mono, base64 encoded
 */
function wavToMulaw(base64Wav) {
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
  // Return raw mulaw samples as base64
  return Buffer.from(wav.data.samples).toString("base64");
}

// ─── Health ───────────────────────────────────────────────────────
fastify.get("/", async () => ({
  status: "ATOM Voice Bridge running",
  version: "3.0.0",
  hume_config: HUME_CONFIG_ID,
  twilio_number: TWILIO_PHONE_NUMBER,
  features: ["mulaw↔PCM transcoding", "barge-in", "session_settings"],
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

// ─── Twilio ↔ Hume Bridge (with transcoding) ─────────────────────
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
    let audioChunkBuffer = []; // Buffer small Twilio chunks before sending to Hume

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
      console.log("Connected to Hume EVI (direct API key auth)");
      humeReady = true;

      // CRITICAL: Tell Hume what audio format we're sending
      // We transcode Twilio mulaw→linear16 PCM at 24kHz mono
      humeWs.send(JSON.stringify({
        type: "session_settings",
        audio: {
          encoding: "linear16",
          sample_rate: HUME_SAMPLE_RATE,
          channels: 1,
        },
        system_prompt: `You are ATOM, a real sales development rep from Antimatter AI. You're on a phone call with ${contactName} at ${companyName}. Rules: you are a real person, NEVER say you're AI or a bot or an assistant. Use short sentences, 5 to 15 words max. Always use contractions. Throw in natural fillers like "yeah" "so" "look" "honestly". Match the prospect's energy. Be warm, conversational, confident but not pushy. Pitch: ${productSlug}. Start by greeting them warmly.`,
      }));

      // Make ATOM speak first after a brief pause
      const firstName = contactName.split(" ")[0];
      setTimeout(() => {
        if (humeWs.readyState === WebSocket.OPEN) {
          humeWs.send(JSON.stringify({
            type: "assistant_input",
            text: `Hey ${firstName}, it's ATOM from Antimatter AI. Hope I'm not catching you at a bad time?`,
          }));
        }
      }, 500);
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

          try {
            // Transcode: Hume WAV → mulaw 8kHz for Twilio
            const mulawPayload = wavToMulaw(msg.data);

            socket.send(JSON.stringify({
              event: "media",
              streamSid,
              media: { payload: mulawPayload },
            }));

            // Send mark so we know when playback completes
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

        // Handle interruptions — Hume detects user speaking over bot
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
            console.log(`  Encoding: ${data.start.mediaFormat?.encoding || "mulaw"}`);
            console.log(`  Sample rate: ${data.start.mediaFormat?.sampleRate || 8000}`);
            break;

          case "media":
            // Forward caller audio to Hume after transcoding
            if (humeReady && humeWs?.readyState === WebSocket.OPEN) {
              try {
                // Transcode: Twilio mulaw 8kHz → linear16 PCM 24kHz
                const pcmPayload = mulawToLinear16(data.media.payload);

                humeWs.send(JSON.stringify({
                  type: "audio_input",
                  data: pcmPayload,
                }));
              } catch (transcodeErr) {
                // Don't spam logs for every chunk — only log periodically
                if (Math.random() < 0.01) {
                  console.error("Twilio→Hume transcode error (sampled):", transcodeErr.message);
                }
              }
            }
            break;

          case "mark":
            // Twilio finished playing a chunk
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
  console.log(`\n  ATOM Voice Bridge v3.0 (with transcoding)`);
  console.log(`  Port: ${PORT} | Domain: ${cleanDomain}`);
  console.log(`  Hume: ${HUME_CONFIG_ID} | Rate: ${HUME_SAMPLE_RATE}Hz`);
  console.log(`  Twilio: ${TWILIO_PHONE_NUMBER} | Rate: ${TWILIO_SAMPLE_RATE}Hz`);
  console.log(`  Transcoding: mulaw 8kHz ↔ linear16 PCM ${HUME_SAMPLE_RATE / 1000}kHz\n`);
});
