# Voice: How It Works and Why It's Hard

## The basics: how voice AI works

A voice AI system has three core jobs:

1. **Speech-to-text (STT)** — Convert the caller's voice into text that the AI can process. This is also called transcription or speech recognition.
2. **The brain** — Read the text, decide what to say, and generate a text response. For a simple scripted system, this is just producing the next line of dialogue. For a full agent, this may also involve calling tools — looking up a calendar, searching the web, checking a file — before responding.
3. **Text-to-speech (TTS)** — Convert the AI's text response back into spoken audio and play it to the caller.

Each of these steps takes time, and the times add up. If the system waits for you to finish speaking, then transcribes, then thinks, then generates audio, then plays it back — the delay can range from a few seconds to well over ten depending on the complexity of the request. That's fine for a chatbot. On a phone call, it's painful.

## What makes a voice call feel natural

The AI systems that sound most natural on the phone — the ones at dentist's offices, restaurants, and call centers — use a few techniques that are invisible to the caller but critical to the experience:

**Streaming transcription.** Instead of waiting for you to finish a sentence before transcribing it, the system processes your speech in real time, sending partial results as you talk. You say "I need to reschedule my appointment" and the system has already transcribed "I need to reschedule" before you've finished the sentence. This shaves seconds off every exchange.

The tradeoff: streaming transcription sends multiple versions of the same utterance as it refines its understanding. "I need to re—" becomes "I need to reschedule" becomes "I need to reschedule my appointment." Each version arrives as a separate event, and the system needs deduplication logic to avoid processing the same message multiple times — responding to "I need to re—" while you're still talking would be a mess.

**Voice Activity Detection (VAD).** This is how the system knows when you've stopped talking and it's time to respond. Without VAD, the system either waits a fixed amount of time after any silence (too slow, or triggers mid-pause) or requires a push-to-talk mechanism (unnatural). Good VAD distinguishes between a mid-sentence pause ("I want to order... let me think... paper towels") and an actual end-of-turn.

**Barge-in.** The ability to interrupt the AI while it's speaking. If the AI is reading back a long confirmation and you say "yes, that's right," it should stop talking and move on — not finish its sentence and then process yours. This requires the system to be listening and speaking at the same time (full-duplex audio).

**Low-latency TTS.** The AI's voice needs to start playing almost immediately after the text is generated. Streaming TTS begins generating audio from the first few words without waiting for the complete response, so the caller hears the AI start to respond within milliseconds of the text being ready.

## Why our scenario is harder

All of the above works well when the brain is fast — a simple prompt on a lightweight model that responds in under a second. A dental office AI that confirms appointments doesn't need to search the web, place orders, or coordinate with other agents. It just talks.

Elvis is a full OpenClaw agent with access to tools: web search, browser automation, file read/write, cross-agent messaging, payment APIs. When Maria calls and says "order paper towels and have Gargunk check in with Anna about summer programs," here's what the agent actually needs to do:

1. Understand the request in context — who is "Anna," who is "Gargunk," what tools are available, what's already on today's task list
2. Parse the request into separate tasks
3. Decide which tools to call and in what order
4. Write notes to the daily memory file (so nothing is lost if the call drops)
5. Formulate a conversational response confirming what it'll do

That reasoning-plus-tool-calling loop takes 8-10 seconds. On a phone call, that's an eternity of dead air. This is the core tension: the same capabilities that make Elvis useful (tools, reasoning, multi-step planning) are exactly what make him slow to respond in a voice conversation.

## Our architecture

We solve this with a two-layer approach:

**Vapi** handles everything that needs to be real-time: streaming STT (via Deepgram nova-3), VAD, streaming TTS (via ElevenLabs with a custom voice), and barge-in support. Vapi is purpose-built for voice AI and handles all the audio complexity described above.

**OpenClaw** provides the brain and tools. The agent has full access to everything it can do in a text conversation — web search, browser automation, payments, cross-agent coordination.

The **[vapi-bridge](vapi-bridge/server.js)** sits between them and manages the latency gap.

## How we manage the latency gap

### Fast path routing

Not every message needs the full agent pipeline. "Hey Elvis" and "thanks, talk later" don't require tool calls or deep reasoning. The bridge pattern-matches these simple conversational messages and routes them to a lightweight model (Haiku) via direct API call — ~1-2 second response time instead of ~8-10 seconds. Elvis's personality still comes through; the response is just faster because it skips the full agent reasoning loop.

### Filler phrases

When the full agent pipeline is working (because the message requires tool calls or complex reasoning), the bridge doesn't leave the caller in silence. After a few seconds, it streams a personality-matched filler phrase — "Let me check on that," "One sec, pulling that up," or something in character. Three tiers: instant canned one-liners for short waits, personality-driven lines for medium waits, and contextual small talk generated on the fly for longer ones.

### Post-call task dispatch

This is the key architectural decision. Instead of executing tasks during the call — which would mean 30-60 seconds of silence while the agent automates an Amazon checkout — Elvis takes notes. He writes tasks to his daily memory file, confirms to the caller what he's going to do, and keeps the conversation moving. After the call ends, a dedicated agent run reads the notes and executes everything: Amazon orders, agent-to-agent delegation via `sessions_send`, Telegram messages, calendar updates.

This aligns with how human workflows actually function. You wouldn't call an assistant, ask them to research something, and then sit in silence while they browse the web. You'd expect them to say "got it, I'll look into that" and get back to you later. The same principle applies here — the call is for communication, not execution.

The caller gets a snappy conversation. The work happens in the background. Maria gets a Telegram message from Elvis when everything is done.

### Deduplication

Because Vapi uses streaming transcription, the bridge receives multiple progressive versions of each utterance as separate HTTP requests. "Order paper" arrives, then "Order paper towels," then "Order paper towels and have Gargunk check in with Anna." Each version comes with a different request ID, so the bridge can't deduplicate by ID alone. Instead, it uses content-based matching: if an incoming message is a prefix or subset of a message already being processed, it's dropped. This prevents the agent from responding to half-finished sentences while still processing the final, complete version.

### Keyword boosting

Names like "Elvis," "Gargunk," and "Zagrodzka" aren't in most speech recognition models' training data. Deepgram's keyword boosting feature lets us weight these terms so they're transcribed correctly instead of being mangled into similar-sounding common words.

## How it got here

The first version used the stock OpenClaw voice-call plugin with Telnyx handling both telephony and transcription. This is a webhook-based architecture: Telnyx transcribes speech in batches, sends it to the agent via webhook, the agent responds, ElevenLabs generates audio, and Telnyx plays it back. It works, but it's half-duplex — the system can't hear while it's speaking, there's no VAD, and latency compounds at every step. The experience felt like talking to a hold menu.

Switching to Vapi for the audio layer while keeping OpenClaw as the brain was a turning point. Vapi handles all the real-time audio complexity (streaming STT, VAD, TTS, barge-in), and the vapi-bridge handles the latency management between Vapi's real-time expectations and OpenClaw's full-agent processing time.

## What's next

- **Pre-loaded context** — Optionally text Elvis on Telegram before calling: "I'm going to call you in a few minutes, I want to go over where we are with the lost Honda title — have your notes ready." The agent pre-fetches relevant memory and research so the conversation starts informed instead of cold. This isn't required — you can always just call and ask, and Elvis will pull up his notes on the spot. It just takes a few seconds longer, the same way a human assistant can answer any question but responds faster if you gave them a heads up on the agenda.
- **Smarter routing** — Better detection of which messages actually need the full agent pipeline vs. which can be handled conversationally, reducing unnecessary latency for more message types.
- **Streaming partial responses** — Begin speaking before the complete response is generated, reducing perceived latency for longer answers.

Voice is the hardest modality to get right for a full-capability agent. The tension between conversational responsiveness and agent capability is real, and there's no silver bullet — every improvement is an engineering tradeoff. But the trajectory is clear: each iteration makes the conversation feel more natural while preserving access to the full toolkit.
