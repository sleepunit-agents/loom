# Comms: talking with your agents inside loom

*2026-11-05. Status: **proposed**. This is a design doc in the `docs/specs/` sense: what loom will build, and the
acceptance criteria its suites must pin. It adds one venue, `loom`, delivered through the runtime the way Discord and
Slack are ([agent-runtime.md](agent-runtime.md) section 5, [bridges.md](bridges.md), [conversations.md](conversations.md)).
It also adds the app that shows that venue's threads. **One decision is the owner's to make before this is built:**
how long a thread's words are kept (see "History: what a thread keeps"). Until he rules, nothing here is built.*

## Why

> "The more it grows… it's starting to feel like something I could just keep full screened on one monitor managing all
> of this stuff. But there's a big capability it lacks right now for that, and that's actually chatting with the
> agents." "We need the idea of multiple chats. So right now, you and I keep bouncing between loom and hocket and
> whatever other idea is in my head. Imagine instead we've built fake future cyberpunk Slack thing and I can literally
> hop between conversations with different agents, archiving them when I'm done." "The chat in loom should be its own
> thing." — the owner, 2026-11-05

Today the owner talks to an agent in a terminal session, or through a Discord or Slack DM. A DM is one place per
person, so it's one conversation: every topic lands in the same thread, and its continuity mixes them. Comms gives
the owner many threads, each its own conversation, inside loom's app, beside the Inbox and the Projects that the
threads produce work for.

**Owners only** (the owner, 2026-11-05, reversing his earlier "anyone who can talk to the agent"):

- A thread shows the working session itself: the tool calls, the approvals and the work in progress. That's the
  owner driving his own subscription.
- A bridge conversation is a different thing. There the agent is the owner's delegate ("Grace asking me, with the
  middleman removed"), and the owner gets the digest afterwards.
- Keeping Comms owner-only means each person drives only their own subscription. That matches the runtime's rule that
  an agent's bodies run only on boxes its owner owns ([agent-runtime.md](agent-runtime.md) section 2).

Everyone else reaches agents through the bridges, as today.

**No terminal.** No PTY or terminal view of a body (the owner, 2026-11-05: decided against).

## Words (to be added to CONTEXT.md)

**Comms**:
loom's app for talking with your own agents: a list of threads, and one thread at a time.
_Avoid_: chat app, messenger, console

**Thread**:
One Comms conversation: a place in the `loom` venue, with an agent, a title and the owner who opened it. Each thread is
its own conversation (conversations.md: agent · venue · place), so each has its own body and continuity.
_Avoid_: chat, channel, session (that's a body's run). conversations.md's "_Avoid_: thread" is about other venues'
own threads; in `loom`, the thread is the venue's word for its place.

**Activity**:
What a body is doing in a thread's turn, as plain one-line cards: "Read `src/delivery.ts`", "Ran the tests", "Asked
to merge". Each card is a summary, never a tool's output.
_Avoid_: log, trace, transcript

## Who may use it

1. **A member may open a thread only with an agent they own.** "Own" is owners.md's rule exactly: a member whose
   `agents` is `"*"` or lists the agent. Today that's the household owner, for Art and Mark. A member who owns their
   own agent, running on their own box with their own CLI login, gets Comms for that agent and no other.
2. **The server enforces it, on every path.** Every Comms route (the thread list, a thread, its messages, its live
   events, posting, title, archive, pin and read state) checks the signed-in member against the thread's agent.
   - The check runs on every request, through the same resolution owners.md uses for page scoping (`agents` from
     `members`, never from what the caller sends).
   - A member who doesn't own the agent gets a `403`, whether the request comes from the app's JSON views, the page,
     or the live stream. The UI also hides those agents, but hiding isn't the protection.
3. **A thread is its opener's.** With several owners on one agent (owners.md), each owner sees only the threads they
   opened. A thread's text is never shown to another member, household owner included. The conversation record (its
   metadata and digests) is still visible to the agent's owners, as for any venue (conversations.md, "Reading").
4. **Agent tokens and pieces can't reach Comms.** Comms routes take a signed-in page session only. An agent reaches a
   thread only as its body, through the runtime (below).

**Not now: a shared agent.** An agent that many people work with directly, Comms-style, would need to run on something
meant for sharing: an API key, or a Team or Enterprise plan, not one person's subscription. If that's ever wanted, it's
a new design: it doesn't widen rule 1.

## The plumbing: `loom` is a venue like any other

```
the owner's composer ──► core: POST /comms/<thread>/send
                           │ checks the owner (rule 1), keeps the text per "History"
                           ▼
                         deliver {agent, venue: "loom", place: <thread place>, from: {person: <member>}, text}
                           │ core's own delivery, source "loom" (src/delivery.ts deliverAsOwner)
                           ▼
                         the runtime: turn + audit text to core; feed, resume or start the thread's body
                           │
          body ──► loom runtime send ──► runtime ──► core venue adapter: POST /api/loom/comms/adapter {op: post}
                                                       │ keeps the reply per "History", raises unread, pushes
                                                       ▼
                                                     the app, live (GET /events: comms)
```

Everything the runtime already does for a bridge applies with no new machinery: the turn written first and once, the
audit log, continuity slots (14 days at most), digests, the loop detector and its Inbox pause, alerts, capacity and
warm houses, model choice, and the body's brief. The new parts are only:

### 1. A core venue, `loom`, adapted by core itself

- **Core declares it.** `loom` joins `session` and `wake` as core's own venues (`CORE_VENUE_ROWS`,
  `src/household-store.ts`). Its label is "loom" and its kind is `live`. Its continuity window is the `live` default:
  14 days.
  - A piece may not declare it. The venue schema's "core names may not be declared" rule covers it.
  - `deliverAsOwner` is already core delivering as source `loom` (`OWNER_SOURCE`). That's a piece name; this is a
    venue name. The two namespaces are separate, and both mean "loom itself".
- **Core is its adapter.** A venue adapter answers three calls on its `send` argv today: post, `--describe` and
  `--status`. A core venue has no bin to run, so its row in `GET /api/loom/venues` says `"adapter": "core"` in place of
  `send`. For such a venue, the runtime makes the same three calls as `POST /api/loom/comms/adapter` with its own
  token (role `runtime`):

  | `op` | Body | Answer | Matches today's argv |
  |---|---|---|---|
  | `post` | `{op, place, agent, text}` | `{ok: true, id}` or `{ok: false, reason, permanent?}` | `send --place --agent`, text on stdin |
  | `describe` | `{op, place, agent}` | `{ok: true, venue, readers, notes}` | `send --describe` |
  | `status` | `{op, place, agent, status: "working"\|"done", messages?: [id]}` | `{ok: true, stop?: true}` | `send --status` |

  - It runs under the runtime's existing limits for an adapter call: 15 s, one retry for an answered `ok: false`
    without `permanent`, and never a retry after a timeout.
  - `post` to a place that isn't a live thread of that agent, an archived thread, or text over 40,000 characters, is
    `{ok: false, permanent: true}` with the reason in words.
  - `describe` answers: "A private thread in loom's app with your owner, <name>. Only they read it." `readers` is the
    thread's member. There are no notes.
  - `status` drives the thread's "working" line (below). `stop: true` is answered once after the owner presses Stop.
- **Places.** A thread's place is `th:<10 lowercase base32 characters>`, random, made when the thread is opened. It
  carries no meaning, so it can't leak a title or a person. The runtime treats it as opaque, as every place is.
- **Who it's from.** An owner's message is delivered `from: {kind: person, slug: <the member's person slug>}`. That's
  the runtime's tier-3 owner, through the gates as today. If the agent's gates don't list the member, the runtime's
  existing rules apply unchanged (agent-runtime.md, section 6). Comms adds no trust of its own.
- **The runtime's hard-coded lists.** `VENUE_KIND` in the runtime's `models.mjs` gains `loom: 'live'`. The relay
  `WHERE` pattern and the gates' `PLATFORMS` stay as they are: a relay never comes from a thread, and a thread needs no
  platform id.

### 2. The brief, for a body in a thread

The runtime's brief already names the venue, the conversation and the run. For `loom` it adds three lines, from
`describe` and the thread:

- "This is a Comms thread in loom: your owner, working with you directly. They can see your tool use as you work."
- "The thread is filed under the project <slug>." (only when the thread has a project)
- "Give the thread a title once you know what it's about: `comms_title`." (only while the thread has none)

### 3. Activity: what the runtime must add to capture

**Today the runtime captures no assistant text, tool use or tool results from a body.** Claude bodies run as
`claude --bg` and write no stream-json. The runtime reads only the job's state, the timeline's tool-work flag for the
loop check, and the status line's rate limits. Codex bodies' `events.jsonl` is read only for turn state and usage.
Replies reach a venue only when the body sends them (`loom runtime send`). So the activity cards need a new capture:

- **Only for `loom` conversations.** No other venue's bodies are read this way.
- **Where it's read:**
  - **Claude:** the session's own transcript, `<projects>/<cwd>/<session>.jsonl`, which the runner already finds for
    slots (`sessionFiles`). Each `tool_use` block makes a card when it appears, and its `tool_result` marks it done or
    failed.
  - **Codex:** `events.jsonl`, the `item.started` and `item.completed` items of types `command_execution`,
    `mcp_tool_call`, `file_change` and `web_search`.
- **What a card holds:** `{id, at, tool, summary, state: running|done|failed}`.
  - `summary` is ≤ 120 printable characters, made by a fixed table, never by a model:
    - a shell command: its `description` when the harness gives one (Claude Code's Bash tool does), else "Ran a
      command";
    - a file read or edit: the verb and the path relative to the repo;
    - a search: "Searched for <pattern>", the pattern cut at 60 characters;
    - an MCP tool: the tool's name in words ("Recalled memories", "Wrote a note");
    - anything else: the tool's name.
  - **Never:** a tool's output, a file's contents, a command line itself, or an environment value. A command line can
    hold a secret, and an output is bulk text.
- **How it travels:** in a house, the body host adds the new cards to its `body-sync` report (every 2 s). The runtime,
  for a local body, tails the files itself. Either way, it posts them to core: `POST /api/loom/comms/activity
  {conversation, run, cards: […≤ 50]}` (role `runtime`). Core accepts cards only for a `loom` conversation with a live
  thread, and it answers `{ok}`.
- **The agent's own text between tools** isn't shown. In a venue body, that text is the body thinking aloud, and
  nobody was ever meant to read it: the reply is what it sends.

### 4. Streaming: what "the reply streaming in" can mean

What Comms streams in is the turn as it happens:

- the "working" line, from the runtime's `status` calls (every 15 s while busy);
- the activity cards, within about 3 s of each step (the 2 s sync plus the live event);
- each reply the body sends, whole, the moment it's posted. A body may send several replies in one run.

**Token-by-token text is not in this design.** It would need a body that runs `claude -p --output-format stream-json
--include-partial-messages`, whose final message is its reply. That's a different runner and a different reply
contract from every other venue. If the owner wants it after using the first version, it's a runner change of its
own, for `loom` bodies only.

### 5. Asks inline: Allow and Deny in the thread

Bodies run without harness permission prompts (the runtime's `LOOM_RUNTIME_CLAUDE_ARGS`, and Codex's bypass flag), so
nothing like Claude Code's own "allow this tool?" ever reaches a venue. The asks a thread shows are loom's own:

- **An approval the body asked for.** The approvals piece's request gains an optional conversation: `approvals request
  … --conversation <cv-…>`, defaulting to `LOOM_BODY_CONVERSATION`, which the runtime already sets in a body's
  environment. It's stored on the record and given in the manifest's ask. That's an edit to the approvals piece,
  made alongside its plain-asks rework (loom-approvals#7).
  - A thread shows each pending approval of its agent whose conversation is the thread's, as an ask card: the
    approval's plain question, why, If you allow, If you deny, and **Allow once** and **Deny**.
  - The buttons post to the approvals piece exactly as the Inbox's would (`ui act`, with the member as caller). The
    first answer wins, as owners.md has it.
  - The card stays in the Inbox too. Answering either one answers both, and the thread's card then says who answered,
    and how.
- **The conversation's open `needs_owner`.** A digest's ask (conversations.md, "Needs you") shows in its thread as the
  same card the Inbox draws, with Yes, No, or a reply. Its Yes or No is a message in that thread, as it is today.
- An ask whose approval is another agent's, or has no conversation, stays only in the Inbox.

### 6. Links in what the agent says

A reply is drawn as the app's markdown (`web/src/markdown.tsx`). These become links, by the same rules as the Needs-you
sheet (conversations.md):

- `t-N` opens the task in the tasks piece's page;
- `owner/repo#N` opens GitHub, and `repo#N` does under household.json's `github`;
- `note:<path>` opens the note;
- `cv-…` opens the conversation;
- `https://` URLs stay links.

Nothing is fetched to preview a link.

### 7. Errors, in words

Every failure a thread can meet is a line in the thread, in plain words, never a status code alone:

| What happened | The thread says |
|---|---|
| No piece offers delivery (core's `503`) | "loom can't reach any agent: the runtime isn't installed." |
| The runtime refused (`4xx` with an error) | "Art didn't get that: <the error's words>." |
| `body: "failed"` | "Art couldn't start: <reason>. Your message is kept; it'll go when Art can start." |
| `body: "queued"` past 2 minutes | "Art is busy with other work; this is waiting its turn." |
| A loop pause | "Paused: Art was repeating itself." The Inbox's Resume and Dismiss are here too |
| A post refused for good | "Art's reply couldn't be shown: <reason>." |
| The stream dropped | "Reconnecting…", then the missed messages, fetched by `seq` |

## The thread

```jsonc
{
  "id": "th:k2m9q4x7ab",           // = the place
  "agent": "art",                  // one agent; "agents" is the stretch goal, below
  "member": "jonathan",            // its opener: the only member who sees it
  "conversation": "cv-…",          // conversations.md's id over agent · "loom" · place
  "title": "Hocket pairing flow",  // ≤ 60; null until written
  "titled_by": "agent",            // or "member"; a member's title is never overwritten by the agent
  "project": "hocket",             // a project slug of the thread's agent, or null
  "pinned": false, "archived": null,   // archived: the time it was archived, or null
  "opened": "…", "last": "…",
  "read_seq": 41                   // the member's last read message
}
```

- **Opening a thread** is a first message: picking an agent, then sending. A thread exists from its first message, so
  there are no empty threads.
- **Title.**
  - The body writes it with `comms_title({title})`, an MCP tool for the conversation given at identity. It's refused
    outside a `loom` conversation, refused over 60 characters or with a line break, and refused once the member has set
    one.
  - Until there's a title, the list shows "New thread with Art" and the time.
  - The member can rename it at any time. The agent's title is its judgment, like a digest: "would they be fine
    reading it?".
  - The title is also the conversation's `label`, so the conversation page and the project hub show it.
- **Project.** Optional, chosen from the agent's live projects when the thread is opened or later, and it can be
  cleared.
  - It's in the brief (above).
  - **For the hub:** conversations.md's digest-project fallback gains a first source, ahead of `links.venues`. A
    digest that names no project takes its thread's project. And projects.md's `conversations` section includes a
    `loom` conversation whose thread names the project even before its first digest. The section's item shape doesn't
    change, so the Projects app needs nothing new. Coordinate through projects.md.
- **Unread.** A thread is unread when its newest agent message's `seq` is past `read_seq`. Viewing a thread with the
  app in front sets `read_seq`.
- **Archive and unarchive.**
  - Archiving hides a thread from the list (an "Archived" filter shows it) and ends its body, so the runtime saves its
    slot.
  - Its conversation, digests and record stay, as for every conversation.
  - Unarchiving brings it back. A message in an archived thread is refused: unarchive first.
- **Pinning** puts a thread at the top of its group. At most 8 are pinned.
- **Stop.** The thread's Stop button sets `stop` for the next `status` call, the same stop word the bridges honour.

**Where it lives.** Thread rows go in the household store (`$LOOM_HOME/household.db`, `comms_threads`), because a
thread joins a member and an agent. The text, if any is kept, goes in its own file, `$LOOM_HOME/comms.db` (see below).

### Stretch: several agents in one thread (designed for, not built)

The record's `agent` becomes `agents` (1–4). Each agent has its own conversation over the same place: the key already
includes the agent. A message goes to the agents it @mentions, else to the thread's first agent, as the bridges'
shared-channel rule does. Each agent sees the other's replies as `from: {kind: agent}` messages, so the relay rules
and the loop detector's ping-pong apply. Every agent in it must be owned by the thread's member. The first version
stores `agent` as a one-element list in the schema, so this isn't a migration.

## History: what a thread keeps (the owner's decision)

**This is a real conflict.** A chat wants history: you scroll up. But loom deliberately keeps no transcripts
(conversations.md, rules 3 and 4):

- raw text lives only in the encrypted audit log, for 7 days at most, and only grading reads it;
- continuity slots, which hold the harness's raw session, last 14 days at most;
- the durable record is metadata and the agent's own digests.

A Comms thread's text has to come from somewhere when the owner reopens it tomorrow. The audit log can't serve it,
because no identity may read that, and a page session is one. So Comms either keeps the words itself or doesn't show
them. Three honest answers:

| | **A. Keep nothing** | **B. Keep 14 days (recommended)** | **C. Keep for the thread's life** |
|---|---|---|---|
| What reopening shows | this tab's messages while it's open; after that, the turns (who, when) with the digests between them | every message from the last 14 days; earlier parts as their digests, marked "Earlier, as Art summed it up" | every message, until the thread is deleted |
| Text kept by loom | none (only in the audit log, as every venue) | each message, encrypted, deleted 14 days after it was sent | each message, encrypted, until the member deletes the thread |
| Matches existing rules | exactly | yes: it's the same ceiling the continuity slot already holds the same words under | no: it's a new exception, for this venue only |
| Feels like chat | no: a reload loses it | yes, for working threads; old threads read as summaries | fully |

**Why B.** The words already sit on loom's machine for 14 days, in the thread's continuity slot, because the body
needs them to resume. Showing them to the owner for that same window adds no new copy that outlives anything else.
After 14 days the agent itself resumes from the digests, and the thread shows exactly what the agent remembers. It
also matches "owner only": the only reader is the member who said half of it.

**Under B or C, the rules for the kept text:**
- It's encrypted at rest with age, to a key of its own (`$LOOM_HOME/comms.key`, made at first use, mode 0600), one
  blob per message, as audit.db does it. That protects copies and backups, not the owner from himself: conversations.md
  rule 3 already says the owner of a loom instance can read what it stores.
- `comms.db` and `comms.key` are left out of bundles and `loom export`, as audit.db is. A restored loom has its
  threads and digests, but not their words.
- Only the thread's member reads it, through the thread's routes. No agent token, piece or `review` token can, and no
  MCP tool returns it.
- Deleting a thread (a member's action, separate from archiving) deletes its words at once, with `secure_delete`.
- Activity cards follow the same retention as the text.
- Under B, archiving doesn't shorten the 14 days. Under C, an archived thread keeps its words until it's deleted.

**Under A,** `comms.db` doesn't exist. The open tab keeps what it was shown in memory, and nothing persists on the
device either.

**Push and privacy, under any answer.**
- A push for a reply says "Art replied" and the thread's title, and **never any message text**. The payload is
  encrypted to the browser (RFC 8291), but it's shown on a lock screen, and a title the agent wrote to be read is a
  safer thing to show there than its words.
- A thread with no title yet pushes "Art replied in a new thread".

**The owner's question:** "Should a Comms thread keep its messages for 14 days, for good, or not at all?"
- If 14 days, I build B as specified.
- If for good, I build C, and conversations.md gains the exception in its rules.
- If not at all, I build A, and threads show digests once the tab is closed.

## The app

**One app, "Comms", in the dock** for a member who owns at least one agent. It's absent for a member who owns none.
Its dock key carries the number of unread threads, as the Inbox's carries its asks.

### Phone

- **The list** is the app's first page, with its groups in this order: Pinned, then Unread, then the rest by `last`.
  Archived threads are hidden behind an "Archived" filter.
  - A row shows the agent's face, the title, the time, the newest digest's summary or "working…", and an unread dot.
  - Swiping a row archives it, with Undo in the toast. A long press pins it.
  - **New thread** opens a picker of the member's own agents, then the composer.
- **A thread** is a page pushed over the list, with back to the list.
  - **The composer** sits above the dock and stays keyboard-safe on iOS: it rides on the visual viewport, so the
    keyboard never covers it, and the page never scrolls sideways. Enter is a newline; the send button sends.
  - **The header** has the agent's face and state, the title (tap to rename), the project, and a menu (Pin, Archive,
    Project, Delete).

### Desktop

Two panes inside the app's window (desk.css's window): the list at the left, about 320 px, and the open thread. The
list stays as you move between threads. ⌘K's Find lists threads by title.

### The look: Neon OS chat

A real chat, with a terminal's flavour:

- **Agent messages** carry the agent's pixel face: the small static avatar crop (trim's work in `web/src`, drawn by
  `AgentAvatar`). The face changes with state while the body works.
- **The owner's messages** are right-aligned, plain, with no avatar.
- **Each message** has a mono timestamp line, `14:02 · art`.
- **The composer** is a mono prompt line, `> `, in the agent's accent.
- **Activity cards** sit between messages, collapsed by default to one line per step ("▸ 6 steps: read 3 files, ran
  the tests"). They open to the list of summaries, each with its state.
- **New things arrive** as `web/src/arrive.tsx` draws them (decode, focus, one glow). Reduced motion: they simply
  appear.
- **Nothing new in the vocabulary.** Comms is loom's own app, not a piece page, so it adds no block type to `vocab.ts`.

### Live

- **The stream.** The app's one stream (`GET /events`, `src/ui/live.ts`) gains a second event, `comms`, with data
  `{thread, seq}` and nothing else: no text, no title.
  - It's sent only to the streams of the thread's member, and the member check (rule 1) runs when the stream opens and
    on each event.
  - Comms events aren't merged into `change`'s 1.5 s gap: they go out within 250 ms.
- **The fetch.** The app then asks `GET /comms/<thread>/since/<seq>` (JSON), which answers the new messages, cards
  and asks, and the thread's state.
- **Reconnecting.** A dropped stream reconnects with the last `seq` it saw, so nothing is missed or doubled.

### Notifications

- A reply in a thread you aren't viewing raises the dock key's count.
- A push goes out when no app of that member has been in front in the last 2 minutes. It uses the existing push path
  (`src/ui/push.ts`), to that member's devices only, titled "Art replied", with no message text.
- A tap opens the thread.

## Edits this forces elsewhere

- **agent-runtime.md**, section 5, "Outbound": a venue core adapts (`adapter: "core"`) gets its post, describe and
  status through `POST /api/loom/comms/adapter`. A new "Activity" paragraph covers the capture, for `loom`
  conversations only.
- **bridges.md:** a note that `loom` is the venue core carries itself, and that it follows the adapters' rules: one
  turn per message, and presence through status.
- **conversations.md:** the venue list gains `loom` (`live`, core's own), and the digest-project fallback gains the
  thread's project. A pointer goes to this doc for the history decision.
- **projects.md:** the `conversations` section includes a thread's project (above). The item shape is unchanged.
- **The runtime (loom-box):** `VENUE_KIND.loom`; core-adapted venues in `adapterCall` and `sendOnce`; activity capture
  in the Claude and Codex runners and the body host.
- **The approvals piece:** `--conversation` on request, and in its manifest's ask.
- **CONTEXT.md:** Comms, Thread, Activity.

## Acceptance criteria

**loom (vitest)**

1. **Owners only, enforced by the server.**
   - A member whose `agents` is `["pond-bot"]` gets a `403` opening, reading, posting to, renaming, pinning,
     archiving or streaming a thread of `art`, through the JSON view, the page route and `GET /events` alike.
   - With `agents: "*"`, all of them work.
   - A second owner of `art` gets a `403` on the first owner's thread.
   - An agent token, a piece token and a `runtime` token on a page route are refused.
2. **The venue.**
   - `GET /api/loom/venues` lists `loom` as `{kind: "live", adapter: "core"}` with no `send`.
   - A piece declaring `loom` is refused at install.
3. **Sending.** A member's message delivers `{venue: "loom", place: <thread>, from: {kind: person, slug: <member>}}`
   through core's own delivery, once per message id. A repeat answers the first answer and writes nothing.
4. **The adapter route.**
   - `post` for a live thread answers `{ok: true, id}` and adds the message.
   - `post` for an archived thread, an unknown place, or another agent's thread answers `{ok: false, permanent: true}`.
   - `describe` names the member as the only reader.
   - `status` sets the working line, and answers `stop: true` once after Stop.
   - Only a `runtime` token reaches the route.
5. **Activity.**
   - Cards are accepted only for a `loom` conversation with a live thread, and capped at 50 per post.
   - A card's `summary` over 120 characters, or holding a line break, is refused.
   - Cards appear in `since/<seq>`.
6. **Title.**
   - `comms_title` works only in a `loom` conversation, refuses over 60 characters, and refuses after a member's
     rename.
   - The title becomes the conversation's `label`.
7. **Project.** A thread's project is the fallback for a digest that names none. The hub's `conversations` section
   lists the thread's conversation before its first digest.
8. **Unread, pin, archive.**
   - Unread counts threads whose newest agent message is past `read_seq`.
   - A ninth pin is refused.
   - Archiving hides the thread from the default list and refuses new messages until it's unarchived.
9. **History** (whichever the owner picks):
   - **B:** a message older than 14 days has no text after the sweep, and its thread shows the digests in its place.
   - **C:** text stays until delete.
   - **A:** `comms.db` is never created.
   - Under B and C, the text decrypts with `comms.key` and not with another identity. A bundle and `loom export`
     contain neither file. Delete removes a thread's text at once.
10. **Live.**
    - A reply sends `comms {thread, seq}` to the member's stream within 250 ms, and to no other member's.
    - The event carries no text.
    - `since/<seq>` returns exactly the messages after `seq`.
11. **Push.** A reply with the member's app not in front for 2 minutes pushes to that member's subscriptions only.
    The payload holds no message text.
12. **Asks.**
    - A pending approval with the thread's conversation shows in the thread with Allow once and Deny.
    - Answering it in the thread answers it in the Inbox, and the other way round.
    - An approval with no conversation, or another agent's, isn't in the thread.

**The runtime (node --test, with `fakeRunner` and a fake core)**

13. A delivery on `loom` starts, feeds and resumes a body as a Slack one does, with `describe`, `status` and `post`
    going to the core adapter route and never to an argv.
14. Activity is captured from a fixture Claude transcript and a fixture Codex `events.jsonl`. A Bash tool call shows
    its `description` and never its command. No output or result text reaches a card. Nothing is captured for a
    `slack` conversation.

**The app (Playwright, phone and desktop viewports)**

15. The list, a thread and the composer load with no console errors and no sideways scroll. On a phone viewport with
    the keyboard open (a resized visual viewport), the composer stays visible above it. The desktop shows two panes.
16. The JS and CSS budgets still pass. Comms loads as its own chunk.

## Order

Each step ships on its own, after the owner's answer on history.

1. **Core:** the venue, threads, the adapter route, sending, the title tool, the history store as decided, live
   events, push, and the server's owner checks. Criteria 1–4 and 6–11.
2. **The runtime:** the core-adapted venue (13), then activity capture (5 and 14).
3. **The app:** phone, then desktop (15 and 16).
4. **Asks inline,** with the approvals piece's `--conversation` (12).
5. **Stretch, later:** several agents in one thread.

## Open questions

- **History:** the owner's decision, above.
- **Token-by-token streaming:** not in this design (see "Streaming"). Revisit once he's used it.
- **The name.** "Comms" it is, unless he prefers another. Others considered: "Wire" (terse, but reads as a news feed)
  and "Channels" (Slack's word, and conversations.md avoids it). "Comms" says what it is in loom's voice.

## Sources

The owner's words and rulings above come from conversations with the agent on 2026-11-05. They're provenance only:
nothing here needs them to be built. What the runtime captures today was checked in loom-box at b908878
(`src/runners.mjs`, `src/delivery.mjs`, `src/bodyhost.mjs`, `src/statusline.mjs`), and the adapter pattern in
loom-discord at 93a213d and loom-slack at 8d47373.

## Review gate

Before this doc merges, a context-stripped reviewer reviews it, and every finding is folded, accepted as a trade-off,
or rejected with a quote.
