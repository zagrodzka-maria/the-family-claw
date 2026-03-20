# Security Considerations

This document covers the threat model for running AI agents with real credentials and real-world access, and how The Family Claw mitigates each risk. Written for people who will ask "but what if the agent just decides to..."

## The Overarching Strategy: Separate Worlds

Before getting into specific risks and mitigations, the single most important security decision is architectural: the agents live in a completely separate environment from the family's personal digital life.

The agents run on a dedicated Mac Mini. They have their own email accounts (created for them), their own payment cards (merchant-locked, with spending limits), their own browser profiles, and their own phone numbers. They do not have access to Maria's bank accounts, medical portals, work email, tax documents, personal browser sessions, or any other family account. There is no path from the agents' environment to those systems — not a locked path, not a credentialed path, simply no path at all.

This means that even in a worst-case scenario — a successful prompt injection that takes full control of an agent — the blast radius is limited to the agent's own sandboxed world: a prepaid card with a $200/month cap, a Gmail account created for the agent, and a Telegram bot. The family's actual finances, health records, and personal accounts are untouched.

Everything below is defense-in-depth layered on top of that separation.

## The Threat Model

This system gives LLM-powered agents access to: payment cards, email accounts, browser sessions with saved logins, Telegram messaging, phone calls, and file system read/write on the host machine. The agents run 24/7 on a dedicated home server. The core risks are:

1. **Prompt injection** — A malicious input (email, web page, Telegram message) tricks the agent into performing unintended actions. This is the most realistic attack vector for LLM-based agents today.
2. **Credential exposure** — The agent leaks API keys, card numbers, or passwords in a message, log, or tool output.
3. **Unauthorized spending** — The agent places orders or makes payments outside its approved scope.
4. **Lateral movement** — An attacker who compromises one agent's session pivots to the other agent or to the host system.
5. **Data leakage between family members** — One family member's private conversations become visible to another through shared context or agent-to-agent communication.
6. **Network exposure** — The gateway or bridge services are accessible from the public internet.

## Mitigations by Layer

### Network

| Risk | Mitigation |
|------|-----------|
| Gateway exposed to internet | Binds to 127.0.0.1 only. No port forwarding. Remote access exclusively via Tailscale SSH tunnel (WireGuard, authenticated by device identity). |
| Voice webhook exposed | Tailscale Funnel proxies the Vapi webhook path. Only Vapi's servers reach it — not arbitrary internet traffic. |
| Service discovery | macOS firewall enabled with stealth mode. The machine does not respond to pings or port scans from the local network. |

### Authentication & Authorization

| Risk | Mitigation |
|------|-----------|
| Unauthorized gateway access | Bearer token required on every request. Token is a 48-character hex string, not derived from any public value. |
| Privilege escalation via WebSocket | The gateway's WebSocket RPC requires Ed25519 device identity signatures (V3 format) for sensitive operations like `chat.send`. Token alone is insufficient — scopes are cleared without device identity. |
| Vapi bridge spoofing | The bridge authenticates with a dedicated credential (`elvis-vapi-bridge-2026`) separate from the gateway token. |

### Payments

This is the layer people worry about most, and reasonably so.

| Risk | Mitigation |
|------|-----------|
| Agent sees full card numbers | The privacy-pay proxy strips PAN and CVV from every API response. The LLM receives card tokens (UUIDs) and last-four digits only. |
| Agent creates new cards | Card creation endpoint returns 403 at the proxy level. Only the human can create cards, via a direct Claude Code session. |
| Agent overspends | Cards have monthly dollar limits set at creation. The Amazon card has a $200/month ceiling. |
| Agent uses card at wrong merchant | Cards are merchant-locked. The Amazon card will decline at any merchant that isn't Amazon. |
| Agent activates paused card without approval | Covered by the yellow tier in the action framework — agent must ask the human before activating a card. In practice, the Amazon card stays active because it's used regularly. |
| Agent decides to buy something expensive | Red tier: any purchase over $50 requires explicit human approval before proceeding. |

The action framework (green/yellow/red) is enforced at the personality level via SOUL.md, not at the infrastructure level. This means it's as robust as the LLM's instruction-following — which is the same trust boundary as the entire system. A prompt injection that bypasses the personality could bypass spending rules too, but the hard limits (merchant lock, monthly cap, no card creation) still hold at the proxy layer.

### Credential Management

| Risk | Mitigation |
|------|-----------|
| API keys in repo | Full secrets audit performed before publication. All keys replaced with placeholders. Verified by automated scan. |
| API keys in agent workspace | Keys live in config files (chmod 600) on the host, not in workspace files. Agent TOOLS.md files contain endpoints and card tokens — not API keys or passwords. |
| Shared credentials between agents | Each agent has its own email account, browser profile (separate CDP port), and session store. No credential sharing. |
| Keys in logs | OpenClaw's logging does not echo request bodies by default. The privacy-pay proxy strips sensitive fields before they reach the agent. |

### Session Privacy

| Risk | Mitigation |
|------|-----------|
| Parent reads teenager's DMs | `dmScope: per-channel-peer` creates isolated sessions per person per channel. Elvis's session with Maria is completely separate from Gargunk's session with Anna. |
| Agent leaks cross-session content | COORDINATION.md contains only items that require multi-party awareness — not private conversation content. Write rules: agents can only update their own entries. |
| Agent-to-agent leaks private info | `sessions_send` injects a message into the other agent's session but does not expose the source session's history. The receiving agent only sees the injected message. |

### Host Security

| Risk | Mitigation |
|------|-----------|
| Agent modifies system files | Agents run within OpenClaw's sandbox. File access is scoped to the agent's workspace directory. |
| Compromised agent pivots to host | A dedicated standard user (`openclaw`) is created separately from the admin account. The `.openclaw` directory is chmod 700. |
| Browser automation escapes sandbox | Playwright runs headless Chrome. Each agent's profile is isolated. The browser has no access to the host filesystem beyond its profile directory. |

## What's Not Mitigated

Transparency about the limits matters more than pretending they don't exist.

- **Prompt injection via web content** — If an agent browses a page with adversarial content, the LLM could be manipulated into unexpected actions. The spending guardrails (merchant lock, monthly cap) limit the blast radius, but there's no input sanitization layer between web content and the agent's reasoning. This is an industry-wide open problem.
- **Personality-level enforcement** — The green/yellow/red action framework is a set of instructions in the system prompt. A sufficiently sophisticated prompt injection could bypass it. The hard infrastructure limits (proxy-level card creation block, merchant locks, spending caps) exist precisely because personality enforcement alone isn't sufficient.
- **Agent memory poisoning** — If an attacker can inject content into a conversation, they could potentially influence what gets written to the agent's daily memory files or COORDINATION.md. These files persist across sessions and influence future behavior.
- **Supply chain** — The system depends on OpenClaw, Claude API, Vapi, ElevenLabs, Telegram Bot API, Privacy.com API, and various npm packages. A compromise of any upstream dependency is outside our control.
- **Physical access** — The Mac Mini runs in a home. Physical access to the machine bypasses all software controls.

## If Something Goes Wrong

The practical recovery path:

1. **Kill the gateway**: `openclaw gateway stop` — all agent activity halts immediately.
2. **Pause all cards**: Via Privacy.com dashboard or API — instant, affects all future transactions.
3. **Revoke Telegram bots**: BotFather → /revoke — disconnects agents from all chats.
4. **Check recent activity**: `openclaw logs`, Privacy.com transaction history, Telegram chat history, agent memory files (memory/YYYY-MM-DD.md).
5. **Rotate credentials**: Gateway token, Vapi bridge token, API keys as needed.

The system is designed so that stopping the gateway is a single command that halts everything. No cleanup required — sessions resume from workspace files when restarted, not from in-memory state.
