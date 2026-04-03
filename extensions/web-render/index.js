// Web Render Plugin — Playwright-based page fetcher for research agents
//
// Gives agents the ability to read JavaScript-heavy pages that plain HTTP
// fetch can't handle (Cloudflare challenges, SPAs, dynamically loaded content).
// Returns plain text only — no interaction, no form filling.
//
// Used by Scout (research agent) to read changelogs, documentation, competition
// entries, and community forums that require JS rendering.

const { chromium } = require("/opt/homebrew/lib/node_modules/openclaw/node_modules/playwright-core");

const MAX_CONTENT_BYTES = 50 * 1024; // 50KB text cap per page
const MAX_FETCHES_PER_RUN = 20; // rate limit per agent run
const PAGE_TIMEOUT_MS = 30000; // 30s page load timeout
const NETWORKIDLE_TIMEOUT_MS = 10000; // 10s after last network request

// Per-agent fetch counters (reset when agent run ends — approximated by TTL)
const fetchCounts = new Map();
const COUNTER_TTL_MS = 10 * 60 * 1000; // 10 min TTL for counters

function getFetchCount(agentId) {
  const entry = fetchCounts.get(agentId);
  if (!entry) return 0;
  if (Date.now() - entry.startedAt > COUNTER_TTL_MS) {
    fetchCounts.delete(agentId);
    return 0;
  }
  return entry.count;
}

function incrementFetchCount(agentId) {
  const entry = fetchCounts.get(agentId);
  if (!entry || Date.now() - entry.startedAt > COUNTER_TTL_MS) {
    fetchCounts.set(agentId, { count: 1, startedAt: Date.now() });
  } else {
    entry.count++;
  }
}

// Shared browser instance (lazy init, reused across calls)
let browserInstance = null;

async function getBrowser() {
  if (browserInstance && browserInstance.isConnected()) {
    return browserInstance;
  }
  browserInstance = await chromium.launch({
    executablePath:
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    headless: true,
    args: [
      "--disable-gpu",
      "--no-sandbox",
      "--disable-dev-shm-usage",
      "--disable-extensions",
      "--disable-background-networking",
    ],
  });
  return browserInstance;
}

async function renderPage(url) {
  const browser = await getBrowser();
  const context = await browser.newContext({
    userAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    viewport: { width: 1280, height: 720 },
    javaScriptEnabled: true,
  });

  const page = await context.newPage();

  try {
    // Block unnecessary resources to speed up loading
    await page.route("**/*", (route) => {
      const type = route.request().resourceType();
      if (["image", "media", "font", "stylesheet"].includes(type)) {
        return route.abort();
      }
      return route.continue();
    });

    await page.goto(url, {
      waitUntil: "domcontentloaded",
      timeout: PAGE_TIMEOUT_MS,
    });

    // Wait briefly for JS to render content
    await page
      .waitForLoadState("networkidle", { timeout: NETWORKIDLE_TIMEOUT_MS })
      .catch(() => {});

    // Extract text content, stripping scripts/styles/nav/footer noise
    const text = await page.evaluate(() => {
      const removeSelectors = [
        "script", "style", "noscript", "svg", "nav", "footer",
        "header", "iframe", '[role="navigation"]', '[role="banner"]',
        '[role="contentinfo"]', ".cookie-banner", ".cookie-consent",
        "#cookie-notice", ".ad", ".ads", ".advertisement",
        '[class*="popup"]', '[class*="modal"]', '[class*="overlay"]',
      ];

      for (const sel of removeSelectors) {
        try {
          document.querySelectorAll(sel).forEach((el) => el.remove());
        } catch (e) {}
      }

      const main =
        document.querySelector("main") ||
        document.querySelector("article") ||
        document.querySelector('[role="main"]') ||
        document.querySelector(".content") ||
        document.querySelector("#content") ||
        document.body;

      if (!main) return "";
      return main.innerText || "";
    });

    // Clean up whitespace
    const cleaned = text
      .replace(/\n{3,}/g, "\n\n")
      .replace(/[ \t]+\n/g, "\n")
      .trim();

    if (cleaned.length > MAX_CONTENT_BYTES) {
      return {
        text: cleaned.slice(0, MAX_CONTENT_BYTES),
        truncated: true,
        fullLength: cleaned.length,
      };
    }

    return { text: cleaned, truncated: false, fullLength: cleaned.length };
  } finally {
    await context.close();
  }
}

module.exports = function (api) {
  api.registerTool((ctx) => ({
    name: "web_render",
    label: "Web Render",
    description:
      "Fetches a URL using a real browser (Playwright), renders JavaScript, bypasses Cloudflare challenges, and returns the page's text content. Use this instead of web_fetch when a page returns empty content, a Cloudflare challenge, or requires JavaScript to render. Returns plain text only — no HTML, no interaction, no form filling. Max 50KB of text per page, max 20 fetches per research session.",
    parameters: {
      type: "object",
      properties: {
        url: {
          type: "string",
          description: "The URL to fetch and render",
        },
      },
      required: ["url"],
    },
    async execute(toolCallId, params) {
      const agentId = ctx.agentId || "unknown";
      const { url } = params;

      // Validate URL
      let parsed;
      try {
        parsed = new URL(url);
      } catch (e) {
        return {
          content: [
            { type: "text", text: JSON.stringify({ error: "Invalid URL", url }) },
          ],
        };
      }

      if (!["http:", "https:"].includes(parsed.protocol)) {
        return {
          content: [
            { type: "text", text: JSON.stringify({ error: "Only http/https URLs are supported", url }) },
          ],
        };
      }

      // Rate limit check
      const count = getFetchCount(agentId);
      if (count >= MAX_FETCHES_PER_RUN) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                error: `Rate limit reached (${MAX_FETCHES_PER_RUN} fetches per session). Wait before fetching more pages.`,
                fetchCount: count,
              }),
            },
          ],
        };
      }

      try {
        incrementFetchCount(agentId);
        const result = await renderPage(url);

        if (!result.text || result.text.length === 0) {
          return {
            content: [
              { type: "text", text: JSON.stringify({ warning: "Page rendered but no text content extracted", url }) },
            ],
          };
        }

        const response = {
          url,
          contentLength: result.fullLength,
          truncated: result.truncated,
          fetchesUsed: getFetchCount(agentId),
          fetchesRemaining: MAX_FETCHES_PER_RUN - getFetchCount(agentId),
        };

        if (result.truncated) {
          response.note = `Content truncated from ${result.fullLength} to ${MAX_CONTENT_BYTES} characters.`;
        }

        return {
          content: [
            { type: "text", text: `${JSON.stringify(response)}\n\n---PAGE CONTENT---\n${result.text}` },
          ],
        };
      } catch (e) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                error: `Failed to render page: ${e.message}`,
                url,
                fetchesUsed: getFetchCount(agentId),
              }),
            },
          ],
        };
      }
    },
  }));
};
