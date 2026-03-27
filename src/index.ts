/**
 * Voice Ordering API — Entry Point
 *
 * REST API that bridges voice assistants (Siri, Google, Alexa) and
 * in-app voice control to the Spoonity + Deliverect MCP servers.
 */

import express from "express";
import { McpClientManager } from "./mcp-client.js";
import { VoiceOrchestrator, type VoiceRequest } from "./orchestrator.js";

// ── Configuration ───────────────────────────────────────────────────────────

const PORT = parseInt(process.env.PORT ?? "8080", 10);
const SPOONITY_MCP_URL = process.env.SPOONITY_MCP_URL ?? "https://spoonity-consumer-mcp-285397558465.us-east1.run.app";
const DELIVERECT_MCP_URL = process.env.DELIVERECT_MCP_URL ?? "https://deliverect-mcp-285397558465.us-east1.run.app";
const MCP_API_KEY = process.env.MCP_API_KEY ?? "";
const VOICE_API_KEY = process.env.VOICE_API_KEY ?? "";
const CORS_ORIGIN = process.env.CORS_ORIGIN ?? "*";

// ── Setup ───────────────────────────────────────────────────────────────────

const app = express();
app.use(express.json());
app.set("trust proxy", 1);

// CORS
app.use((_req, res, next) => {
  res.header("Access-Control-Allow-Origin", CORS_ORIGIN);
  res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type, X-Api-Key, Authorization");
  if (_req.method === "OPTIONS") { res.sendStatus(204); return; }
  next();
});

// Auth middleware
function auth(req: express.Request, res: express.Response, next: express.NextFunction) {
  if (VOICE_API_KEY && req.headers["x-api-key"] !== VOICE_API_KEY) {
    res.status(401).json({ error: "Invalid API key" });
    return;
  }
  next();
}

// MCP client
const mcp = new McpClientManager({
  spoonityUrl: SPOONITY_MCP_URL,
  deliverectUrl: DELIVERECT_MCP_URL,
  apiKey: MCP_API_KEY,
});

const orchestrator = new VoiceOrchestrator(mcp);

// ── Routes ──────────────────────────────────────────────────────────────────

/** POST /voice/order — Main voice processing endpoint */
app.post("/voice/order", auth, async (req, res) => {
  try {
    const voiceReq: VoiceRequest = {
      text: req.body.text || "",
      spoonity_session_key: req.body.spoonity_session_key,
      vendor_id: req.body.vendor_id,
      latitude: req.body.latitude,
      longitude: req.body.longitude,
      basket_id: req.body.basket_id,
      state: req.body.state,
      state_data: req.body.state_data,
    };

    const result = await orchestrator.process(voiceReq);
    res.json(result);
  } catch (err: any) {
    console.error("[voice/order] Error:", err);
    res.status(500).json({
      response: "Sorry, I'm having trouble processing that. Please try again.",
      error: err.message,
    });
  }
});

/** POST /voice/rewards — Quick rewards check */
app.post("/voice/rewards", auth, async (req, res) => {
  try {
    const result = await orchestrator.process({
      text: "check my rewards and balance",
      spoonity_session_key: req.body.spoonity_session_key,
      vendor_id: req.body.vendor_id,
    });
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ response: "Couldn't check rewards", error: err.message });
  }
});

/** POST /voice/status — Check order status */
app.post("/voice/status", auth, async (req, res) => {
  try {
    const result = await orchestrator.process({
      text: "check my order status",
      state_data: { checkout_id: req.body.checkout_id },
    });
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ response: "Couldn't check status", error: err.message });
  }
});

/** POST /voice/stores — Find nearby stores */
app.post("/voice/stores", auth, async (req, res) => {
  try {
    const result = await orchestrator.process({
      text: "find stores near me",
      spoonity_session_key: req.body.spoonity_session_key,
      vendor_id: req.body.vendor_id,
      latitude: req.body.latitude,
      longitude: req.body.longitude,
    });
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ response: "Couldn't find stores", error: err.message });
  }
});

// ── Webhook endpoints for native assistants ─────────────────────────────────

/** POST /webhook/siri — Siri Shortcuts webhook */
app.post("/webhook/siri", auth, async (req, res) => {
  try {
    const result = await orchestrator.process({
      text: req.body.input || req.body.text || "",
      spoonity_session_key: req.body.session_key || req.body.spoonity_session_key,
      vendor_id: req.body.vendor_id,
    });
    // Siri Shortcuts expects a simple response format
    res.json({
      spokenText: result.response,
      displayText: result.response,
      actions: result.actions,
    });
  } catch (err: any) {
    res.json({ spokenText: "Sorry, I couldn't process that request. Please try again." });
  }
});

/** POST /webhook/google — Google Assistant webhook */
app.post("/webhook/google", auth, async (req, res) => {
  try {
    // Google Actions sends intent + parameters
    const text = req.body.queryResult?.queryText || req.body.text || "";
    const result = await orchestrator.process({
      text,
      spoonity_session_key: req.body.session_key,
      vendor_id: req.body.vendor_id,
    });

    // Dialogflow response format
    res.json({
      fulfillmentText: result.response,
      fulfillmentMessages: [{
        text: { text: [result.response] },
      }],
    });
  } catch (err: any) {
    res.json({ fulfillmentText: "Sorry, I couldn't process that. Please try again." });
  }
});

/** POST /webhook/alexa — Alexa Skills Kit webhook */
app.post("/webhook/alexa", auth, async (req, res) => {
  try {
    const alexaReq = req.body.request;
    let text = "";

    if (alexaReq?.type === "IntentRequest") {
      text = alexaReq.intent?.slots?.query?.value || alexaReq.intent?.name || "";
    } else if (alexaReq?.type === "LaunchRequest") {
      text = "help";
    }

    const result = await orchestrator.process({
      text,
      spoonity_session_key: req.body.session?.attributes?.session_key,
      vendor_id: req.body.session?.attributes?.vendor_id,
    });

    // Alexa response format
    res.json({
      version: "1.0",
      response: {
        outputSpeech: {
          type: "PlainText",
          text: result.response,
        },
        shouldEndSession: !result.state, // keep session open for multi-turn
      },
      sessionAttributes: {
        state: result.state,
        state_data: result.state_data,
      },
    });
  } catch (err: any) {
    res.json({
      version: "1.0",
      response: {
        outputSpeech: { type: "PlainText", text: "Sorry, something went wrong. Please try again." },
        shouldEndSession: true,
      },
    });
  }
});

// ── Health & Info ────────────────────────────────────────────────────────────

app.get("/health", (_req, res) => {
  res.json({
    status: "ok",
    service: "voice-ordering-api",
    endpoints: {
      spoonity_mcp: SPOONITY_MCP_URL,
      deliverect_mcp: DELIVERECT_MCP_URL,
    },
  });
});

app.get("/", (_req, res) => {
  res.setHeader("Content-Type", "text/html");
  res.send(`<!DOCTYPE html><html><head><title>Voice Ordering API</title></head>
<body style="font-family:system-ui;background:#0a0a14;color:#e0e0e0;display:flex;align-items:center;justify-content:center;min-height:100vh">
<div style="text-align:center"><h1>🎙 Voice Ordering API</h1>
<p style="color:#888">Bridges Siri, Google Assistant, Alexa → MCP Servers</p>
<pre style="text-align:left;font-size:14px;color:#6a6">POST /voice/order
POST /voice/rewards
POST /voice/status
POST /voice/stores
POST /webhook/siri
POST /webhook/google
POST /webhook/alexa
GET  /health</pre></div></body></html>`);
});

// ── Start ───────────────────────────────────────────────────────────────────

app.listen(PORT, "0.0.0.0", () => {
  console.error(`Voice Ordering API on http://0.0.0.0:${PORT}/`);
  console.error(`  Spoonity MCP: ${SPOONITY_MCP_URL}`);
  console.error(`  Deliverect MCP: ${DELIVERECT_MCP_URL}`);
});
