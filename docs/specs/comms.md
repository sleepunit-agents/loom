# Comms: talking with your agents inside loom

*2026-11-05. Status: **proposed**. This is a design doc in the `docs/specs/` sense: what loom will build, and the
acceptance criteria its suites must pin. It adds one venue, `loom`, delivered through the runtime the way Discord and
Slack are ([agent-runtime.md](agent-runtime.md) section 5, [bridges.md](bridges.md), [conversations.md](conversations.md)).
It also adds the app that shows that venue's threads. The owner decided how long a thread's words are kept (14 days,
2026-11-05: see "History").*

## Why

> "The more it grows… it's starting to feel like something I could just keep full screened on one monitor managing all
> of this stuff. But there's a big capability it lacks right now for that, and that's actually chatting with the
> agents." "We need the idea of multiple chats. So right now, you and I keep bouncing between loom and hocket and
> whatever other idea is in my head. Imagine instead we've built fake future cyberpunk Slack thing and I can literally
> hop between conversations with different agents, archiving them when I'm done." "The chat in loom should be its own
> thing." — the owner, 2026-11-05

Today the owner talks to an agent in a terminal session, or through a Discord or Slack DM. A DM is one place per
person, so it's one conversation: every topic lands in it, and its continuity mixes them. Comms gives the owner many
threads, each its own conversation, inside loom's app, beside the Inbox and the Projects the threads make work for.

**Owners only** (the owner, 2026-11-05, reversing his earlier "anyone who can talk to the agent"):

- A thread shows the working session itself: the tool calls, the approvals and the work in progress. That's the
  owner driving his own subscription.
- A bridge conversation is a different thing. There the agent is the owner's delegate ("Grace asking me, with the
  middleman removed"), and the owner gets the digest afterwards.
- Keeping Comms owner-only means each person drives only their own subscription. That matches the runtime's rule that
  an agent's bodies run only on boxes its owner owns ([agent-runtime.md](agent-runtime.md) section 2).

Everyone else reaches agents through the bridges, as today.

**No terminal.** There is no PTY or terminal view of a body (the owner, 2026-11-05: decided against).

## Words (to be added to CONTEXT.md)

**Comms**:
loom's app for talking with your own agents: a list of threads, and one thread at a time.
_Avoid_: chat app, messenger, console

**Thread**:
One Comms conversation: a place in the `loom` venue, with an agent, a title and the member who opened it. Each thread
is its own conversation (conversations.md: agent · venue · place), so each has its own body and continuity.
_Avoid_: chat, channel, session (that's a body's run). conversations.md's "_Avoid_: thread" is about other venues'
own threads; in `loom`, the thread is the venue's word for its place.

**Message** (in Comms):
One entry in a thread, numbered by `seq`: the member's words, the agent's reply, an activity card, an ask or an error
line.
_Avoid_: turn (that's the conversation record's metadata entry), post

**Activity**:
What a body is doing in a thread's turn, as plain one-line cards: "Read `src/delivery.ts`", "Ran the tests", "Asked
to merge". Each card is a summary, never a tool's output.
_Avoid_: log, trace, transcript

## Who may use it

1. **A member may open and use a thread only with an agent they own.** "Own" is owners.md's rule exactly: a member
   whose `agents` is `"*"` or lists the agent. Today that's the household owner, for Art and Mark. A member who owns
   their own agent, running on their own box with their own CLI login, gets Comms for that agent and no other.
2. **A thread is its opener's.** With several owners on one agent (owners.md), each owner sees only the threads they
   opened. A thread's words are never shown to another member, household owner included. The conversation record
   (its metadata and digests) is still visible to the agent's owners, as for any venue (conversations.md, "Reading").
3. **The server enforces both, on every route in "Routes" below.** Each request resolves the signed-in member's
   `agents` from `members` (owners.md), never from what the caller sends. Then:
   - a thread route answers `403` unless the member owns the thread's agent **and** is the thread's `member`;
   - the list route returns only the member's own threads with agents they own;
   - opening a thread with an agent the member doesn't own is a `403`;
   - a thread id that doesn't exist is a `403` too, the same answer as another member's thread, so a route never says
     whether a thread exists. Only the member of a thread they deleted gets `404` for it: a delete leaves a tombstone,
     `comms_deleted` (the thread id, its member, its agent, its channel number and when), holding no words.
   This holds whether the request is the app's JSON view or a page load. The UI also hides those agents, but hiding
   isn't the protection.
4. **The live streams.** A thread's live updates come on its own stream, `GET /comms/<thread>/events`, which the app
   opens while that thread is on screen. It's a thread route like the others: `403` unless rule 3 passes, checked when
   it opens and again before each event it sends, so a member who stops owning the agent is cut off at the next event.
   The app's shared stream, `GET /events` (ui-app.md, "Live"), carries nothing of Comms but a bare `change` (so the
   dock's unread count refreshes), sent only to the streams of the thread's own member. That needs a member-scoped
   `changed` in `src/ui/live.ts`: today's `changed(about)` reaches every owner of an agent.
5. **Agent tokens and pieces can't reach Comms' routes.** Comms routes take a signed-in page session and its
   anti-forgery token for writes, as every page action does. An agent reaches a thread only as its body, through the
   runtime (below), and reads its own agent's threads through one MCP tool, `comms_thread` ("An agent reading its own
   threads"). The runtime reaches only the two `/api/loom/comms/…` routes, with its own token.

**Not now: a shared agent.** An agent that many people work with directly, Comms-style, would need to run on something
meant for sharing: an API key, or a Team or Enterprise plan, not one person's subscription. If that's ever wanted, it's
a new design. It doesn't widen rule 1.

### Routes

Every route below is checked by rule 3 (page routes) or takes only the runtime's token (`/api/loom/comms/…`). JSON
in and out.

**A thread's address** is `/comms/<its id without th:>` (t-1918): a page's path has no colon (`vocab.ts` PATH_CHARS),
so `comms/th:…` broke a reload, as `login:<id>` once did. Every route takes either form; a page load of the old one is
redirected to the new; links loom draws (From, push) use the new.

| Route | What it does |
|---|---|
| `GET /comms` | the member's threads (rule 3), with each one's unread state |
| `POST /comms/new` `{agent, project?, id, text}` | opens a thread with its first message (`403` for an agent the member doesn't own). The same member, agent, `id` and text again answer the same thread; the same `id` with another agent or other text is a `409`. The thread row keeps its first message's id and an HMAC of its text keyed by `comms.salt` (`first_id`, `first_hash`) for the thread's life, which is how a repeat is known |
| `GET /comms/<thread>` | the thread and its newest 100 messages |
| `GET /comms/<thread>/since/<seq>` | the messages after `seq`, and the thread's state |
| `GET /comms/<thread>/before/<seq>` | the 100 messages before `seq`, newest last: scrolling up |
| `GET /comms/<thread>/events` | the thread's live stream (server-sent events) |
| `POST /comms/<thread>/send` `{id, text}` | the member's message |
| `POST /comms/<thread>/title` `{title}` | renames it: 1–60 characters, one line (`400` otherwise) |
| `POST /comms/<thread>/project` `{project \| null}` | files or unfiles it |
| `POST /comms/<thread>/pin`, `/unpin`, `/archive`, `/unarchive` | as named |
| `GET /comms/<thread>/work` | the thread's work, live from the pieces ("Work in this thread") |
| `POST /comms/<thread>/read` `{seq}` | sets `read_seq` (never backwards), and marks the member in front (below) |
| `POST /comms/<thread>/stop` | asks the body to stop (below) |
| `POST /comms/<thread>/delete` | deletes the thread's words and its row (below) |
| `POST /api/loom/comms/adapter` | the runtime's adapter calls (role `runtime`) |
| `POST /api/loom/comms/activity` | the runtime's activity cards (role `runtime`) |

## The plumbing: `loom` is a venue like any other

```
the member's composer ──► POST /comms/<thread>/send {id, text}
                           │ rule 3; keeps the message per "History"
                           ▼
                         deliver {id: "comms:<thread>:<id>", agent, venue: "loom", place: <thread>,
                                  from: {kind: person, slug: <member>}, kind: message, at, text}
                           │ core's own delivery, source "loom" (src/delivery.ts, deliverAsOwner)
                           ▼
                         the runtime: turn + audit text to core; feed, resume or start the thread's body
                           │
          body ──► loom runtime send ──► runtime ──► POST /api/loom/comms/adapter {op: post}
                                                       │ keeps the reply per "History", raises unread, pushes
                                                       ▼
                                                     the app, live (GET /comms/<thread>/events: {seq})
```

Everything the runtime already does for a bridge applies with no new machinery: the turn written first and once, the
audit log, continuity slots, digests, the loop detector and its Inbox pause, alerts, capacity and warm houses, model
choice, and the body's brief. The new parts follow.

### 1. A core venue, `loom`, adapted by core itself

- **Core declares it.** `loom` joins `session` and `wake` as core's own venues (`CORE_VENUE_ROWS`,
  `src/household-store.ts`). Its label is "loom" and its kind is `live`.
  - A piece may not declare it. The venue schema's "core names may not be declared" rule covers it.
  - `deliverAsOwner`'s source is also called `loom` (`OWNER_SOURCE`). That's a piece name and this is a venue name:
    the two namespaces are separate, and both mean "loom itself".
- **Continuity: 14 days.** The runtime gives `live` venues 14 days by default (loom-box's `CONTINUITY_DAYS` in
  `src/delivery.mjs`; 14 is also agent-runtime.md's ceiling). For `loom`, 14 days is the window this doc assumes, and
  Comms' history is tied to it. A household that shortens the runtime's window for `loom` (its
  `LOOM_RUNTIME_CONTINUITY` setting) should shorten Comms' too: the window is household.json's `comms_days` (1–14,
  default 14), set to match by the owner. Comms never keeps words longer than `comms_days`.
- **Delivering a member's message.** Core delivers it as its own delivery, through `deliverAsOwner` (source `loom`).
  That's how the Inbox's Reply already delivers the owner's words (conversations.md, "Needs you").
  - Core's own delivery skips the checks that are for pieces: a declared venue, and `from: person` only from an
    adapter. That's as built, but extensions.md's "Who may deliver what" doesn't say it yet, and it gains that
    sentence (see "Edits").
  - **The message id.** The app gives each message a random id when it's typed: exactly 16 characters of RFC 4648
    base32, lowercased (`a`–`z`, `2`–`7`). It keeps the id with the draft until the send succeeds. Any other id is a
    `400`. The delivery's `id` is `comms:<thread>:<id>`.
    - A second send with the same id, after one that was delivered, gets the first answer back. It makes no second
      message and no second delivery. That's core's delivery rule: only a successful answer is kept.
    - A send whose delivery failed kept nothing, so the same id delivers afresh. That's what Send again does, and its
      message row is the same one, marked delivered once it goes.
  - **Sending** (t-1881). A send is accepted once its message is recorded: `new` and `send` answer at once with
    `delivery: "sending"`, and core delivers in the background. A body can take 20 s or more to start, and nothing
    waits on it. The message is `sending` until core records what came of it: `delivered`, or `failed` with its error
    line. The thread's live stream tells the app when that's recorded, and the app shows only what the server
    recorded, never a guess: "sending…" while it's on its way, "Not delivered · Send again" only after a recorded
    failure.
    - Send again (the same id, after a failure) puts it back on its way, once: a second tap, or another tab, while it's
      on its way answers `sending` and delivers nothing more. It's the same delivery as the first try (its id, its
      time and its label are the first try's), so if the first had reached the runtime after all, the runtime answers
      the repeat and no body hears it twice.
    - A message still `sending` 15 minutes after its delivery began was cut off (loom restarted under it): it's
      recorded `failed` ("couldn't be reached: loom restarted while it was delivering it"), and Send again delivers it.
  - **Text** on `new` and `send` is 1–40,000 characters, the delivery contract's bounds. Anything else is a `400`.
- **Core is its adapter.** The runtime makes three adapter calls on a venue (as built in loom-box, `src/delivery.mjs`
  and `src/policy.mjs`). For a piece's venue, all three run on its declared `send` argv:
  - **post:** `send --place P --agent A`, with the text on stdin. It answers `{ok: true, id?}` or `{ok: false,
    reason, permanent?}`. The runtime makes it for each `loom runtime send` a body makes.
  - **describe:** `send --describe`. It answers `{ok: true, guest?, peer?, venue?, readers?, notes?, brief?}`. The
    runtime asks it before starting a body, and starts none if it fails. `venue` is a key the gates' guest lists
    name, `notes` are names of the policy's brief files, and `readers` is the person slugs who will read the place.
    `brief` (added for Comms, as built in the runtime's `src/policy.mjs`) is up to 3 printable lines of at most 300
    characters, put into the body's brief as written.
  - **status:** `send --status working|done [--message <delivery id>]…`. The runtime sends `working` with the
    delivery ids when messages reach a body, `working` again every 15 s while it's busy, and `done` when the turn
    ends. It answers `{ok: true, stop?: true}`, and `stop: true` makes the runtime end that body.

  A core venue has no bin to run. So its row in `GET /api/loom/venues` says `"adapter": "core"` instead of `send`,
  and the runtime makes the same three calls as `POST /api/loom/comms/adapter` with its own token:

  | `op` | Body | Answer |
  |---|---|---|
  | `post` | `{op, place, agent, text, run?, on?}` | `{ok: true, id}` (the new message's `seq`, as a string) or `{ok: false, reason, permanent?}` |
  | `describe` | `{op, place, agent}` | `{ok: true, brief, readers}` |
  | `status` | `{op, place, agent, status: "working"\|"done", messages?: [delivery id], replied?: false, run?}` | `{ok: true, stop?: true}` |
  | `trace` | `{op, place, agent}` | `{ok: true, trace}`: the thread's delivery facts, no words ("Tracing a reply") |

  - These run under the runtime's existing limits for an adapter call: 15 s, one retry for an answered `ok: false`
    without `permanent`, and never a retry after a timeout.
  - `post` is `{ok: false, permanent: true}`, with the reason in words, for: a place that isn't a thread of that
    agent, an archived or deleted thread, empty text, or text over 40,000 characters.
  - `post`'s `on` names the harness a switched body answers on (loom-box t-1907: `"Codex"` while the agent's own
    account is out of quota). It's one word, a letter then up to 23 letters, digits, `.` or `-`. It's kept as the
    reply's card, `{on}` and nothing else. An `on` of any other shape is dropped and the reply posts without it,
    never refused.
  - `describe` answers `brief`, whose first line is "A private thread in loom's app with your owner, <their name>. Only
    they read it. They can see your tool use as you work. Work you record here can name this conversation as its source:
    conversation:<cv>." (the thread's conversation, so a house body can pass it: "Made here"), and `readers: [<member>]`.
  - `status: working` shows the thread's working line, and `done` clears it. After the member presses Stop, the next
    `status` call answers `stop: true` once.
  - `done` with `replied: false` and its `run` (t-1900) says the body's turn is over and nothing it said was posted
    in that run (it sent nothing, or every send was refused; a turn refused for a usage limit, run again on another
    harness, and one the member stopped, aren't said). The thread gains an error message, `no-reply`, once per run
    (the same run said again adds nothing), so a turn that ends in silence isn't silence on screen. `run` is the
    runtime's run id, 1 to 128 letters, digits, `.`, `_`, `:` or `-`; without a well-formed one, `replied: false` is
    ignored, as it is on `working`.
- **The sender's trust.** For a delivery on `loom` from source `loom`, the runtime takes the sender as **tier 3**,
  the owner (loom-box's tiers: 1 guest, 2 trusted, 3 owner; `src/policy.mjs`). It never looks the sender up in the
  gates. Core delivers there only from a member who owns the agent (rule 3), so the gates have nothing to add. A
  delivery on `loom` from any other source is refused by core, since no piece may declare the venue.
- **Places.** A thread's place, and its id, is `th:` and the first 10 characters of the lowercased RFC 4648 base32 of
  an HMAC-SHA-256 over `member\0agent\0id` (the member's slug, the agent and the first message's id). Its key is
  `$LOOM_HOME/comms.salt`: 32 random bytes, made at first use, mode 0600. So a replayed `new` lands in the same thread, and the place carries no
  meaning: it can't leak a title or a person, and nobody without the salt can predict it. The runtime treats it as
  opaque, as every place is.
- **The runtime's hard-coded lists.** `VENUE_KIND` in loom-box's `src/models.mjs` gains `loom: 'live'`. The relay
  `WHERE` pattern and the gates' `PLATFORMS` stay as they are: a relay never comes from a thread, and a thread needs
  no platform id.

### 2. The brief, for a body in a thread

The runtime's brief already names the venue, the conversation and the run, and carries `describe`'s `brief` lines. For
`loom`, core's `describe` answer adds up to two more lines after its first, so the runtime needs no Comms-specific code
for them:

- "The thread is filed under the project <slug>." (only when the thread has a project);
- "Give the thread a short title once you know what it's about: call `comms_title`." (only while it has none).

### 3. Activity: what the runtime must add to capture

**Today the runtime captures no assistant text, tool use or tool results from a body** (loom-box at b908878).
- Claude bodies run as `claude --bg` and write no stream-json (`src/statusline.mjs` says so).
- The runtime reads only three things from a Claude body: the job's state, its timeline's tool-work flag for the loop
  check, and the status line's rate limits.
- From a Codex body, `events.jsonl` is read only for turn state and usage.
- Replies reach a venue only when the body sends them (`loom runtime send`).

So the activity cards need a new capture:

- **Only for `loom` conversations.** No other venue's bodies are read this way.
- **Where it's read:**
  - **Claude:** the session's own transcript, `<projects>/<cwd>/<session>.jsonl`, which the runner already finds for
    slots (`sessionFiles`). An `assistant` line's `message.content[]` entry of `type: "tool_use"` (`id`, `name`,
    `input`) makes a card when it appears, with `state: running`. A later `user` line's `tool_result` entry with that
    `tool_use_id` marks it `done`, or `failed` when `is_error` is true.
  - **The fixtures** for both are recorded from real runs when this is built, and kept in the runtime's `test/`. This
    doc fixes the fields they're read by, above and below, not their bytes.
  - **Codex:** `events.jsonl`, items of `type` `command_execution`, `mcp_tool_call`, `file_change` and `web_search`.
    `item.started` makes the card (`status: "in_progress"`), and `item.completed` finishes it, keyed by the item's
    `id`: `status: "completed"` is `done`, and `status: "failed"` is `failed` (measured 2026-11-05 with `codex exec
    --json`: a command that exited 2 came back `"status": "failed", "exit_code": 2`). A `todo_list` item is the plan:
    its card is `done` from the start and its label follows `item.updated` (t-1944).
- **What a card holds:** `{id, at, tool, summary, state: running|done|failed}`.
  - `summary` is the step's label (t-1944: Jonathan, 2026-11-07, "he could be playing minecraft as far as I can tell"):
    at most 120 printable characters, with no line break. It's made by this fixed table (loom-box
    `src/activity.mjs`, `src/redact.mjs`), never by a model:

    | Tool | Label |
    |---|---|
    | a shell command | its `description` when the harness gives one (Claude Code's Bash tool does), else its short form: the program and its subcommand and a few plain words (`Ran gh pr checks 603`, `Ran npm test`), a file reader as `Read delivery.mjs (lines 120–180)`, a search as `Searched for "x" in src`, a fetch as `Fetched from api.github.com`, a script as `Ran a python3 snippet`; up to three commands of a chain, never a pipe's later stages, and "Ran a command" when none says anything (`cd`, `echo`) |
    | a file read or edit | the verb and the path relative to the repo, and the line range a read names |
    | a search | `Searched for "<pattern>"` and where, the pattern cut at 60 characters |
    | a web fetch | `Read a page on <host>` |
    | a message to another agent | `Messaged <who>: "<its first line>"` |
    | an MCP tool | the tool's name in words and its key argument (`Remembered "title"`, `Wrote a note "path"`); a digest is only "Wrote its digest" |
    | the plan (TodoWrite, Codex's todo list) | `Plan (2/5): <the item it's on>` |
    | anything else | the tool's name |

  - **A failed step says why**, after ` — `: an exit code and one fixed phrase matched in its output (`exit 1: 3 tests
    failed`, `exit 127: command not found`, `no such file`, `not allowed`). The output is only matched, never shown.
  - **Never:** a tool's output or result, a file's contents (a heredoc's body included), a whole command line, or an
    environment value. Every label goes through `redact` last, which takes out known token shapes (GitHub, Anthropic,
    OpenAI, Slack, AWS, Google, GitLab, npm, age, JWTs, PEM keys), a URL's user and password, Authorization and cookie
    header values, the value of any `NAME=value`, the value of a secret-named flag or query parameter, and long
    token-like runs. Its tests are loom-box `test/redact.test.mjs`.
  - A card's `summary` is stored like a message's words: an age blob in `text`, swept with them. Only `tool` and
    `state` are plain.
- **How it travels.** In a house, the body host adds new cards to its `body-sync` report (every 2 s). For a local
  body, the runtime tails the files itself. Either way, it posts them to core: `POST /api/loom/comms/activity
  {conversation, run, cards: [1–50]}` (role `runtime`).
  - Core accepts them only for a `loom` conversation whose thread is live (not archived or deleted). Otherwise it
    answers `409`.
  - A post of more than 50 cards, or with any card breaking the shape above (a non-printable character in `summary`
    included), is refused whole (`400`).
  - A card whose `id` the thread already has updates that card's `state` and its label (sealed again, unless its words
    were already swept). It doesn't add a second one.
- **Only `tool_use` entries and tool items become cards.** A Claude `text` or `thinking` entry, a Codex
  `agent_message` or `reasoning` item, and every result are skipped whole.
- **The agent's own text between tools** isn't shown. In a venue body, that text is the body thinking aloud, and
  nobody was ever meant to read it: the reply is what it sends.

### 4. Streaming: what "the reply streaming in" means here

What Comms streams in is the turn as it happens:

- the working line, from the runtime's `status` calls;
- the activity cards, within a few seconds of each step (the house's 2 s sync, then the runtime's 5 s tick, then the
  live event);
- each reply the body sends, whole, the moment it's posted. A body may send several replies in one run.

**Token-by-token text is not in this design.** It would need a body that runs `claude -p --output-format stream-json
--include-partial-messages`, whose final message is its reply. That's a different runner and a different reply
contract from every other venue. If the owner wants it after using this, it's a runner change of its own, for `loom`
bodies only.

### 5. Asks inline: Allow and Deny in the thread

Bodies run without harness permission prompts (the runtime's `LOOM_RUNTIME_CLAUDE_ARGS`, and Codex's bypass flag), so
nothing like Claude Code's own "allow this tool?" ever reaches a venue. The asks a thread shows are loom's own:

- **An approval the body asked for.** The approvals piece's request gains an optional conversation:
  `approvals request … --conversation <cv-…>`. It defaults to `LOOM_BODY_CONVERSATION`, which the runtime already
  sets in a body's environment. It's stored on the record and given in the manifest's ask. That's an edit to the
  approvals piece, to make alongside its plain-asks rework (loom-approvals#7).
  - A thread shows each pending approval of its agent whose conversation is the thread's. The card has the approval's
    plain question, why, If you allow, If you deny, and **Allow once** and **Deny**.
  - They're live only once loom says, now, that the ask is still open (`/inbox/open?a=<the approval's id>`: by the id,
    since an approval a need waits on is drawn on that need and its own card leaves the Inbox), and loom is asked
    again right before Allow or Deny is sent: a copy kept on this device may be of an ask answered since. Answered
    since, loom unreachable, or the answer a copy (stamped `x-loom-saved-at`): the buttons stay disabled and the card
    says why (`web/src/ask-open.ts`, the Inbox's own rule; the desktop's Needs you does the same, with its buttons left
    out until then).
  - The buttons post to the approvals piece exactly as the Inbox's would (`ui act`, with the member as caller). The
    first answer wins, as owners.md has it.
  - The card stays in the Inbox too. Answering either one answers both, and the thread's card then says who answered
    and how.
- **How an ask becomes a message.** Core writes an `ask` message into the thread, with the next `seq`, when it first
  sees the ask: an approval when the approvals piece's manifest (which core already reads each minute for the Inbox)
  first lists it with the thread's conversation; a `needs_owner` when the digest carrying it is written. The message
  stores only the reference (`{approval: id}` or `{digest: id}`). Its words, its state and who answered are read live
  each time the thread is drawn, from the approvals piece's manifest and `state` and from the digest's answers. So the
  card says "Allowed by Jonathan" without the row changing.
- **The conversation's open `needs_owner`.** A digest's ask (conversations.md, "Needs you") shows in its thread as the
  same card the Inbox draws, with Yes, No, or a reply. A Yes or No from the thread is a message in that thread, as it
  is today.
- An approval with no conversation, or another agent's, stays only in the Inbox.

### 6. Links in what the agent says

A reply is drawn as the app's markdown (`web/src/markdown.tsx`). These become links, by the same rules as the Needs-you
sheet (conversations.md):

- `t-N` opens the task in the tasks piece's page (as the sheet's, and so are the next two);
- `owner/repo#N` opens GitHub, and so does `repo#N`, under household.json's `github`;
- `note:<path>` opens the note (Comms' own addition: the sheet has no note links);
- `cv-…` opens the conversation;
- `https://` URLs stay links. Nothing else is a link.

Nothing is fetched to preview a link.

### 7. Errors, in words

Every failure a thread can meet is an error message in the thread, in plain words, never a status code alone:

| What happened | The thread says |
|---|---|
| No piece offers delivery (core's `503`) | "loom can't reach any agent: the runtime isn't installed." |
| The runtime refused (a `4xx` with an error) | "Art didn't get that: <the error's words>." |
| `body: "failed"` | "Art couldn't start: <reason>." |
| `body: "queued"`, and no `status: working` within 2 minutes | "Art is busy with other work; this is waiting its turn." |
| `body: "queued"` because no body could start (the runtime's reason "no body could start (…): trying again in N s"): it's retrying, not busy, and no busy line follows (t-1918) | "Art couldn't start; retrying." With **What happened**, the trace |
| A loop pause (the runtime's `deferred` note turn) | "Paused: Art was repeating itself." The Inbox's Resume and Dismiss are on it |
| A `post` the runtime reports failed | "Art's reply couldn't be shown: <reason>." |
| A turn over with nothing sent (`status: done`, `replied: false`) | "Art finished without replying." With **What happened**, the reply's trace |
| No `age` program (the send is refused with `503`, nothing delivered, nothing stored but the error) | "loom can't keep messages safely right now: the age program is missing." |
| A read with no way to decrypt: `comms.key` missing or not a plain file, or neither the age library nor the program can take it (the read is refused with `503` and its reason, as before t-1926; nothing is shown as swept) | "Can't open this conversation right now: loom couldn't decrypt it." With **Try again**; what the app already shows stays, under "What's shown here may be out of date." (t-1937). Another `5xx` on a read: "…: loom couldn't answer." |
| The stream dropped | "Reconnecting…" while it's down, then the missed messages, fetched by `seq` |

A refused action that isn't a delivery (a `400` or `409` from a route: a ninth pin, a send to an archived thread)
answers with its reason in words, which the app shows as a toast, never a bare code. The runtime's activity posts are
the runtime's business: a refused one is logged, and the member sees nothing.

A message whose delivery failed is kept, marked "not delivered", with **Send again**, which re-sends it with the same
id.

### An agent reading its own threads (t-1896)

A body can read, read only, the messages of a thread its own agent is the agent of, as the thread's member sees them:
the member's words and its replies (for `comms_days`, then the message without them), tool cards, and error cards in
their fixed words. That's how a body checks whether its reply showed, or what the "couldn't be shown" card said.

- **One MCP tool, `comms_thread {thread?, before?, limit?}`.** No route: rule 5 stands for every Comms route.
- **Whose.** The agent is the MCP server's own agent dir, never anything the caller sends (as `comms_title`). With no
  `thread`, it's the thread of the conversation given to identity. With one, it's that thread only when its agent is
  the same agent. Another agent's thread, a deleted one, or an id that never was are the same refusal, and say nothing
  of it. A body can name another of its own agent's threads: they're one agent's, and the words were said to it.
- **What.** Words past `comms_days` are dropped at read time too, not only by the sweep. The newest `limit` (30 by default, at most 100) messages, or those before `before`, oldest first, and the
  thread's state. Never a write.

### Tracing a reply (t-1895)

What happened to one message, from the member's send to the reply on screen, is in two records: core's (the message's
delivery, the thread's state, the reply's `run`, any error card) and the runtime's (the run: its body, its house, its
end, what it sent and what was refused). The runtime joins them: its `comms_trace` tool and `loom runtime trace`
(loom-box, `src/trace.mjs`) read its own record and ask core's half with the adapter op `trace`.

- **`trace {op, place, agent}`** answers `{ok: true, trace: {thread, conversation, archived, working_since,
  queued_since, last_failed, messages}}`: the newest 100 messages' `seq`, `at`, `kind`, `from`, `run`, a member's
  message's `delivery`, an error card's code and its words (the fixed table, with the runtime's own reason in it where
  the card has one), a tool card's tool and state. Never a member's or an agent's words. An
  archived thread answers too. A place that isn't a thread of that agent's is `{ok: false, permanent: true}`.
- **Who reads a trace.** The op takes the agent the runtime names, as `post` and `status` do: the runtime is trusted to
  name it, and it answers only that agent's caller. An agent, its own agent's threads (the runtime's tool runs as the session's agent); an owner,
  the threads of agents they own (owners.md), as for any conversation record (conversations.md, "Reading"). Never
  across agents.

## The thread and its messages

```jsonc
{
  "id": "th:k2m9q4x7ab",           // = the place
  "agents": ["art"],               // exactly one now; several is the stretch goal, below
  "member": "jonathan",            // its opener: the only member who sees it
  "conversation": "cv-…",          // conversations.md's id over agent · "loom" · place
  "title": "Hocket pairing flow",  // ≤ 60, one line; null until written
  "titled_by": "agent",            // or "member"
  "project": "hocket",             // a live project slug of the thread's agent, or null
  "pinned": false,
  "archived": null,                // the time it was archived, or null
  "opened": "…", "last": "…",
  "read_seq": 41                   // the member's last read message
}
```

Messages (`comms_messages`):

```jsonc
{ "thread": "th:…", "seq": 42,     // per thread, from 1, assigned by core, never reused
  "at": "…",
  "kind": "message",               // message (the member's), reply, card, ask, error
  "from": "jonathan",              // the member's slug, or the agent's id
  "id": "…",                       // a message's client id; a reply's delivery ref; a card's id
  "text": "<age blob or null>",    // words, kept per "History"; null once swept
  "card": null,                    // a card: {tool, state} (its summary is in text); an ask: {approval} or {digest}
  "run": "…",                      // on a card or reply: the body run it came from (the runtime's run id)
  "delivered": true,               // on a member's message: false while its delivery failed, null while on its way
  "delivery": "delivered" }        // on a member's message: sending, delivered or failed
```

- **Who it's from.** A `message` is from the member. A `reply`, `card` or `ask` is from the agent. An `error` is from
  `loom`, and stores its fixed code and the runtime's reason in `card` (`{error, reason}`), plainly: those are loom's
  words, not the conversation's, so they need no `age`. Within one thread, a member's message `id` with different text
  is a `409`.
- **Opening a thread** is a first message: picking an agent, then sending. A thread exists from its first message, so
  there are no empty threads.
- **Title.**
  - The body writes it with `comms_title({title})`, an MCP tool for the conversation given at identity.
    - It's refused outside a `loom` conversation, over 60 characters, or with a line break.
    - It's refused once the member has set a title: the agent never overwrites a member's.
  - Until there's a title, the list shows "New thread with Art" and the time.
  - The member can rename it at any time. The agent's title is its judgment, like a digest: "would they be fine
    reading it?".
  - The title is also the conversation's `label` (core writes it there), so the conversation page and the project hub
    show it.
- **Project.** It's optional. It's chosen from the agent's live projects when the thread is opened or later, and it
  can be cleared. A slug that isn't one of the agent's live projects is a `400`.
  - It's in the brief (above).
  - **For the hub:** conversations.md's digest-project fallback gains a first source, ahead of `links.venues`. A
    digest that names no project takes its thread's project, even when the place also matches a project's
    `links.venues`.
  - projects.md's `conversations` section also includes a `loom` conversation whose thread names the project, before
    its first digest. The section's item shape doesn't change, so the Projects app needs nothing new.
- **Unread.** A thread is unread when its newest `reply` has a `seq` past `read_seq`. The app sets `read_seq` while
  the thread is on screen and the app is in front.
- **Archive and unarchive.**
  - Archiving hides a thread from the default list (an "Archived" filter shows it). It ends its body, so the runtime
    saves its slot: core calls the runtime's piece API as the household owner, `run {argv: ["deliver", "end",
    "<conversation>"]}`, a runtime verb that ends that conversation's body if it has one (a no-op if not). A runtime
    that doesn't answer leaves the body to its warm-idle timeout, and the archive still stands.
  - Its conversation, digests and record stay, as for every conversation.
  - Unarchiving brings it back. Sending to an archived thread is a `409`: unarchive first.
- **Pinning** puts a thread at the top of the list. A member has at most 8 pinned threads, and a ninth pin is a `409`.
- **Stop.** The Stop button sets `stop` for the thread's next `status` call: the runtime's own stop path, as the
  bridges' stop word uses it.
- **Delete** removes the thread's row and every message of it, words included, at once. `comms.db` runs with SQLite's
  `secure_delete` on, so freed pages are zeroed. The
  conversation record and its digests stay, as they do for every venue. It asks first.

**What the conversation page shows.** A `loom` conversation has no venue render: `conversation({id})` and
`loom:conversation/<id>` show core's generic render (conversations.md, "Rendering": metadata, digests, turn counts),
never a thread's messages. So another owner of the agent sees that the conversation happened and what the agent made
of it, as for any venue, and never its words. The conversation page links to the thread only for its own member.

**Where it lives.** Thread rows go in the household store (`$LOOM_HOME/household.db`, `comms_threads`), because a
thread joins a member and an agent. Messages, and every word of them, go only in `$LOOM_HOME/comms.db`. No other table
anywhere holds a Comms message's text.

### Stretch: several agents in one thread (designed for, not built)

- `agents` holds 1–4 agents. Each has its own conversation over the same place: the key already includes the agent.
- A message goes to the agents it @mentions, else to the thread's first agent, as the bridges' shared-channel rule
  does.
- Each agent sees the others' replies as `from: {kind: agent}` messages, so the relay rules and the loop detector's
  ping-pong apply.
- Every agent in a thread must be owned by its member.
- The first version already stores `agents` as a list, so this needs no migration.

## History: what a thread keeps (decided: 14 days)

**Decided by the owner, 2026-11-05:** "14 days is great. you've got the full context, I don't need to look back at
everything."

**The conflict this settles.** A chat wants history: you scroll up. But loom deliberately keeps no transcripts
(conversations.md, rules 3 and 4):

- raw text lives only in the encrypted audit log, for 7 days at most, and only grading reads it;
- continuity slots, which hold the harness's raw session, last 14 days at most;
- the durable record is metadata and the agent's own digests.

The audit log can't serve a thread: no identity may read it, and a page session is one. So Comms keeps its threads'
words itself. That's a new copy that a person reads, and conversations.md's rule 4 names it as the one exception.

**What reopening a thread shows:** every message from the last 14 days, and before that the digests, under "Earlier,
as Art summed it up". After 14 days the agent itself resumes from its digests, so the thread shows what the agent
remembers.

**Why 14 days.** The same words already sit on loom's machine for 14 days, in the thread's continuity slot, because the
body needs them to resume. Showing them to the owner for that window keeps no word longer than the slot does. The only
reader is the member who said half of it.

**Considered and not chosen:**
- keeping words only until seen (an hour), after which a thread is a list of digests;
- keeping them for the thread's life, which would break rule 3's "no transcripts" for this venue.

**The rules for the kept words:**
- **Encryption.** They're encrypted at rest with age, one blob per message as audit.db does it, to a key of their own
  (`$LOOM_HOME/comms.key`, made at first use, mode 0600). That protects copies and backups, not the owner from himself:
  conversations.md rule 3 already says the owner of a loom instance can read what it stores. Reading a thread decrypts
  in loom's own process with the age library (`age-encryption`, t-1926; the owner's ruling of 2026-11-07), with the
  `age` program as the fallback for a message the library can't read (logged, without its words). The decrypted words
  live only for that request: no cache of them in memory. Writing stays with the `age` program (one process a send,
  from the synchronous write path), and each reads the other's files (`src/comms-age.integration.test.ts`). A `comms.key` the library can't take at all (not
  an X25519 identity) still reads, one `age` process a message as before t-1926, after one log line. The audit
  log (`src/audit.ts`) and bundles (`src/bundle.ts`) keep the program too: the audit log's decrypt is pinned to one
  function by its own criterion, and a bundle is restored with the `age` CLI.
- **The window** is household.json's `comms_days` (1–14, default 14), tied to the slot's window (section 1).
- **A sweep** runs hourly and at daemon start, like the audit log's. It sets `text` to null on every message older
  than `comms_days`, in `secure_delete` mode, so the deleted pages are zeroed. Rows stay, with their `seq`, `at`,
  `from` and `kind`.
- **Not in bundles.** `comms.db`, `comms.key` and `comms.salt` are left out of bundles and `loom export`, as audit.db
  is. A restored loom has its threads and digests, but not their words.
- **One reader.** Only the thread's member reads them, through the thread's routes. No agent token, piece token,
  `runtime` token or `review` token can, and no MCP tool returns them.
- **Deleting** a thread deletes its words at once. Archiving doesn't change the window.
- **Activity cards'** summaries are kept the same way, for the same window.

**Push and privacy.**
- A push for a reply says "Art replied" and the thread's title, and **never any message text**. The payload is
  encrypted to the browser (RFC 8291), but it's shown on a lock screen, and a title the agent wrote to be read is a
  safer thing to show there than its words.
- A thread with no title yet pushes "Art replied in a new thread".

## The app

**One app, "Comms", in the dock** for a member who owns at least one agent. It's absent for a member who owns none.
Its dock key carries the number of unread threads, as the Inbox's carries its asks. On a phone it comes after Places, so
a narrow phone (one whose dock holds four keys) keeps Places and finds Comms under More; from about 430 px it's a key.

### Phone

- **The list** is the app's first page, in this order: Pinned, then Unread, then the rest by `last`. Archived
  threads are hidden behind an "Archived" filter.
  - A row shows the agent's letter (t-1925 D), the title, the time, the newest digest's summary or "working…", and an unread dot.
  - Swiping a row archives it, with Undo in the toast. A long press pins it.
  - **New thread** opens a picker of the member's own agents, then the composer.
- **A thread** is a page pushed over the list, with back to the list.
  - **The composer** sits above the dock and stays keyboard-safe on iOS: it rides on the visual viewport, so the
    keyboard never covers it, and the page never scrolls sideways. Enter is a newline; the send button sends.
  - **The header** has the title (tap to rename), the project, Stop while the body is
    working, and a menu: Pin, Archive, Project, Delete.

### Desktop

**The thread** has a **band** of fixed height (232 px) over the chat (Jonathan, 2026-11-07: "outlook-esque"): on the
left the comm screen at its own size (its glass the sprite's 96 × 84 at a whole 2×, never stretched to the width), on
the right **In this conversation** (the agent with what it's doing, and you) and **Work in this thread**, which scroll
inside the band, so its height never changes however much work there is. The chat (the messages and the composer)
takes the rest of the height and scrolls on its own. Wherever there's width to spare, the people-and-work side takes
it, never the comm screen.

**Two panes** (the list at the left, 320 px, beside the thread) where Comms' box is 1100 px or wider: the list's 320,
the comm screen's 224 and a people-and-work side of 320 or more, with room around them. **Narrower** (a mid-size
window, Comms beside the widgets at 1280, a narrow tile): one pane, the thread with its band, the list a drawer from the
menu button in its header; with no thread open the list fills the pane. The list stays as you move between threads. ⌘K's Find lists threads by title.

### The look: Neon OS chat

A real chat, with a terminal's flavour:

- **Agent messages** carry the agent's pixel face: the small static avatar crop (trim's work in `web/src`, drawn by
  `AgentAvatar`). The face changes with state while the body works.
- **The member's messages** are right-aligned and plain, with no avatar.
- **Each message** has a mono timestamp line, `14:02 · art`.
- **The composer** is a mono prompt line, `> `, in the agent's accent.
- **Activity cards** sit between messages, grouped by `run` and collapsed by default to one line per run: "▸ N steps"
  and the newest card's summary ("▸ 6 steps · Ran the tests"). A group opens to a `now:` line (the step it's on, and
  the plan's item when there's a plan), then its labels, each with its state; three or more like steps in a row that
  finished well fold into one line that opens ("Ran 6 commands · Ran npm test"). A plan card isn't counted as a step.
- **The working line** is one mono line under the newest message (t-1918): `Art E Fish is working · Ran the tests ·
  0:42`, the step it's on now (the newest running card since your message, else the newest) and the time since
  `status: working` began; while your message is with it and nothing's back yet, `Art E Fish is thinking…`. It shows
  while the runtime's `status` says working (or the thread waits on the agent), and goes on `done`. The list row shows "working…" at the same time. The runtime says `working` again every 15 s while the body
  works, and posts its activity: a thread with no word of either for 90 s isn't working any more (its body gone, its
  `done` lost), and core records it so (t-1881). The runtime also tries a `done` that didn't land again, each tick.
- **New things arrive** as `web/src/arrive.tsx` draws them (decode, focus, one glow). Reduced motion: they simply
  appear.
- **Nothing new in the vocabulary.** Comms is loom's own app, not a piece page, so it adds no block type to `vocab.ts`.

### The comm screen

> "We should absolutely show the avatar for the agent like it's a fuckin Wing Commander chat cut scene or whatever."
> — the owner, 2026-11-05

Each thread gets a framed panel with the agent's animated pixel portrait: the classic space-sim comms screen, drawn as
Neon OS's own, not copied from any game.

- **Scrolling** is a chat app's (t-1918, `web/src/comms-follow.ts`): the thread follows its newest message only while
  you're within 80 px of the bottom; scrolled up, nothing moves you, and a **New messages ↓** pill counts what came in
  below (it takes you down). Your own message always brings you down. Content growing above you (a run's steps opened,
  an image) leaves you where you were (the browser's scroll anchoring). Each step's card and the **working line** under
  the messages ("Art is working · Ran the tests · 0:12", or "is thinking…") show as they arrive.
- **The composer's hint** (Enter to send · Shift+Enter for a new line) is faint, shows only while the composer has
  focus, and takes no line of its own (t-1925 C).
- **In a box too narrow for two panes** (under 1100 px: a narrow tile, a mid-size desktop), the threads fold out as a drawer over the
  thread from the menu button in its header (t-1925 C): focus goes into it, Tab stays in it, Esc or the scrim closes it
  and gives focus back to the button, picking a thread closes it. With no thread open the list fills the pane. A phone
  keeps its list, then the thread with its way back.
- **The list's agents** are their letters (t-1925 D): the pixel face is the comm screen's one big picture.
- **The portrait** is the agent's pixel face (`web/src/pixel-face.tsx`), at 2× or larger, at whole-pixel scales only.
  An agent with no sprite gets its drawn face (`face.tsx`) in the same frame.
- **The frame** has chassis edges in the agent's tint, a scanline overlay, a small signal meter, and a mono label with
  the agent's name and what it's doing now (t-1918): `ART E FISH · WORKING`. The word is the face's state, said as a
  radio would: `THINKING` (your message is with it, nothing back yet), `WORKING`, `TALKING` (a reply landing), `WAITING
  ON YOU` (an ask), `DONE`, or `NO CARRIER` (it can't be reached: the last delivery failed). The thread's header draws no
  separate state blob: this line, the face and the working line under the messages say it. The channel number is the
  screen's accessible name ("Art's comm screen, channel 03") and the list's line.
  - The channel number is given when the thread opens: one more than the highest number among that member's threads
    with that agent, deleted ones included (the tombstone keeps it), from 1. It's never reused or changed, and it's
    shown with at least two digits (`CH 03`, `CH 112`).
  - The signal meter is the link's: full while the thread's stream is open, one bar while it reconnects (the thread says
    Reconnecting), empty with no carrier.
  - `· ON CODEX` follows it while the thread's latest reply came from a body on another harness than the agent's own,
    because that account was out of quota. The runtime's `post` names the harness (`on: "Codex"`), and core keeps it
    on the reply's card. (loom-box t-1907.) It's read from the messages the app has loaded: a thread whose newest 100
    messages hold no reply at all shows no word. That's accepted, since every turn ends in a reply.
- **Where it sits:**
  - **Desktop:** the left of the thread's band, at its own size (the glass 192 × 168, the sprite's 96 × 84 at 2×, and
    the agent's own manifest scale on top, cropped by the frame like a camera's), never stretched; a short tile (under
    520 px tall) folds it to its one-line strip.
  - **Phone:** a compact strip at the top of the thread, which collapses to the small avatar in the header once you
    scroll.
- **The face follows the thread's real state**, through the existing states and the beat-and-hold player:

  | The thread | Face state |
  |---|---|
  | a message of yours on its way or delivered (`started`, `resumed` or `queued`), and no card or `working` status yet | `thinking` |
  | `status: working`, or a card arriving | `working` |
  | a reply lands | `talking`, one beat |
  | after the talking beat, with `status: done` or no `working` for 30 s | `complete` (done), then `idle` |
  | an ask pending in the thread | `needs-input` (waiting, always facing south) |
  | the last delivery or post failed, or a loop pause | `error` |
  | a turn over with no reply (the `no-reply` message after your last message) | `idle`: the wait is over, as after a reply |

  A pending ask wins over everything except `error`: with an ask pending, `working` and `talking` show as
  `needs-input`, and an `error` still shows as `error`.
- **What a test can see.** The screen carries `data-face` (the state's name in the table) and `data-anim` (the
  manifest state actually played: `talking`, or the one it fell back to). During the signal transition it carries
  `data-signal="on"`.
- **Talking is a manifest state the player falls back from.** There's no talking animation yet. `talking` joins the
  face states, and the player uses a manifest's `talking` animations when it has them. Without them, it uses `done`'s,
  then `working`'s. So when the owner makes a talking sheet in PixelLab, adding it to the agent's manifest is the
  whole change.
- **How talking plays** (the owner, 2026-11-05: small breaks between the talking loops):
  - **A bounded run.** When a reply lands, the face plays one talking beat per 150 characters of the reply, rounded
    up, at least 1 and at most 4. Then it plays the done beat, then rests as idle. A reply arriving mid-run adds its
    beats to the run, still capped at 4 in all.
  - **A breath between beats.** After each talking beat (one animation, about 1.5 s), the face holds its rest frame
    for a random 400–1200 ms before the next one. That's not a continuous loop, and not idle's multi-second gaps.
  - **Which talking animation** is picked by its manifest weight at each beat, and a rare one is never played twice
    in a row (the player's existing rule). Art's sheet weights them talking 70, animated 20 and smug aside 10 (rare).
  - **Reduced motion:** no talking beats at all; the face holds its rest frame.
- **The signal transition.** When a reply arrives, the screen plays a short burst of static and a scanline roll, for
  250 ms, before the talking beat starts. With reduced motion there's no transition, and the face shows its rest frames only,
  as the player already does.
- **YOU, the other side.** A small panel in the same frame style shows the member's avatar or initial, labelled `YOU`.
  It's on the desktop column only; a phone leaves it out.

### Live

- **The event.** The thread's stream (`GET /comms/<thread>/events`) sends one event, `message`, with data
  `{seq}` and nothing else: no text, no title. That's the thread's own stream (rule 4). Each event goes out within
  250 ms of the message, without the shared stream's coalescing (`GAP_MS`, 1.5 s, in `src/ui/live.ts`).
- **The fetch.** The app then asks `GET /comms/<thread>/since/<seq>`, which answers the new messages and the thread's
  state.
- **Reconnecting.** A dropped stream reconnects, and the app fetches `since/<the last seq it has>`, so nothing is
  missed or doubled.

### Notifications

- A reply in a thread you aren't viewing raises the dock key's count.
- **In front** is per thread: an app of that member has that thread's stream open and the page visible
  (`document.visibilityState` is `visible`). The app tells core with `POST /comms/<thread>/read`, sent when the
  thread is shown and every 30 s while it stays visible. Core takes "in front in the last 2 minutes" from those calls.
- A push for a reply goes out when no app of that member has had that thread in front in the last 2 minutes. Being in
  another thread doesn't hold it back. It uses the existing push path
  (`src/ui/push.ts`), to that member's subscriptions only, titled as "Push and privacy" says.
- A tap opens the thread.

## Work in this thread

> "how hard… to link work related to a thread? … I just asked you in that thread to make visual changes… so that's
> potentially tasks, potentially changes, etc. if that shit showed up under the list of people on the right, that
> would be bonkers" — the owner, 2026-11-05, approving both layers below.

A thread's right column lists the work the thread is about, with each item's live state. Two layers feed it:

1. **What the thread mentions:** every task, change and note named in its messages, the member's and the agent's.
2. **What the thread made:** tasks a body created or updated while working in the thread, and the changes linked to
   them or citing the thread's conversation. These are marked **made here**.

### The refs index (what it mentions)

- **When it's written.** When core appends a `message` or a `reply`, it reads the text it's about to encrypt for
  references. The patterns are the ones the app links (section 6, `web/src/plain.ts`), matched anywhere in the text,
  code spans and URLs included, each kept once:
  - a task: `t-` and 1–9 digits, between word boundaries (`\bt-\d{1,9}\b`: `t-12` and `(t-12)`, not `at-12`),
    kept as `t-12`;
  - a change: `owner/repo#N`, with owner and repo of letters, digits, `_`, `.` and `-`, not right after a letter,
    digit, `.`, `/` or `-`, and N of 1–10 digits, kept as `github:owner/repo#N`. A bare `repo#N` is kept only under
    household.json's `github`, as `github:<github>/repo#N`;
  - a note: `note:` at the start of the text or after whitespace, then a path of letters, digits, `_`, `.`, `/` and
    `-`, with any trailing `.` or `/` dropped and none with a `..` segment, kept as `note:<path>`
    (`note:pond/plan.` keeps `note:pond/plan`).

  A `cv-…` id and a URL itself are not work, and are not kept. Cards, asks and errors are never read.
- **Where it's kept.** In household.db, `comms_refs (thread, ref, seq, pos, at)`, with the thread rows: one row per
  thread and ref, holding the newest message naming it (`seq`, its time) and where in it (`pos`, 0 for the first ref
  named). A thread keeps at most 200 refs. Past that, the one named longest ago is dropped: the oldest message's, and
  within one message the earliest named. A ref over 200 characters isn't kept.
- **No words.** A row holds a reference and nothing else: no message text, no title, no state. That's why it may
  outlive the words. The 14-day sweep ("History") leaves `comms_refs` alone, so the panel still lists the work after
  the words that named it are gone. Deleting a thread deletes its refs with it. Being in household.db, the refs are
  in bundles, as thread rows are; the words still aren't.
- **Older threads.** Threads from before the index get one backfill, at the first daemon start after the upgrade (with
  the sweep that runs then). It reads every `message` and `reply` whose `text` isn't null yet, of every thread,
  archived ones included, decrypting each once, and indexes it. Then it writes `refs_backfilled` (and when) into
  household.db's `comms_meta`. A start that finds that row reads nothing. No view ever decrypts history to find refs.
  Threads whose member no longer owns their agent are skipped: nobody can open their panel.

### Made here (provenance)

- **A task's source.** A task can carry `source`, a string like `conversation:cv-0123456789ab` (taskstore-core's
  `it-ts-source`). The tasks CLI sets it:
  - from `--source <kind>:<value>` on `create` and `update`;
  - otherwise from `LOOM_BODY_CONVERSATION` (the runtime sets it in a venue body's environment), as
    `conversation:<cv>`: on `create`, and on an `update` of a task that has no source yet. So a task keeps the first
    thread that made or changed it, unless `--source` names another. **Accepted as a trade-off:** the CLI reads the
    task before its update, outside the write, so two bodies in different threads updating one source-less task at
    the same moment can leave it the second thread's.

  The `run` API carries no environment (extensions.md, "`run`"), so a body in a house passes `--source` itself. loom
  can't make it: the thread's brief gives the conversation as a source to name (section 1, `describe`, without naming
  any piece), and the agent's own guidance (Art's CLAUDE.md, outside loom) asks it to. **Accepted as a trade-off:** a
  house body that doesn't pass it makes tasks that show only when the thread names them, never as made here.
- **A change's source.** A change is made in a conversation only through a task that vouches for it: the task's
  description cites the change, or a comment on the task by one of the household's agents or the owner does, and
  that task's `source` is the conversation. A change's own title, body and branch never count, whoever opened it:
  anyone with access can type into them, and edit them after an agent opened it. So a `cv-` id or a task id written
  on a forge links (changes.md, "Linked tasks") but never makes a change "made here". A change the thread names still
  shows, as mentioned, which claims nothing. The tasks piece's export carries each task's `source` (it-ts-source), and the Changes
  piece already reads that export at each sync: it now keeps, beside the citations, the snapshot's `sources`, a map
  of task id to conversation id for the tasks whose source is a conversation, and nothing else of them. So a change
  made from a new task shows within one sync.

### The thread feed (the seam)

A managed piece offers a thread section the way it offers a project one: `sections.thread` in its `loom` block,
beside `sections.project`.

```jsonc
"loom": { "sections": { "project": { … },
                        "thread":  { "label": "Tasks", "argv": ["loom-tasks", "thread-feed", "--json"] } } }
```

- **The schema.** `thread` has `label` (required, ≤ 40 characters) and `argv` (required, the same rules as
  `project.argv`: 1–16 strings of at most 200, the first one of the piece's own bins), and no other key. Either of
  `project` and `thread` may be declared alone.
- **What declaring it promises:** the piece's `sections.project` feed, if it has one, also accepts `--conversation
  <cv>` (repeated), for "Project hubs" below.
- **What a piece may keep:** nothing. It answers from the refs and the conversation id it's given, and writes neither
  to its store, a log or a file. The refs are the member's pointers, and stay in household.db only.
- **Who's asked.** For a member whose `agents` is `"*"`, every piece declaring `sections.thread`. For a member who owns
  only some agents, only those that also declare `owners: 2` (extensions.md, "The manifest"): the gate every other
  surface applies, so a piece that member can't see answers them nothing here either.
- **The call.** Core runs `argv`, then `--conversation <cv>`, then `--ref <ref>` for each of the thread's refs, newest
  first. On stdin it sends `{caller}`, the same caller a page load sends the piece (extensions.md, "Pages"), so the
  piece scopes what it answers exactly as its own pages do. It goes through the offers runner: 3 s, the process group
  killed afterwards, at most 6 pieces at once.
- **The answer.** One JSON object, ≤ 64 KB:

  ```jsonc
  { "items": [
      { "title": "Fix the comm screen's frame",   // required, ≤ 200
        "ref": "t-1881",                          // required, ≤ 200: the ref, in the index's form
        "status": "Blocked",                      // required, ≤ 24: the state, in words
        "tone": "bad",                            // optional: bad (red CI, a blocked task), warn (waits on you), ok (done)
        "when": "2026-11-05T21:10:00Z",           // optional, ISO-8601 UTC: when it last moved
        "page": "task/t-1881",                    // optional, as a feed item's page; or "href", https only
        "made": true } ] }                        // optional: made in this thread
  ```

  At most 50 items, every key known, at most one of `page` and `href`, each field within its cap and form (`made` may
  also be `false`, read as absent). Any one of
  these broken fails the whole answer, as that piece's failure alone.
- **What each piece answers.**
  - **Tasks:** each `t-N` ref the store holds, and each task whose `source` is `conversation:<cv>` (`made: true`).
    `status` is Open, In progress, Blocked (it has an open blocker), Waiting on you (assigned to the owner: the tasks
    page's "Your call"; to any other member it reads "Waiting on <Owner>", from the caller), Done or Cancelled.
    Blocked is `bad`, Waiting `warn`, Done `ok`. A task whose id is over 200 characters is left out. `when` is the task's `closedAt`, else `startedAt`, else
    `createdAt`. `page` is the task's page.
  - **Changes:** each `github:…#N` ref, from the snapshot, with its Words (changes.md, "Who a change waits on"). CI
    red, Conflicts and Changes asked for are `bad`, Waiting on you `warn`, Merged `ok`. A ref the snapshot doesn't
    hold answers `status: "Not tracked"` and an `href` to GitHub. Every change made in the conversation is also
    listed, `made: true`. `page` is the change's page.
  - **Core** lists each `note:<path>` ref itself: `title` the path, `status` "Note", no link (loom has no note page
    yet).

### The panel

- **The route.** `GET /comms/<thread>/work`, a thread route under rule 3, answers `{items, failed}`.
  - `items` are every piece's items, the pieces in name order, then core's notes, merged. Two items with the same
    `ref` are one: the first answer marked `made` survives whole, else the first answer. Fields are never mixed from
    two. At most 100 are shown.
  - Each item's `page` becomes the URL it opens (`/p/<piece>/<page>`, or loom's own for `loom:`), checked as a feed
    item's page is.
  - The order: `bad` first, then `warn`, then the rest. Within each, the newest `when` first, and items without one
    last.
  - `failed` lists the labels of the pieces that didn't answer.
- **Desktop.** In the thread's band, beside the comm screen: a panel, "Work in this thread", always open, under "In
  this conversation" (the agent and you: a thread has one member), in the same frame style; the band's side scrolls. Each row has its status as a badge in its tone (with words, never colour alone), the title, the ref in mono,
  and "made here" when it was. A row opens the item's page.
  - Empty, it says "Nothing yet. Tasks, changes and notes this thread names or makes show up here."
  - A piece that failed adds one muted line: "Tasks didn't answer."
- **Phone.** A strip under the comm strip, "Work (N)", N the number of items, folded by default and opened with a tap.
  When any item is `bad`, it says so in words too: "Work (5 · 1 needs a look)". Open, it shows the same rows.
- **When it's read.** When the thread opens, 5 s after each new reply, and every 60 s while the thread is on screen.
  Never for the list, and never for a thread that isn't open.
- **Its code** is part of the Comms chunk. Nothing is added to the first page.

### From: the other direction

A piece's page can say where a task or change came from with a new block, `{"type": "from", "conversation":
"cv-…"}`. Core replaces it before the page is drawn, wherever it sits (a section, a `details`, a panel row's sheet), so
no piece ever sees a thread's title or member:

| The conversation | The viewer | Drawn as |
|---|---|---|
| a Comms thread | its member, who owns its agent | a link, "From: <title>" (or "From: New thread with <Agent>"), to the thread |
| a Comms thread | another owner of its agent | text, "From a Comms thread": no title, no link |
| a Comms thread | a member who doesn't own its agent | text, "From a conversation" |
| anything else, or unknown | anyone | text, "From a conversation" |

A member who doesn't own the agent can't see its conversation records (rule 2), so they aren't told a thread exists.

- The thread's link is `loom:comms/<thread>`, which opens `/comms/<thread>`. It joins the `loom:` pages a link may
  name. Comms' own routes still
  refuse anyone but the thread's member (rule 3), so the link is only a look.
- **The tasks piece** shows the block in a task's side column when its `source` is `conversation:<cv>`.
- **The Changes piece** shows it on a change's page for the conversation the change was made in (above).

### Project hubs

A thread filed under a project already feeds its hub (section "Project" above). Its work does too:

- the hub passes `--conversation <cv>` for each of the project's filed threads, archived ones included, newest `last`
  first and at most 200, to the `sections.project`
  feed of each piece that also declares `sections.thread`. Pieces that don't declare it get the same arguments as
  before, since an older feed refuses a flag it doesn't know;
- the tasks piece adds tasks made in those conversations to the project's section. The Changes piece accepts the flag
  and adds nothing: a change counts as made in a thread only from a repo the project already names, and its section
  already lists those.


## Edits this forces elsewhere

- **agent-runtime.md**, section 5, "Outbound": the three adapter calls as built, and a venue core adapts (`adapter:
  "core"`). Also a new "Activity" paragraph: the capture, for `loom` conversations only. (In this PR.)
- **bridges.md:** a note that `loom` is the venue core carries itself, under the adapters' rules. (In this PR.)
- **conversations.md:** `loom` joins core's venues, the digest-project fallback gains the thread's project, the
  hub's `conversations` section also takes a thread's project, and open questions gain the history decision. (In
  this PR.) Rule 4 gains the exception the owner ruled for. (In this PR.)
- **projects.md:** the `conversations` section includes a thread's project. (In this PR.) The item shape is unchanged.
- **extensions.md** (in this PR):
  - "Who may deliver what" gains: "Core's own delivery (source `loom`: the owner's words from loom's page, and Comms)
    isn't a piece's, and skips the piece checks."
  - `GET /api/loom/venues` lists core's `loom` with piece `loom` and `adapter: "core"` in place of `send`.
- **ui-app.md** (in this PR):
  - the dock gains Comms, for a member who owns an agent;
  - "Live" says a Comms thread has its own stream, and that the shared stream's `change` can be scoped to one member;
  - Comms is its own chunk, outside the first page's budget;
  - the face states gain `talking`, which falls back to `done`'s animation, then `working`'s.
- **The runtime (loom-box):**
  - `VENUE_KIND.loom`;
  - core-adapted venues in its adapter calls (`adapterCall`, `sendOnce`, `announce`, `presencePass`);
  - tier 3 for `loom` from source `loom`;
  - the `deliver end <conversation>` verb, owner calls only;
  - activity capture in the Claude and Codex runners and the body host.
- **The approvals piece:** `--conversation` on request, and in its manifest's ask.
- **extensions.md, MCP:** `comms_title` is a core tool name, so a piece offering one by that name is refused at
  install.
- **src/household.ts:** household.json's `comms_days` (1–14, default 14), checked when the household loads.
- **src/bundle.ts:** `comms.db`, `comms.key` and `comms.salt` are left out, and an export refuses a staging that holds
  them, as for the audit log.
- **CONTEXT.md:** Comms, Thread, Message (in Comms), Activity.
- **Work in this thread** (in its PRs):
  - extensions.md: `sections.thread` beside `sections.project`, the `from` block, and `loom:comms/<thread>` among the
    `loom:` pages;
  - projects.md: the hub's `--conversation` for pieces that declare `sections.thread`;
  - changes.md: the thread feed, a change's conversation, and its `from` block;
  - conversations.md, rule 4's exception: the refs index holds no words, so it may outlive them;
  - taskstore-core: `it-ts-source`; the tasks piece's `thread-feed`, its `--source` flag and its `from` block;
  - Art's CLAUDE.md (outside loom): pass `--source conversation:$LOOM_BODY_CONVERSATION` when working in a thread.

## Acceptance criteria

**loom (vitest)**

1. **Owners only, enforced by the server.**
   - A member whose `agents` is `["pond-bot"]` gets a `403` on every thread route in "Routes", for a thread of `art`,
     in both its JSON and its page form. `POST /comms/new` with `agent: "art"` is a `403` too, and `GET /comms`
     doesn't list the thread.
   - With `agents: "*"`, the thread's own member gets every route.
   - A second owner of `art` gets a `403` on every thread route of the first owner's thread.
   - An agent token, a piece token and a `runtime` token on any page route are refused. A page session on either
     `/api/loom/comms/…` route is refused.
   - `GET /comms/<thread>/events` is a `403` for the `pond-bot` member and for the second owner of `art`.
   - With the thread's member, the second owner and the `pond-bot` member each holding `GET /events`, a reply sends
     `change` only to the thread's member.
   - After the member's `agents` is changed so they no longer own `art`, their open thread stream gets no further
     event, and the next request on it is a `403`.
   - A write without the session's anti-forgery token is refused.
   - `conversation({id})` and `loom:conversation/<id>` for a thread's conversation, read by another owner of `art`,
     contain none of a planted message's words.
2. **The venue.**
   - `GET /api/loom/venues` lists `loom` with `kind: "live"`, piece `loom` and `adapter: "core"`, and no `send`.
   - A piece declaring `loom` is refused at install.
3. **Sending.**
   - A member's message delivers `{id: "comms:<thread>:<id>", venue: "loom", place: <thread>, from: {kind: person,
     slug: <member>}, kind: message}` through core's own delivery.
   - The same id again, after a delivered send, answers the first answer: one message row, one delivery.
   - `POST /comms/new` twice with the same member and id answers one thread, with one message and one delivery.
   - An id of 15 or 17 characters, or with `0`, `1`, `8` or an uppercase letter, is a `400`.
   - Empty text, and text of 40,001 characters, are a `400`.
   - Two threads' places differ, match `^th:[a-z2-7]{10}$`, and are the same when made again with the same salt. With
     another salt the same member, agent and id give another place, and no place equals the unkeyed SHA-256's.
   - `new` with the same id and another agent, or other text, is a `409`.
   - A thread id that never existed, and another member's thread, both answer `403`, with the same body.
   - In one thread, the same message `id` with different text is a `409`.
   - A member's title over 60 characters, or with a line break, is a `400`.
   - With the runtime answering `503`, the message is kept with `delivered: false`, and Send again with the same id
     delivers it once.
   - With the runtime taking 20 s to answer, `send` answers at once, the message is `sending` the whole time (never
     "Not delivered"), then `delivered`, with no error recorded. Send again tapped three times while it's on its way
     delivers it once. A `sending` message past 15 minutes reads `failed`, with its error line (t-1881). A store made
     before t-1881 gains its new columns in place.
4. **The adapter route.**
   - `post` for a live thread answers `{ok: true, id}` and adds a `reply` message.
   - `post` with `on: "Codex"` keeps `{on: "Codex"}` as the reply's card, and nothing else. `on` of another shape (markup,
     two words, over 24 characters, not a string) leaves the card empty.
   - `post` answers `{ok: false, permanent: true}` for each of: an archived thread, a deleted one, an unknown place,
     another agent's thread, empty text, and text over 40,000 characters.
   - `describe` answers `readers: [<member>]`, and carries the project line only when the thread has a project, and
     the title line only while it has no title.
   - `status: working` shows the working line (`<NAME> · working · m:ss`) and `done` clears it.
   - With no `working` and no activity for 90 s, the working line clears on its own (t-1881).
   - After Stop, exactly the next `status` call answers `stop: true`.
   - Only a `runtime` token reaches the route.
5. **Activity.**
   - Cards are accepted only for a `loom` conversation with a live thread (`409` otherwise).
   - A post of 51 cards is refused whole.
   - In `comms.db`, a stored card's summary is an age blob, never plain.
   - A card with a `summary` over 120 characters, or with a line break, makes the post `400`.
   - A second card with the same `id` updates the first's `state`, and adds no message.
   - Cards appear in `since/<seq>`.
   - `before/<seq>` returns the 100 messages before `seq`, in order.
6. **Title.**
   - `comms_title` works only in a `loom` conversation. It refuses over 60 characters, a line break, and any title
     after a member's rename.
   - The title becomes the conversation's `label`.
7. **Project.**
   - A thread's project is used for a digest that names none. It wins over a different project whose
     `links.venues` names the same `loom:<place>`.
   - The hub's `conversations` section lists the thread's conversation before its first digest.
   - A slug that isn't one of the agent's live projects is a `400`.
8. **Unread, pin, archive, delete.**
   - Unread counts threads whose newest `reply` is past `read_seq`. `read` never lowers `read_seq`.
   - A member's ninth pin is a `409`.
   - Archiving hides the thread from the default list, calls the runtime's `deliver end <conversation>` (the fake
     runtime sees it), and refuses sends
     (`409`) until it's unarchived.
   - Delete removes the row and every message of it. After it, the thread's routes answer `404` to its member.
   - A deleted thread leaves exactly a `comms_deleted` row (id, member, agent, channel, at), and another member asking for it gets
     the same `403` as for one that never existed.
   - `comms.db` has `secure_delete` on (`PRAGMA secure_delete` answers 1), and after a delete the file holds none of a
     planted message's bytes.
9. **History.**
   - After the sweep, a message or card older than `comms_days` (14 by default) has `text` null, and its row stays.
     With `comms_days: 3`, it sweeps at 3 days. A household with `comms_days` 0, 15 or not a whole number fails to
     load, naming the setting.
   - The sweep runs at daemon start: a message stored 15 days ago in a stopped daemon's `comms.db` has no text once the
     daemon is up.
   - `comms.key` and `comms.salt` are made with mode 0600.
   - `GET /comms/<thread>` shows the thread's digests in place of the swept words.
   - Text decrypts with `comms.key`, and not with another age identity.
   - A thread reads in loom's own process, with no age program installed; a message the library can't read is read by
     the program, logged once a read without its words or the key; a message changed under it, or a new `comms.key`,
     reads as it is now (nothing decrypted is kept between reads); with neither a key the library takes nor the
     program, a read is `503 no-age`, and with a `comms.key` missing or not a plain file, a `503`. What the library writes, `age -d` reads, and the reverse
     (`src/comms-age.integration.test.ts`, t-1926).
   - An open thread whose read is refused (`comms.key` gone) says "Can't open this conversation right now: loom couldn't
     decrypt it.", keeps the messages it shows under "What's shown here may be out of date.", and **Try again** clears
     it once a read works (`src/ui/comms-refused.integration.test.ts`, t-1937).
   - A planted message's words appear, as plain bytes, in no file under `$LOOM_HOME`.
   - A bundle and `loom export` contain none of `comms.db`, `comms.key` and `comms.salt`.
10. **Live.**
    - A reply sends `message {seq}` on the thread's stream within 250 ms. So does a move of the thread's state with
      no new message (working or done, a message delivered or not, a step done): the event carries the newest seq,
      and the app reads again (t-1881).
    - The event's data has exactly the key `seq`.
    - `since/<seq>` returns exactly the messages after `seq`, in order.
11. **Push.**
    - A reply, while the member has had no app in front for 2 minutes, pushes to that member's subscriptions only.
    - The payload's title and body hold no message text. An untitled thread's push says "Art replied in a new
      thread".
    - With a `read` call on that thread in the last 2 minutes, no push is sent. With `read` calls only on another
      thread, the push is sent.
12. **Asks.**
    - A pending approval whose conversation is the thread's shows in it with Allow once and Deny.
    - Answering it in the thread answers it in the Inbox, and the other way round.
    - An approval with no conversation, or another agent's, isn't in the thread.
    - An open `needs_owner` digest of the thread's conversation shows in the thread with Yes and No, and a Yes there
      delivers `Yes, to: <ask>` into the thread as the member's message, and answers it in the Inbox.
13. **Errors.**
    - With a fake runtime (or a missing `age`) causing each delivery failure in section 7's table, the thread gains
      that row's error message. Closing the thread's stream mid-turn and reopening it shows the missed messages once.
    - A ninth pin and a send to an archived thread answer a reason in words. No error message or toast is a bare status
      code.
13a. **No reply.** The runtime's `status: done` with `replied: false` and a run gives the thread one "Art finished without replying."
    message with **What happened** (the trace's link), live; the same run said again adds nothing; a `done` without
    it, or on `working`, adds nothing; and the face leaves `thinking` for `idle`.
14. **Links.** In a reply, `t-12`, `acme/app#3`, `note:pond/plan` and `cv-…` render as their links, and an `http://` or
    `javascript:` URL renders as plain text. Rendering a reply makes no network request.

**The runtime (node --test, with `fakeRunner` and a fake core)**

15. A delivery on `loom` starts, feeds and resumes a body as a Slack one does. `describe`, `status` and `post` go to the
    core adapter route, never to an argv. The body's brief carries `describe`'s lines, and its sender is tier 3 with
    no gates read (the fake gates doc is empty).
16. Activity is captured from a Claude transcript fixture (real lines from a `claude --bg` session, kept in the
    runtime's `test/`) and a Codex `events.jsonl` fixture (from a real `codex exec --json` run).
    - A Bash call shows its `description` and never its command.
    - A `text` or `thinking` entry, and a Codex `agent_message`, make no card, and none of their words reach one.
    - A file read shows a path relative to the repo, never one starting with `/`.
    - A Claude `tool_use` makes a `running` card, its `tool_result` makes it `done`, and one with `is_error: true`
      makes it `failed`. A Codex `item.started` makes a `running` card, and `item.completed` with `status:
      "completed"` or `"failed"` makes it `done` or `failed`. Each card's `run` is the body's run.
    - No result or output text reaches any card.
    - Nothing is captured for a `slack` conversation.

**The app (Playwright, phone and desktop viewports)**

17. The comm screen draws the agent's sprite at a whole-number scale ≥ 2, or its drawn face without one. Its face
    state follows the table: a fake thread stepped through started, a card, a reply, done, a pending ask and a
    failure shows `thinking`, `working`, `talking`, `complete`, `needs-input` and `error` in turn (by `data-face`).
    - With a card arriving while an ask is pending, it shows `needs-input`. With a failure while an ask is pending, it
      shows `error`.
    - A reply sets `data-signal="on"` for 250 ms (±50) before `data-face` becomes `talking`. With reduced motion it's
      never set.
    - A manifest without `talking` shows `data-anim="done"` for it, and one with neither shows `working`.
    - A 400-character reply plays exactly 3 talking beats, then done. A 2,000-character one plays 4. A second reply
      landing during the second beat of a 3-beat run ends it at 4. Each gap between two talking beats is 400–1200 ms
      of the rest frame. With reduced motion, no talking beat plays.
    - The frame's label reads `<NAME> · CH <nn> · LINK OK` with the stream open, `LINK LOST` with it closed, and
      `NO CARRIER` after a failed delivery. A reply posted with `on: "Codex"` adds `· ON CODEX`, and the next reply
      without it takes it away. A member's third thread with an agent is `CH 03`, and stays `CH 03` after
      the first is deleted.
    - The desktop's band shows who's in the conversation (the agent, you) and a phone's thread has no band.
18. The list, a thread and the composer load with no console errors and no sideways scroll. On a phone viewport with
    the keyboard open (a resized visual viewport), the composer stays visible above it. The desktop shows two panes,
    and one at a time when the Comms box is narrower than 1100 px (a narrow tile, a mid-size window): the list, then a
    thread or New thread with the list in a drawer; 1099 px is one pane, 1100 two, and an open thread stays mounted
    across the edge.
    The dock has a Comms key for a member who owns an agent, with the unread count, and none for a member who owns
    none.
19. The JS and CSS budgets still pass. Comms loads as its own chunk.

**Work in this thread** (its own section; its numbers continue these)

**loom (vitest)**

20. **The index.**
    - A member's message "see t-12, acme/app#3 and note:pond/plan" and a reply "made t-40" leave `comms_refs` holding
      exactly `t-12`, `github:acme/app#3`, `note:pond/plan` and `t-40` for the thread. A bare `app#3` is kept as
      `github:<github>/app#3` only with household.json's `github` set. A `cv-…` id and an `https://` URL aren't kept.
    - A planted word from the message that is part of no ref is in no `comms_refs` column, and household.db's file
      doesn't contain it.
    - `at-12`, `x/acme/app#3` and `notes:x` aren't kept; `note:pond/plan.` is kept as `note:pond/plan`.
    - After the sweep has nulled the words, the refs are still there. After a delete, none are.
    - With a message naming t-1 then a later one naming 200 others, t-1 is dropped; within one message of 201 refs,
      the first named is.
    - A daemon start with a thread whose messages predate the index indexes them and writes `refs_backfilled` to
      `comms_meta`. A message added straight to `comms.db` after that, with no index row, is still unindexed after a
      second start.
21. **The feed.** With two fake pieces offering `sections.thread`:
    - `GET /comms/<thread>/work` runs each with `--conversation <cv>` and one `--ref` per ref, newest first, and
      `{caller}` on stdin;
    - it answers their items merged, one per `ref` (`made` kept), `bad` before `warn` before the rest, newest first
      within each, with core's note items;
    - a piece answering an unknown key, 51 items, a 25-character `status` or a non-zero exit is in `failed` by its
      label, and the other's items are still there;
    - when both answer the same `ref`, one marked `made`, the panel has that one's whole item;
    - for a member whose `agents` is `["art"]`, a piece without `owners: 2` isn't run, and one with it is, even when
      its manifest shows nothing else;
    - the route is a `403` for the `pond-bot` member and for a second owner of `art`, as every thread route is;
    - a `sections` block with a `thread` lacking `label`, with an unknown key, or whose `argv[0]` isn't one of the
      piece's bins, is refused at install; one with only `thread` is accepted.
22. **From.** A piece page carrying `{type: "from", conversation}` for a thread's conversation shows the thread's
    member "From: <title>" linking to `/comms/<thread>`. A second owner of the agent gets "From a Comms thread", and
    the `pond-bot` member "From a conversation"; for both, the page's HTML and JSON hold neither the title nor the
    thread id. Another venue's conversation shows "From a conversation".
23. **The hub.** A thread filed under project `p` makes the hub pass `--conversation <cv>` to a piece declaring
    `sections.thread`, and not to one that doesn't.

**The tasks piece (taskstore, vitest)**

24. `create --source conversation:cv-…` holds it, and `show` returns it. With `LOOM_BODY_CONVERSATION` set, a create
    without `--source` holds `conversation:<it>`, an update of a task without a source sets it, and an update of a
    task with one leaves it. `thread-feed --conversation <cv> --ref t-1` answers t-1 with its title and status, and
    each task made in `<cv>` with `made: true`; a task blocked by an open one is `Blocked`, `bad`. A task page shows
    the `from` block for a task with a `conversation:` source, and none for one without. Its project feed accepts `--conversation`
    and lists a task made in that conversation. `thread-feed` leaves the store file unchanged.

**The Changes piece (python unittest)**

25. `thread-feed --conversation <cv> --ref github:acme/app#3` answers that change with its Words, CI red as `bad`;
    an unknown ref as "Not tracked" with a GitHub `href`; and a change cited by the description of a task whose source
    is `conversation:<cv>`, or by an agent's comment on it, with `made: true`. A change whose title, body or branch
    carries `<cv>` isn't made, an agent's or anyone else's; nor is one only a non-agent's comment cites; nor one whose
    own text cites a made task that never cites it back. A change page for such a change has
    the `from` block.

**The app (Playwright)**

26. At 1280 px the panel sits in the right column under YOU, and lists a thread's fake items in the route's order with
    their status words. At 390 px, "Work (N)" is folded with N the item count and "1 needs a look" for one `bad`
    item, opens on a tap, and nothing on the page is wider than the viewport. The first-page JS and CSS budgets still
    pass.

## Order

Each step ships on its own.

1. **Core:** the venue, threads and messages, the routes and their owner checks, the adapter route, sending, the title
   tool, the history store as decided, live events, push, errors and links. Criteria 1–11, 13 and 14.
2. **The runtime:** the core-adapted venue and tier (15), then activity capture (16). Core's side of activity (5)
   ships in step 1.
3. **The app:** phone, then desktop, with the comm screen (17–19).
4. **Asks inline,** with the approvals piece's `--conversation` (12).
5. **Stretch, later:** several agents in one thread.
6. **Work in this thread:** the pieces first (taskstore's `source` and `thread-feed`, Changes' `thread-feed`), then
   core's index, route, `from` block and the panel (20–26).

## As built (the app, t-1876)

Points the first version settled or left for later:

- **Task links** go to the tasks piece's page for the task (`/p/tasks/task/t-N`), as the Inbox's sheet links them.
- **`note:<path>`** is set as code, not linked: loom has no note page yet.
- **Inside links** are links only to the allowed pages (a task, a conversation), checked again on the click against
  this origin. An inside-looking URL an agent writes is left as its words.
- **Later:** new messages don't yet decode in through `arrive.tsx`; Find (⌘K) lists the Comms app but not threads by
  title; a swiped-away row has no Undo toast (a long press pins; a swipe or long press never also opens the row); the
  phone keyboard inset isn't covered by a browser test.
- **The comm screen's** compact strip shows the agent's small static avatar (`AgentAvatar`), never the portrait scaled
  down; its `data-face` follows the player's own beats (talking, then done, then the thread's state).

## As built (asks inline, t-1876)

- **Read live, not stored:** a thread's asks are read from the pieces' manifests on each thread read (and every 30 s
  while it's open), matched by conversation **and** agent, from the pieces the viewer may hear from (the Inbox's own
  filter), and only those that need the owner (`attention` not false). They aren't written as `ask` messages.
- **Later:** a digest's `needs_owner` inline with Yes and No (it's answered in the Inbox for now); an answered ask
  leaving a line in the thread ("Allowed by Jonathan").

## Open questions

- **Token-by-token streaming:** not in this design (see section 4). Revisit once he's used it.
- **The name.** "Comms" it is, unless he prefers another. Others considered: "Wire" (terse, but reads as a news feed)
  and "Channels" (Slack's word, and conversations.md avoids it).

## Sources

The owner's words and rulings above come from conversations with the agent on 2026-11-05. They're provenance only:
nothing here needs them to be built. What the runtime does today was checked in loom-box at b908878 (`src/runners.mjs`,
`src/delivery.mjs`, `src/policy.mjs`, `src/bodyhost.mjs`, `src/statusline.mjs`, `src/models.mjs`), and the adapter
pattern in loom-discord at 93a213d and loom-slack at 8d47373.

## Review gate

Before this doc merges, a context-stripped reviewer reviews it, and every finding is folded, accepted as a trade-off,
or rejected with a quote.
