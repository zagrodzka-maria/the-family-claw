# How Agents Coordinate

OpenClaw agents run in isolated sessions. A DM with Maria, a DM with Anna, the family group chat, and a voice call are all separate contexts with no shared history. And when multiple agents share a Telegram group, they each receive every message independently — they process in parallel, and all respond seconds later with no awareness of what the others said.

This page covers the two custom plugins that solve these problems.

## Problem 1: Isolated Sessions

Maria posts in the family group chat that she wants to cancel the Amazon Prime trial before it renews. Ten minutes later, she DMs Elvis: "hey, did you cancel that Prime thing yet?" Elvis has no idea what she's talking about — his DM session has no history of the group chat. To a human, this is absurd. You're talking to the same agent on the same platform. But under the hood, the group chat and the DM are completely separate sessions with no shared memory.

This is a [well-known pain point](https://github.com/openclaw/openclaw/issues/24832) in the OpenClaw community. Several approaches exist (shared databases, memory plugins, session merging), but most add complexity or require changes to how agents store and retrieve information.

### Solution: coordination-injector

A 23-line plugin ([source](extensions/coordination-injector/index.js)) that hooks into OpenClaw's `before_prompt_build` event and injects the contents of a shared `COORDINATION.md` file into every agent turn as system context.

```
Voice call with Maria  ──┐
                         ├──► COORDINATION.md ◄──┬── Telegram DM with Anna
Telegram group chat    ──┘                       └── Gargunk's next turn
```

All three agents read from and write to the same file. Write rules are append-only: agents can add new entries and update their own, but never edit another agent's entries. This prevents write conflicts while keeping information current. Every entry is tagged with a status label (OPEN, DECIDED, ON HOLD, CANCELLED, RESOLVED) so agents can scan the file and synthesize the full state of any topic.

The plugin runs on every turn for every session, so context is always current — no polling, no API calls, no database. An agent writes something in one session, and every other session sees it on the next interaction.

### Writing to shared state

Because agents run with `workspaceOnly: true` (they can only access files in their own workspace), direct file writes to the shared `COORDINATION.md` path would be blocked. The coordination-injector plugin also provides a `coordination_write` tool that agents use to append entries. The tool runs server-side within the plugin, bypassing the workspace restriction. Two actions are available:

- **append** — Any agent can add an entry. The plugin auto-tags it with the agent ID and a Pacific time timestamp.
- **rewrite** — Only the main agent (Elvis) can use this, for weekly cleanup: merging duplicates, archiving resolved items, removing stale entries.

### What belongs in COORDINATION.md

Items that require awareness or action from multiple parties — agents or humans. Examples: "Maria said she wants to cancel Amazon Prime before April 16" (Elvis heard it on a voice call, Gargunk needs to know because Anna asked about Prime shipping). Single-party tasks go to the agent's own daily memory file, not to coordination.

## Problem 2: Group Chat Chaos

When a human posts in the family Telegram group, all three bots receive the webhook independently. Each agent processes the message in isolation, and all three respond ~10 seconds later with near-identical messages. The agents can't see each other's responses because Telegram doesn't forward bot messages to other bots' webhooks. The result is uncanny and useless — three similar replies arriving simultaneously.

### Solution: group-orchestrator

A custom plugin ([source](extensions/group-orchestrator/index.js)) that intercepts group chat responses using OpenClaw's hook system and sequences them so each agent sees what came before.

**How it works:**

1. **`message_received` hook** — When a human posts in the group, the plugin determines who should respond first. Primary selection: explicit name mention ("Elvis, what about..."), topic matching (Anna + school → Gargunk, Julia + college → Sadie), or default to Elvis as coordinator.

2. **`message_sending` hook** — The primary agent's response goes through to Telegram. All other agents' initial responses are cancelled (`{ cancel: true }`).

3. **`message_sent` hook** — After the primary's message is confirmed delivered, the plugin re-triggers the next agent via the gateway's WebSocket RPC (`chat.send`), injecting the full conversation context: the original human message and every response so far.

4. Each follow-up agent sees what's been said and decides: respond with something new, or reply with `[SKIP]` (which the plugin intercepts and cancels before it reaches Telegram).

**The result:**

Before:
```
Human: "What's everyone up to this weekend?"
[10 seconds pass]
Elvis: "Anna has Polish school Saturday. Nothing else on the calendar."
Gargunk: "Anna's got Polish school Saturday. I'm also going to bug her about that AP Stats review."
Sadie: "Looks like Anna has Polish school Saturday. I don't have anything for Julia this weekend."
```

After:
```
Human: "What's everyone up to this weekend?"
Elvis: "Anna has Polish school Saturday. Nothing else on the calendar."
Gargunk: "Yeah and I'm going to bug her about that AP Stats review she's been avoiding."
[Sadie: nothing to add — stays silent]
```

### Technical details

- **State management:** In-memory Map, not files. Rounds auto-expire after 60 seconds.
- **Re-trigger mechanism:** Gateway WebSocket RPC with Ed25519 device identity authentication (same pattern used by the vapi-bridge for cross-agent delegation).
- **Primary timeout:** If the primary agent doesn't respond within 30 seconds, follow-ups start anyway.
- **Follow-up delay:** 2 seconds between each agent, so messages appear in Telegram before the next agent processes.
- **`[SKIP]` handling:** Detected and cancelled in the `message_sending` hook before reaching Telegram. When a skip is cancelled, the plugin dispatches the next follow-up agent directly (since `message_sent` won't fire for cancelled messages).

### Why not just tell the agents to take turns?

We tried. The agents have no mechanism to coordinate timing — they can't see each other's responses in Telegram (platform limitation), and they all start processing the moment the webhook arrives. Prompt instructions like "wait for Elvis to respond first" don't work when the agent has no way to know whether Elvis has responded. The orchestration has to happen at the infrastructure level, not the prompt level.

## Agent-to-Agent Communication

Separate from group chat orchestration, agents can communicate directly using two OpenClaw tools:

- **`sessions_spawn`** — "Ask the other agent a question, get the answer back to me." Creates an isolated sub-agent run. The sub-agent delivers through the spawner's bot — useful for getting information, not for having the other agent act under their own identity.
- **`sessions_send`** — "Tell the other agent to go do something independently using their own channels." Injects a message into the other agent's real session. The agent acts from its own context, its own Telegram bot, its own delivery channels.

The distinction matters: when Elvis needs Gargunk to message Anna, he uses `sessions_send` — Gargunk receives the delegation in his own session and messages Anna as Gargunk, not as Elvis. If Elvis used `sessions_spawn`, the response would come from Elvis's bot, which would be confusing for Anna.

All three agents have bidirectional `sessions_send` access. Gargunk and Sadie collaborate directly on cross-sibling coordination (summer opportunities, shared logistics) without going through Elvis. Family-level coordination items still route through Elvis as the central hub.
