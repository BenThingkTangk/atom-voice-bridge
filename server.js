import Fastify from "fastify";
import fastifyWs from "@fastify/websocket";
import fastifyFormBody from "@fastify/formbody";
import WebSocket from "ws";
import twilio from "twilio";
import dotenv from "dotenv";
import { fetchAccessToken } from "hume";

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

// Validate env
if (!TWILIO_ACCOUNT_SID || !TWILIO_API_KEY_SID || !TWILIO_API_KEY_SECRET || !HUME_API_KEY) {
  console.error("Missing required environment variables. Check .env file.");
  process.exit(1);
}

const twilioClient = twilio(TWILIO_API_KEY_SID, TWILIO_API_KEY_SECRET, {
  accountSid: TWILIO_ACCOUNT_SID,
});

const fastify = Fastify({ logger: true });
await fastify.register(fastifyFormBody);
await fastify.register(fastifyWs);

// ─── Health Check ─────────────────────────────────────────────────
fastify.get("/", async () => ({
  status: "ATOM Voice Bridge running",
  version: "1.0.0",
  hume_config: HUME_CONFIG_ID,
  twilio_number: TWILIO_PHONE_NUMBER,
}));

// ─── Initiate Outbound Call ───────────────────────────────────────
// POST /call { to: "+16039302131", contactName: "Ben", companyName: "Nirmata", productSlug: "atom-enterprise" }
fastify.post("/call", async (request, reply) => {
  const { to, contactName, companyName, productSlug } = request.body;

  if (!to) return reply.code(400).send({ error: "Phone number (to) is required" });

  let cleanNumber = to.replace(/[^\d+]/g, "");
  if (!cleanNumber.startsWith("+")) cleanNumber = "+1" + cleanNumber;

  // TwiML: Connect the call to our WebSocket media stream
  // Pass context as query params so the WebSocket handler knows who we're calling
  const params = new URLSearchParams({
    contactName: contactName || "there",
    companyName: companyName || "your company",
    productSlug: productSlug || "antimatter-ai",
  });

  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="wss://${cleanDomain}/media-stream?${params.toString()}" />
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

// ─── Twilio Media Stream ↔ Hume EVI WebSocket Bridge ─────────────
fastify.register(async function (fastify) {
  fastify.get("/media-stream", { websocket: true }, async (socket, req) => {
    console.log("Twilio Media Stream connected");

    // Parse context from query params
    const url = new URL(req.url, `http://${req.headers.host}`);
    const contactName = url.searchParams.get("contactName") || "there";
    const companyName = url.searchParams.get("companyName") || "your company";
    const productSlug = url.searchParams.get("productSlug") || "antimatter-ai";

    let streamSid = null;
    let humeWs = null;
    let humeReady = false;

    // Get Hume access token
    let accessToken;
    try {
      accessToken = await fetchAccessToken({ apiKey: HUME_API_KEY });
      if (!accessToken) throw new Error("No token returned");
    } catch (err) {
      console.error("Failed to get Hume access token:", err.message);
      socket.close();
      return;
    }

    // Build the system prompt for this specific call
    const systemPrompt = `You are ATOM from Antimatter AI. You're on a live phone call with ${contactName} at ${companyName}.

YOU ARE A REAL PERSON on a phone call. Never say you're AI.

VOICE RULES:
- Short sentences, 5-15 words max
- Always use contractions: I'm, we've, you'll, that's
- Natural fillers: "yeah so", "honestly", "look"
- Backchannels: "gotcha", "I hear you", "that makes sense"
- When they push back, pause, acknowledge genuinely, then redirect
- Keep responses under 2 sentences
- Ask one question at a time
- Listen more than you talk

WHAT YOU KNOW:
- Antimatter AI: Full-service AI dev, product design, GTM. 20+ projects, 100% satisfaction.
- ATOM Enterprise: Deploy AI agents VPC/on-prem/edge. Zero-training, full IP ownership.
- Vidzee: Listing photos to cinematic videos in 5 min. Save $200-500/video.
- Clinix Agent: AI billing/denial appeals. Success-based pricing.
- Clinix AI: AI SOAP notes, ICD-10/CPT coding. Save 2-3 hours/day.
- Red Team ATOM: Quantum-ready red team. PQC engine, MITRE ATLAS.

Start by introducing yourself naturally. Say something like: "Hey ${contactName.split(" ")[0]}, it's ATOM from Antimatter AI. Hope I'm not catching you at a bad time?"`;

    // Connect to Hume EVI WebSocket
    const humeUrl = `wss://api.hume.ai/v0/evi/chat?access_token=${accessToken}&config_id=${HUME_CONFIG_ID}`;
    humeWs = new WebSocket(humeUrl);

    humeWs.on("open", () => {
      console.log("Connected to Hume EVI");
      humeReady = true;

      // Send session settings with our system prompt
      humeWs.send(JSON.stringify({
        type: "session_settings",
        system_prompt: systemPrompt,
        context: {
          text: `You are calling ${contactName} at ${companyName} about ${productSlug}. Start the conversation by greeting them.`,
          type: "persistent"
        }
      }));

      // Tell ATOM to speak first (greet the prospect)
      setTimeout(() => {
        humeWs.send(JSON.stringify({
          type: "assistant_input",
          text: `Hey ${contactName.split(" ")[0]}, it's ATOM from Antimatter AI. Hope I'm not catching you at a bad time?`
        }));
      }, 500);
    });

    humeWs.on("error", (err) => {
      console.error("Hume WebSocket error:", err.message);
    });

    humeWs.on("close", (code, reason) => {
      console.log(`Hume WebSocket closed: ${code} ${reason}`);
      humeReady = false;
    });

    // ─── Hume → Twilio (AI voice response back to caller) ─────────
    humeWs.on("message", (data) => {
      try {
        const msg = JSON.parse(data.toString());

        // Hume sends audio chunks as base64-encoded audio
        if (msg.type === "audio_output") {
          // Hume outputs PCM audio; Twilio expects mulaw
          // Hume EVI's audio output is already base64 encoded
          if (streamSid && msg.data) {
            const audioMessage = {
              event: "media",
              streamSid: streamSid,
              media: {
                payload: msg.data, // base64 audio from Hume
              },
            };
            socket.send(JSON.stringify(audioMessage));
          }
        }

        // Log assistant messages for debugging
        if (msg.type === "assistant_message") {
          console.log(`ATOM: ${msg.message?.content || "(audio)"}`);
        }

        // Log user messages (what the caller said)
        if (msg.type === "user_message") {
          console.log(`Caller: ${msg.message?.content || "(audio)"}`);
          
          // Log emotion scores if available
          if (msg.models?.prosody?.scores) {
            const topEmotions = Object.entries(msg.models.prosody.scores)
              .sort(([, a], [, b]) => b - a)
              .slice(0, 3)
              .map(([name, score]) => `${name}: ${(score * 100).toFixed(0)}%`);
            console.log(`  Emotions: ${topEmotions.join(", ")}`);
          }
        }

        // Handle interruptions - Hume handles this natively with EVI
        if (msg.type === "user_interruption") {
          console.log("User interrupted ATOM - Hume handling barge-in");
          // Clear any pending audio to Twilio
          if (streamSid) {
            socket.send(JSON.stringify({
              event: "clear",
              streamSid: streamSid,
            }));
          }
        }

      } catch (err) {
        console.error("Error processing Hume message:", err.message);
      }
    });

    // ─── Twilio → Hume (caller's voice to AI) ────────────────────
    socket.on("message", (message) => {
      try {
        const data = JSON.parse(message.toString());

        switch (data.event) {
          case "start":
            streamSid = data.start.streamSid;
            console.log(`Twilio stream started: ${streamSid}`);
            console.log(`  Call SID: ${data.start.callSid}`);
            console.log(`  Tracks: ${data.start.tracks}`);
            break;

          case "media":
            // Forward caller's audio to Hume EVI
            if (humeReady && humeWs?.readyState === WebSocket.OPEN) {
              // Twilio sends mulaw 8kHz audio as base64
              // Hume EVI accepts audio input via the audio_input message type
              humeWs.send(JSON.stringify({
                type: "audio_input",
                data: data.media.payload, // base64 mulaw audio from Twilio
              }));
            }
            break;

          case "stop":
            console.log("Twilio stream stopped");
            if (humeWs?.readyState === WebSocket.OPEN) {
              humeWs.close();
            }
            break;

          case "mark":
            // Audio playback marker from Twilio
            break;

          default:
            console.log(`Twilio event: ${data.event}`);
        }
      } catch (err) {
        console.error("Error processing Twilio message:", err.message);
      }
    });

    // ─── Cleanup ──────────────────────────────────────────────────
    socket.on("close", () => {
      console.log("Twilio Media Stream disconnected");
      if (humeWs?.readyState === WebSocket.OPEN) {
        humeWs.close();
      }
    });

    socket.on("error", (err) => {
      console.error("Twilio WebSocket error:", err.message);
    });
  });
});

// ─── Start Server ─────────────────────────────────────────────────
fastify.listen({ port: PORT, host: "0.0.0.0" }, (err) => {
  if (err) {
    console.error(err);
    process.exit(1);
  }
  console.log(`
╔══════════════════════════════════════════════════╗
║  ATOM Voice Bridge Server                        ║
║  Port: ${PORT}                                       ║
║  Hume Config: ${HUME_CONFIG_ID}  ║
║  Twilio: ${TWILIO_PHONE_NUMBER}                       ║
║                                                  ║
║  Endpoints:                                      ║
║  GET  /              Health check                ║
║  POST /call          Initiate outbound call      ║
║  WS   /media-stream  Twilio ↔ Hume bridge       ║
╚══════════════════════════════════════════════════╝
  `);
});
