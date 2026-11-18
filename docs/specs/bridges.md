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
   - **a bot or webhook** is delivered only in a shared place whose rule lets bots talk, and only if it writes this
     agent's mention. It is never delivered in a direct message;
   - **a person** is delivered only if their account is linked to a member who is in the household now, or
     the agent's owner has given the account a tier. A stranger is dropped, in a shared place and in a direct
     message;
   - **the stop word** ("stop" or "cancel" alone) from a linked member who may end the agent's jobs, where
     a job of the agent's is working, ends that job and is not delivered;
   - in a shared place, a person's message is the agent's when it addresses the agent, or addresses nobody and the
     place's rule names the agent.
3. **Addressed** means: a written mention of the bot; on Discord a written ping of the role Discord manages
   for the bot; a reply to one of the bot's messages; a message in a thread that hangs under one of the
   bot's messages. Nothing looser: a bot that has only spoken in a thread, or spoke last, is not addressed.
4. A delivered message joins a **conversation** (`place.ts`): one per Discord channel, one per Discord
   thread, one per Slack thread in a shared place, one per direct conversation. A one-to-one direct conversation
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

A job on anybody else's word has no part in this. A session is the harness's own record of what an
earlier body read and used, tool results included. Both session doors (`conversation.session`,
`conversation.sessionSave`, `src/shared-conversation-sessions.ts`) refuse such a job's body, on loom's own
reading of the job's word, and the body program does not ask. It starts fresh and is told what was said
earlier, like any body with no session. The session an owners' job saved stays as it was: the guest's
job cannot replace or remove it, and the guest's answer does not make it count as behind, so the next
owners' job continues it. That continued session does not hold what the guest's job was told or said in
between; those words are in the conversation's kept history, which a continued body is not told again.

A body with file tools finds the kept files of the messages it took written into its scratch directory,
named in its input. If the channel's rule names a brief, the body is given that page; if the agent has no
such page the work goes on and the agent's owners get one notice.

A job whose word is anybody else's (not the agent's own work, not its owners': `jobWord`) runs with loom's
tools only: no shell, files, web or helpers of the harness's own, no secrets, no attachment files and no
file on a post, and the agent's guests-only tool denials apply to it. A tier does not change that, and a
household member who does not have the agent counts as anybody else. A message that would make an owners'
job anybody else's, arriving after the job was admitted, waits for the next job
(`docs/accepted-tradeoffs.md`, "A job on anybody else's word runs with loom's tools only").

While a running job holds a Discord message unanswered, the bot reacts 👀 to it and shows typing in the
channel (`presence.ts`). Both are best effort.

## The answer

- The body's final text is posted as the reply to the last message it took (`bridges.reply`). During its
  run it may post more with `bridges.say`. At most twenty posts are made for the mail one job took. On
  Discord a `bridges.say` post may carry up to four files, 600 KB together, each named by a path inside
  the body's working or scratch directory; they are kept with the post (`bridge_send_files`) until it is
  settled.
- What a body may schedule follows whose word its job works on, not the place (`docs/runtime/tempo.md`):
  working for owners, or as the agent's own work, it schedules from a shared place what it could from the
  owner's own thread; working for anybody else, only into the shared place it is in, at listed times,
  with its own words. On such a word a one-time trigger is set at once: a body comes back to work it is
  doing any time. A repeating one is asked of the household's owners as a card, and set only when an
  owner allows it.
- A job whose mail is no message from the bridge (a trigger's firing in the conversation, a note from
  another body of the agent) answers by a post in the conversation itself, addressed from the
  conversation's place (`bridge_sends.conversation`, with no `incoming`).
- Where a stop word stopped a job the bot says "Stopped here.". Notes and firings waiting in that
  conversation are given to the stopped job, and neither they nor one that arrives later start any work
  until a person speaks there. (Only in a bridge's conversation: a stop elsewhere parks nothing.) A person speaking is mail from a member, or a delivered message from an
  account that is no bot and no webhook.

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
- Into one member's private conversation only that member's word goes, and the agent's own work. This is
  asked where a note is admitted and where a firing is made, not only at the doors: a note or a firing on
  anybody else's word is not delivered there; the note is dropped, or the trigger stopped, with a notice.
- A guest's word goes one hop. A job on anybody else's word that a note or a brief started hands nothing
  on, to its own body elsewhere or to a peer agent; one a person's message or a firing started may hand
  to its own channel's report target and may brief a peer agent. No number of notes is refused. When
  such a job has handed 5 notes and briefs together, and at each further 5 (`NOTES_NOTICE_EVERY`), the
  members who have the agent are told, or the household's owners when nobody has it: who the job works
  for, the conversation, and that nothing was stopped.
- A report target is read from the rule of the agent that answers the channel, and the `channel` card
  takes one only on a bridge of that agent's.
- A note on the word of somebody no longer known (a member who left, an outside account with no tier
  now) starts no job. Admission closes it with that reason and tells the members who have the agent, or
  the household's owners. A firing still waiting when its asker stops being known goes the same way. A
  note parked by a stop word is asked about when it is released.
- The note says how to answer (a note back to the conversation it came from) only when that would be
  taken, and otherwise says a note back would be refused.
- A channel target's thread is judged before a conversation is opened for it: none on Discord, where a
  thread is a channel of its own; on Slack, the time of the message that started it.
- A chain's start, length and conversations are stored on each note: `inbox.chain_started_at` and
  `inbox.chain` (a JSON list of conversation ids, oldest first; its length is the count), with the
  conversation the note came from in `inbox_refs` and the one it went to in `inbox.conversation`.
- What counts as the agent's own work is said once (`jobWord` in `src/shared-place-mail.ts`): a job with
  nobody behind any of its mail, which is a lane's own start and a firing the agent itself asked for.
  Mail from an agent is never that. A brief between agents carries the sending job's word, and agent
  mail on nobody's word, or a household agent's bot writing in a channel, counts as anybody else's.
- Mail on somebody's word, from an agent or from the schedule, that arrives after a job was admitted is
  left for the next job, so a job never runs a guest's note under the policy it was claimed with for an
  owner. What a job was admitted for is marked by admission (`inbox.job`), not told by a clock.
- A job whose mail is no bridge message may also post during its run with `bridges.say`; it goes where
  its answer will.
- Neither its answer nor such a post is queued while the conversation's place is closed (its connection
  gone or off, its channel filtered out): the body is told why.
- A post that answers no message is seen and reviewed by whoever sees its conversation, and in a direct
  conversation is erased at the keep time with the conversation's other words.
- A thread's rules (its channel rule, filters and report target) are its parent channel's, read by one
  function (`ruleChannel`), as admission reads them.
- The agent's own work, with no person behind any of its mail, may post a text straight to a ruled channel
  with `bridges.post`, through the same queue.
- Every post goes through one queue (`sends.ts`): split at the platform's limit, each part recorded when
  the platform confirms it (`bridge_send_parts`). A post whose outcome is unknown is `uncertain` and is
  never sent again; an owner may dismiss it. While effects are off a post is `held` for an owner to release.
- On Discord a post may ping the users whose mention the agent wrote, and nothing else. On Slack a post
  pings nobody.

## Not built

- A setting that lets everyone in a shared place talk to an agent as a guest (a column on the channel's rule).
- A link from an outside account to a People card (a column on the person link).
- Rooms where a bot's every post wakes an agent without a mention: a bot wakes an agent only by writing
  its mention.
- Reading an edit.
- Sessions for harnesses other than Claude Code, and posts with files on Slack.
