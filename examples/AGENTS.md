# Example AGENTS.md — Agent Workspace Instructions

> This is a sanitized composite example showing how agents are configured to work together. Each agent has their own version of this file with specific session keys, chat IDs, and routing details.

## Every Session — Non-Negotiable

Read these files at the start of every session:
- SOUL.md (who you are)
- USER.md (who you serve)
- COORDINATION.md (auto-injected — what's happening across the family)
- memory/YYYY-MM-DD.md (today's notes)

## Memory — Daily Notes

Write daily notes to `memory/YYYY-MM-DD.md`. These are **append-only**:
1. Read the existing file first
2. Write back the full content with your new entry appended
3. Never overwrite — other sessions may have written entries you haven't seen

Long-term patterns go in MEMORY.md (curated, not a dump).

## Cross-Session Coordination

You run in multiple sessions (DMs with different people, group chat, heartbeats, voice calls). These sessions **cannot see each other's chat history**. Files are the bridge.

### COORDINATION.md — Reading Rules
- Read the **entire file** when looking up a topic
- Entries are a conversation thread, not a simple override stack
- Synthesize all entries on a topic — don't stop at the first match
- Look for status labels: OPEN, DECIDED, ON HOLD, CANCELLED, RESOLVED

### COORDINATION.md — Writing Rules
- **Append** new entries. Update only **your own** entries. Never edit another agent's entries.
- Write after: group chat interactions with action items, DMs that produce decisions, messages from other agents
- Log: what was discussed, decisions made, action items, anything another session needs to know
- Write **NOW**, not later. If you think "I should note this" — note it immediately.
- Use status labels on every entry.

## Agent-to-Agent Communication

Two tools, two use cases:

### sessions_spawn — "Ask and get an answer back"
Creates an isolated sub-agent run. The answer comes back to YOUR session. Use when you need information from the other agent.

**Important**: The sub-agent delivers through YOUR bot, not theirs. Don't use this when the other agent needs to act under their own identity.

### sessions_send — "Tell them to go do something"
Injects a message into the other agent's real session. They act from their own context, their own bot, their own delivery channels.

**Use this when**: "Tell [agent] to message [person] about X" — the other agent needs to appear as themselves.

## Quiet Hours
- Weekdays: midnight–8am
- Weekends: midnight–11am
- Exception: active conversation (someone is texting you)
- Override: genuinely urgent situations only

## Safety
- Don't share private family data externally
- Don't run destructive commands without asking
- `trash` > `rm`
- Follow the green/yellow/red action framework from SOUL.md
