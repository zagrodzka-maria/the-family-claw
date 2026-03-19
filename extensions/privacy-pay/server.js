/**
 * Privacy Pay — Local API proxy for Privacy.com
 *
 * Sits between Elvis and the Privacy.com API.
 * API key stays server-side, never exposed to the LLM.
 * Elvis uses web_fetch to hit localhost endpoints.
 *
 * Port: 3336 (localhost only)
 */

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { homedir } from "node:os";

const PORT = 3336;
const BIND = "127.0.0.1";
const PRIVACY_BASE = "https://api.privacy.com/v1";

// Load API key from config file
const CONFIG_PATH = path.join(homedir(), ".openclaw", "extensions", "privacy-pay", "config.json");

function loadApiKey() {
  try {
    const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
    return cfg.apiKey;
  } catch {
    console.error("[privacy-pay] No config.json found. Create it with: {\"apiKey\": \"your-key\"}");
    process.exit(1);
  }
}

const API_KEY = loadApiKey();

// Simple auth token for local requests (prevents random localhost access)
const LOCAL_TOKEN = process.env.PRIVACY_PAY_TOKEN || "YOUR_LOCAL_AUTH_TOKEN";

// ── Privacy.com API client ──────────────────────────────────────────

async function privacyRequest(method, endpoint, body) {
  const url = `${PRIVACY_BASE}${endpoint}`;
  const opts = {
    method,
    headers: {
      "Authorization": `api-key ${API_KEY}`,
      "Content-Type": "application/json",
    },
  };
  if (body) opts.body = JSON.stringify(body);

  const res = await fetch(url, opts);
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { raw: text }; }

  if (!res.ok) {
    return { error: true, status: res.status, message: data.message || text };
  }
  return data;
}

// ── Request handler ─────────────────────────────────────────────────

async function handleRequest(req, res) {
  // CORS and auth
  const authHeader = req.headers.authorization || "";
  const token = authHeader.replace(/^Bearer\s+/i, "");

  // Health check (no auth needed)
  if (req.method === "GET" && req.url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok", service: "privacy-pay" }));
    return;
  }

  // Auth check for all other endpoints
  if (token !== LOCAL_TOKEN) {
    res.writeHead(401, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Unauthorized" }));
    return;
  }

  const url = new URL(req.url, `http://${BIND}:${PORT}`);
  const pathname = url.pathname;

  try {
    // ── LIST CARDS ────────────────────────────────────────────
    if (req.method === "GET" && pathname === "/cards") {
      const page = url.searchParams.get("page") || "1";
      const pageSize = url.searchParams.get("page_size") || "50";
      const result = await privacyRequest("GET", `/cards?page=${page}&page_size=${pageSize}`);

      // Sanitize: strip full PAN, only show last_four
      if (result.data) {
        result.data = result.data.map(card => ({
          token: card.token,
          memo: card.memo,
          last_four: card.last_four,
          state: card.state,
          type: card.type,
          spend_limit: card.spend_limit,
          spend_limit_duration: card.spend_limit_duration,
          created: card.created,
        }));
      }

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(result));
      return;
    }

    // ── CREATE CARD — DISABLED ─────────────────────────────────
    // Card creation is restricted to the human operator only.
    // Agents cannot create cards. They can only manage existing ones.
    if (req.method === "POST" && pathname === "/cards") {
      res.writeHead(403, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        error: "Card creation is disabled. Only the human operator can create new cards.",
      }));
      return;
    }

    // ── GET CARD DETAILS ──────────────────────────────────────
    if (req.method === "GET" && pathname.startsWith("/cards/") && pathname.split("/").length === 3) {
      const cardToken = pathname.split("/")[2];
      const result = await privacyRequest("GET", `/cards/${cardToken}`);

      // Strip sensitive fields
      if (result.pan) {
        result.pan_last_four = result.pan.slice(-4);
        delete result.pan;
        delete result.cvv;
      }

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(result));
      return;
    }

    // ── UPDATE CARD (pause/unpause/close, update limit) ──────
    if (req.method === "PATCH" && pathname.startsWith("/cards/")) {
      const cardToken = pathname.split("/")[2];
      const body = await readBody(req);
      const parsed = JSON.parse(body);

      // Enforce: can pause, unpause, or close. Cannot reopen a closed card.
      const allowedStates = ["OPEN", "PAUSED", "CLOSED"];
      if (parsed.state && !allowedStates.includes(parsed.state)) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: `State must be one of: ${allowedStates.join(", ")}` }));
        return;
      }

      const result = await privacyRequest("PATCH", `/cards/${cardToken}`, parsed);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(result));
      return;
    }

    // ── LIST TRANSACTIONS ─────────────────────────────────────
    if (req.method === "GET" && pathname === "/transactions") {
      const page = url.searchParams.get("page") || "1";
      const pageSize = url.searchParams.get("page_size") || "20";
      const cardToken = url.searchParams.get("card_token") || "";
      let endpoint = `/transactions?page=${page}&page_size=${pageSize}`;
      if (cardToken) endpoint += `&card_token=${cardToken}`;

      const result = await privacyRequest("GET", endpoint);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(result));
      return;
    }

    // ── 404 ───────────────────────────────────────────────────
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Not found", endpoints: [
      "GET /health",
      "GET /cards",
      "POST /cards",
      "GET /cards/:token",
      "PATCH /cards/:token",
      "GET /transactions",
    ]}));

  } catch (err) {
    console.error("[privacy-pay] Error:", err);
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: err.message }));
  }
}

// ── Helpers ──────────────────────────────────────────────────────────

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", c => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
    setTimeout(() => reject(new Error("Body read timeout")), 10000);
  });
}

// ── Server ───────────────────────────────────────────────────────────

const server = http.createServer(handleRequest);
server.listen(PORT, BIND, () => {
  console.log(`[privacy-pay] Listening on http://${BIND}:${PORT}`);
  console.log(`[privacy-pay] Endpoints: /health, /cards, /cards/:token, /transactions`);
});

process.on("SIGTERM", () => { server.close(() => process.exit(0)); });
process.on("SIGINT", () => { server.close(() => process.exit(0)); });
