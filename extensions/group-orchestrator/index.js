/**
 * Group Chat Orchestrator Plugin
 *
 * Problem: When a human posts in the family Telegram group, all 3 agents
 * receive the message independently, process simultaneously, and respond
 * ~10s later with near-identical messages. Agents can't see each other's
 * responses (Telegram doesn't forward bot messages to other bots' webhooks).
 *
 * Solution: Cancel non-primary agents' initial responses, then re-trigger
 * them sequentially with context about what was already said. Each agent
 * speaks as themselves, sees the full thread, and can choose to add
 * something or stay silent.
 *
 * Flow:
 *   1. Human posts in group chat → all 3 agents start processing
 *   2. Plugin determines PRIMARY responder (by name mention or default Elvis)
 *   3. message_sending hook: PRIMARY's response goes through; others cancelled
 *   4. message_sent hook: re-triggers non-primary agents via gateway chat.send
 *      with injected context of what's been said so far
 *   5. Each follow-up agent responds or sends [SKIP] if nothing to add
 *   6. [SKIP] responses are cancelled by message_sending hook
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import crypto from "node:crypto";
import { pathToFileURL } from "node:url";

// ── Config ──────────────────────────────────────────────────────────────────

const GROUP_CHAT_ID = process.env.OPENCLAW_GROUP_CHAT_ID || "YOUR_GROUP_CHAT_ID";
const GATEWAY_WS_URL = "ws://127.0.0.1:18789";
const OPENCLAW_HOME = join(homedir(), ".openclaw");
const OPENCLAW_ROOT = "/opt/homebrew/lib/node_modules/openclaw";
const DEVICE_IDENTITY_PATH = join(OPENCLAW_HOME, "identity", "device.json");
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

const GATEWAY_TOKEN = (() => {
  try {
    const cfg = JSON.parse(readFileSync(join(OPENCLAW_HOME, "openclaw.json"), "utf-8"));
    return cfg.gateway?.auth?.token || "";
  } catch { return ""; }
})();

// Agent → accountId mapping (for identifying who's sending in hooks)
const AGENT_ACCOUNTS = {
  main: "default",
  gargunk: "gargunk",
  sadie: "sadie",
};
const ACCOUNT_TO_AGENT = Object.fromEntries(
  Object.entries(AGENT_ACCOUNTS).map(([agent, acct]) => [acct, agent])
);

// Agent group session keys
const AGENT_SESSION_KEYS = {
  main: `agent:main:telegram:group:${GROUP_CHAT_ID}`,
  gargunk: `agent:gargunk:telegram:group:${GROUP_CHAT_ID}`,
  sadie: `agent:sadie:telegram:group:${GROUP_CHAT_ID}`,
};

// Agent display names (for context injection)
const AGENT_NAMES = {
  main: "Elvis",
  gargunk: "Gargunk",
  sadie: "Sadie",
};

// Priority order for non-primary agents (after primary responds)
const DEFAULT_FOLLOW_UP_ORDER = ["gargunk", "sadie", "main"];

// Name mention patterns for primary selection
const NAME_PATTERNS = {
  main: /\belvis\b/i,
  gargunk: /\bgargunk\b/i,
  sadie: /\bsadie\b/i,
};

// Topic patterns for primary selection when no name is mentioned
const TOPIC_PATTERNS = {
  gargunk: /\banna\b.*\b(school|homework|test|class|grade|chore|assignment|ap stats|english|history|math)\b/i,
  sadie: /\bjulia\b.*\b(college|ucsc|santa cruz|internship|job|dorm|major)\b/i,
};

// ── Orchestration State ─────────────────────────────────────────────────────

// In-memory state for active orchestration rounds
// Map<roundKey, RoundState>
const rounds = new Map();

// Round state structure:
// {
//   messageContent: string,         // The human's original message
//   senderName: string,             // Who sent it
//   timestamp: number,              // When received
//   primaryAgent: string,           // Agent ID of primary responder
//   responses: Map<agentId, string>,// Collected responses
//   phase: "waiting" | "followup" | "done",
//   followUpQueue: string[],        // Agents still to re-trigger
//   timeoutId: NodeJS.Timeout,      // Auto-cleanup timer
// }

const ROUND_TIMEOUT_MS = 60000; // Clean up rounds after 60s
const PRIMARY_TIMEOUT_MS = 30000; // If primary doesn't respond in 30s, move on

function makeRoundKey(messageContent, timestamp) {
  // Key by content hash + rough timestamp bucket (within 5s)
  const bucket = Math.floor(timestamp / 5000);
  const hash = crypto.createHash("md5").update(messageContent).digest("hex").slice(0, 8);
  return `${hash}-${bucket}`;
}

function cleanupRound(key) {
  const round = rounds.get(key);
  if (round?.timeoutId) clearTimeout(round.timeoutId);
  rounds.delete(key);
}

function selectPrimary(messageContent) {
  // 1. Explicit name mention
  for (const [agentId, pattern] of Object.entries(NAME_PATTERNS)) {
    if (pattern.test(messageContent)) return agentId;
  }
  // 2. Topic-based
  for (const [agentId, pattern] of Object.entries(TOPIC_PATTERNS)) {
    if (pattern.test(messageContent)) return agentId;
  }
  // 3. Default: Elvis
  return "main";
}

function getFollowUpOrder(primaryAgent) {
  return DEFAULT_FOLLOW_UP_ORDER.filter((a) => a !== primaryAgent);
}

// ── Gateway WebSocket RPC ───────────────────────────────────────────────────

function base64UrlEncode(buf) {
  return buf.toString("base64").replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/g, "");
}

function derivePublicKeyRaw(pem) {
  const spki = crypto.createPublicKey(pem).export({ type: "spki", format: "der" });
  if (
    spki.length === ED25519_SPKI_PREFIX.length + 32 &&
    spki.subarray(0, ED25519_SPKI_PREFIX.length).equals(ED25519_SPKI_PREFIX)
  ) {
    return spki.subarray(ED25519_SPKI_PREFIX.length);
  }
  return spki;
}

function signPayload(privPem, payload) {
  return base64UrlEncode(
    crypto.sign(null, Buffer.from(payload, "utf8"), crypto.createPrivateKey(privPem))
  );
}

/**
 * Send a message to an agent's group session via gateway chat.send RPC.
 * Returns true on success, throws on failure.
 */
async function gatewayChatSend(sessionKey, message) {
  let deviceIdentity;
  try {
    deviceIdentity = JSON.parse(readFileSync(DEVICE_IDENTITY_PATH, "utf8"));
  } catch (err) {
    throw new Error(`Cannot load device identity: ${err.message}`);
  }

  const { WebSocket: WsWebSocket } = await import(
    pathToFileURL(join(OPENCLAW_ROOT, "node_modules", "ws", "wrapper.mjs")).href
  );

  return new Promise((resolve, reject) => {
    const ws = new WsWebSocket(GATEWAY_WS_URL);
    let reqId = 0;
    const nextId = () => String(++reqId);

    const timeout = setTimeout(() => {
      ws.close();
      reject(new Error("Gateway WebSocket timeout (30s)"));
    }, 30000);

    ws.on("open", () => {});

    ws.on("message", (raw) => {
      try {
        const data = JSON.parse(raw.toString());

        // Step 1: Connect challenge — device identity + token auth
        if (data.type === "event" && data.event === "connect.challenge") {
          const nonce = data.payload.nonce;
          const signedAtMs = Date.now();
          const role = "operator";
          const scopes = ["operator.admin", "operator.read", "operator.write"];
          const clientId = "cli";
          const clientMode = "cli";
          const platform = "darwin";

          const payloadStr = [
            "v3", deviceIdentity.deviceId, clientId, clientMode, role,
            scopes.join(","), String(signedAtMs), GATEWAY_TOKEN, nonce, platform, "",
          ].join("|");
          const signature = signPayload(deviceIdentity.privateKeyPem, payloadStr);
          const publicKeyRaw = base64UrlEncode(derivePublicKeyRaw(deviceIdentity.publicKeyPem));

          ws.send(JSON.stringify({
            type: "req",
            method: "connect",
            id: nextId(),
            params: {
              minProtocol: 3, maxProtocol: 3,
              client: { id: clientId, displayName: "Group Orchestrator", mode: clientMode, version: "1.0", platform },
              role, scopes,
              auth: { token: GATEWAY_TOKEN },
              device: { id: deviceIdentity.deviceId, publicKey: publicKeyRaw, signature, signedAt: signedAtMs, nonce },
            },
          }));
          return;
        }

        // Step 2: Auth success → send chat.send
        if (data.type === "res" && data.id === "1") {
          if (!data.ok) {
            clearTimeout(timeout);
            ws.close();
            reject(new Error(`Gateway auth failed: ${JSON.stringify(data.error)}`));
            return;
          }

          ws.send(JSON.stringify({
            type: "req",
            method: "chat.send",
            id: nextId(),
            params: {
              sessionKey,
              message,
              deliver: true,
              idempotencyKey: `group-orch-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            },
          }));
          return;
        }

        // Step 3: chat.send response
        if (data.type === "res" && data.id === "2") {
          clearTimeout(timeout);
          if (data.ok) {
            resolve(true);
          } else {
            reject(new Error(`chat.send failed: ${JSON.stringify(data.error)}`));
          }
          setTimeout(() => ws.close(), 2000);
          return;
        }
      } catch (err) {
        // parse error, ignore
      }
    });

    ws.on("error", (err) => {
      clearTimeout(timeout);
      reject(new Error(`Gateway WebSocket error: ${err.message || err}`));
    });

    ws.on("close", () => {
      clearTimeout(timeout);
    });
  });
}

// ── Follow-up Dispatch ──────────────────────────────────────────────────────

/**
 * Re-trigger the next agent in the follow-up queue with context about
 * what's been said so far.
 */
async function dispatchNextFollowUp(roundKey) {
  const round = rounds.get(roundKey);
  if (!round || round.phase === "done") return;

  if (round.followUpQueue.length === 0) {
    round.phase = "done";
    cleanupRound(roundKey);
    return;
  }

  round.phase = "followup";
  const nextAgent = round.followUpQueue.shift();
  const sessionKey = AGENT_SESSION_KEYS[nextAgent];
  if (!sessionKey) {
    // Skip unknown agent, move to next
    await dispatchNextFollowUp(roundKey);
    return;
  }

  // Build context of what's been said
  let context = `[GROUP CHAT ORCHESTRATOR]\n\nA message was posted in the family group chat. Here's what's been said so far:\n\n`;
  context += `${round.senderName}: "${round.messageContent}"\n\n`;

  for (const [agentId, response] of round.responses) {
    context += `${AGENT_NAMES[agentId]}: "${response}"\n\n`;
  }

  context += `You are ${AGENT_NAMES[nextAgent]}. The above messages have already been posted in the group chat. `;
  context += `If you have something NEW and DIFFERENT to add — your own perspective, information only you have, or a direct response to something said — go ahead and respond naturally in the group chat. `;
  context += `If you have nothing meaningful to add (the topic doesn't concern you, or what you'd say has already been said), reply with exactly: [SKIP]`;

  try {
    await gatewayChatSend(sessionKey, context);
  } catch (err) {
    console.error(`[group-orchestrator] Failed to re-trigger ${nextAgent}:`, err.message);
    // Move on to the next agent
    await dispatchNextFollowUp(roundKey);
  }
}

// ── Plugin Registration ─────────────────────────────────────────────────────

export default function register(api) {

  // ── Hook: message_received ──────────────────────────────────────────────
  // Record inbound group messages and determine primary responder.
  // This hook is read-only (returns void).
  api.on(
    "message_received",
    (event, ctx) => {
      try {
        // Only intercept group messages for our target group
        if (!ctx?.isGroup && !ctx?.groupId) return;
        const groupId = String(ctx.groupId || "");
        if (groupId !== GROUP_CHAT_ID) return;

        const content = event?.content || "";
        const sender = event?.from || "Someone";
        const timestamp = event?.timestamp || Date.now();

        // Skip messages that look like orchestrator re-triggers
        if (content.startsWith("[GROUP CHAT ORCHESTRATOR]")) return;

        const roundKey = makeRoundKey(content, timestamp);

        // Only create the round once (first agent to receive it)
        if (!rounds.has(roundKey)) {
          const primaryAgent = selectPrimary(content);
          const followUpQueue = getFollowUpOrder(primaryAgent);

          rounds.set(roundKey, {
            messageContent: content,
            senderName: sender,
            timestamp,
            primaryAgent,
            responses: new Map(),
            phase: "waiting",
            followUpQueue,
            timeoutId: setTimeout(() => cleanupRound(roundKey), ROUND_TIMEOUT_MS),
          });

          console.log(
            `[group-orchestrator] New round ${roundKey}: primary=${AGENT_NAMES[primaryAgent]}, ` +
            `followUp=[${followUpQueue.map((a) => AGENT_NAMES[a]).join(", ")}]`
          );
        }
      } catch {
        // Don't break message processing
      }
    },
    { priority: 10 },
  );

  // ── Hook: message_sending ───────────────────────────────────────────────
  // Gate outbound responses: let primary through, cancel others.
  // Also cancel [SKIP] responses from follow-up agents.
  api.on(
    "message_sending",
    (event, ctx) => {
      try {
        const content = event?.content || "";

        // Cancel [SKIP] responses BEFORE group detection — never let this reach any channel
        if (content.trim() === "[SKIP]" || content.includes("[SKIP]")) {
          const agentId = ACCOUNT_TO_AGENT[ctx?.accountId] || "unknown";
          console.log(`[group-orchestrator] ${AGENT_NAMES[agentId] || agentId} skipped (nothing to add)`);

          // Find active round and dispatch next follow-up (message_sent won't fire for cancelled messages)
          for (const [key, round] of rounds) {
            if (round.phase === "followup") {
              setTimeout(() => dispatchNextFollowUp(key), 2000);
              break;
            }
          }

          return { cancel: true };
        }

        // Only intercept group messages for our target group
        if (!ctx?.isGroup && !ctx?.groupId) return;
        const groupId = String(ctx.groupId || ctx.conversationId || "");
        if (groupId !== GROUP_CHAT_ID) return;

        // Determine which agent is sending
        const agentId = ACCOUNT_TO_AGENT[ctx.accountId];
        if (!agentId) return; // Unknown agent, let through

        // Find the active round this response belongs to
        // Match by recency — find the most recent round in "waiting" or "followup" phase
        let matchedRoundKey = null;
        let matchedRound = null;
        for (const [key, round] of rounds) {
          if (round.phase === "waiting" || round.phase === "followup") {
            if (!matchedRound || round.timestamp > matchedRound.timestamp) {
              matchedRoundKey = key;
              matchedRound = round;
            }
          }
        }

        if (!matchedRound) return; // No active round, let through

        // If this is a follow-up agent responding (phase === "followup"), let it through
        // and record the response
        if (matchedRound.phase === "followup") {
          matchedRound.responses.set(agentId, content);
          console.log(`[group-orchestrator] ${AGENT_NAMES[agentId]} follow-up response recorded`);
          // Dispatch next follow-up after this one sends (handled in message_sent)
          return; // Let through
        }

        // Phase is "waiting" — determine if this agent is primary
        if (agentId === matchedRound.primaryAgent) {
          // Primary agent: let through, record response
          matchedRound.responses.set(agentId, content);
          console.log(`[group-orchestrator] ${AGENT_NAMES[agentId]} (primary) response recorded`);
          return; // Let through
        }

        // Non-primary agent during "waiting" phase: cancel
        console.log(
          `[group-orchestrator] Cancelling ${AGENT_NAMES[agentId]}'s initial response ` +
          `(waiting for primary ${AGENT_NAMES[matchedRound.primaryAgent]})`
        );
        return { cancel: true };

      } catch {
        // Don't break message delivery
      }
    },
    { priority: 10 },
  );

  // ── Hook: message_sent ──────────────────────────────────────────────────
  // After a message is sent, trigger the next follow-up if applicable.
  api.on(
    "message_sent",
    (event, ctx) => {
      try {
        if (!ctx?.isGroup && !ctx?.groupId) return;
        const groupId = String(ctx.groupId || ctx.conversationId || "");
        if (groupId !== GROUP_CHAT_ID) return;

        const agentId = ACCOUNT_TO_AGENT[ctx.accountId];
        if (!agentId) return;

        // Find the active round
        let matchedRoundKey = null;
        let matchedRound = null;
        for (const [key, round] of rounds) {
          if (round.phase === "waiting" || round.phase === "followup") {
            if (!matchedRound || round.timestamp > matchedRound.timestamp) {
              matchedRoundKey = key;
              matchedRound = round;
            }
          }
        }

        if (!matchedRound || !matchedRoundKey) return;

        // If primary just sent and we're still in "waiting", start follow-ups
        if (matchedRound.phase === "waiting" && agentId === matchedRound.primaryAgent) {
          console.log(
            `[group-orchestrator] Primary (${AGENT_NAMES[agentId]}) sent. ` +
            `Starting follow-ups: [${matchedRound.followUpQueue.map((a) => AGENT_NAMES[a]).join(", ")}]`
          );
          // Small delay to let the message appear in Telegram first
          setTimeout(() => dispatchNextFollowUp(matchedRoundKey), 2000);
          return;
        }

        // If a follow-up agent just sent, dispatch the next one
        if (matchedRound.phase === "followup") {
          console.log(`[group-orchestrator] ${AGENT_NAMES[agentId]} follow-up sent. Dispatching next.`);
          setTimeout(() => dispatchNextFollowUp(matchedRoundKey), 2000);
          return;
        }
      } catch {
        // Don't break
      }
    },
    { priority: 10 },
  );

  // ── Hook: before_prompt_build ───────────────────────────────────────────
  // For group chat sessions, inject awareness that orchestration is active.
  api.on(
    "before_prompt_build",
    (event, ctx) => {
      try {
        if (!ctx?.isGroup && !ctx?.groupId) return;
        const groupId = String(ctx.groupId || "");
        if (groupId !== GROUP_CHAT_ID) return;

        return {
          appendSystemContext: `\n\n<group-chat-orchestration>
You are in a multi-agent group chat with Elvis, Gargunk, and Sadie. A group chat orchestrator manages response flow so the conversation feels natural.

Rules:
- If the orchestrator re-triggers you with context about what other agents have already said, read it carefully. Only respond if you have something NEW to add — your own perspective, information only you know, or a direct follow-up.
- If you have nothing to add, respond with exactly: [SKIP]
- Never repeat what another agent just said. Build on it, disagree, or add your own angle.
- Keep group chat responses conversational and concise.
- You can address other agents by name — they will see your messages.
</group-chat-orchestration>`,
        };
      } catch {
        // skip
      }
    },
    { priority: 4 }, // Lower priority than coordination-injector (5) — runs after
  );

  // ── Primary timeout handler ──────────────────────────────────────────────
  // If primary doesn't respond within 30s, start follow-ups anyway.
  // Check every 5s for stale "waiting" rounds.
  setInterval(() => {
    const now = Date.now();
    for (const [key, round] of rounds) {
      if (round.phase === "waiting" && now - round.timestamp > PRIMARY_TIMEOUT_MS) {
        console.log(
          `[group-orchestrator] Primary ${AGENT_NAMES[round.primaryAgent]} timed out. ` +
          `Starting follow-ups.`
        );
        dispatchNextFollowUp(key);
      }
    }
  }, 5000);
}
