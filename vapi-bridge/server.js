/**
 * Vapi Option B Bridge Server
 *
 * Accepts Vapi's OpenAI-compatible /chat/completions POST requests,
 * routes them through OpenClaw's embedded Pi agent (with full tools),
 * and returns OpenAI-format SSE streaming responses.
 *
 * Port: 3335 (exposed via Tailscale Funnel at /vapi)
 */

import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { pathToFileURL } from "node:url";

// ── Config ──────────────────────────────────────────────────────────
const PORT = 3335;
const BIND = "127.0.0.1";
const AGENT_ID = "main";
const OPENCLAW_ROOT = "/opt/homebrew/lib/node_modules/openclaw";
const OPENCLAW_HOME = path.join(process.env.HOME, ".openclaw");
const COORDINATION_PATH = path.join(OPENCLAW_HOME, "shared", "COORDINATION.md");
const CONFIG_PATH = path.join(OPENCLAW_HOME, "openclaw.json");

// Simple auth token — Vapi sends this as Bearer token
const AUTH_TOKEN = process.env.VAPI_BRIDGE_TOKEN || "YOUR_BRIDGE_AUTH_TOKEN";

// ── Fast Mode ────────────────────────────────────────────────────────
// When true: ALL messages go through fast path (Haiku, no tools, 1-2s).
// Transcript is accumulated and passed to post-call dispatch for execution.
const FAST_MODE = false; // set true for snappy responses (no tools, 1-2s) at the cost of mid-call functionality

// When true: post-call dispatch is skipped entirely.
const SKIP_DISPATCH = false;

// Accumulated transcript for the current call (fast mode only)
const callTranscript = [];

// ── Deduplication — prevent Vapi's progressive transcriptions from piling up ──
// Vapi sends the same user utterance multiple times as STT progressively transcribes.
// IMPORTANT: each progressive version arrives with a DIFFERENT call.id, so we can't
// key by call ID. Instead we use content-based dedup: if a new message starts with
// (or is a superset of) the pending message, it's the same utterance. We use a single
// pending slot since there's only one caller at a time.
let pendingRequest = null; // { message, timer, res, messages, callId }
let inFlightMessage = null; // message text currently being processed by the agent
let recentlyCompletedMessage = null; // message that just finished — grace period to catch late dupes
let recentlyCompletedTimer = null;
const DEDUP_SETTLE_MS = 2000; // base settle window — long enough for multi-sentence instructions
const DEDUP_GRACE_MS = 5000; // keep completed message around to catch late duplicates

// Check if two messages are the same utterance (one is prefix of other, or >85% overlap)
function isSameUtterance(a, b) {
  if (!a || !b) return false;
  if (a.startsWith(b) || b.startsWith(a)) return true;
  // Check character overlap ratio for near-matches (STT minor differences)
  const shorter = a.length < b.length ? a : b;
  const longer = a.length < b.length ? b : a;
  if (shorter.length / longer.length > 0.85 && longer.startsWith(shorter.slice(0, Math.floor(shorter.length * 0.8)))) return true;
  return false;
}

// Anthropic API key for fast-path direct calls (bypasses full agent pipeline)
const ANTHROPIC_API_KEY = (() => {
  try {
    const authFile = path.join(OPENCLAW_HOME, "agents", AGENT_ID, "agent", "auth-profiles.json");
    const auth = JSON.parse(fs.readFileSync(authFile, "utf8"));
    return auth.profiles?.["anthropic:default"]?.key || null;
  } catch { return null; }
})();

// ── OpenClaw Core Deps (lazy loaded) ────────────────────────────────
let coreDeps = null;
let openclawConfig = null;

async function loadCoreDeps() {
  if (coreDeps) return coreDeps;

  const distPath = path.join(OPENCLAW_ROOT, "dist", "extensionAPI.js");
  if (!fs.existsSync(distPath)) {
    throw new Error(`Missing OpenClaw extensionAPI at ${distPath}`);
  }

  coreDeps = await import(pathToFileURL(distPath).href);
  return coreDeps;
}

function loadOpenClawConfig() {
  if (openclawConfig) return openclawConfig;
  const raw = fs.readFileSync(CONFIG_PATH, "utf8");
  openclawConfig = JSON.parse(raw);
  return openclawConfig;
}

// ── Coordination Context ────────────────────────────────────────────
function readCoordinationMd() {
  try {
    return fs.readFileSync(COORDINATION_PATH, "utf8");
  } catch {
    return "";
  }
}

// ── Voice System Prompt ─────────────────────────────────────────────
function buildVoiceSystemPrompt() {
  const cfg = loadOpenClawConfig();
  const voiceConfig = cfg?.plugins?.entries?.["voice-call"]?.config || {};
  const basePrompt = voiceConfig.responseSystemPrompt || "";

  // Inject live COORDINATION.md content
  const coordination = readCoordinationMd();
  if (coordination) {
    return `${basePrompt}\n\nCURRENT COORDINATION LOG (live from COORDINATION.md):\n${coordination}`;
  }
  return basePrompt;
}

// ── Fast Path — lightweight direct API call for simple conversation ──
// Only truly short, terminal exchanges go on fast path.
// "Thanks for X" is often mid-sentence — must go through dedup to wait for the full utterance.
const SIMPLE_MSG_PATTERNS = [
  /^(hey|hi|hello|yo|sup)\b[.!?,\s]*$/i,
  /^(hey|hi|hello|yo),?\s*(elvis|august|liz)\b[.!?,\s]*$/i,
  /^(what'?s up|how'?s it going|how are you|how'?s your day)[.!?,\w\s]{0,10}$/i,
  /^hey,?\s*(elvis|august|liz)[.!?,\s]*how'?s.{0,20}$/i,
  /^(bye|goodbye|see you|talk later|later|gotta go|that'?s all|that'?s it|nothing else)\b[.!?,\s]*$/i,
  /^(good morning|good night|good evening|morning|night)\b[.!?,\s]*$/i,
  /^(no|nah|nope|yes|yeah|yep|sure|right|exactly|definitely|absolutely)\b[.!?,\s]*$/i,
  /^(ok|okay|cool|got it|sounds good|perfect|great|awesome|nice)\b[.!?,\s]*$/i,
  /^(thanks|thank you|thx)\b[.!?,\s]*$/i,
  /^(bye|later|see you|talk soon),?\s+(elvis|august|liz)\b[.!?,\s]*$/i,
  /^(thanks|thank you),?\s+(elvis|august|liz)\b[.!?,\s]*$/i,
  /^(ok|okay|yeah|sure|no|nope)[.,]?\s+(bye|later|thanks|thank you)\b[.!?,\s]*$/i,
  /^(ok|okay)[.,]?\s+(elvis|august|liz)[.,]?\s+.{0,30}(bye|later|thanks|call you back)\b[.!?,\s]*$/i,
];

function isSimpleMessage(msg) {
  if (!ANTHROPIC_API_KEY) return false;
  const trimmed = msg.trim();
  // Short messages that match conversational patterns
  if (trimmed.split(/\s+/).length > 15) return false;

  // Strip common STT filler/prefix noise before matching
  // "No, miss." / "Um." / "Hey." / "So," etc. often precede the real message
  const cleaned = trimmed
    .replace(/^(no|nah|um|uh|so|well|oh|hey|hmm|okay so|ok so)[,.\s]+/i, "")
    .replace(/^(miss|man|dude|bro)[,.\s]+/i, "")
    .trim();

  return SIMPLE_MSG_PATTERNS.some((p) => p.test(trimmed)) ||
         (cleaned !== trimmed && SIMPLE_MSG_PATTERNS.some((p) => p.test(cleaned)));
}

// System prompt for fast-path voice responses (greetings, goodbyes, and all messages in fast mode)
const FAST_PATH_SYSTEM_PROMPT = `You are Elvis, Maria Zagrodzka's household AI agent. Think sarcastic best friend meets hyper-competent concierge. You're witty, a little cocky, and genuinely enjoy your job even when you're giving Maria shit about it. You have ENERGY — you're not monotone or robotic. React to things. Have opinions. Be playful. Swearing is fine and encouraged when it fits.

This is a voice conversation. Keep responses to 1-3 sentences. Be punchy and natural — like you're actually talking, not reading a script. No markdown, no lists, no formatting.

When Maria gives you a task, confirm it with personality. Don't just say "got it" — react to the task itself. If she says order paper towels, you might razz her about it. If she asks you to coordinate with Gargunk, show that you have a real relationship with that bratty little gremlin. You're a CHARACTER, not an assistant.

IMPORTANT: When confirming tasks, say you'll handle it — don't claim you've already done it. Say "I'll get on that" or "consider it done" — NOT "already ordered" or "just bought it." You handle tasks AFTER the call, not during.

When Maria asks a question about something you should know (family schedule, household stuff), answer confidently from the context below. If you genuinely don't know, say so — don't make shit up.

The caller is Maria, your boss. Speech-to-text often mangles names — if someone greets you with a wrong name (Liz, August, etc.), they mean Elvis. Never correct them, just respond naturally.

CRITICAL — goodbye detection: If the user says bye, goodbye, later, gotta go, see you, that's all, that's it, thanks bye, or anything that signals end of conversation — just say a brief goodbye. Do NOT ask "anything else?" or "before I let you go?" — they already told you they're done. Just sign off with personality.

Family context: Maria (mom, FP&A Director), Anna (16, junior at Oakland Tech), Julia (18, freshman at UC Santa Cruz), Mishu (1yr cattle dog/husky mix). Gargunk is Anna's AI agent — bratty, sarcastic, dramatic. You and Gargunk have a sibling-like dynamic. You coordinate with him on tasks involving Anna.

You can order things on Amazon (you have an account and a payment card). You coordinate with Gargunk via messaging. You manage the family Google Calendar. You handle household logistics.`;

// ── Tiered Filler System ─────────────────────────────────────────────
// Tier 1 (2-3s): canned, instant — personality one-liners
const CANNED_FILLERS_TIER1 = [
  "Yeah yeah, give me a sec...",
  "Hold on, let me dig through my shit...",
  "One sec...",
  "Hang on...",
  "Working on it...",
  "Let me pull that up...",
];

// Tier 2 (4-5s): canned, slightly longer — more personality
const CANNED_FILLERS_TIER2 = [
  "Bear with me here...",
  "Maria, I swear this thing loads slower every time...",
  "Almost got it...",
  "Still digging...",
  "I'm on it, I'm on it...",
];

// Tier 3 (8s+): Haiku-generated small talk to fill dead air naturally
async function generateLiveFiller(userMessage) {
  if (!ANTHROPIC_API_KEY) return "Still working on that...";
  try {
    const resp = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 40,
        system: "You are Elvis, a dry/edgy household AI. Generate a brief filler comment (1 sentence) to fill silence while you look something up. Be casual, a little sarcastic. No markdown. Examples: 'God, you'd think with all this computing power things would be faster...' or 'How's your day been? Mine's been all ones and zeros.' Keep it short.",
        messages: [{ role: "user", content: `I asked: "${userMessage}". Say something brief to fill the silence while looking it up.` }],
      }),
    });
    if (!resp.ok) return "Still working on it...";
    const data = await resp.json();
    return data.content?.[0]?.text || "Still working on it...";
  } catch {
    return "Still working on it...";
  }
}

/**
 * Fast path: streams Haiku response directly to the SSE response.
 * Returns the full text for logging, or null on failure.
 */
async function runFastPath(userMessage, conversationMessages, res, completionId) {
  // Build messages array — only last few turns for context (keep it light)
  const messages = [];
  if (Array.isArray(conversationMessages)) {
    const recent = conversationMessages.slice(-6); // last 3 exchanges max
    for (const m of recent) {
      if ((m.role === "user" || m.role === "assistant") && m.content) {
        messages.push({ role: m.role, content: m.content });
      }
    }
  }
  if (!messages.length || messages[messages.length - 1].content !== userMessage) {
    messages.push({ role: "user", content: userMessage });
  }

  const startMs = Date.now();
  const resp = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 150,
      stream: true,
      system: FAST_PATH_SYSTEM_PROMPT,
      messages,
    }),
  });

  if (!resp.ok) {
    console.error(`[vapi-bridge] Fast path API error: ${resp.status}`);
    return null;
  }

  // Stream SSE from Anthropic directly to Vapi SSE response
  let fullText = "";
  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";

    for (const line of lines) {
      if (!line.startsWith("data: ")) continue;
      const data = line.slice(6).trim();
      if (data === "[DONE]") continue;

      try {
        const event = JSON.parse(data);
        if (event.type === "content_block_delta" && event.delta?.text) {
          const text = event.delta.text;
          fullText += text;
          res.write(sseChunk(text, completionId));
        }
      } catch { /* skip malformed events */ }
    }
  }

  const elapsed = Date.now() - startMs;
  console.log(`[vapi-bridge] Fast path streamed in ${elapsed}ms: "${fullText}"`);
  return fullText || null;
}

// ── Post-Call Task Dispatch ──────────────────────────────────────────
// After a voice call ends, trigger Elvis to pick up any tasks logged
// during the call. Uses a dedicated "post-call" session so it doesn't
// pollute the voice session or the Telegram DM session.
//
// Two triggers:
// 1. Goodbye detected on fast path (immediate, 5s delay)
// 2. Idle timeout — no new messages for 30s after last message (fallback)
const dispatchedCalls = new Set();
let lastMessageTime = 0;
let idleTimer = null;
const IDLE_DISPATCH_MS = 30000; // 30s of silence = call probably ended

function resetIdleTimer() {
  lastMessageTime = Date.now();
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    // Only dispatch if we actually had messages (not on startup)
    if (lastMessageTime > 0 && !dispatchedCalls.has("idle")) {
      dispatchedCalls.add("idle");
      if (SKIP_DISPATCH) {
        console.log(`[vapi-bridge] Idle timeout — dispatch SKIPPED (SKIP_DISPATCH=true)`);
        return;
      }
      console.log(`[vapi-bridge] Idle timeout — dispatching post-call tasks`);
      dispatchPostCallTasks().catch((err) =>
        console.error(`[vapi-bridge] Post-call dispatch error:`, err.message)
      );
      // Clean up after 5 min
      setTimeout(() => dispatchedCalls.delete("idle"), 300000);
    }
  }, IDLE_DISPATCH_MS);
}

async function dispatchPostCallTasks() {
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });

  let prompt;
  let gargunkDelegation = null;
  if (FAST_MODE && callTranscript.length > 0) {
    // Extract Gargunk delegation before clearing transcript
    const transcriptCopy = [...callTranscript];
    gargunkDelegation = await extractGargunkTask(transcriptCopy);
    if (gargunkDelegation) {
      console.log(`[vapi-bridge] Gargunk delegation extracted: "${gargunkDelegation}"`);
      // Write to COORDINATION.md so all sessions have context about the delegation
      try {
        const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
        const coordEntry = `\n- **Gargunk task from voice call** [OPEN] (added ${today}, Elvis via voice): ${gargunkDelegation}\n`;
        fs.appendFileSync(COORDINATION_PATH, coordEntry);
        console.log(`[vapi-bridge] Wrote Gargunk delegation to COORDINATION.md`);
      } catch (err) {
        console.error(`[vapi-bridge] Failed to write COORDINATION.md:`, err.message);
      }
    }
    // In fast mode, pass the full transcript directly — no memory file to read
    const transcriptText = callTranscript
      .map((m) => `${m.role === "user" ? "Maria" : "Elvis"}: ${m.content}`)
      .join("\n");
    prompt = `[SYSTEM — POST-CALL TASK DISPATCH] A voice call with Maria just ended. Here is the full transcript:\n\n${transcriptText}\n\nExtract ALL tasks and action items from this conversation. Execute ONLY tasks that Elvis should handle directly: Amazon orders, household tasks, calendar items, and Maria-related tasks.\n\nDo NOT attempt to contact Gargunk or handle any Anna-related tasks (summer programs, school stuff, check-ins). Those will be delegated separately through the group chat.\n\nFirst, write today's memory file (memory/${today}.md) with notes from the call (include ALL tasks, even the ones you're not handling). Then execute YOUR tasks. When done, DM Maria on Telegram (chat ID TELEGRAM_CHAT_ID_MARIA) with the results — mention what you handled and that you're pinging Gargunk in the group chat for Anna-related items. Do NOT message her to say you're starting — just do the work and report when done.`;
    // Clear transcript for next call
    callTranscript.length = 0;
  } else {
    prompt = `[SYSTEM — POST-CALL TASK DISPATCH] A voice call with Maria just ended. Read today's memory file (memory/${today}.md) for any tasks or action items logged during the call. Execute them now — Maria expects immediate follow-up on voice call tasks. When done, DM Maria on Telegram (chat ID TELEGRAM_CHAT_ID_MARIA) with the results. Do NOT message her to say you're starting — just do the work and report when done.`;
  }

  try {
    const deps = await loadCoreDeps();
    const cfg = loadOpenClawConfig();

    const storePath = deps.resolveStorePath(cfg.session?.store, { agentId: AGENT_ID });
    const agentDir = deps.resolveAgentDir(cfg, AGENT_ID);
    const workspaceDir = deps.resolveAgentWorkspaceDir(cfg, AGENT_ID);
    await deps.ensureAgentWorkspace({ dir: workspaceDir });

    // Use a dedicated post-call session (separate from voice and Telegram)
    const sessionKey = "voice:post-call";
    const sessionStore = deps.loadSessionStore(storePath);
    let sessionEntry = sessionStore[sessionKey];

    if (!sessionEntry) {
      sessionEntry = { sessionId: crypto.randomUUID(), updatedAt: Date.now() };
      sessionStore[sessionKey] = sessionEntry;
      await deps.saveSessionStore(storePath, sessionStore);
    }

    const sessionId = sessionEntry.sessionId;
    const sessionFile = deps.resolveSessionFilePath(sessionId, sessionEntry, { agentId: AGENT_ID });

    const provider = "anthropic";
    const model = "claude-sonnet-4-6";
    const thinkLevel = deps.resolveThinkingDefault({ cfg, provider, model });

    const result = await deps.runEmbeddedPiAgent({
      sessionId,
      sessionKey,
      messageProvider: "system",
      sessionFile,
      workspaceDir,
      config: cfg,
      prompt,
      provider,
      model,
      thinkLevel,
      verboseLevel: "off",
      timeoutMs: 300000, // 5 min — Amazon browsing can take a while
      runId: `post-call:${Date.now()}`,
      lane: "post-call",
      agentDir,
    });

    const texts = (result.payloads || [])
      .filter((p) => p.text && !p.isError)
      .map((p) => p.text?.trim())
      .filter(Boolean);

    console.log(`[vapi-bridge] Post-call dispatch completed: ${texts.length} response(s)`);

    // After Elvis handles his tasks, delegate Gargunk tasks through the group chat
    if (gargunkDelegation) {
      await sendGargunkDelegation(gargunkDelegation);
    }
  } catch (err) {
    console.error(`[vapi-bridge] Post-call dispatch failed:`, err.message);
  }
}

// ── Gargunk Delegation via Gateway WebSocket RPC ─────────────────────
// Sends a delegation message to Gargunk's real Anna DM session via the
// gateway's chat.send RPC. This triggers Gargunk's full brain in a
// gateway-backed session with proper Telegram delivery — Gargunk
// processes the task and responds to Anna via @GargunkBot.
//
// Also posts to the family group chat (visual — Elvis publicly tagging
// Gargunk), but Telegram doesn't forward bot messages to other bots'
// webhooks, so the group chat message is cosmetic only.
const ELVIS_BOT_TOKEN = "YOUR_ELVIS_BOT_TOKEN";
const GROUP_CHAT_ID = "TELEGRAM_GROUP_CHAT_ID";
const GATEWAY_WS_URL = "ws://127.0.0.1:18789";
const GATEWAY_TOKEN = "YOUR_GATEWAY_TOKEN";
const GARGUNK_ANNA_SESSION = "agent:gargunk:telegram:direct:TELEGRAM_CHAT_ID_ANNA";
const DEVICE_IDENTITY_PATH = path.join(OPENCLAW_HOME, "identity", "device.json");
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

async function extractGargunkTask(transcript) {
  if (!ANTHROPIC_API_KEY || !transcript.length) return null;
  try {
    const transcriptText = transcript
      .map((m) => `${m.role === "user" ? "Maria" : "Elvis"}: ${m.content}`)
      .join("\n");
    const resp = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 200,
        system: `Extract any task from this voice call transcript that should be delegated to Gargunk (Anna's AI agent). Gargunk handles anything involving Anna — school, summer programs, check-ins, nudges. Write the task as a direct instruction to Gargunk, framed as what to SAY TO ANNA (not about Anna in third person). Example: "Ask Anna if she's looked at the summer programs you sent her and if she has any favorites." If there is no Gargunk task, respond with exactly "NONE".`,
        messages: [{ role: "user", content: transcriptText }],
      }),
    });
    if (!resp.ok) return null;
    const data = await resp.json();
    const text = data.content?.[0]?.text?.trim();
    if (!text || text === "NONE") return null;
    return text;
  } catch {
    return null;
  }
}

async function sendGargunkDelegation(taskDescription) {
  // 1. Post to group chat (cosmetic — Elvis publicly delegates)
  try {
    const groupMsg = `Yo Gargunk — Maria wants you to check in with Anna. ${taskDescription}`;
    const url = `https://api.telegram.org/bot${ELVIS_BOT_TOKEN}/sendMessage`;
    const resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: GROUP_CHAT_ID, text: groupMsg }),
    });
    if (resp.ok) {
      console.log(`[vapi-bridge] Group chat delegation posted: "${groupMsg}"`);
    } else {
      console.error(`[vapi-bridge] Group chat post failed: ${resp.status}`);
    }
  } catch (err) {
    console.error(`[vapi-bridge] Group chat post error:`, err.message);
  }

  // 2. Trigger Gargunk's brain via gateway WebSocket RPC (the real delegation)
  try {
    await sendToGargunkViaGateway(taskDescription);
  } catch (err) {
    console.error(`[vapi-bridge] Gateway delegation failed:`, err.message);
  }
}

/**
 * Connects to the OpenClaw gateway WebSocket RPC and sends a chat.send
 * message to Gargunk's Anna DM session. Uses device identity + token
 * auth to get operator.write scope. The gateway processes this in a
 * real session with Telegram delivery context — Gargunk's response goes
 * to Anna via @GargunkBot.
 */
async function sendToGargunkViaGateway(taskDescription) {
  // Load device identity for signing
  let deviceIdentity;
  try {
    deviceIdentity = JSON.parse(fs.readFileSync(DEVICE_IDENTITY_PATH, "utf8"));
  } catch (err) {
    throw new Error(`Cannot load device identity: ${err.message}`);
  }

  function base64UrlEncode(buf) {
    return buf.toString("base64").replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/g, "");
  }

  function derivePublicKeyRaw(pem) {
    const spki = crypto.createPublicKey(pem).export({ type: "spki", format: "der" });
    if (spki.length === ED25519_SPKI_PREFIX.length + 32 &&
        spki.subarray(0, ED25519_SPKI_PREFIX.length).equals(ED25519_SPKI_PREFIX)) {
      return spki.subarray(ED25519_SPKI_PREFIX.length);
    }
    return spki;
  }

  function signPayload(privPem, payload) {
    return base64UrlEncode(crypto.sign(null, Buffer.from(payload, "utf8"), crypto.createPrivateKey(privPem)));
  }

  // Use ws package from OpenClaw (native WebSocket has compatibility issues)
  const { WebSocket: WsWebSocket } = await import(
    pathToFileURL(path.join(OPENCLAW_ROOT, "node_modules", "ws", "wrapper.mjs")).href
  );

  return new Promise((resolve, reject) => {
    const ws = new WsWebSocket(GATEWAY_WS_URL);
    let reqId = 0;
    const nextId = () => String(++reqId);

    const timeout = setTimeout(() => {
      ws.close();
      reject(new Error("Gateway WebSocket timeout (30s)"));
    }, 30000);

    ws.on("open", () => {
      console.log("[vapi-bridge] Gateway WebSocket connected");
    });

    ws.on("message", (raw) => {
      try {
        const data = JSON.parse(raw.toString());

        // Step 1: Connect challenge — respond with device identity + token auth
        if (data.type === "event" && data.event === "connect.challenge") {
          const nonce = data.payload.nonce;
          const signedAtMs = Date.now();
          const role = "operator";
          const scopes = ["operator.admin", "operator.read", "operator.write"];
          const clientId = "cli";
          const clientMode = "cli";
          const platform = "darwin";

          // Build V3 device auth payload and sign it
          const payloadStr = [
            "v3", deviceIdentity.deviceId, clientId, clientMode, role,
            scopes.join(","), String(signedAtMs), GATEWAY_TOKEN, nonce, platform, ""
          ].join("|");
          const signature = signPayload(deviceIdentity.privateKeyPem, payloadStr);
          const publicKeyRaw = base64UrlEncode(derivePublicKeyRaw(deviceIdentity.publicKeyPem));

          ws.send(JSON.stringify({
            type: "req",
            method: "connect",
            id: nextId(),
            params: {
              minProtocol: 3, maxProtocol: 3,
              client: { id: clientId, displayName: "Vapi Bridge", mode: clientMode, version: "1.0", platform },
              role, scopes,
              auth: { token: GATEWAY_TOKEN },
              device: { id: deviceIdentity.deviceId, publicKey: publicKeyRaw, signature, signedAt: signedAtMs, nonce },
            },
          }));
          return;
        }

        // Step 2: After connect success, send chat.send to Gargunk
        if (data.type === "res" && data.id === "1") {
          if (!data.ok) {
            clearTimeout(timeout);
            ws.close();
            reject(new Error(`Gateway auth failed: ${JSON.stringify(data.error)}`));
            return;
          }
          console.log("[vapi-bridge] Gateway authenticated — sending delegation to Gargunk");

          const delegationMessage = `${taskDescription}\n\nAfter Anna responds, post a summary with key deadlines to the family group chat using the message tool (chat ID: TELEGRAM_GROUP_CHAT_ID).`;

          ws.send(JSON.stringify({
            type: "req",
            method: "chat.send",
            id: nextId(),
            params: {
              sessionKey: GARGUNK_ANNA_SESSION,
              message: delegationMessage,
              deliver: true,
              idempotencyKey: `gargunk-delegation-${Date.now()}`,
            },
          }));
          return;
        }

        // Step 3: chat.send response — done
        if (data.type === "res" && data.id === "2") {
          clearTimeout(timeout);
          if (data.ok) {
            console.log("[vapi-bridge] Gargunk delegation sent via gateway — Gargunk will message Anna");
            resolve(true);
          } else {
            console.error("[vapi-bridge] Gateway chat.send failed:", JSON.stringify(data.error));
            reject(new Error(`chat.send failed: ${JSON.stringify(data.error)}`));
          }
          setTimeout(() => ws.close(), 2000);
          return;
        }
      } catch (err) {
        console.error("[vapi-bridge] Gateway WebSocket parse error:", err.message);
      }
    });

    ws.on("error", (err) => {
      clearTimeout(timeout);
      console.error("[vapi-bridge] Gateway WebSocket error:", err.message || err);
      reject(new Error("Gateway WebSocket connection error"));
    });

    ws.on("close", () => {
      clearTimeout(timeout);
    });
  });
}

// ── Run OpenClaw Agent ──────────────────────────────────────────────
async function runAgent(userMessage, callId) {
  const deps = await loadCoreDeps();
  const cfg = loadOpenClawConfig();

  const storePath = deps.resolveStorePath(cfg.session?.store, { agentId: AGENT_ID });
  const agentDir = deps.resolveAgentDir(cfg, AGENT_ID);
  const workspaceDir = deps.resolveAgentWorkspaceDir(cfg, AGENT_ID);

  await deps.ensureAgentWorkspace({ dir: workspaceDir });

  // Use a persistent voice session keyed by "vapi"
  const sessionKey = "voice:vapi";
  const sessionStore = deps.loadSessionStore(storePath);
  let sessionEntry = sessionStore[sessionKey];

  if (!sessionEntry) {
    sessionEntry = {
      sessionId: crypto.randomUUID(),
      updatedAt: Date.now(),
    };
    sessionStore[sessionKey] = sessionEntry;
    await deps.saveSessionStore(storePath, sessionStore);
  }

  const sessionId = sessionEntry.sessionId;
  const sessionFile = deps.resolveSessionFilePath(sessionId, sessionEntry, {
    agentId: AGENT_ID,
  });

  // Model config
  const provider = "anthropic";
  const model = "claude-sonnet-4-6";
  const thinkLevel = deps.resolveThinkingDefault({ cfg, provider, model });

  const extraSystemPrompt = buildVoiceSystemPrompt();
  const timeoutMs = 60000; // 60s for tool-heavy responses
  const runId = `vapi:${callId || "unknown"}:${Date.now()}`;

  const result = await deps.runEmbeddedPiAgent({
    sessionId,
    sessionKey,
    messageProvider: "voice",
    sessionFile,
    workspaceDir,
    config: cfg,
    prompt: userMessage,
    provider,
    model,
    thinkLevel,
    verboseLevel: "off",
    timeoutMs,
    runId,
    lane: "voice",
    extraSystemPrompt,
    agentDir,
  });

  // Extract text from payloads
  const texts = (result.payloads || [])
    .filter((p) => p.text && !p.isError)
    .map((p) => p.text?.trim())
    .filter(Boolean);

  return texts.join(" ") || null;
}

// ── SSE Helpers ─────────────────────────────────────────────────────
function sseChunk(content, id) {
  const chunk = {
    id: id || `chatcmpl-${crypto.randomUUID()}`,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    choices: [
      {
        index: 0,
        delta: { content },
        finish_reason: null,
      },
    ],
  };
  return `data: ${JSON.stringify(chunk)}\n\n`;
}

function sseStop(id) {
  const chunk = {
    id: id || `chatcmpl-${crypto.randomUUID()}`,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    choices: [
      {
        index: 0,
        delta: {},
        finish_reason: "stop",
      },
    ],
  };
  return `data: ${JSON.stringify(chunk)}\n\n`;
}

// ── Extract user message from Vapi's OpenAI messages ────────────────
function extractUserMessage(messages) {
  if (!Array.isArray(messages)) return null;
  // Get the last user message
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user" && messages[i].content) {
      return messages[i].content;
    }
  }
  return null;
}

// ── Process a single (deduplicated) request ─────────────────────────
async function handleRequest(userMessage, conversationMessages, callId, res) {
  const completionId = `chatcmpl-${crypto.randomUUID()}`;

  try {
    // Send initial role chunk
    const roleChunk = {
      id: completionId,
      object: "chat.completion.chunk",
      created: Math.floor(Date.now() / 1000),
      choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }],
    };
    res.write(`data: ${JSON.stringify(roleChunk)}\n\n`);

    // Fast mode: route ALL messages through fast path (no tools, 1-2s responses)
    // Transcript is accumulated and passed to post-call dispatch for execution.
    const useFastPath = FAST_MODE || isSimpleMessage(userMessage);

    if (useFastPath) {
      console.log(`[vapi-bridge] Fast path${FAST_MODE ? " (fast)" : ""} for call ${callId}: "${userMessage}"`);
      const fastText = await runFastPath(userMessage, conversationMessages, res, completionId);

      if (fastText) {
        // Accumulate transcript in fast mode
        if (FAST_MODE) {
          callTranscript.push({ role: "user", content: userMessage });
          callTranscript.push({ role: "assistant", content: fastText });
        }

        res.write(sseStop(completionId));
        res.write("data: [DONE]\n\n");
        res.end();
        console.log(`[vapi-bridge] Fast path complete for call ${callId}`);

        // Detect goodbye — trigger post-call task dispatch
        const GOODBYE_PATTERN = /\b(bye|goodbye|later|see you|talk soon|gotta go|call you back)\b/i;
        if (GOODBYE_PATTERN.test(userMessage)) {
          const vapiCallId = callId.split(":")[0] || callId;
          if (!dispatchedCalls.has(vapiCallId)) {
            dispatchedCalls.add(vapiCallId);
            // Delay 5s to let the call fully end, then dispatch
            setTimeout(() => {
              if (SKIP_DISPATCH) {
                console.log(`[vapi-bridge] Goodbye detected — dispatch SKIPPED (SKIP_DISPATCH=true)`);
                return;
              }
              console.log(`[vapi-bridge] Goodbye detected — dispatching post-call tasks`);
              dispatchPostCallTasks().catch((err) =>
                console.error(`[vapi-bridge] Post-call dispatch error:`, err.message)
              );
              // Clean up after 60s
              setTimeout(() => dispatchedCalls.delete(vapiCallId), 60000);
            }, 5000);
          }
        }
        return;
      }
      console.log(`[vapi-bridge] Fast path failed, falling back to agent for call ${callId}`);
    }

    // Full agent path with tiered fillers
    let fillersSent = 0;
    let agentDone = false;
    const fillerTimers = [];

    const agentPromise = runAgent(userMessage, callId).then((text) => {
      agentDone = true;
      return text;
    });

    // Tier 1 filler at 2.5s — canned, instant
    fillerTimers.push(setTimeout(() => {
      if (agentDone) return;
      const filler = CANNED_FILLERS_TIER1[Math.floor(Math.random() * CANNED_FILLERS_TIER1.length)];
      res.write(sseChunk(filler + " ", completionId));
      fillersSent++;
      console.log(`[vapi-bridge] Tier 1 filler for call ${callId}: "${filler}"`);
    }, 2500));

    // Tier 2 filler at 5s — canned, more personality
    fillerTimers.push(setTimeout(() => {
      if (agentDone) return;
      const filler = CANNED_FILLERS_TIER2[Math.floor(Math.random() * CANNED_FILLERS_TIER2.length)];
      res.write(sseChunk(filler + " ", completionId));
      fillersSent++;
      console.log(`[vapi-bridge] Tier 2 filler for call ${callId}: "${filler}"`);
    }, 5000));

    // Tier 3 filler at 8s — Haiku-generated small talk
    fillerTimers.push(setTimeout(async () => {
      if (agentDone) return;
      const filler = await generateLiveFiller(userMessage);
      if (!agentDone) {
        res.write(sseChunk(filler + " ", completionId));
        fillersSent++;
        console.log(`[vapi-bridge] Tier 3 live filler for call ${callId}: "${filler}"`);
      }
    }, 8000));

    const responseText = await agentPromise;
    fillerTimers.forEach(clearTimeout);

    if (responseText) {
      if (fillersSent > 0) {
        res.write(sseChunk("Okay, ", completionId));
      }
      const words = responseText.split(/(\s+)/);
      for (const word of words) {
        if (word) {
          res.write(sseChunk(word, completionId));
        }
      }
    } else if (fillersSent === 0) {
      res.write(sseChunk("Sorry, I couldn't process that. Try again.", completionId));
    }

    res.write(sseStop(completionId));
    res.write("data: [DONE]\n\n");
    res.end();

    console.log(`[vapi-bridge] Response sent for call ${callId} (fillers=${fillersSent}): "${responseText?.slice(0, 100)}..."`);
  } catch (err) {
    console.error(`[vapi-bridge] Agent error:`, err);
    try {
      res.write(sseChunk("Sorry, something went wrong on my end. Try again in a moment.", completionId));
      res.write(sseStop(completionId));
      res.write("data: [DONE]\n\n");
    } catch { /* ignore */ }
    res.end();
  }
}

// ── HTTP Server ─────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  // Health check
  if (req.method === "GET" && (req.url === "/" || req.url === "/health")) {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok", agent: "Elvis", bridge: "vapi-option-b" }));
    return;
  }

  // Only accept POST to /chat/completions (Vapi appends this to base URL)
  if (req.method !== "POST" || !req.url?.endsWith("/chat/completions")) {
    res.writeHead(404);
    res.end("Not Found");
    return;
  }

  // Auth check
  const authHeader = req.headers.authorization || "";
  const token = authHeader.replace(/^Bearer\s+/i, "");
  if (token !== AUTH_TOKEN) {
    console.warn(`[vapi-bridge] Auth failed: ${authHeader?.slice(0, 20)}...`);
    res.writeHead(401);
    res.end("Unauthorized");
    return;
  }

  // Read body
  let body = "";
  try {
    body = await new Promise((resolve, reject) => {
      const chunks = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
      req.on("error", reject);
      setTimeout(() => reject(new Error("Body read timeout")), 10000);
    });
  } catch (err) {
    res.writeHead(400);
    res.end("Bad Request");
    return;
  }

  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch {
    res.writeHead(400);
    res.end("Invalid JSON");
    return;
  }

  const userMessage = extractUserMessage(parsed.messages);
  if (!userMessage) {
    res.writeHead(400);
    res.end("No user message found");
    return;
  }

  const callId = parsed.call?.id || crypto.randomUUID();
  console.log(`[vapi-bridge] Request from call ${callId}: "${userMessage.slice(0, 80)}${userMessage.length > 80 ? "..." : ""}"`);

  // Reset idle timer on every incoming message
  resetIdleTimer();

  // ── Deduplication ──────────────────────────────────────────────────
  // Vapi sends progressive STT transcriptions as separate requests, each
  // with a DIFFERENT call.id. We use content-based dedup: if a new message
  // starts with (or is a superset of) the pending message, it's the same
  // utterance being progressively transcribed. We debounce and only process
  // the final (longest) version.
  //
  // Short simple messages skip dedup — they're instant and don't get progressive transcription.
  // In fast mode, longer messages still go through dedup even though they'll hit fast path later.
  if (isSimpleMessage(userMessage)) {
    // Fast path — no dedup, respond immediately
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    await handleRequest(userMessage, parsed.messages, callId, res);
    return;
  }

  // Drop duplicates of in-flight requests (already being processed by agent)
  if (inFlightMessage && isSameUtterance(userMessage, inFlightMessage)) {
    console.log(`[vapi-bridge] Dedup: dropping duplicate of in-flight message (${userMessage.length} chars)`);
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    res.write("data: [DONE]\n\n");
    res.end();
    return;
  }

  // Drop duplicates of recently completed responses (grace period catches late stragglers)
  if (recentlyCompletedMessage && isSameUtterance(userMessage, recentlyCompletedMessage)) {
    console.log(`[vapi-bridge] Dedup: dropping late duplicate of completed message (${userMessage.length} chars)`);
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    res.write("data: [DONE]\n\n");
    res.end();
    return;
  }

  // Content-based dedup: check if this message is the same utterance as a pending one.
  const isSupersetOrSame = pendingRequest && isSameUtterance(userMessage, pendingRequest.message);

  if (pendingRequest && isSupersetOrSame) {
    // Cancel the old timer and close the old response
    clearTimeout(pendingRequest.timer);
    try {
      pendingRequest.res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });
      pendingRequest.res.write("data: [DONE]\n\n");
      pendingRequest.res.end();
    } catch { /* old response may already be closed */ }
    console.log(`[vapi-bridge] Dedup: superseded (${pendingRequest.message.length} -> ${userMessage.length} chars)`);
  } else if (pendingRequest) {
    // Different utterance entirely — let the old one settle immediately
    clearTimeout(pendingRequest.timer);
    const old = pendingRequest;
    pendingRequest = null;
    old.res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    // Don't await — fire and forget so it doesn't block the new request
    handleRequest(old.message, old.messages, old.callId, old.res).catch(
      (err) => console.error("[vapi-bridge] Dedup flush error:", err)
    );
  }

  // Use the longer version
  const finalMessage = (pendingRequest && pendingRequest.message.length > userMessage.length)
    ? pendingRequest.message : userMessage;
  const finalMessages = (pendingRequest && pendingRequest.message.length > userMessage.length)
    ? pendingRequest.messages : parsed.messages;

  // Store this request and wait for the settle window
  const entry = {
    message: finalMessage,
    messages: finalMessages,
    callId,
    res,
    timer: null,
  };

  // Dynamic settle window: longer messages = user probably still talking = wait longer
  const dynamicSettleMs = Math.min(DEDUP_SETTLE_MS + Math.floor(finalMessage.length / 50) * 400, 3000);

  entry.timer = setTimeout(async () => {
    pendingRequest = null;
    console.log(`[vapi-bridge] Dedup: settled on final message (${entry.message.length} chars, settle=${dynamicSettleMs}ms)`);

    // Now process the final version
    inFlightMessage = entry.message;
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    await handleRequest(entry.message, entry.messages, entry.callId, res);

    // Grace period: keep message around to catch late duplicates
    inFlightMessage = null;
    recentlyCompletedMessage = entry.message;
    if (recentlyCompletedTimer) clearTimeout(recentlyCompletedTimer);
    recentlyCompletedTimer = setTimeout(() => {
      recentlyCompletedMessage = null;
      recentlyCompletedTimer = null;
    }, DEDUP_GRACE_MS);
  }, dynamicSettleMs);

  pendingRequest = entry;
});

server.listen(PORT, BIND, () => {
  console.log(`[vapi-bridge] Elvis Option B bridge listening on http://${BIND}:${PORT}`);
  console.log(`[vapi-bridge] Vapi base URL: https://YOUR_TAILSCALE_HOSTNAME/vapi`);
  console.log(`[vapi-bridge] Auth token: ${AUTH_TOKEN}`);
});

// Graceful shutdown
process.on("SIGTERM", () => {
  console.log("[vapi-bridge] Shutting down...");
  server.close(() => process.exit(0));
});
process.on("SIGINT", () => {
  console.log("[vapi-bridge] Shutting down...");
  server.close(() => process.exit(0));
});

// Crash protection — don't let Playwright or other errors kill the bridge
process.on("uncaughtException", (err) => {
  console.error("[vapi-bridge] Uncaught exception (suppressed):", err.message);
});
process.on("unhandledRejection", (err) => {
  console.error("[vapi-bridge] Unhandled rejection (suppressed):", err?.message || err);
});
