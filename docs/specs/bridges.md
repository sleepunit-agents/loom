# Bridges: Discord and Slack as places an agent is spoken to

*Rewritten 2026-11-17 to say what the code does. The page this replaces described an earlier design (one
"shuttle" service, bodies in an agent's warm house, session slots); that program was removed, and the
older specs that cite this page for it ([agent-runtime.md](agent-runtime.md),
[piece-storage.md](piece-storage.md), [projects.md](projects.md)) describe that earlier design too. The
decisions behind each rule here, and what would change them, are in
[accepted-tradeoffs.md](../accepted-tradeoffs.md), "Bridges and conversations".*

The code is `src/pieces/bridges/`, with its doors in `src/shared-bridge-commands.ts` and
`src/shared-bridge-reply.ts`.

## What there is

- **A connection** is one agent's bot on one platform in one workspace (a Discord guild, a Slack team):
  `bridge_connections`. It names the secret its token comes from (and, for Slack, the app token's). The
  bridge reads the token from loom's secret holder each time it uses it. One daemon in loom holds every
  enabled connection: a Gateway session for Discord, a Socket Mode connection for Slack.
- **A channel rule** says which agent answers a room when nobody is addressed, whether bots may talk
  there, and optionally a **brief**: the name of a role page of that agent's, given to the body of every
  conversation in the room. `bridge_channels`.
- **A filter** on a connection lists rooms it ignores, or the only rooms it answers:
  `bridge_channel_filters`. An `only` filter chooses rooms; it never drops a direct message.
- **A person link** says which household member an outside account is: `bridge_people`.
- **A tier** is how an agent's owner places an outside account that is no member: `agent_people`.

All five are changed by a card: the agent files it with `household.propose` (`change: "bridge"`, or
`"bodyPolicy"` for tiers) and a household owner allows it. Nothing else changes them. An owner releases
or dismisses a held or doubtful reply with `bridges.command`.

Read them with the generated queries, for example a connection's state:

```graphql
{ bridgeConnections { id platform agent enabled state stateAt } }
```

`state` is `connecting`, `connected`, `backoff` or `disconnected`. `bridgeActivity` counts what each
connection received, delivered and held in the last day.

## A message coming in

1. The platform's frame is stored before it is acknowledged (`bridge_raw_events`), then read. For Discord
   the daemon first learns the channel's kind, and for a thread who wrote the message it was started from.
2. `receive` in `incoming.ts` decides, in this order:
   - the connection is off: **held**, and tried again for a day;
   - the room is ignored, or outside an `only` filter: dropped;
   - it is the bot's own post: dropped;
   - **a bot or webhook** is delivered only in a room whose rule lets bots talk, and only if it writes this
     agent's mention. It is never delivered in a direct message;
   - **a person** is delivered only if their account is linked to a member who is in the household now, or
     the agent's owner has given the account a tier. A stranger is dropped, in a room and in a direct
     message;
   - **the stop word** ("stop" or "cancel" alone) from a linked member who may end the agent's jobs, where
     a job of the agent's is working, ends that job and is not delivered;
   - in a room, a person's message is the agent's when it addresses the agent, or addresses nobody and the
     room's rule names the agent.
3. **Addressed** means: a written mention of the bot; on Discord a written ping of the role Discord manages
   for the bot; a reply to one of the bot's messages; a message in a thread that hangs under one of the
   bot's messages. Nothing looser: a bot that has only spoken in a thread, or spoke last, is not addressed.
4. A delivered message joins a **conversation** (`place.ts`): one per Discord channel, one per Discord
   thread, one per Slack thread in a room, one per direct conversation. A one-to-one direct conversation
   with a linked member is private to that member.
5. The message becomes mail in the agent's inbox, and the runtime starts a job for the conversation if it
   has none. A Discord message's attachments are listed in its words with Discord's link. The files of a
   delivered message are fetched and kept fourteen days (`bridge_files`): Slack's with the connection's
   credential, Discord's first five up to 8 MB each from its signed links.

A dropped message keeps no words. An edit is not read.

## The job

A body takes the conversation's waiting mail. Before that it asks loom for the harness session the last
body of this conversation left (`conversation_sessions`, sealed, at most 700 KB packed, kept for the
household's keep time for words). Handed one, it continues it and is told only the new mail. Otherwise
it starts fresh and is told what was said earlier in the conversation
(`src/core/conversations/bridge-history.ts`). When it has answered it hands the session back. Only Claude
Code keeps sessions so far.

A body with file tools finds the kept files of the messages it took written into its scratch directory,
named in its input. If the channel's rule names a brief, the body is given that page; if the agent has no
such page the work goes on and the agent's owners get one notice.

A sender who is not a member and is not at tier 3 makes the job a guest's, and the agent's guests-only
tool denials apply to it.

While a running job holds a Discord message unanswered, the bot reacts 👀 to it and shows typing in the
channel (`presence.ts`). Both are best effort.

## The answer

- The body's final text is posted as the reply to the last message it took (`bridges.reply`). During its
  run it may post more with `bridges.say`. At most twenty posts are made for the mail one job took. On
  Discord a `bridges.say` post may carry up to four files, 600 KB together, each named by a path inside
  the body's working or scratch directory; they are kept with the post (`bridge_send_files`) until it is
  settled.
- A job whose mail is no message from the bridge (a trigger's firing in the conversation, a note from
  another body of the agent) answers by a post in the conversation itself, addressed from the
  conversation's place (`bridge_sends.conversation`, with no `incoming`).
- Where a stop word stopped a job the bot says "Stopped here.". Notes and firings waiting in that
  conversation are given to the stopped job and start no work until a person speaks there.

## Between conversations

- A body never posts into or reads another conversation. It hands a note to the agent's body there:
  `conversation.handoff` with `to`, either `{conversation}` or `{platform, workspace, channel, thread?}`
  for a channel the agent has a rule for (the conversation is opened if there is none). The note is mail
  in the target conversation and starts its job. That body is told it is a note from another body of the
  same agent and not a person, where it came from, on whose word, and the chain so far.
- Who may hand to where is `mayHandTo` in `src/policy.ts`: the agent's own work and a body working for
  owners or members who have the agent, anywhere; any other body only to its channel rule's `reportsTo`
  (set on the `channel` card as `reportsTo: {platform, workspace, channel}`).
- The receiving job counts the person the sending body worked for as in the room.
- A chain's start, length and conversations are stored on each note: `inbox.chain_started_at` and
  `inbox.chain` (a JSON list of conversation ids, oldest first; its length is the count), with the
  conversation the note came from in `inbox_refs` and the one it went to in `inbox.conversation`.
- The agent's own work, with no person behind any of its mail, may post a text straight to a ruled channel
  with `bridges.post`, through the same queue.
- Every post goes through one queue (`sends.ts`): split at the platform's limit, each part recorded when
  the platform confirms it (`bridge_send_parts`). A post whose outcome is unknown is `uncertain` and is
  never sent again; an owner may dismiss it. While effects are off a post is `held` for an owner to release.
- On Discord a post may ping the users whose mention the agent wrote, and nothing else. On Slack a post
  pings nobody.

## Not built

- A setting that lets everyone in a room talk to an agent as a guest (a column on the channel's rule).
- A link from an outside account to a People card (a column on the person link).
- Rooms where a bot's every post wakes an agent without a mention: a bot wakes an agent only by writing
  its mention.
- Reading an edit.
- Sessions for harnesses other than Claude Code, and posts with files on Slack.
