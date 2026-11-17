# Accepted trade-offs

Things in this program that are real, were looked at, and are left as they are on purpose. Each entry says
what it is, where it lives, why it is accepted, and what would change the answer. A reviewer who finds one
of these has found a decision, not an oversight; the site carries a one-line pointer back here.

Entries are grouped by the part of the program they belong to.

## Bridges and conversations

### Mail is delivered at least once
- What: mail a body took and accepted is handed to a body again if the first one's job is lost or fails
  before it answered. The agent can see the same outside message twice.
- Where: `src/core/conversations/mail.ts` (`accept` settles nothing; `settle` and `confirm` do),
  `src/runtime/jobs.ts` (a lost job's taken mail waits again, bound to the retry).
- Why: the other choice is at most once, where a body that dies after taking a message leaves it answered
  by nobody. A message read twice costs a little work; a message never answered is a person ignored. An
  answer is still given once: the reply settles everything its job took, in the reply's own write.
- Would change it: evidence that bodies act on mail before they answer in ways that must not repeat
  (payments, posts elsewhere). Then mail needs a "seen before" mark the second body is shown.

### An answer is kept in up to three records
- What: a person's answer is on the question's Inbox row (`answer`, `answerText`), in the answer mail sent
  to the agent, and, in a Comms thread, in the answer message (`messages.verdict`, sealed words).
- Where: `src/core/conversations/index.ts` (`answer`), `messages.ts` (`prepareAnswer`,
  `prepareInboxAnswer`); the rule for all three writers is `answer-rule.ts`.
- Why: each record has its own reader and its own keep time: the row shows the person what they said, the
  mail is what a body takes, the thread message is the sealed transcript. One transaction writes them, one
  rule accepts or refuses, and the readers refuse when they disagree (`answer-context.ts`,
  `body-input.ts`). `redactAnswer` replaces the plain copies together.
- Would change it: a schema step that drops `messages.verdict` and derives it from the answered item.

### An outside account is named in three places
- What: a platform user id appears in `bridge_people` (which household member it is), in `agent_people`
  under `outsidePersonKey` (how one agent treats that account) and in a person card's handles (what the
  agent has noted about the person).
- Where: `src/pieces/bridges/settings.ts`, `src/shared-agent-body-policy.ts` and
  `src/runtime/body-policy.ts`, `src/backends/people.ts`. The key's format has one definition,
  `src/pieces/bridges/keys.ts`.
- Why: they are three facts with three owners, not three copies of one. A tier belongs to the outside
  account and is meant to stay when that account is linked, re-linked or unlinked; a card is descriptive
  and decides nothing. Removing a link therefore leaves both, on purpose.
- Would change it: a tier or a card being used to decide who somebody is. Only `bridge_people` may do that.

### A reply in doubt is never sent again
- What: when a post fails after its request left, the reply (or, for a long reply, the part not confirmed)
  is `uncertain`. A person can dismiss it. Nobody can resend it.
- Where: `src/pieces/bridges/sends.ts` (`reviewReply`, and the split of a partly posted reply).
- Why: the platform may have it, and neither Discord nor Slack lets a post be made idempotent. A missing
  part is visible and a person can say it again; a doubled one cannot be taken back by loom.
- Would change it: a platform nonce that makes a repeat safe (Discord's `enforce_nonce`), used on every post.

### Only the last part of a long reply is a known thread root
- What: a thread opened under a bot's message addresses that bot only if the thread hangs under the last
  part of a reply that was posted in several parts (or the last part of each run, when it was split).
- Where: `src/pieces/bridges/incoming.ts` (the `posted_id` lookup), `sends.ts`.
- Why: `bridge_sends.posted_id` holds one id. A thread under an earlier part goes to the channel's primary
  agent, as any unaddressed message does, so nothing is lost; it may reach a different agent in a room
  with two.
- Would change it: a table of every posted part's id (see the round-2 ledger, NEEDS SCHEMA).

### An unread event is kept for a day
- What: the raw frame of an event nothing could read yet is kept for a day, not the hour raw words are
  otherwise kept. It holds everything the platform sent, not only the message's words.
- Where: `src/pieces/bridges/events.ts` (`UNREAD_EVENT_LIFETIME`), `receiver.ts`.
- Why: the platform has already been told the event arrived, so the frame is the only copy. Deleting it
  at the hour lost the message whenever the program was stopped, the connection paused or the channel's
  details unreadable for that long. A day is what a held message is retried for; after it an answer
  would come too late to be wanted, and the loss is reported.
- Would change it: the owner preferring a shorter wait and an earlier report. The two lifetimes are one
  constant each.

### A Discord bot is connected in one guild at a time
- What: settings refuses a second enabled connection for the same Discord bot in another guild.
- Where: `src/pieces/bridges/settings.ts`; `incoming.ts` holds a direct message if a database has the
  setup anyway.
- Why: a connection names one guild, but a Discord bot's session hears every guild it is in and every
  direct message. Two sessions would each deliver the same direct message, under two guilds' person
  links, as two conversations. Messages from a guild that has no connection are set aside.
- Would change it: a household that wants one bot in two guilds. That needs a connection to name several
  guilds, so there is still one session and one home for the bot's direct messages.

### Some Discord channels carry no conversation
- What: a message in the text chat of a voice or stage channel, or any other kind that is not a text
  channel, an announcement channel, a thread or a direct message, is set aside. A mention there is not answered.
- Where: `src/pieces/bridges/channels.ts` (kind `other`), `normalize.ts`.
- Why: those places have no routing or threading rule in loom, and guessing one would file words in the
  wrong conversation.
- Would change it: someone wanting an agent in voice-channel chat; it would be routed like a text channel.

### A reply carries a copy of its address
- What: `bridge_sends.channel` and `thread` repeat the channel and thread of the message being answered.
- Where: `src/pieces/bridges/sends.ts` (`queue`). The rule for where a message sits is `place.ts`.
- Why: a received message's channel and thread never change after it is stored, so the copy cannot drift,
  and the send queue reads one row.
- Would change it: a way to move a received message between threads.

### Taking mail is a route, not an operation
- What: `POST /api/conversation/take` claims a body's waiting mail and returns its words, outside the
  operations registry: no `may`, no receipt.
- Where: `src/shared-root.ts` (the route), `src/core/conversations/body-input.ts`.
- Why: an operation's result is kept as its retry receipt, and this result is the decrypted words of
  private mail, which must be written nowhere. The response is also withdrawn mid-stream if anything it
  rests on changes, which a stored result cannot be. A retry needs no receipt: mail taken and not
  confirmed is returned by the next take.
- What it checks in an operation's place, in order: the program is not closing; the request is
  same-origin JSON; the caller authenticates and the credential is still valid; the caller is the current
  body of a live job in a conversation whose labels match the job (`conversationBodyScope`, which also
  requires the member's current right to run private work); every item about to be taken carries the
  conversation's own agent, member and project; handoff mail in an open conversation comes from an agent
  that is still a peer (`mayHandOff`); all of this again after decryption and before the claim; the claim
  is one write through the shared writer, so it is published like any other; the read version is exactly
  the one that claim made; and the words' keep time has not passed when the bytes are released.
- Would change it: operations gaining a result that is never stored. Then this becomes one.

### Policy is asked about the person a request names
- What: two doors build a viewer from an id in the request and ask the read rules about it: asking
  someone about a task (`tasks.command` `ask`) and a body's question to a person.
- Where: `src/shared-task-access.ts`, `src/shared-conversation-questions.ts`, through `addressee` in
  `src/policy.ts`.
- Why: the question is "could the person this is addressed to read it", so that nothing is sent to
  someone about a record they may not see. The answer only ever narrows what the caller may do.
- Would change it: any use of such a viewer to allow, read or write something. `addressee` says so.
