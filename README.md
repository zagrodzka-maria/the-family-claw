# The Family Claw

<p align="center">
  <img src="https://zagrodzka-maria.github.io/the-family-claw/demo/thefamily.PNG" width="600" />
</p>

A live multi-agent family system built on [OpenClaw](https://openclaw.ai) and Claude Sonnet 4.6. Four AI agents — each with their own personality, communication channels, and responsibilities — coordinate to manage a real household of three humans and a dog.

This isn't a prototype. It runs 24/7 on a Mac Mini M2 in Oakland, CA. Everything in this repo is real code running in production. The [commit history](https://github.com/zagrodzka-maria/the-family-claw/commits/main) is the build log.

> **April 2, 2026 — Scout goes public.** The family's fourth agent is a research analyst — isolated from the other agents by design. Scout monitors the OpenClaw ecosystem, reads changelogs, evaluates community solutions, and reports to Maria with actionable recommendations. This week Scout flagged that OpenClaw 4.2 ships native cross-agent memory search, which could replace our custom coordination-injector plugin. The system is starting to improve itself.

> **March 27, 2026 — Group chat orchestration.** When all three agents share a Telegram group, they no longer triple-reply. A custom plugin sequences responses so each agent sees what came before and decides whether to add something or stay quiet. Details in [ORCHESTRATION.md](ORCHESTRATION.md).

> **March 24, 2026 — Welcome, Sadie.** Julia's agent is live. The family now runs three agents: Elvis (household manager), Gargunk (Anna's academic wingmate), and Sadie (Julia's college & career support).

## What Makes This Different

**Most personal AI agents are single-brain, single-channel, single-person.** This is a family of agents that talk to each other, share context across isolated sessions, make phone calls, place Amazon orders, and manage payments — all while maintaining separate identities and respecting privacy boundaries between family members.

Five things that set this apart:

1. **Per-person family agents with agent-to-agent coordination** — Not a single AI shared by everyone. Each family member has their own agent with its own personality and channels, and the agents coordinate through shared context and cross-agent messaging
2. **Cross-session context and group orchestration** — Custom plugins solve two common OpenClaw pain points: isolated sessions that can't share context ([#24832](https://github.com/openclaw/openclaw/issues/24832), [#37667](https://github.com/openclaw/openclaw/issues/37667), [#9264](https://github.com/openclaw/openclaw/issues/9264)), and multi-agent group chats where everyone talks over each other. See [ORCHESTRATION.md](ORCHESTRATION.md).
3. **End-to-end voice-to-action orchestration** — A single phone call can trigger Amazon orders, agent-to-agent delegation, Telegram messages, and calendar updates — across multiple agents and channels
4. **A research agent that monitors the ecosystem and recommends improvements** — Scout reads changelogs, evaluates new OpenClaw features against the family's setup, and flags when community solutions could replace custom code. The system gets better without Maria writing a line of code.
5. **Everything here is what's running** — No private code, no secret sauce. The infrastructure, plugins, and bridge code in this repo are the same files running on the Mac Mini. If you're building something similar, take what's useful.

## See It in Action

> ### [▶ Watch the demo video (90 sec)](https://youtu.be/N2DLDer8OmU)
> A single voice call triggers Amazon orders, agent-to-agent delegation, and Telegram messages across the family.

Gargunk and Anna — real conversations, real personality:

<p float="left">
  <img src="https://zagrodzka-maria.github.io/the-family-claw/demo/screenshots/anna&gargunk1.png" width="32%" />
  <img src="https://zagrodzka-maria.github.io/the-family-claw/demo/screenshots/anna&gargunk2.png" width="32%" />
  <img src="https://zagrodzka-maria.github.io/the-family-claw/demo/screenshots/anna&gargunk3.png" width="32%" />
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
- Collaborates with Sadie on cross-sibling coordination (summer opportunities, shared logistics)

### 🌊 Sadie — College & Career Support
*Low-key. Competent. Not trying too hard.*

A college student's agent. The user is skeptical about the whole agent concept — she prefers ChatGPT because it's not "personified." Sadie is designed to demonstrate value without being eager or pushy.

- Summer jobs and internships (high priority — Sadie leads the search, presents curated options, tracks applications)
- Academic support: course planning, major exploration, study strategies
- Collaborates with Gargunk on sibling logistics (summer opportunities, schedules, shared chores)
- Can message Maria directly when it makes sense — not required to go through Elvis for everything
- Communicates via Telegram DMs and family group chat
- Named by the user herself

### 🔭 Scout — Research Analyst
*Reads everything. Says only what matters.*

The family's intelligence layer. Sharp, quiet, and isolated from the other agents by design.

- Monitors OpenClaw releases, changelogs, community solutions, and security advisories
- Evaluates new features against the family's existing setup and recommends whether to adopt, wait, or ignore
- Uses a [custom browser plugin](extensions/web-render/) (Playwright) to read JavaScript-heavy pages that plain HTTP fetch can't handle
- Delegates bulk reading to sub-agents (via `sessions_spawn`) to keep the main research context clean for synthesis
- Reports directly to Maria via Telegram DM — does not communicate with Elvis, Gargunk, or Sadie
- Security isolation: Scout processes the most untrusted external content (web pages, forums, search results). Keeping him disconnected from agents that have payment tools, browser sessions, and family messaging limits the blast radius if a prompt injection gets through.

## How the System Improves Itself

Scout's research isn't just monitoring — it feeds a continuous improvement loop. Here's a real example from this week:

**April 2, 2026 — Scout's heartbeat research sweep** flagged that OpenClaw 4.2 introduced `memorySearch.qmd.extraCollections`, a native feature for cross-agent session search. This is directly relevant because we built a [custom plugin](extensions/coordination-injector/) to solve the same problem — cross-session context sharing.

Scout's recommendation: evaluate whether the native feature replaces or complements the custom plugin. The native approach avoids injecting content into every turn (our current method) and instead lets agents search across each other's session history on demand. Different tradeoff — lower per-turn token cost, but requires the agent to know it should search. Scout recommended planning the upgrade to 4.2 (skipping three intermediate versions) and testing both approaches side by side.

This is what continuous research looks like in practice: a new feature ships, the research agent evaluates it against the family's specific setup, and Maria gets a recommendation with context — not just "version X is available" but "here's what it means for us and whether it's worth the disruption."

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
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐       │
│  │    ELVIS      │  │   GARGUNK    │  │    SADIE     │       │
│  │ (household)   │  │  (Anna's)    │  │  (Julia's)   │       │
│  │               │  │              │  │              │       │
│  │ Telegram DMs  │  │ Telegram DMs │  │ Telegram DMs │       │
│  │ Group Chat    │  │ Group Chat   │  │ Group Chat   │       │
│  │ Voice Calls   │  │ Email (Gmail)│  │ Email (Gmail)│       │
│  │ Browser       │  │ Browser      │  │ Browser      │       │
│  │ Payments      │  │              │  │              │       │
│  └──────┬────┬───┘  └──────┬───────┘  └──────┬───────┘       │
│         │    │  sessions   │   sessions       │              │
│         │    └────_send────┤────_send──────────┘              │
│         │                  │                                 │
│  ┌──────────────────────────────────────────────────┐        │
│  │              SCOUT (research analyst)             │        │
│  │  Web Search ─ Web Fetch ─ Web Render (Playwright) │        │
│  │  Telegram DM to Maria only ─ No agent comms      │        │
│  │  ⚠ ISOLATED — no payments, no browser control,   │        │
│  │    no sessions_send, no COORDINATION.md write     │        │
│  └──────────────────────────────────────────────────┘        │
│                                                              │
│  ┌──────▼──────────────────▼──────────────────────────┐      │
│  │            SHARED COORDINATION.MD                   │      │
│  │  (auto-injected into every session via plugin)      │      │
│  └────────────────────────────────────────────────────┘      │
│                                                              │
│  ┌────────────────────────────────────────────────────┐      │
│  │          GROUP CHAT ORCHESTRATOR                    │      │
│  │  (sequences responses so agents don't talk over     │      │
│  │   each other — see ORCHESTRATION.md)                │      │
│  └────────────────────────────────────────────────────┘      │
└──────────────────────────────────────────────────────────────┘
               │
┌──────────────▼───────────────────────────────────────────────┐
│                    INTEGRATIONS                               │
│                                                              │
│  Telegram ─── Privacy.com ─── Amazon ─── Google Calendar     │
│  ElevenLabs ─── Vapi ─── Brave Search ─── Gmail              │
└──────────────────────────────────────────────────────────────┘
```

## How Agents Coordinate

OpenClaw sessions are isolated by design — a DM with Maria, a DM with Anna, the family group chat, and a voice call are all separate sessions with no shared history. And when multiple agents share a Telegram group, they all receive each message independently and respond simultaneously with no awareness of each other's replies.

We solve both problems with custom plugins. For the full technical details, see [ORCHESTRATION.md](ORCHESTRATION.md).

**Cross-session context:** A [23-line plugin](extensions/coordination-injector/index.js) hooks into `before_prompt_build` and injects a shared `COORDINATION.md` file into every agent turn. All three agents read from and write to the same file with append-only rules. Elvis learns something on a voice call → writes it to COORDINATION.md → Gargunk and Sadie see it in their next conversations. No polling, no API calls, no database. Just a file and a plugin.

**Group chat orchestration:** Telegram doesn't forward bot messages to other bots' webhooks — so when three agents share a group chat, they all process independently and respond simultaneously with no awareness of each other. A [custom plugin](extensions/group-orchestrator/index.js) fixes this: it determines who should respond first (by name mention, topic, or default to Elvis), lets the primary respond, cancels the others, then re-triggers them sequentially with full context of what's been said. Each follow-up agent decides whether to add something or stay silent. The result: a natural conversation instead of three bots saying the same thing at the same time.

## How Agent-to-Agent Communication Works

Two tools, two use cases:

- **`sessions_spawn`** — "Ask the other agent a question, get the answer back." Creates an isolated sub-agent run. The sub-agent delivers through the spawner's bot (wrong identity for outbound messages).
- **`sessions_send`** — "Tell the other agent to go do something independently." Injects a message into the other agent's real session. The agent acts from its own context, its own Telegram bot, its own delivery channels.

Example flow from a single voice call:
1. Maria calls Elvis: "Order paper towels and have Gargunk check in with Anna about summer programs"
2. Elvis places the Amazon order via browser automation
3. Elvis uses `sessions_send` to tell Gargunk to message Anna
4. Gargunk messages Anna on Telegram as himself (not as Elvis)
5. Elvis DMs Maria on Telegram with a status update
6. Gargunk updates everyone on the family group chat

## How Voice Calls Work

Voice AI isn't mainstream yet. For many people, their only experience with it might be a phone call that catches them off guard — maybe a dentist's office confirming an appointment, or a restaurant handling a reservation — where it takes a few turns to realize you're not talking to a person. That works because it's a short script on a fast model with nothing to look up and nothing to do. Our scenario is different: Elvis is a full agent with tools. When Maria calls and says "order paper towels and have Gargunk check in with Anna about summer programs," the agent needs to reason about the request, decide which tools to call, write notes, and coordinate with another agent. That thinking takes time — and silence on a phone call is unforgiving.

The [vapi-bridge](vapi-bridge/server.js) connects Vapi's real-time voice platform to OpenClaw's agent backend. Vapi handles the audio layer (speech recognition, voice activity detection, text-to-speech, interruption support) while OpenClaw provides the brain and tools. The bridge layer between them manages the latency gap with several optimizations:

- **Fast path** — Simple conversational messages (greetings, goodbyes) route to a lightweight model for ~1-2s responses instead of the full agent pipeline at ~8-10s
- **Filler phrases** — When the agent is busy calling tools, the bridge streams personality-matched fillers so the caller doesn't hear dead air
- **Post-call task dispatch** — Instead of executing tasks mid-call (long silences), Elvis takes notes during the conversation and executes everything after hangup — Amazon orders, agent delegation, Telegram messages, calendar updates. This mirrors how human workflows actually work: you wouldn't call an assistant, ask them to research something, and then sit in silence while they browse the web. You'd expect them to say "got it, I'll look into that" and get back to you later.

Voice is the hardest modality to get right for a tool-using agent, and this is an active area of development. For a deeper look at how real-time voice works, the specific challenges of connecting it to a full agent, and where we're headed next, see [VOICE.md](VOICE.md).

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

- Each family member's DM sessions are isolated — Anna's conversations with Gargunk aren't visible in Maria's sessions, and vice versa
- Separate browser profiles per agent prevent login session collisions
- Payment card creation requires human approval
- Agents follow a green/yellow/red action framework — costly, external, or irreversible actions always require human confirmation

To be clear about what "privacy" means here: the session isolation is enforced by OpenClaw at the application layer, not by access controls. Maria built and operates this system, has full access to the Mac Mini, and can read any file on it — including session transcripts. The privacy boundary is a parenting choice, not a technical lock. It gives the teenager a space to interact with her agent without every message landing in front of the parent, while the parent retains the ability to check in if a genuine safety concern arises.

## Security

OpenClaw agents run with real tools — they browse the web, send messages, read and write files, and execute shell commands on the host machine. When you add payment cards, email accounts, and browser sessions with saved logins on top of that, the attack surface is significant. Prompt injection (a malicious input that hijacks the agent's reasoning) is the most realistic threat, and it's an unsolved problem industry-wide. An agent that can place an Amazon order can be tricked into placing the wrong one.

The foundational security decision: the agents live in their own world. They run on a dedicated Mac Mini with their own email accounts, their own payment cards, their own browser profiles, and their own phone numbers. They never touch the family's personal accounts — no access to Maria's bank, medical records, work email, or personal browser sessions. If an agent is compromised, the blast radius is limited to the agent's own sandboxed environment, not the family's digital life.

Everything below is defense-in-depth on top of that separation:

- **Workspace isolation** — `workspaceOnly: true` restricts each agent to reading and writing files within its own workspace directory. Shared writes go through a plugin-provided `coordination_write` tool that runs server-side. Agents cannot access each other's workspaces or system files.
- **Tool deny lists** — Shell access (`group:runtime`) and gateway reconfiguration (`gateway`) are denied globally. Agents cannot execute arbitrary commands or change their own configuration. Sensitive tools like `cron` are restricted to recognized owner accounts.
- **Network isolation** — The gateway binds to loopback only. Remote access is via Tailscale SSH tunnel (WireGuard-encrypted, no port forwarding to the public internet). macOS firewall is on with stealth mode.
- **Token authentication** — All gateway requests require a bearer token. The vapi-bridge authenticates with a separate credential. Device identity (Ed25519 key pair) is required for privileged operations like cross-agent session injection.
- **Payment guardrails** — The [privacy-pay proxy](extensions/privacy-pay/server.js) strips PAN and CVV from all API responses so the LLM never sees full card numbers. Card creation is disabled server-side (403) — only the human can create cards. Cards are merchant-locked (e.g., Amazon-only) with monthly spending limits.
- **Browser profile isolation** — Each agent runs its own Chrome profile on a separate CDP port. One agent cannot access another agent's authenticated browser sessions.
- **Session privacy** — DM sessions are isolated per person per channel. Anna's conversations with Gargunk are private from the parent. Agents cannot read other agents' sessions — only write to them via explicit `sessions_send`.
- **Credential separation** — API keys live in config files on the Mac Mini (chmod 600), not in agent workspace files or this repo. The `.openclaw` directory is chmod 700 under a dedicated standard user separate from the admin account.
- **Phone allowlist** — Inbound voice calls are restricted to a configured allowlist. Unknown callers cannot reach the agents.
- **Research agent isolation** — Scout (the research agent) processes the most untrusted external content — web pages, forums, search results. He is deliberately disconnected from agents that have payment tools, browser sessions, and family messaging. If a prompt injection gets through web content, Scout can send annoying messages to Maria but cannot spend money, access accounts, or influence other agents. No `sessions_send`, no `coordination_write`, no payment tools, no browser control.
- **Automated security sweep** — A daily script scans workspace files for leaked secrets, suspicious URLs, prompt injection patterns, unauthorized cron jobs, transaction anomalies, and file permission changes. Alerts are delivered via Telegram.

For a more detailed discussion of the threat model and mitigations, see [SECURITY.md](SECURITY.md).

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
├── SECURITY.md                      # Threat model and mitigations
├── VOICE.md                         # How voice calls work (deep dive)
├── ORCHESTRATION.md                 # Cross-session context & group chat orchestration
├── extensions/
│   ├── coordination-injector/       # Cross-session context plugin (23 lines)
│   │   ├── index.js
│   │   └── openclaw.plugin.json
│   ├── group-orchestrator/          # Group chat response sequencing
│   │   ├── index.js
│   │   └── openclaw.plugin.json
│   ├── privacy-pay/                 # Payment card API proxy
│   │   └── server.js
│   └── web-render/                  # Playwright page fetcher for research agents
│       ├── index.js
│       └── openclaw.plugin.json
├── vapi-bridge/                     # Voice call → OpenClaw bridge
│   ├── server.js
│   └── package.json
└── examples/                        # Sanitized agent personality files
    ├── elvis-SOUL.md
    ├── gargunk-SOUL.md
    ├── sadie-SOUL.md
    ├── scout-SOUL.md
    ├── scout-IDENTITY.md
    └── AGENTS.md
```

## What's Next

- **Outbound voice calls** — Elvis currently receives calls. Next: Elvis calls Maria when he has a question or needs a decision. Pre-loaded context means no mid-call latency from tool lookups.
- **OpenClaw 4.2 upgrade** — Scout flagged that the latest release includes native cross-agent memory search. Currently evaluating whether it replaces or complements our custom coordination-injector plugin. Upgrade path planned: skip 3.31 and 4.1, go directly to 4.2.
- **QA agent** — An operational health monitor that reads all agents' context (memory files, session transcripts, workspace files) and flags issues: stale memory, bloated sessions, agents ignoring their own notes, contradictions between agents. Think of it as the agents monitoring each other.
- **More agents** — Finance and specialized agents as the family's needs evolve. The coordination infrastructure scales — each new agent joins the same shared context and communication layer on day one.

## Built By

Maria Zagrodzka — FP&A Director, not a developer. Built with Claude Code (Anthropic) as part of the [AI Daily Brief Claw Camp](https://aidailybrief.com) program.

The whole system was built conversationally — no IDE, no framework knowledge required. Just describing what the family needed and iterating until it worked.

Lead image by Anna Sears (with AI assist). Demo video edited by Anna Sears.
