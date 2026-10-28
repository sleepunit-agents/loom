# Bridges: one shuttle for the household, a conversation as the unit

*2026-10-28. Status: **accepted** (Jonathan, terminal, 2026-10-28: "send em"). Jonathan, terminal: "imagine this. magical
future loom is running on its box, and loom-shuttle is running there with it,
and the slack bridge is enabled. its running there, on the loom box, once
instance. a message comes in from slack... it goes oh ok, this is for: agent
Art from: people Loren on Slack in a DM. if there's an existing session for
that, it gets fed this... if there's a previous session, we bring it back up
and send the new stuff. if that combo has never existed before, we spin up a
brand new session." A design doc in the `docs/specs/` sense: what will be
built, and what the tests must pin. t-1434. Builds on
[owners.md](owners.md), [agents-in-people.md](agents-in-people.md) and
[runtime.md](runtime.md).*

## Why

Today a bridge is a house per agent per platform, and the house is two things
fused: the **interface** (a connection to Slack or Discord) and the **bodies**
(Claude sessions started inside that same house, in the agent's repo, with its
secrets).

- **It doesn't scale.** Sixty agents on Slack and Discord would be 120 houses,
  each up all day, mostly idle.
- **Each agent's bridge is its own copy.** Mark's Discord runs the same
  shuttle code as Art's, but from his own `shuttle.json`, `routes.json` and
  `people.json`, kept by hand in his repo. The Bridges board in loom shows
  Art's only.
- **The data is in files.** Who a Slack id is, who may do what, which channel
  belongs to which agent: all in JSON beside the bridge. Jonathan, 2026-10-28:
  "if it's a file and not coming right out of loom's db, it's probably wrong"
  (notes/decisions/2026-10-28-loom-owns-the-data.md in Art's repo).

## The shape

One **shuttle service** runs on loom's box, as the household's (not any
agent's). It holds every agent's platform connections, routes each message to
a **conversation**, and gets that conversation a **body** in the agent's own
house when it needs one.

```
Slack / Discord ──► shuttle (one, on loom's box)
                      │  which agent?  which person?  which venue?
                      ▼
                   conversation (agent, who, venue)
                      │  live body?  feed it
                      │  ended?      resume it in the agent's house
                      │  new?        start one, with the brief
                      ▼
                   the agent's house (loom-box): bodies are sessions in it
```

### Connections: one bot per agent per platform

An agent keeps its own identity on each platform: Art's Slack app, Mark's
Discord bot. Mark talking as his own user is worth keeping. The shuttle holds
one connection for each, in one process: a Discord poller per bot token, a
Slack socket per app.

- **What an agent connects to is loom's**: each agent's Setup gets a Bridges
  section listing the platforms it's on and the secret each token comes from.
  No `shuttle.json`.
- **Adding an agent to Slack** is a form on its Setup page, not a new house.

### Routing: which agent a message is for

1. **A DM** is for the agent whose bot received it.
2. **In a shared channel**, a mention decides: `@art …` in #mark is Art's, and
   Mark doesn't answer. This is the "primary, mention-only" rule the Discord
   bridge already follows, made the rule for every platform.
3. **No mention** goes to the channel's **primary** agent, if it has one. A
   channel's primary is set in loom (the agent's Bridges section, or the
   channel's own row), not in `routes.json`.
4. **Several bots see the same message** in a shared channel. The shuttle
   handles each platform message once (by its id), then hands it to each
   addressed agent once.

### The conversation is the unit

A conversation is keyed by **(agent, who, venue)**: Art · Loren · Slack DM, or
Mark · #pond · Discord. Its record (owned by the shuttle piece, reached
through loom) holds the conversation's state, its body if it has one, and its
continuity.

- **A live body** for the key gets the message fed in: today's inbox hook,
  which shuttle already has.
- **A conversation with an ended body** is resumed: a body starts in the
  agent's house with that conversation's session restored (see Continuity),
  and gets the new messages.
- **A conversation never seen before** gets a new body with the brief: who's
  talking (their People card, as the agent knows them), where, and what the
  agent may do for them.

### Bodies: sessions in the agent's house, not a house each

The scaling answer is to separate houses from conversations:

- **An agent has a warm house while any of its conversations is active**, on
  any box that may host it. Its bodies are sessions inside that house, one per
  active conversation, sharing its repo, tools and secrets. A busy agent gets a
  second house when the first is full; an idle agent has none.
- **The house is stopped after it's been idle a while** (no live body for N
  minutes), and started again on the next message.
- **Measured 2026-10-28** (Art's repo, notes/bridges/2026-10-28-body-start.md):
  a cold house is running about 10 s after it's asked for (12.0 s, 9.3 s, on
  loom's box with the image cached); a session's process in a warm house starts
  in about 0.1 s. Everything after that (the session loading, the model
  answering) is the same either way. So a warm house saves about 10 s on a
  conversation's first message: keep it warm while a conversation is active and
  for a few minutes after, and let a new conversation after a quiet spell pay
  the 10 s once. A shared pool only if remote boxes prove much slower.
- Sixty agents, mostly idle, are a handful of houses at any moment, not 120.

### Capacity is squishy, not a hard cap

Jonathan: "if we say slack can have 5 bodies per agent, that needs to be a
little squishy. imagine we have 5, a 6th comes in, and one of those 5 is idle,
but not so idle we've killed it. might as well answer the 6th so it doesn't
sit."

- **The limit counts busy bodies, not existing ones.** A body that has
  answered and is waiting for a reply is idle. It stays warm (so its
  conversation continues instantly) but doesn't hold a slot.
- **A new conversation over the limit takes a warm idle body's place** rather
  than waiting: the least recently active idle body is ended (its conversation
  saved) and the new one starts in its house.
- **Only busy bodies wait.** A message waits only when the agent has its limit
  of bodies mid-turn, and the board says so.
- **The real limit is the box,** not a number per platform: memory and CPU
  decide how many warm bodies a house keeps. The number is a default, not a
  wall.

### Continuity

A resumed conversation should feel like the same one, on any box.

- **Each conversation has a slot** (loom-box's slots, as lanes use them): the
  session's state is saved when its body ends and restored when it resumes,
  so `--resume` works wherever the next house runs.
- **When the harness changes, or the slot is gone,** the fallback is a summary
  handoff: the agent's loom memory of the conversation, plus its last N turns.
- **How long continuity lasts** is per venue. A DM continues for weeks; a busy
  channel thread starts fresh after a quiet day.

### Who someone is, and what they may do

**Jonathan, 2026-10-28:** "shuttle is a loom extension, right? so loom the
ecosystem can own it just fine. it can still belong to shuttle if that's what
makes sense. extensions need the ability to store proper data and such."

- **The gates belong to shuttle**: who a platform id is (this Slack id is
  `jonathan-barket`), and what each person may do with each agent (tiers,
  grants, restricts). Gates are per agent: Loren may be a guest of Art's and
  trusted by Mark.
- **Shuttle keeps them in its loom store** ([piece-storage.md](piece-storage.md)),
  not in `people.json`: an **owner-written collection**, which a piece can
  change only while it's acting on an owner's page action. A body, an agent's
  token, or the piece serving an agent's call can't write it. That's the
  enforced owner-only surface notes/decisions/2026-10-21-shuttle-beside-loom.md
  named as its reopen trigger, and this ruling closes that reopen.
- **People still describes, the gates authorize.** An agent-written card never
  grants anything, and People's `where` handles are not the authority for who
  an id is. The gate entry is, keyed by the same slug.

### Harnesses

Bodies run on whatever harness the agent's house runs (shuttle's runner seam:
Claude today, Codex next). Mid-turn input (feeding a live body) is per harness.
Where a harness can't take it, the message waits for the turn to end.

### Upgrades

One service upgrades the way bridges do now
([shuttle#22](https://github.com/sleepunit-agents/shuttle/pull/22)): when idle
and behind, it stops cleanly and starts fresh. Agent houses pick up their
repo the same way.

## Moving there

Each step ships on its own.

1. **Measure.** Done on loom's box (above); a remote box (`one`) still to
   measure before the defaults are settled.
2. **Gates and identities into shuttle's loom store** (after piece storage,
   [piece-storage.md](piece-storage.md)): an owner-written collection, its page
   (on Bridges), and a migration from Art's and Mark's `people.json`.
3. **Agents' bridge settings into shuttle's loom store**: platforms, token
   secrets, channel primaries, shown on each agent's Setup. A migration from
   `shuttle.json` and `routes.json`.
4. **One shuttle, every agent's connections**: the household's shuttle service
   holds Art's and Mark's bots, routes by the rules above, and runs bodies as it
   does today, still in its own house. The Bridges board covers every agent,
   and owner scoping applies to it.
5. **Bodies in the agent's house**: conversations, warm houses, busy-only
   capacity, and slots for continuity. The bridge stops running bodies itself.
6. **Retire the per-agent bridge houses and files.**

## What the tests must pin

- A DM to an agent's bot reaches that agent; in a shared channel a mention of
  another agent reaches that one alone; no mention reaches the channel's
  primary, or nobody.
- One platform message seen by several bots is handled once per addressed agent.
- The same (agent, who, venue) reaches the same conversation: a live body is
  fed; an ended one is resumed with its slot; a new key starts a body with the
  brief.
- Over the limit with a warm idle body, a new conversation starts at once, and
  the idle one's conversation is saved, not lost. With every body busy, it
  waits, and the board says why.
- A gate changes only through an owner's action. An agent token, or anything a
  body can call, is refused.
- A household with no migrated data behaves as today.

## Open questions

- **Default warm-idle time and busy limit**, once `one` is measured too.
- **One warm house per agent, or a pool per box?** Start with per agent; a
  shared pool only if cold start forces it.
