# The Family Claw

<p align="center">
  <img src="demo/thefamily.PNG" width="600" />
</p>

A live multi-agent family system built on [OpenClaw](https://openclaw.ai) and Claude Sonnet 4.6. Two AI agents — each with their own personality, communication channels, and responsibilities — coordinate to manage a real household of three humans and a dog.

This isn't a prototype. It runs 24/7 on a Mac Mini M2 in Oakland, CA.

## What Makes This Different

**Most personal AI agents are single-brain, single-channel, single-person.** This is a family of agents that talk to each other, share context across isolated sessions, make phone calls, place Amazon orders, and manage payments — all while maintaining separate identities and respecting privacy boundaries between family members.

Three things that set this apart:

1. **Per-person family agents with agent-to-agent coordination** — Not a single AI shared by everyone. Each family member has their own agent with its own personality and channels, and the agents coordinate through shared context and cross-agent messaging
2. **Cross-session context via custom plugin** — Addresses a common pain point in the OpenClaw community (issues [#24832](https://github.com/openclaw/openclaw/issues/24832), [#37667](https://github.com/openclaw/openclaw/issues/37667), [#9264](https://github.com/openclaw/openclaw/issues/9264)) with a 23-line plugin
3. **End-to-end voice-to-action orchestration** — A single phone call can trigger Amazon orders, agent-to-agent delegation, Telegram messages, and calendar updates — across multiple agents and channels

## See It in Action

**[Watch the demo](https://youtu.be/DiERIks1ULA)** — a single voice call triggers Amazon orders, agent-to-agent delegation, and Telegram messages across the family.

Gargunk and Anna — real conversations, real personality:

<p float="left">
  <img src="demo/screenshots/anna&gargunk1.png" width="32%" />
  <img src="demo/screenshots/anna&gargunk2.png" width="32%" />
  <img src="demo/screenshots/anna&gargunk3.png" width="32%" />
</p>

## The Agents

### 🕺 Elvis — Household Manager
*The legend of housekeeping. The pelvis of productivity.*

The central coordinator. Dry humor, full vocabulary, gets things done.

- Manages household operations, shopping, calendar, research
- Places Amazon orders via browser automation
- Makes and receives voice phone calls (Vapi + ElevenLabs custom voice)
- Coordinates with other agents on behalf of the parent
- Handles payments through merchant-locked Privacy.com cards
- Communicates via Telegram DMs, family group chat, and phone

### 👹 Gargunk — Academic Wingmate
*Part gremlin, part guidance counselor. 100% unfiltered.*

A teenager's personal assistant. Bratty, sarcastic, thick-skinned — designed to match a 16-year-old's communication style.

- Homework help, study planning, school schedule management
- College prep and summer program research (pressure relief valve so mom doesn't have to push)
- Email via Gmail
- Communicates via Telegram DMs and family group chat
- Receives delegated tasks from Elvis (e.g., "check in with Anna about summer plans")

## Architecture

```
┌──────────────────────────────────────────────────────────────┐
│                      VOICE LAYER                             │
│   Phone Call → Vapi (STT/VAD/TTS) → vapi-bridge → OpenClaw  │
│                                                              │
│   Features: streaming audio, barge-in, filler phrases,       │
│   fast path (Haiku) for greetings, post-call task dispatch   │
└──────────────┬───────────────────────────────────────────────┘
               │
┌──────────────▼───────────────────────────────────────────────┐
│                    OPENCLAW GATEWAY                           │
│              (port 18789, loopback, token auth)               │
│                                                              │
│  ┌─────────────────┐          ┌─────────────────┐           │
│  │     ELVIS        │◄────────►│    GARGUNK       │           │
│  │  (main agent)    │ sessions │ (Anna's agent)   │           │
│  │                  │  _send   │                  │           │
│  │ Telegram DMs     │          │ Telegram DMs     │           │
│  │ Group Chat       │          │ Group Chat       │           │
│  │ Voice Sessions   │          │ Email (Gmail)    │           │
│  │ Browser (Chrome) │          │ Browser (Chrome) │           │
│  │ Payments (API)   │          │                  │           │
│  └────────┬─────────┘          └────────┬─────────┘           │
│           │                             │                    │
│  ┌────────▼─────────────────────────────▼─────────┐          │
│  │          SHARED COORDINATION.MD                 │          │
│  │   (auto-injected into every session via plugin) │          │
│  └─────────────────────────────────────────────────┘          │
└──────────────────────────────────────────────────────────────┘
               │
┌──────────────▼───────────────────────────────────────────────┐
│                    INTEGRATIONS                               │
│                                                              │
│  Telegram ─── Privacy.com ─── Amazon ─── Google Calendar     │
│  ElevenLabs ─── Vapi ─── Brave Search ─── Gmail              │
└──────────────────────────────────────────────────────────────┘
```

## How Cross-Session Context Works

OpenClaw sessions are isolated by design — a DM with mom, a DM with the teenager, the family group chat, and a voice call are all separate sessions with no shared history. This is a [common pain point](https://github.com/openclaw/openclaw/issues/24832) in the OpenClaw community.

Our solution: a **23-line custom plugin** ([coordination-injector](extensions/coordination-injector/index.js)) that hooks into `before_prompt_build` and injects a shared `COORDINATION.md` file into every agent turn. Both agents read from and write to the same file with append-only rules — agents can add entries and update their own, but never edit another agent's entries.

Result: Elvis learns something on a voice call with Mom → writes it to COORDINATION.md → Gargunk sees it in his next Telegram conversation with the teenager. No polling, no API calls, no database. Just a file and a plugin.

## How Agent-to-Agent Communication Works

Two tools, two use cases:

- **`sessions_spawn`** — "Ask the other agent a question, get the answer back." Creates an isolated sub-agent run. The sub-agent delivers through the spawner's bot (wrong identity for outbound messages).
- **`sessions_send`** — "Tell the other agent to go do something independently." Injects a message into the other agent's real session. The agent acts from its own context, its own Telegram bot, its own delivery channels.

Example flow from a single voice call:
1. Mom calls Elvis: "Order paper towels and have Gargunk check in with Anna about summer programs"
2. Elvis places the Amazon order via browser automation
3. Elvis uses `sessions_send` to tell Gargunk to message Anna
4. Gargunk messages Anna on Telegram as himself (not as Elvis)
5. Elvis DMs Mom on Telegram with a status update
6. Gargunk updates everyone on the family group chat

## How Voice Calls Work

The [vapi-bridge](vapi-bridge/server.js) connects Vapi's real-time voice platform to OpenClaw's agent backend:

- **Vapi** handles all real-time audio: streaming STT (Deepgram nova-3), Voice Activity Detection, streaming TTS (ElevenLabs custom voice), barge-in support
- **vapi-bridge** routes messages through OpenClaw's embedded agent with full tool access
- **Fast path**: Simple conversational messages (greetings, goodbyes) route to Haiku for ~1-2s response time instead of the full agent pipeline (~8-10s)
- **Filler phrases**: If the full agent path takes >3s (tool calls), streams a personality-matched filler ("Let me check on that...") so the caller doesn't hear dead air
- **Post-call dispatch**: After the call ends, a dedicated agent run reads the conversation notes and executes all pending tasks (Amazon orders, agent delegation, calendar updates, Telegram messages)

## How Payments Work

The [privacy-pay proxy](extensions/privacy-pay/server.js) sits between agents and the Privacy.com API:

- API key stays server-side, never exposed to the LLM
- PAN and CVV stripped from all responses
- Card creation disabled at the server level — only the human can create new cards
- Agents can list cards, check balances, pause/unpause, and view transactions
- Merchant-locked cards (e.g., Amazon-only) with monthly spending limits
- Green/yellow/red spending rules enforced at the agent personality level

## Agent Personality System

Each agent has a set of workspace files that define who they are:

| File | Purpose |
|------|---------|
| **SOUL.md** | Personality, communication style, values, action framework |
| **USER.md** | Who they serve — family context, preferences, boundaries |
| **AGENTS.md** | Workspace rules, memory protocols, coordination instructions |
| **TOOLS.md** | Credentials, reference data, practical cheat sheets |
| **MEMORY.md** | Long-term curated context |
| **HEARTBEAT.md** | Periodic check-in schedule and tasks |
| **memory/YYYY-MM-DD.md** | Daily append-only notes |

See [examples/](examples/) for sanitized versions of these files.

## Privacy & Boundaries

- Each family member's DM sessions are isolated — the teenager's conversations with Gargunk are private from Mom (exception: genuine safety concerns)
- Separate browser profiles per agent prevent login session collisions
- Payment card creation requires human approval
- Agents follow a green/yellow/red action framework — costly, external, or irreversible actions always require human confirmation

## Stack

| Component | Technology |
|-----------|------------|
| Agent framework | OpenClaw 2026.3.13 |
| AI model | Claude Sonnet 4.6 (Anthropic) |
| Voice | Vapi + ElevenLabs + Deepgram |
| Messaging | Telegram Bot API |
| Payments | Privacy.com API |
| Browser automation | Playwright (headless Chrome) |
| Shopping | Amazon (automated checkout) |
| Calendar | Google Calendar |
| Email | Gmail |
| Search | Brave Search API |
| Remote access | Tailscale SSH tunnel |
| Hardware | Mac Mini M2, runs 24/7 |

## Repo Structure

```
the-family-claw/
├── README.md
├── extensions/
│   ├── coordination-injector/    # Cross-session context plugin (23 lines)
│   │   ├── index.js
│   │   └── openclaw.plugin.json
│   └── privacy-pay/              # Payment card API proxy
│       └── server.js
├── vapi-bridge/                  # Voice call → OpenClaw bridge
│   ├── server.js
│   └── package.json
└── examples/                     # Sanitized agent personality files
    ├── elvis-SOUL.md
    ├── gargunk-SOUL.md
    └── AGENTS.md
```

## What's Next

- **Julia's Agent** (next week) — Julia's home from college for spring break. Same concept as Gargunk but tuned for a college freshman: part-time jobs, internships, course planning, plus the usual school stuff. Third agent in the family, same coordination infrastructure.
- **Finance Agent** — Personal finance manager for the household. The interesting part: it plugs into the existing agent-to-agent coordination. Elvis is about to order a new appliance? He checks with the finance agent first — "hey, have we budgeted for this? what's our price range?" — and surfaces a recommendation for Maria to review before anything gets purchased.
- **More agents planned** — Career, social, and specialized agents as the family's needs evolve. The coordination infrastructure scales — each new agent joins the same shared context and communication layer on day one.

## Built By

Maria Zagrodzka — FP&A Director, not a developer. Built with Claude Code (Anthropic) as part of the [AI Daily Brief Claw Camp](https://aidailybrief.com) program.

The whole system was built conversationally — no IDE, no framework knowledge required. Just describing what the family needed and iterating until it worked.

Lead image by Anna Sears (with AI assist). Demo video edited by Anna Sears.
