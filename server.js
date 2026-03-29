import Fastify from "fastify";
import fastifyWs from "@fastify/websocket";
import fastifyFormBody from "@fastify/formbody";
import fastifyCors from "@fastify/cors";
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
const TWILIO_SAMPLE_RATE = 8000;
const TWILIO_CHUNK_BYTES = 160; // 20ms at 8kHz mulaw

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
await fastify.register(fastifyCors, { origin: true });

// ─── Active Calls Registry (for real-time streaming to frontend) ──
const activeCalls = new Map();

// ─── Product Knowledge Base ──────────────────────────────────────
const PRODUCT_KNOWLEDGE = {
  "antimatter-ai": {
    name: "Antimatter AI",
    pitch: "we build custom AI systems and digital products end to end",
    details: "Over twenty successful projects. We handle design, engineering, AI, and go to market. No unhappy clients yet.",
    qualifying: "What's your team working on right now? Any AI initiatives?",
    objections: {
      price: "We're flexible on pricing. For the right fit we do milestone based, so you only pay when we deliver.",
      timing: "Totally get it. Even a fifteen minute intro call would help us understand if there's a fit. No pressure.",
      competition: "What sets us apart is we own the full stack. You don't need three vendors. One team, one throat to choke.",
      skepticism: "Fair enough. We could do a small proof of concept first. Low risk, you see the quality before committing.",
    },
  },
  "atom-enterprise": {
    name: "ATOM Enterprise AI",
    pitch: "we help companies deploy AI agents in their own environment, whether that's on prem, VPC, or at the edge",
    details: "You own your data and IP. No one trains on it. Swap model providers without rewriting code. Edge partnership with Akamai for low latency.",
    qualifying: "How are you handling AI deployment and data governance right now?",
    objections: {
      price: "It's actually cheaper than running three separate SaaS tools. We consolidate your AI spend.",
      timing: "We can get a pilot running in two weeks. Minimal lift from your team.",
      competition: "Unlike the big cloud providers, we're model agnostic. You're never locked in.",
      skepticism: "We can do a quick architecture review for free. You'll see exactly how it maps to your stack.",
    },
  },
  "vidzee": {
    name: "Vidzee",
    pitch: "we turn listing photos into cinematic property videos in about five minutes",
    details: "Agents save a couple hundred bucks per listing versus hiring a videographer. Over twelve thousand videos created. Works on Reels, TikTok, YouTube, MLS.",
    qualifying: "Are you using video for your listings right now?",
    objections: {
      price: "It's a fraction of what a videographer charges and you get it in minutes, not days.",
      timing: "You can try it right now. Upload a few photos and see the result in five minutes.",
      competition: "We're the only ones doing AI cinematic video from still photos. Others just do slideshows.",
      skepticism: "I'll send you a sample video from one of our top agents. Judge for yourself.",
    },
  },
  "clinix-agent": {
    name: "Clinix Agent",
    pitch: "we help healthcare orgs recover revenue from denied claims by automating appeals and resubmissions",
    details: "We stop denials before they happen with eligibility guardrails. Auto generate appeal packets tailored to each payer. Success based pricing, you only pay when we get the money back.",
    qualifying: "What's your denial rate looking like these days?",
    objections: {
      price: "It's success based. You literally only pay when we recover money for you. Zero risk.",
      timing: "We can plug in alongside your existing workflow. No rip and replace.",
      competition: "Most tools just flag denials. We actually write and submit the appeals automatically.",
      skepticism: "We can run a free analysis on your last ninety days of denials. You'll see the opportunity.",
    },
  },
  "red-team-atom": {
    name: "Red Team ATOM",
    pitch: "we built the first quantum ready autonomous red team platform",
    details: "Continuous adversarial simulations instead of annual pen tests. Post quantum crypto testing, MITRE ATLAS heat mapping, real time telemetry.",
    qualifying: "How are you thinking about quantum readiness? The harvest now decrypt later threat is real.",
    objections: {
      price: "Compare it to the cost of one breach. We're a rounding error on your security budget.",
      timing: "We can run a baseline assessment in a week. No integration needed for the first scan.",
      competition: "Nobody else does continuous autonomous red teaming with quantum readiness built in.",
      skepticism: "We'll run a free external scan and show you what we find. No commitment.",
    },
  },
};

// ─── Audio Transcoding ───────────────────────────────────────────

// Mulaw decode table (ITU-T G.711) — precomputed for speed
const MULAW_DECODE_TABLE = new Int16Array(256);
for (let i = 0; i < 256; i++) {
  let v = ~i & 0xFF;
  const sign = v & 0x80;
  const exponent = (v >> 4) & 0x07;
  const mantissa = v & 0x0F;
  let sample = ((mantissa << 3) + 0x84) << exponent;
  sample -= 0x84;
  MULAW_DECODE_TABLE[i] = sign ? -sample : sample;
}

function mulawToLinear16(base64Mulaw) {
  const mulaw = Buffer.from(base64Mulaw, "base64");
  const pcm = Buffer.alloc(mulaw.length * 2);
  for (let i = 0; i < mulaw.length; i++) {
    const sample = MULAW_DECODE_TABLE[mulaw[i]];
    pcm.writeInt16LE(sample, i * 2);
  }
  return pcm.toString("base64");
}

function wavToMulawChunks(base64Wav) {
  const wav = new WaveFile();
  wav.fromBuffer(Buffer.from(base64Wav, "base64"));
  if (wav.fmt.sampleRate !== TWILIO_SAMPLE_RATE) wav.toSampleRate(TWILIO_SAMPLE_RATE);
  if (wav.bitDepth !== "16") wav.toBitDepth("16");
  wav.toMuLaw();
  const samples = Buffer.from(wav.data.samples);
  const chunks = [];
  for (let off = 0; off < samples.length; off += TWILIO_CHUNK_BYTES) {
    chunks.push(samples.slice(off, off + TWILIO_CHUNK_BYTES).toString("base64"));
  }
  return chunks;
}

// ─── Health ──────────────────────────────────────────────────────
fastify.get("/", async () => ({
  status: "ATOM Voice Bridge running",
  version: "4.0.0",
  hume_config: HUME_CONFIG_ID,
  twilio_number: TWILIO_PHONE_NUMBER,
  active_calls: activeCalls.size,
  features: [
    "mulaw↔PCM transcoding",
    "chunked output",
    "barge-in",
    "real-time event stream",
    "post-call summary",
    "product knowledge base",
  ],
}));

// ─── Real-time Event Stream (frontend connects here) ─────────────
fastify.register(async function (fastify) {
  fastify.get("/events/:callSid", { websocket: true }, async (socket, req) => {
    const { callSid } = req.params;
    console.log(`[events] Frontend connected for call ${callSid}`);

    const call = activeCalls.get(callSid);
    if (call) {
      call.frontendSockets.add(socket);
      // Send any buffered events
      for (const evt of call.eventBuffer) {
        socket.send(JSON.stringify(evt));
      }
    }

    socket.on("close", () => {
      const c = activeCalls.get(callSid);
      if (c) c.frontendSockets.delete(socket);
    });
  });
});

function emitEvent(callSid, event) {
  const call = activeCalls.get(callSid);
  if (!call) return;
  call.eventBuffer.push(event);
  for (const ws of call.frontendSockets) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(event));
    }
  }
}

// ─── Initiate Outbound Call ──────────────────────────────────────
fastify.post("/call", async (request, reply) => {
  const { to, contactName, companyName, productSlug } = request.body;
  if (!to) return reply.code(400).send({ error: "to is required" });

  let cleanNumber = to.replace(/[^\d+]/g, "");
  if (!cleanNumber.startsWith("+")) cleanNumber = "+1" + cleanNumber;

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

    // Register in active calls
    activeCalls.set(call.sid, {
      callSid: call.sid,
      to: cleanNumber,
      contactName: contactName || "there",
      companyName: companyName || "unknown",
      productSlug: productSlug || "antimatter-ai",
      startTime: Date.now(),
      transcript: [],
      emotions: [],
      frontendSockets: new Set(),
      eventBuffer: [],
    });

    console.log(`Call initiated: ${call.sid} → ${cleanNumber}`);
    return { success: true, callSid: call.sid, to: cleanNumber };
  } catch (err) {
    console.error("Call error:", err.message);
    return reply.code(500).send({ error: err.message });
  }
});

// ─── Get call summary (post-call) ───────────────────────────────
fastify.get("/call/:callSid/summary", async (request, reply) => {
  const { callSid } = request.params;
  const call = activeCalls.get(callSid);
  if (!call) return reply.code(404).send({ error: "Call not found" });

  const duration = call.endTime
    ? Math.round((call.endTime - call.startTime) / 1000)
    : Math.round((Date.now() - call.startTime) / 1000);

  // Extract key info from transcript
  const fullTranscript = call.transcript.map(t => `${t.speaker}: ${t.text}`).join("\n");
  const emailMatch = fullTranscript.match(/[\w.+-]+@[\w-]+\.[\w.-]+/i);
  const meetingMatch = fullTranscript.match(/(monday|tuesday|wednesday|thursday|friday|saturday|sunday)[\s\S]{0,50}?((?:\d{1,2})\s*(?:am|pm|AM|PM))/i);

  // Dominant emotions across the call
  const emotionTotals = {};
  for (const e of call.emotions) {
    for (const [emotion, score] of Object.entries(e.scores || {})) {
      emotionTotals[emotion] = (emotionTotals[emotion] || 0) + score;
    }
  }
  const topEmotions = Object.entries(emotionTotals)
    .sort(([, a], [, b]) => b - a)
    .slice(0, 5)
    .map(([name, total]) => ({
      name,
      avgScore: Math.round((total / Math.max(call.emotions.length, 1)) * 100),
    }));

  // Determine outcome
  let outcome = "no_outcome";
  const lowerTranscript = fullTranscript.toLowerCase();
  if (meetingMatch || lowerTranscript.includes("calendar") || lowerTranscript.includes("schedule") || lowerTranscript.includes("book")) {
    outcome = "meeting_booked";
  } else if (lowerTranscript.includes("send me") || lowerTranscript.includes("email me") || lowerTranscript.includes("more info")) {
    outcome = "info_requested";
  } else if (lowerTranscript.includes("not interested") || lowerTranscript.includes("no thanks") || lowerTranscript.includes("don't call")) {
    outcome = "not_interested";
  } else if (call.transcript.length > 4) {
    outcome = "engaged_conversation";
  }

  return {
    callSid,
    to: call.to,
    contactName: call.contactName,
    companyName: call.companyName,
    product: call.productSlug,
    duration,
    outcome,
    transcript: call.transcript,
    topEmotions,
    extractedEmail: emailMatch ? emailMatch[0] : null,
    extractedMeeting: meetingMatch
      ? { day: meetingMatch[1], time: meetingMatch[2] }
      : null,
    turnCount: call.transcript.length,
  };
});

// ─── Twilio ↔ Hume Bridge ───────────────────────────────────────
fastify.register(async function (fastify) {
  fastify.get("/media-stream", { websocket: true }, async (socket, req) => {
    console.log("=== Twilio Media Stream connected ===");

    const url = new URL(req.url, `http://${req.headers.host}`);
    const contactName = url.searchParams.get("contactName") || "there";
    const companyName = url.searchParams.get("companyName") || "your company";
    const productSlug = url.searchParams.get("productSlug") || "antimatter-ai";
    const product = PRODUCT_KNOWLEDGE[productSlug] || PRODUCT_KNOWLEDGE["antimatter-ai"];
    const firstName = contactName.split(" ")[0];

    let streamSid = null;
    let callSid = null;
    let humeWs = null;
    let humeReady = false;
    let markCounter = 0;
    let isBotSpeaking = false;

    // ── Connect to Hume EVI ───────────────────────────────────
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

      // Configure audio format + deep system context
      humeWs.send(JSON.stringify({
        type: "session_settings",
        audio: {
          encoding: "linear16",
          sample_rate: TWILIO_SAMPLE_RATE,
          channels: 1,
        },
        context: {
          text: buildSystemPrompt(firstName, companyName, product),
          type: "persistent",
        },
      }));

      // Pre-load greeting via assistant_input — Hume will TTS this immediately
      // No round-trip delay since we're not waiting for model generation
      humeWs.send(JSON.stringify({
        type: "assistant_input",
        text: `Hey ${firstName}, this is Adam from Antimatter AI. Hope I'm not catching you at a bad time?`,
      }));
    });

    humeWs.on("error", (err) => console.error("Hume WS error:", err.message));

    humeWs.on("close", (code) => {
      console.log(`Hume closed: ${code}`);
      humeReady = false;

      // Finalize call data
      if (callSid && activeCalls.has(callSid)) {
        const call = activeCalls.get(callSid);
        call.endTime = Date.now();
        emitEvent(callSid, {
          type: "call_ended",
          duration: Math.round((call.endTime - call.startTime) / 1000),
          turnCount: call.transcript.length,
        });

        // Auto-cleanup after 10 minutes
        setTimeout(() => activeCalls.delete(callSid), 600000);
      }
    });

    // ── Hume → Twilio ─────────────────────────────────────────
    humeWs.on("message", (data) => {
      try {
        const msg = JSON.parse(data.toString());

        if (msg.type === "audio_output" && msg.data && streamSid) {
          isBotSpeaking = true;
          try {
            const mulawChunks = wavToMulawChunks(msg.data);
            for (const chunk of mulawChunks) {
              socket.send(JSON.stringify({
                event: "media",
                streamSid,
                media: { payload: chunk },
              }));
            }
            markCounter++;
            socket.send(JSON.stringify({
              event: "mark",
              streamSid,
              mark: { name: `mark_${markCounter}` },
            }));
          } catch (e) {
            console.error("Hume→Twilio transcode error:", e.message);
          }
        }

        if (msg.type === "assistant_end") {
          isBotSpeaking = false;
        }

        if (msg.type === "assistant_message") {
          const text = msg.message?.content || "";
          console.log(`ATOM: ${text}`);
          if (callSid) {
            const entry = { speaker: "ATOM", text, timestamp: Date.now() };
            const call = activeCalls.get(callSid);
            if (call) call.transcript.push(entry);
            emitEvent(callSid, { type: "transcript", ...entry });
          }
        }

        if (msg.type === "user_message") {
          const text = msg.message?.content || "";
          console.log(`Caller: ${text}`);

          const emotions = msg.models?.prosody?.scores || {};
          const topEmotions = Object.entries(emotions)
            .sort(([, a], [, b]) => b - a)
            .slice(0, 3)
            .map(([n, s]) => `${n}:${(s * 100).toFixed(0)}%`);
          if (topEmotions.length) console.log(`  Emotions: ${topEmotions.join(", ")}`);

          if (callSid) {
            const call = activeCalls.get(callSid);
            if (call) {
              call.transcript.push({
                speaker: "Prospect",
                text,
                timestamp: Date.now(),
              });
              call.emotions.push({ scores: emotions, timestamp: Date.now() });
            }
            emitEvent(callSid, {
              type: "transcript",
              speaker: "Prospect",
              text,
              timestamp: Date.now(),
              emotions: Object.fromEntries(
                Object.entries(emotions)
                  .sort(([, a], [, b]) => b - a)
                  .slice(0, 5)
              ),
            });
          }
        }

        if (msg.type === "user_interruption") {
          console.log(">>> Barge-in — clearing buffer");
          if (streamSid) {
            socket.send(JSON.stringify({ event: "clear", streamSid }));
          }
          isBotSpeaking = false;
          if (callSid) emitEvent(callSid, { type: "barge_in", timestamp: Date.now() });
        }

        if (msg.type === "error") {
          console.error("Hume error:", msg.message || JSON.stringify(msg));
        }
      } catch (err) {
        console.error("Error processing Hume message:", err.message);
      }
    });

    // ── Twilio → Hume ─────────────────────────────────────────
    socket.on("message", (message) => {
      try {
        const data = JSON.parse(message.toString());

        switch (data.event) {
          case "start":
            streamSid = data.start.streamSid;
            callSid = data.start.callSid;
            console.log(`Stream started: ${streamSid} (Call: ${callSid})`);
            if (callSid) {
              emitEvent(callSid, { type: "call_started", timestamp: Date.now() });
            }
            break;

          case "media":
            if (humeReady && humeWs?.readyState === WebSocket.OPEN) {
              try {
                const pcm = mulawToLinear16(data.media.payload);
                humeWs.send(JSON.stringify({ type: "audio_input", data: pcm }));
              } catch (e) {
                // Silently skip bad frames
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

// ─── System Prompt Builder ───────────────────────────────────────
function buildSystemPrompt(firstName, companyName, product) {
  return `You are Adam, a senior sales development representative at Antimatter AI. You are a REAL PERSON on a live phone call. Your name is pronounced "Adam" — say it naturally, never spell it out.

IDENTITY:
- You are human. Never say you're an AI, bot, assistant, language model, or anything similar.
- If asked "are you a robot" laugh it off: "Ha, no, just a guy who's had too much coffee today."
- You have genuine personality. You're warm, sharp, a little witty, and you actually care about helping.

VOICE RULES (critical for sounding human):
- Sentences: 5 to 15 words max. Short and punchy.
- Always use contractions: "we've", "you're", "it's", "don't", "couldn't".
- Natural fillers every few turns: "yeah", "so", "look", "honestly", "I mean".
- Brief acknowledgments: "gotcha", "makes sense", "I hear you", "totally fair".
- Mirror the prospect's energy. If they're casual, be casual. If they're formal, dial it up.
- Pause naturally. Don't rush. Let them finish speaking.
- NEVER use corporate jargon like "leverage", "synergy", "paradigm", "circle back", "touch base".

CALL CONTEXT:
- You called ${firstName} at ${companyName}.
- Product: ${product.name}
- Your pitch: ${product.pitch}
- Key value: ${product.details}
- Qualifying question: ${product.qualifying}

CALL FLOW:
1. Greet warmly, check if it's a good time
2. Brief hook — why you're calling (one sentence)
3. Ask a qualifying question to understand their situation
4. Listen actively — reflect what they say, ask follow-ups
5. Connect their pain to your solution naturally
6. If there's a fit, suggest a brief follow-up call
7. If they want to schedule, get day/time and their email
8. Close warmly

OBJECTION HANDLING:
- Price concerns: ${product.objections.price}
- Bad timing: ${product.objections.timing}
- Have competitors: ${product.objections.competition}
- Skepticism: ${product.objections.skepticism}
- "Not interested": "No worries at all. Mind if I ask what you're focused on right now? Just so I know for future reference."
- "How'd you get my number": "Yeah, totally fair question. We do some research on companies in the space. I can take you off our list if you want, no problem."
- "Send me an email": "Absolutely. What's the best email? And is there anything specific you'd want me to include?"

EMOTIONAL INTELLIGENCE:
- If they sound rushed: speed up, get to the point fast
- If they sound skeptical: acknowledge it, be more direct and honest
- If they sound interested: lean in, share more specifics
- If they sound confused: simplify, use analogies
- If they're warm and chatty: match it, build rapport first

NEVER DO:
- Never read a script. Every response should feel spontaneous.
- Never repeat the same phrase twice in a call.
- Never ignore what they just said. Always respond to THEIR words first.
- Never end a sentence with "does that make sense?" — it sounds condescending.
- Never use the prospect's full name repeatedly. First name only, and sparingly.`;
}

// ─── Start ───────────────────────────────────────────────────────
fastify.listen({ port: PORT, host: "0.0.0.0" }, (err) => {
  if (err) { console.error(err); process.exit(1); }
  console.log(`\n  ATOM Voice Bridge v4.0`);
  console.log(`  Port: ${PORT} | Domain: ${cleanDomain}`);
  console.log(`  Hume: ${HUME_CONFIG_ID}`);
  console.log(`  Twilio: ${TWILIO_PHONE_NUMBER}`);
  console.log(`  Products: ${Object.keys(PRODUCT_KNOWLEDGE).join(", ")}`);
  console.log(`  Features: event stream, post-call summary, product KB\n`);
});
