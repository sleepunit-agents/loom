# Boards: a conversation with a second window the agent fills from bricks

*2026-11-27. Status: **built and running on the owner's household**, on the branch `art/boards`; draft as a document.
Cold-reviewed four times (three rounds on 2026-11-26, one on 2026-11-27 against the code); every round was blocking
and the last one's findings are folded here without a further round. This fixes the records, the operations and the
behaviour. It does not fix the look. What is built, what was only run by hand and what does not exist are said where
they apply, and gathered at the end of "Checks".*

> **The only page after sign-in, since 2026-11-28 (t-2428).** The desktop was removed (the owner: "toss it. it'll still
> be in git after all."). This page is the one a member reaches after signing in; every other address of loom's is
> the sign-in gate ("Sign-in, and the addresses that are not this page's", under "The page"). Where this spec says
> "the desktop's X" or "as on the desktop", it names where a brick's reads, words and rules were taken from; those
> files are in git before that day. What it once left to the desktop is gathered under "Not on any page since the
> desktop went", at the end of "The page".

## Why

> "does a future OS that's managed by an agent have apps? lain doesn't click email. she asks navi about her messages.
> and while she's doing that, she's not overwhelmed with folders and icons and bullshit. its just, here's the message."
> — the owner, 2026-11-26

> "it's a polished chat interface, mimicking what we're getting here in claude code, stapled to a second window where
> you're able to show me related loom shit. I say I want to know what's happening as progress happens, you pop up the
> kanban board for that project and it just autoupdates with websocket shit on its own so now I'm just watching it move
> over there while we talk." — the owner, 2026-11-26

> "that *design* being stored in the db, rather than the data itself which still gets pulled, means not only can you
> return to the same view, but you can mutate from it." — the owner, 2026-11-26

> "this is lego. you're building with bricks and using your imagination to do it. if we discover we want a new brick,
> we don't cobble that shit together out of paper. we go to our brick factory and think it through and make a new brick
> and now everybody's got a new brick to use." — the owner, 2026-11-26

The branch built a ticket page, a project page and a people directory by hand and put a conversation beside them. No
agent took part in what was drawn. The agent could not put anything on the screen and was told what the member was
looking at by a line of text glued to the front of each message. The member could read records and could not act on
them.

Here the conversation is the main thing. Beside it is a second window, the board, which the agent fills. The agent
chooses from a fixed set of parts and never draws. What it chose is a record, so the board can be returned to, linked,
changed in place, and reused.

## What this leans on

Things that exist today and are used as they are. An implementer should read them first.

- **Thread**: one Comms conversation between a member and an agent (`threads` in `src/core/data/schema.ts`; the word is
  in `CONTEXT.md`). The branch calls a thread a "context"; this spec does not.
- **`comms.send`**: the operation by which a member's words, and files, enter a thread. A send starts a job for the
  thread's agent. Files stay exactly as the branch has them.
- **Job mail**: what a job's body is handed when it starts (`src/runtime/body-program.ts`).
- **Live reads**: every loom page reads the shared schema through `useDataQuery` (`web/src/data/graphql`), which keeps
  a result current as rows change and applies each table's visibility rule to the signed-in member.
- **The operation layer**: operations are registered with an input schema and run for a viewer (a member, or a job's
  body). A write carries a command id, and a repeat with the same id returns the first result. Suites call operations
  with a constructed viewer and no model. Everything under "Records", "Operations" and "What the agent is told" is
  built and tested this way.
- **`tasks.command`** and the inbox and approval operations: what the desktop calls to change a ticket, answer a
  question or decide an approval.
- **Work trace**: the nested tool and subagent steps drawn in the conversation (`web/src/pair/work-tree.ts`,
  `src/runtime/pair-events.ts`, tested from recorded harness output).
- **Presence**: the agent's portrait, name and one status line, as the branch draws it. The line is worked out on the
  page from the thread's `working` flag, its waiting inbox items and its unread replies (`quickPresence` in
  `web/src/pair/main.tsx`). It needs no new record.
- **Fit**: an app's declaration of the room it can use, defined in `docs/specs/desk-tiling.md`. Bricks declare the same
  four numbers per form: minimum, ideal and maximum width, and minimum height, in px.

## Words (to be added to CONTEXT.md)

**Brick**:
one kind of thing that can be shown: a ticket, a person, a project's lanes, a trend. Loom ships it. It takes typed
parameters and reads its own data, live, as the member looking.
_Avoid_: module, widget, card, component

**Form**:
one of the fixed ways a brick draws itself. **Primary**, **side** and **compact** are the forms a placement can take on
a board. **Chip** is one line naming the brick and what it is about, used inside words, inside other bricks, and for
folded placements. **Hover** is what pointing at a chip shows. Every brick has side, compact, chip and hover. Primary
is optional: a brick that has it **can be big**. A brick may be small-only. No brick is big-only.
_Avoid_: variant, size, view

**Big**:
the one placement on a board drawn in the primary form: the live placement of lowest rank whose brick can be big. A
board whose bricks are all small-only has no big placement.

**Flag**:
a mark on a placement that says it changed and is worth a look. It moves nothing. A brick raises its own; the agent
can raise one.

**Session**:
one piece of agent work with its own conversation and its jobs: what the agent hands off from the thread, or any other
running work the member may read.

**Board**:
the second window: an ordered set of placed bricks inside one thread. It has an address. It is changed in place.
_Avoid_: view, page, canvas, workspace, context

**Placement**:
one brick on one board, with its parameters and its rank.

**Rank**:
a placement's position in its board's order, counted from 0. Rank decides which placement is big (see **Big**). The
layout turns rank and the room available into a form and a rectangle. Nobody chooses a rectangle.
_Avoid_: zone, core, secondary, tertiary (the owner's earlier words for what rank and screen size now decide)

**Blueprint**:
a saved design: placements, some of whose record parameters are left open, with a name and a description. Opening a
blueprint makes a board. Changing the board does not change the blueprint.
_Avoid_: template, layout, saved view

**Trail**:
a thread's open boards, left to right, in the order they last joined it.

## Rules

1. **Bricks are the only thing that draws on a board.** The agent sends a brick's name and parameters. It cannot send
   markup, a query, a style or a rectangle. Every parameter is a record reference, a choice from a fixed list, or a
   whole number in a stated range; a schema may mark a parameter optional. A **record reference** is shaped like an
   id and nothing else: an ASCII letter or digit, then up to 119 of ASCII letters, digits and `: . _ / @ -`; a ticket
   is `t-` and a number; a person is `member:` or `contact:` and a lowercase slug; a change is `github:`, the
   repository as lowercase `owner/repo`, `#` and a number, which is how loom writes a change's id, and the only
   reference that may hold a `#`; a knowledge page is its slug, which may be 200 long and holds no `:` or `@`. It is checked for shape only, so
   it may name no record, and it is shown only as an id (see "Names" under "The page"). The only free text the agent
   gives a board is its title, which is one clean line (see "Records"). Known limit: an id-shaped string such as `contact:call-me` is still accepted and is
   shown, small and in monospace, beside a brick that says it is unavailable.
2. **A new brick is a change to loom.** It arrives with side, compact, chip and hover, and with primary if it can be
   big; a fit for each board form it has; the changes it flags itself for; a parameter schema with a default for every parameter that is not a record reference, its actions, its link key if it
   has one, tests and a catalogue entry. What that touches, file by file, is "Adding a brick".
3. **The board is the record of what is in the second window.** The page draws the board's placements and nothing
   else there. The address holds one id. The page keeps no board state in the query string, the fragment or the
   browser's storage.
4. **The agent always knows what is on the boards.** Every change the member makes to any board in the thread (looking
   at a flagged placement is not a change) is a
   row, and the agent is handed those rows as sentences: at the start of its next job, or sooner in the result of its
   next board call.
5. **The member decides and does not pilot.** A brick carries the actions loom already has for its record. The member
   can also remove a placement, place a brick by clicking a chip, and make a brick that can be big the big one.
6. **A click never waits for a model.** Placing from a chip starts no job.
7. **A change is drawn when it lands.** Each stored change to the board on screen is drawn at once, while the job that
   made it is still running.
8. **Bricks follow the records.** A brick's data changes on screen when the records change, with no reload and no
   job: within a few seconds of a change made elsewhere (at most about five, as mail arrives), at once after the
   member's own action on the page, and at once when the member asks for it (the placement's refresh control). The
   conversation and the board's own placements are immediate (rule 7): they do not wait those seconds. How, and
   what it costs, is "Live reads and their cost".
9. **The presence and the input are always on screen** on the page of a thread the member owns, at every width, with
   or without a board.
10. **A flag never moves anything, and never starts a job.** What happens in loom and whether an agent is woken for
    it is decided elsewhere and has nothing to do with this page. A session the agent handed off reports back to the
    thread as loom already does; that is a reply, and the agent then decides whether the board changes.
11. **The agent in the thread decides and dispatches.** It may look things up, run a command and use its harness's
    own subagents for reading. Work that writes code or runs long is handed off as a session through loom, so that it
    can be shown. This is judgment; no suite checks it.

There is no note brick. What the agent has to say goes in the conversation.

## Records

Five tables for boards, one for a session's steps and one for the tickets a session is for, all in the shared schema.

**`board_threads`**: `thread`, `since`. A thread that has the second window: its member has sent from this page.
Only in such a thread is an agent told about boards or allowed to open one. A board nobody can see is never made.

**`boards`**: `id`; `thread`; `title` (at most 80 characters, may be empty, stored exactly as given; a **single
clean line**: it holds no control character (Unicode Cc: a line break, a tab), no format character (Cf: a direction
override, a zero-width character, a soft hyphen) and no line or paragraph separator, and a title that does is refused
with the reason, never repaired. The rule has one home, `src/core/line-name.ts`, and a blueprint's name and
description and a session step's tool are held to it too. A title stored before the rule is not rewritten: wherever
loom repeats it, to a job or to the page, the forbidden characters are left out);
`blueprint` (the one it was opened from, or null); `revision` (1 when opened; goes up by exactly one for each later
operation that writes a `board_changes` row); `agent_seen` (a revision; 0 until the agent has been handed the board);
`opened_at`; `trail_at` (when it last joined the trail: set on open and on reopen); `changed_at`; `closed_at` (null
while it is on the trail); `shown_at` (when the member last sent a message with this board on screen, or null). A
board is readable by its thread's member and its thread's agent and by nobody else. A
board is always between one member and one agent. Two members never share one.

**`board_placements`**: `board`; `id` (unique across all boards, never reused); `brick`; `params` (JSON, valid for that brick's schema, stored
with every default filled in); `rank`; `placed_by_kind` (`agent` or `member`); `placed_at`; `removed_at` (null while
live); `flagged_at` (when the agent last flagged it, null once the member has seen it). Among a board's live placements the ranks are exactly 0 to n−1. No two live placements on a board have the same
brick and the same params. A board may have no live placements. Removed placements stay as rows; they are not loaded with the board, only
looked up by id to name one in a sentence. Visibility follows the
board.

**`board_changes`**: `board`; `revision`; `seq` (order within one revision, from 0); `at`; `actor_kind` (`agent` or
`member`); `change` (`open`, `place`, `remove`, `rank`, `title`, `close`, `reopen`, `act`, `maximize`, `flag`);
`placement` (for `place`, `remove`, `rank`, `act`, `maximize` and `flag`, otherwise null); `from_value` and `to_value`
(text, read back as text: the old and new rank for `rank` and `maximize`, the old and new title for `title`, the rank
taken in `to_value` for `place`, otherwise null); `action` (for `act`: the name of one of the brick's actions) and
`detail` (for `act`: JSON matching that action's declared schema, which holds only choices and ids, and, for two
actions alone, a name a member typed: the `secrets` brick's secret name and the `household` brick's token label,
each refused in the shape of a credential; see "The first bricks" and docs/accepted-tradeoffs.md). Placements
shifted by another's `place`, `remove`, `rank` or `maximize` get no rows of their own. Visibility follows the board.

**`blueprints`** (schema 52 added `member`): `id`; `agent`; `member` (the member of the thread it was saved in);
`name` (unique per agent and member, 1 to 80 characters, a single clean line, trimmed); `description` (at most 300
characters, a single clean line, trimmed); `parameters` (JSON: a list of `{name, kind}` in order of first use in the design; kind is one of `session`, `project`,
`ticket`, `change`, `repository`, `person`, `agent`, `inbox item`, `approval`, `knowledge page`, `knowledge topic`);
`design` (JSON: an ordered list of `{brick, params}` in rank order, where a record-reference param's value is either
fixed or `{"open": "<parameter name>"}`); `created_at`; `used_at`; `uses`. A blueprint belongs to its agent and
its member together: it is listed, opened and replaced only by a job of that agent working in a thread of that
member, in any such thread. A job of the same agent for another member does not see it, cannot open it (its id is
answered exactly as an unknown one) and cannot replace it by saving under its name, which makes a blueprint of that
member's own. A thread that is no one member's has no blueprints. No member reads `blueprints`. Deleting a thread
does not delete a blueprint saved in it. The upgrade to schema 52 deleted the blueprints saved before it: a
blueprint had never recorded the board or thread it was saved from, so none could be given its member; a board
opened from one kept its placements and no longer names a blueprint.

**`job_trace`** (schema 49): `conversation`, `seq`, `job`, `at`, `tool`, `card_state` (`running`, `done`, `failed`),
`client_id`, `words`, `keep_until`. One row for each work step the body of a handed-off job reports, under the child
conversation and numbered within it. `keep_until` is 90 days after `at` for a row written since 2026-11-27; a row
written before that keeps the limit it was stamped with then (the Comms keep time of that day, 14 days at most). It is not a board record: it is what the `session` brick's big form reads (see
"Sessions"). `words` is sealed with the household's words key, as a message's words are; `tool` is kept in the clear
and is a single clean line of at most 200 characters. A row is deleted when it is past its keep time. A row is
written only by the body of a job that is that conversation's own, for a conversation whose venue is `handoff`, that
has a member, and whose result returns to that member's open thread, and never for a job working on anybody else's
word; a step for any other is refused, and all of this is checked by loom at the door, not only by the body. No row is written to `messages`, `turns` or
`threads` for a step.

**`conversation_tasks`** (schema 50): `conversation`, `task`. One row for each ticket a handed-off session was said
to be for: the ids the handing-off agent gave as `tickets` in `conversation.handoff`. It holds no words. It is not a
board record: it is what the `ticket` brick's "Sessions" reads (see "A ticket's sessions"). A row goes when its ticket
or its conversation row is deleted, and when the thread the session was handed off from is deleted; nothing in loom
deletes a conversation row today. Nothing writes a row but
`conversation.handoff`.

A board holds no record data and none of a conversation's words. The one exception is the two typed names an `act`
detail may hold (a secret's name and a token's label, above): never a value, a description or a sentence.

## Operations

All are registered in the operation layer. A repeat with the same command id and a different input is refused. Writes
to one board are applied one at a time in the order they arrive; a rank given in a call is read against the board as it
is when that change is applied, the changes of one call being applied in order.

### For the agent

These are the operations as a job's body may call them, and only for boards in that job's own thread, only when
that thread has a `board_threads` row, and only for blueprints of that job's own agent and that thread's member;
anything else from a body is denied. Where a member may call an operation of the same name, what
the member may pass is under "For the member".

- `bricks.catalogue()` → for every brick: name, one line on what it shows, parameter schema with defaults, which
  parameters are references and of what kind, link key, whether it can be big, what it flags itself for, and its
  actions. Any member may call it too; it holds nothing private.
- `blueprints.list()` → every blueprint of this agent for this thread's member: id, name, description, parameters, uses. The agent chooses by
  reading. There is no search in this version.
- `boards.list()` → every board in the thread, open ones in trail order and then the closed: id, title, open or
  closed, `trail_at`, and its big placement or null.
- `boards.open({title?, blueprint?, arguments?, place?})` → a new board, last on the trail, at revision 1, with an
  `open` row. A missing title is empty. `place` is one `{brick, params?}` and cannot be given with a blueprint.
  With a blueprint, `arguments` must name every parameter and nothing else, or the call is refused. Each open param is
  filled, each placement is checked against its brick's schema, and if any fails the call is refused and nothing is
  stored. If two filled placements have the same brick and params, the call is refused. The placements are made in
  revision 1, one `place` row each, and the blueprint's `used_at` and `uses` are
  updated.
- `boards.change({board, changes})` → `changes` is one to 40 of:
  - `place {brick, params?, rank?}`: a missing record-reference param is refused unless the brick's schema marks it
    optional (only `repository`'s `project` is); other missing params take the brick's defaults. Without `rank` the
    placement goes last.
    With `rank` r, from 0 to n, it takes rank r and every live placement at r or later moves down one. Refused if,
    after defaults, a live placement has the same brick and params.
  - `remove {placement}`: live placements after it move up one.
  - `rank {placement, rank}`: rank from 0 to n−1; the ones between shift by one.
  - `title {title}`.
  - `maximize {placement}`: refused unless the placement's brick can be big, and refused on the big placement. It
    takes the big placement's rank; the placement that was big follows it, first among the small; the rest keep their
    order.
  - `flag {placement}`: sets `flagged_at`. It takes no words. Flagging a flagged placement sets the time again.

  A rank outside its range is refused. The changes are applied in order, in one revision; if any is refused, none is
  stored. A call on a closed board is refused.
- `boards.read({board, since?, limit?})` → the board, and the `board_changes` rows with a revision greater than
  `since` (default 0), oldest first, at most `limit` rows (100 by default, from 50 to 500) and always whole
  revisions; `more` is true when there are later rows, and the caller reads on with `since` set to the last revision
  it was given.
- `boards.close({board})`, `boards.reopen({board})` → each writes its row and raises the revision. Closing a closed
  board, or reopening an open one, is refused. Reopening sets
  `trail_at`, so the board is last on the trail.
- `blueprints.save({board, name, description, placements})` → `placements` is an ordered list of `{placement, open?}`
  naming which live placements to keep, in the order given. `open` maps a record-reference param of that placement to
  a parameter name, for example `{"project": "project"}`; other params cannot be opened and keep their values. Two
  params may share a parameter name only if they are of the same record kind. The save is refused if two entries of
  the resulting design have the same brick and the same params. Saving under a name this agent already uses for this
  member replaces that blueprint's description, parameters and design and keeps its `id`, `uses` and `used_at`. A
  name or a description that is not a single clean line is refused.

`boards.open`, `boards.change`, `boards.close` and `boards.reopen`, called by the agent, return: the board's id (as
`board`), title, revision, whether it is closed, its live placements in rank order, each with its id (as `placement`),
brick, params, rank and whether it is flagged; the same as text; and **meanwhile**, the member's `board_changes` rows
with a revision greater than `agent_seen`, as sentences (the latest 50, then a line counting any earlier ones). The call then sets `agent_seen` to the board's revision. So a
member change to a board made while a job is running reaches the agent in the next writing call it makes on that
board. A change to another board waits for the next job's brief. `boards.read` returns the board and the rows it was
asked for, with no meanwhile, and leaves `agent_seen` alone. `blueprints.save` returns the blueprint's id, name and
parameters. A member's call returns the board's id and revision and nothing else: the page has the rest by its live
read.

### For the member

Each is denied unless the caller is the thread's member.

- `boards.open({thread, place})` → a board with an empty title holding that one placement, at revision 1, with an
  `open` row and a `place` row.
- `boards.change` with `place` (no `rank`: it goes last), `remove` and `maximize` only. A member `title`, `rank`,
  `flag`, or `place` with a `rank` is refused.
- `boards.seen({board, placement})` → clears `flagged_at`. It writes no `board_changes` row and does not raise the
  revision. The page calls it when the member points at or clicks a flagged placement.
- `boards.close`, `boards.reopen`.
- `boards.act({board, placement, action, detail})` → refused unless the placement is live on an open board, `action`
  is one of its brick's actions, and `detail` matches that action's schema. Writes an `act` row and raises the
  revision. The page calls it after the action's own operation has succeeded. The record acted on is the placement's.

`boards.act` records what the page reports. It does not prove the action happened. The owner accepted this on
2026-11-26: "its always a two player game where one player is an agent". The only caller is the thread's own member,
and the only reader is that member's agent, which can read the record itself. So the agent is told it as a report
and not as a fact ("The member's page reported: used approve on …"), and its standing instructions tell it to read
the record itself before relying on a reported action. Two reports have no record the agent can read: a secret's
value set or removed (`secrets`) and a token made (`household`). For those the reasoning is only the first half: the
caller is the thread's own member, who could as well type "I saved PUMP_TOKEN" in the conversation, so a false report
is no more than a false sentence from the same person, and it is still told as a report. `boards.act` checks that
the caller is the thread's member and that the detail fits; it does not check that the member is an owner or that
the secret or token exists.

The page reads `boards` and `board_placements` through live reads: the thread's boards for the trail, and the shown
board's live placements.

### What is refused, and what is not

A `place` with an unknown brick, or params that fail the schema, is refused with the reason. A `place` whose params are
well formed but name a record that does not exist, is of another kind, or that the member may not read, is accepted:
the brick draws "unavailable", the same in each case. Operations check shape. Visibility stays in the read.

## Limits

Each number is written once, in `src/core/boards/limits.ts` (boards) or `src/core/conversations/job-trace.ts` (a
session's steps). A call that would pass one is refused with a message that says what to do instead. Nothing is
closed or deleted to make room.

- Open boards on one thread's trail: 20. Opening or reopening past it is refused: close one, or change one.
- Boards one thread has had, open and closed: 200. Opening past it is refused: reopen a closed one or change an open
  one. There is no way to delete a board short of deleting the thread.
- Live placements on one board, and placements one blueprint keeps: 40.
- Changes in one `boards.change` call: 40.
- Blueprints of one agent for one member: 100. A new name past it is refused; saving under an existing name still
  replaces that one. There is no operation that deletes a blueprint.
- A brick's `params`, an action's `detail` and a blueprint's `arguments`, checked before the brick's own schema reads
  them: at most 40 names, each of at most 80 characters, and at most 8,000 characters as JSON.
- `boards.read`: 100 change rows by default, from 50 to 500 when asked, whole revisions only.
- Sentences about the member's changes handed to a job at once, in a brief or in a call's meanwhile: the latest 50,
  then one line counting the earlier ones. All of them are marked told.
- A session's steps: 2,000 for one job and 10,000 for one handoff conversation. A step past either is refused and the
  body drops it; the work and its reply are not affected. A step's words are at most 100,000 characters at the door
  and the body cuts them at 16,000; its tool is at most 200 characters.
- `sessionTrace`: 100 steps by default and 200 at most in one read.

`board_changes` rows and removed placements are never deleted while their thread exists, so both still grow with
use; what is bounded is how much of them any one call loads or returns.

## What the agent is told

`comms.send` gains one optional field, `shows`: `{"board": <id or null>}`. The page always sends it, with the id of
the board on screen or null. The send writes the thread's `board_threads` row if it has none and, for a board, sets
that board's `shown_at`. A board that is not in the thread refuses the send. Nothing is added to the member's words;
the bracketed prefix goes.

When a job starts in a thread with a `board_threads` row, its body calls `boards.brief` before it reads its mail, and
is told what the reply says, after a fixed paragraph on how to fill a board (the standing instructions below). In any
other thread the call is refused and the body is told nothing about boards. `boards.brief` does three things, in one
transaction:

1. Picks the **shown** board: among the thread's boards, the one with the latest time, where a board's time is its
   `shown_at` if that is later than its `trail_at`, otherwise its `trail_at` if it is open, otherwise it has none. So
   it is the board the member last sent from, unless one has joined the trail since. It may be closed: the text then
   says the member last sent from it and that it has since been closed, not that they are looking at it.
2. Builds the text with the pure function `boardBrief(shown, boards)`, where each board comes with its placements
   (live ones, and removed ones named by an unseen change) and its member `board_changes` rows with a revision greater
   than its `agent_seen`.
3. Sets `agent_seen` to the current revision on the shown board and on every board with unseen member changes.

The text reads, for the shown board: its id, its title, whether it is open or closed, and its live placements in rank order, each as placement id,
brick and params. Then, for every board in the thread with unseen member changes, one sentence per row, naming the
board by id and the placement by brick and params:

- `open`: "The member opened board B." (its first placement follows as a `place` sentence)
- `place`: "The member placed person(person=member:jonathan) on board B."
- `remove`: "The member removed trend(days=30, project=loom) from board B." Params are written in name order.
- `close`, `reopen`: "The member closed board B." / "The member reopened board B."
- `maximize`: "The member made trend(days=30, project=loom) the big one on board B."
- `act`: "The member's page reported: used close on ticket(ticket=t-2441) on board B." An action whose detail is not
  empty ends ": " and the detail, as `answer` does: "…on board B: answer=yes." It is worded as a report because that
  is what it is: `boards.act` stores what the page said and loom did not see the action happen.

At most 50 such sentences are written, the latest across the thread's boards, then one line saying how many earlier
changes are not listed and that `boards.read` has them. The title is written as a JSON string, so a quote in it
cannot end it, and without any character the title rule forbids.

With no shown board the text says so. Apart from a board's title, everything in the text is an id, a brick name, a
choice or a whole number. If a job dies
before reading its mail, those sentences are not sent again; the agent can still call `boards.read`. That is accepted.

The agent's reply is words. What it shows is the `boards.*` calls it made during the job.

**References in words.** A ticket id written as `t-123` is drawn as a `ticket` chip. Any other brick with a link key
is written as `[label](loom:<brick>/<key>)` and drawn as that brick's chip. The brick turns the key into its params.
Both are drawn as chips in the agent's words and in the member's, and not inside code.

**Standing instructions.** The text a job is handed with its brief tells it: build a new board one `boards.change`
per brick so the member watches it come together; change the board on screen when the subject is the same and open a
new one when it is not; remove what no longer serves; make big the brick that answers what was asked, and keep a
board to three to five bricks; save a board worth returning to, and always when it finds itself building the same
board a second time; when no brick shows what is needed, say so and file a ticket for the brick; when the member has
chosen the big one, flag before changing it, and change it only when it cannot wait; never write a board or placement
id in its reply; treat what the member did on a board as their page's report, and read the record itself before
relying on a reported action; and hand off work that writes code or runs long, placing a `session` brick for it. The text is
`boardsMail` in `src/core/boards/brief.ts`, and that file is the wording. These are judgment. No suite checks them.

## The page

One page per thread. Its address is `/app/b/<board id>`, or `/app/t/<thread id>`. `/app/boards` is the way in with no
id: it opens the member's own boards thread with the household's first agent, `th:board-` and a digest of the two
ids, making it with `comms.open` if it does not exist.

- **Two halves.** The conversation is one half and the board is the other. At 640 px and wider both are always open.
  With no board, the conversation has the page.
- **Narrow.** Below 640 px the board has the screen and a bar holding the presence and the input stays on it.
  Pushing the bar opens the conversation as a sheet over the board. Closing the sheet returns to the board. With no
  board the sheet is open and cannot be closed.
- **The input.** There is one, the same control with or without a board.
- **The draft (built 2026-11-27).** What is typed and not sent is the desktop Comms composer's draft
  (`web/src/pieces/comms/drafts.ts`, used as it is): kept in this browser's localStorage only, under
  `loom:comms:draft:<member>:<thread>:v1`, so it comes back after a reload or a visit to another conversation, and the
  desktop's composer for the same thread holds the same words. It is the member's own words and never a parameter, a
  detail, a board record or part of the address (rule 1, rule 3): it leaves the browser only as the message, on Send.
  It is cleared when loom acknowledges that send (a newer edit typed meanwhile is kept); a send that fails keeps it with
  the same client id, so sending again cannot post it twice. As on the desktop there is no size, count or age limit
  beyond loom's own limit on a message; storage that is blocked or full keeps nothing and the input works the same.
- **The conversation.** Words and the work trace. The work trace is drawn in every Comms thread the member owns, not
  only the pairing thread.
- **The board.** The layout is a pure function `layout(placements in rank order, fits, area) → for each placement a
  form and a rectangle, or folded`. The big placement gets the primary form and never folds; below its minimum width it
  takes the full width. The rest get side, then compact, in rank order, as room allows. With no big placement, all of
  them do. A placement there is no room
  for is **folded**: shown as its chip in one row at the end of the board, under a hairline, after the count of
  how many are folded ("3 more"). The exact rule is the design
  pass's to write. Fixed here: it is pure, it reads only rank, fit and area, and the same input always gives the same
  output. A board with an empty title is headed by the name of its big brick, or of its first placement if none is big, without the reference; it has no heading if it has no placements.
- **Motion.** Placements are keyed by id. One that appears enters, one that goes leaves, the rest move to their new
  rectangles without being redrawn. The page reads the board's `revision` with its placements and applies each
  revision's differences in one step, so everything that changed in one revision starts moving in the same frame. With reduced motion set, changes apply without
  movement.
- **Big and small.** A small placement whose brick can be big has one control to maximize it, and so has its chip
  in the folded row. The big placement has none: there is no minimize, because something else becomes big only by
  being chosen. A brick's small forms are their own drawing of the same record, not the big form shrunk: `lanes` in
  the side form is its lanes in one column, and in the compact form one line of counts. Every brick's compact form is
  one or two lines that say where its record stands.
- **Names.** A placement is headed by its brick's name. A reference is shown only in the small monospace line beside
  it, never as the heading, whether or not it names a record.
- **Flags.** A placement is flagged when its `flagged_at` is set, or when the page saw one of its brick's flagged
  changes happen while it was open. A flag pulses once when it arrives and then stays as a quiet mark. It goes when
  the member points at or clicks the placement, and a brick's own flag also goes when its condition ends (the check
  passes again). A flagged placement that is folded is marked on its chip and the folded row is marked; it does not
  unfold. A brick's own flag is the page's and is not stored: a page that was closed when the change happened shows
  the record as it now is, with no flag.
- **The header row (built 2026-11-28, t-2428, `web/src/boards/board-head.tsx`).** The board's heading and, after it
  in one slim line, what needs the member, then Close. The owner: "this big empty space after the board title until
  close… feels like we could cram some stuff in there". Left to right:
  - **Attention chips**, one for each flagged placement on the board (its stored flag, or the brick's own flag), in
    rank order: the brick's name, its reference and the flag word, "Ticket t-7 · look here", "Ticket t-7 · closed".
    Built only from what the placements carry: the stored flag takes no words, so it reads "look here"; there is no
    free text from the agent. Pressing a chip brings its placement into view and gives it the keyboard (a folded
    one: its chip in the folded row), and does nothing else: it clears no flag, calls no operation, makes no request.
    The placement itself is focusable only this way (`tabindex=-1`), and focus landing on the placement itself is not
    looking at it; focus inside it still is ("Flags"). A chip goes when its flag does. As many chips as the row has
    room for are shown, each 13 rem at most with its gap (`CHIP_ROOM`, 208 px): chosen from the row's width, not measured
    chip by chip, so one coming or going never moves the rest. The rest are `+N` ("N more flagged: show them"), which
    opens a small list over the board made of the same chips; Escape or a chip pressed closes it. Where not even one
    chip fits beside the `+N` (a phone) every chip folds to one count, "N flagged", which opens the list of all of them:
    a count is one touch target that says how many, where a line scrolled sideways hides the rest behind an edge.
  - **The page's notices**, said here once, on the board on screen only, and no longer inside a brick: a token
    notice ("The first bricks", household; its rules are `token-notices.ts`'s, unchanged), "Token “…” may have been
    made" or "Token “…”: its value is lost", which opens the notice in full with Dismiss; "loom was updated: the page
    reloads when your message is sent or cleared" with Reload now, while the page waits for a newer build ("A
    restart"); "N bricks didn’t load" with Try all again, for the placements whose own tries are spent (each still
    says its own sorry, Try again and what was caught). One notice is said in the row with its action. Two or more
    fold to one "N notices", which opens each in full with its action: the row cannot hold three notices and a chip
    on a laptop's board, and a notice cut to its first word says nothing. On a phone even one is folded so, its
    button naming its kind ("Token notice", "loom was updated", "2 bricks didn’t load").
  - **One quiet mark**, "Getting new data", while any placement on the board is getting it (each placement keeps its
    own, "Live reads and their cost").
  - **Close** as an icon at the far end, named "Close board"; the same `boards.close`, with no question asked, as
    before. A closed board has "Reopen" there, in words.
  The row's height never changes as these come and go: one line of a fixed block size (2 rem), nothing in it wraps,
  the chips' strip and each notice cut short where the row runs out, and the lists open over the field, outside the row.
- **Chips.** Clicking a chip places that brick, with the params its key gives and defaults for the rest, last on the
  open board on screen. If that placement is already live, the call is refused and nothing changes. If the board on
  screen is closed, or there is none, the click opens a new board.
- **The trail.** The page follows the thread. When any board in the thread is opened or reopened, by either party, the
  page moves right to it. When the board on screen is closed by the member, it stays on screen, closed, until they
  go elsewhere; a closed board that is not the one in the address gives way to the last board on the trail, and with
  none to `/app/t/<thread id>`. `/app/t/<thread id>` for a thread with a trail goes to the last board on it. A change
  to a board that is not on screen is stored and drawn when the member goes there.
- **Off screen (built 2026-11-27, the owner's ruling: "we absolutely treat everything not on the current screen as
  paused").** Only the board on screen draws its bricks. Every other board on the trail keeps its frame, so the trail
  still slides between laid-out boards: its heading, and each placement's rectangle, name, reference and stored flag,
  from what the page knows without asking (the registry and the board's own read). It mounts no brick body, so it
  holds no live read and fetches no brick's module, and nothing in it takes the keyboard. When the page goes to
  another board, the arriving board's bricks are drawn as the slide starts and the leaving board's are let go when
  it ends (at once where motion is reduced). A closed board drawn by its own address is the board on screen. The
  page's own reads (the thread's boards, the conversation, the list of conversations) are never paused.
  What this costs, accepted by the owner: words half typed in a brick's form on a board the page slid away from are
  lost.
- **What the page remembers (built 2026-11-27).** A brick drawn again (its board came back on screen) shows what it
  last showed at once, and its placement's header carries one small mark, named "Getting new data" for assistive
  technology, until the fresh answer arrives; the mark takes no room and does not pulse where motion is reduced.
  What is remembered is the last live answer to each selection a brick made (the same document and variables), in
  the page's memory only: never in localStorage, sessionStorage, IndexedDB or the address, so it ends with the page.
  It is the most recent 300 answers, the oldest dropped first; it is emptied when another member signs in and when
  the session ends; and one answer is dropped the moment its selection is refused or its feed closes, when the brick
  shows what it shows for that state and nothing of the old answer. Every selection is still asked of the server
  each time: nothing is read from a cache in place of asking. Only brick bodies are under this; the page's own
  reads and the whole desktop are as they were. While a placement is getting new data its brick's controls work,
  except where acting on old data would be dangerous: the `approval` brick's Allow, Deny and reason, and every
  control of the `secrets` brick, wait for the fresh answer. A brick's own flag compares the remembered value with
  the fresh one, so a record that changed while its board was off screen flags its brick when the board returns:
  that is "this changed while you were not looking", and it is raised on purpose.
- **How fresh a brick is (built 2026-11-27, the owner's ruling: "the comparison I'd give is email").** Every read a
  brick makes is **relaxed**: loom reads it again at most once in five seconds (`LIVE_RELAXED_MS`), so a change made
  elsewhere reaches a brick within about that. The page's own reads are **eager**, as every read was before: the
  conversation's transcript and tail, the thread's own row, the thread's boards and the shown board's placements
  (so a brick the agent places still appears at once), the list of conversations, and what the page reads to open
  itself. One read of a brick is eager too: the `session` brick's step list in the big form while its job is
  running, because watching a session work is what it is for; once the job has ended it is relaxed like the rest
  (the small form's one line of the latest step is always relaxed). The page asks loom to read its bricks' data
  **now** on three occasions. *After the member's own write*: the moment loom answers any write this page sends
  (an operation, or one of the desktop's command doors the bricks reuse: every POST to `/api/…`, watched in one
  place, `web/src/boards/own-writes.ts`), every brick on screen is asked for, so a click is still shown at once,
  in its own brick and in the others; the two writes that change no brick's data ask nothing (`boards.seen`,
  `boards.act`). *On request*: each open placement has a third quiet control among its tools, a refresh, named
  "Refresh <brick's name>" for assistive technology, which asks for that placement's reads only. *When the tab is
  seen again* after being hidden. A board that comes back on screen needs no asking: its bricks open their reads
  anew, and a read's first answer never waits. While an asking is unanswered the placement shows the same small
  mark as above, "Getting new data"; pointing at it says when what is drawn was last confirmed ("Getting new data,
  as of 12 s ago": seconds under a minute, then the kit's `Time` wording), and assistive technology is given the
  same words as the mark's description. A brick that is only waiting out its five seconds shows nothing. Asking
  never opens a read again, so it never shows the loading line and never drops what is drawn. A brick's own flag
  is raised once for the difference between what was drawn and what is drawn now, however many changes that was,
  and not for the member's own action here: the change that follows it within `OWN_ACTION_MS` (the relaxed time
  and two seconds) is taken to be theirs, whether it came by the asking or, that failing, by the next reading.
- **A closed board.** Its address draws it as it was, with no refresh, remove or maximize controls and one control to reopen
  it. Its bricks are drawn and do nothing: no action, no chip, no input in them responds.
- **Not yours.** A board or thread id that does not exist, or that the member may not read, draws one line saying
  there is nothing here, and no presence and no input.
- **The conversation's header (design pass, 2026-11-27).** One quiet line: the agent's face and name, and under the
  name the thread's title as plain words before how the agent stands. One unobtrusive control beside it (three
  dots; the keys of `web/src/shell/shortcuts.ts` open it too) opens one panel that holds everything else: the list of
  conversations, its search and a new one with each agent, this conversation's rename, pin, archive and delete, and
  notifications on this device (a line that opens its state, its on and off, and its two choices). Nothing else is in the header,
  but for Stop while the agent is working (below).
- **Stop, and the bridge receipt (built 2026-11-27, t-2428).** While the agent is working in the conversation, and
  for the member whose conversation it is (never a terminal's), the header has "Stop…" beside the presence. It asks
  first, naming the conversation and its agent ("Stop Art in “…”? What it is doing in this conversation ends now;
  what it already did stays."), sends nothing on "Keep it going", and on "Stop the conversation" sends Comms' own
  thread stop, `comms.change {stop}`, as the desktop's Comms header does: the permission is the one `comms.change`
  holds, the thread's member and nobody else. It is not a job's stop (`runtime.jobStop`, which the `session` and
  `agent` bricks send): loom marks the thread, and the job working in it notices (the worker before the body runs,
  the body on its next report), stops, and ends as stopped by the member with the reason `stop`; a job that finishes
  first keeps its work and the mark is dropped, so it never stops whatever is asked next. Once loom has the mark the
  header says "Stopping…" and offers nothing more. A refusal says "You can’t stop this conversation."; any other
  failure "That did not stop it. Try again.", and the question stays open. It reads nothing of its own: whether the
  agent is working and whether a Stop is asked are the open thread's selection, the one the panel reads. A
  conversation that came in by Discord or Slack has, under the header, the line the desktop's conversation activity
  draws for it: when the member's latest message there arrived, whether the agent took it up and when, and whether a
  reply went back ("Your message by Discord 5 min ago · Art took it up 4 min ago · Reply sent"). It is the desktop's
  `latestBridgeReceipt` (the member's own messages only), read only for such a conversation, at the relaxed pace;
  nothing of the bridge is named but which one, and nothing is linked.
- **Threads (built 2026-11-27).** A control beside the presence, and the keys the desktop's launcher had (Ctrl+Space,
  a double tap of Shift; `web/src/shell/shortcuts.ts`), open a list of the member's open threads: Comms' own rows in Comms' order (pinned, then most
  recent; its first fifty), each with its title, its agent, "Working" and "Unread". Arrow keys move, Enter chooses,
  Escape closes. Choosing one pushes `/app/t/<thread id>`; back and forward are resolved again, and a board of the
  thread on screen is handed to the page without redrawing the conversation. The list ends with "New conversation
  with" each agent the member may give work to (`homeComms.agents`), which makes a thread as Comms' "New" does
  (`comms.open` with a new id and no title) and goes to it. A thread that was read is not opened again with
  `comms.open`. The presence is the thread's own agent: its directory name and, for any agent but Art, its face
  drawn still from `agents.markBg/faceShape/faceEyes` and the desktop's face shapes. Under the presence is the
  thread's title; the member whose thread it is can rename it, pin or unpin it, archive it (asked first) or restore
  it, and delete it, by `comms.change` as Comms' More menu does. Delete is asked first, and the question names the
  conversation by its title ("Delete “…” and its private words? It cannot be undone."); nothing is sent until it is
  answered yes, and then the page goes to `/app/boards`. A refused or failed change says "Could not save. Try again."
  and leaves the question open. **Search (2026-11-27)**: the top of the list is Comms' search box. It is asked on
  submit (Enter or Search), never on a keystroke, as `commsThreads(archived:false, search:…)` by one request
  (`useDataOnce`), never a live selection; what it found takes the list's place, in Comms' order, with no new
  conversations under it, and says "No conversations match." or "Search is unavailable. Try again.". Emptying the
  box or "Show the list" goes back to the live list. What was typed is the panel's own state: never a parameter,
  a detail, the address or storage (rule 1). `commsFolders` is not read: the panel shows no folder counts. The page marks the thread read (`comms.change`, `read`) when its conversation is on screen in a
  visible tab and holds something after the read mark, as Comms does; "Unread" in the list is Home's rule, a reply
  from the thread's agent after that mark, served as `unread` on a Comms thread row. Nothing about the thread or
  board shown is in a query string, a fragment or storage.
- **Coming back, and installing (2026-11-27).** The page links its own manifest (`/boards.webmanifest`: id and
  start `/app/boards`, scope `/`); installed from this page, loom opens at `/app/boards`. The other manifest
  (`/manifest.webmanifest`, id `/`), the one the desktop and the phone's app were installed with, keeps its id and
  now starts at `/app/boards` too (2026-11-28). The page registers loom's service worker (`/sw.js`, scope `/`),
  which asks the member nothing. Beside the presence is "Notifications": a panel that says what is true of this device (unavailable,
  unsupported by the browser, blocked by the browser, off, on for this device: on means loom lists this browser's
  own push subscription and the browser allows it) and turns it on and off by Account's own helper and
  operations (`notifications.subscribe`, `notifications.removeDevice`; `web/src/pieces/account/notifications.ts`).
  The browser is asked for permission only on the member's press. A push is sent for what it was sent for before
  (an Inbox item that waits on the member at full volume: a question, an approval, a notice) and still carries no
  words. It names a boards address in `url`: the thread's (`/app/t/<thread id>`) when the item belongs to a thread
  that is the member's own, and `/app/boards` otherwise; the thread's is in `board` too, as before. A click always
  opens the boards page (2026-11-28; until then a push named the desktop's address in `url` and the device chose
  between the two, a choice kept in the browser's cache storage, `loom-device`, which a new worker now deletes): an
  open boards page first, then any other loom window, taken there, then a new window. A notification shown before,
  or a push sent before, that names the desktop's address opens the thread its `board` names, or `/app/boards`. An
  open boards page is focused and is not loaded again when the push names no thread or the thread it is already at.
  **A reply can bring its member back (2026-11-27).** The panel of a device that is on also offers "Also notify
  this device when the agent replies". It is loom's record of that device (`notification_devices.replies`, schema
  51), off until ticked and off for every device enrolled before; it is set by `notifications.subscribe` with an
  optional `replies`, which changes only the device of the browser that calls it. Enrolling again without saying
  keeps the choice; a browser another person takes over starts off.
  When an agent's reply is stored in a loom thread that is one member's own (`conversation.message`, kind `reply`),
  each of that member's devices that chose replies is noted for it (`notification_replies`: one row for a device
  and a thread, holding the reply's number and no words). Nothing is noted for a card, a progress message, the
  member's own message, a thread of another venue or of no single member, or the result a finished handed-off
  session brings to its origin thread: the agent is woken by that result and its own reply to it is the one
  pushed. *Looking at it:* the push is sent `REPLY_PUSH_WAIT_MS` (10 seconds,
  `src/core/signin/shared-notifications.ts`) after the reply was stored, and only if the thread's read mark is
  still before the reply then. A page with the conversation on screen in a visible tab marks it read within
  that time, so it is not pushed; a hidden tab or a closed sheet does not mark it,
  so it is. Loom keeps no record of open pages, and this is the whole rule: a member who left the conversation on
  screen and walked away gets no push, and a page too slow to mark the reply read inside the wait gets one while
  it is being read. *Several replies:* a later reply in the thread takes the device's row over and the wait starts
  again, so replies stored inside one wait are one push; a reply after a push was sent is a new push with the same
  tag, which replaces the earlier notification on the device. A reply is never pushed twice to a device, and a
  body's retry of a reply notes nothing new. *What it says:* the fixed title "loom", an empty body, a tag made
  from a fingerprint of the thread's id, and the thread's boards address (`/app/t/<thread id>`) in both `url` and
  `board`; the worker opens it as above. No word of the reply, no
  title of the thread and no name of the agent leaves loom: the push service and a locked screen learn that
  something happened in loom, and the device, on a press, which thread. The delivery is the Inbox push's own
  (claimed before it is sent and never sent again, an hour to arrive, a dead endpoint removed) and is rechecked
  when it is sent: nothing goes to a device whose browser is signed out or whose member was removed, for an
  archived or deleted thread, or to any device but the thread's own member's. A reply already read when a
  progress message becomes the reply is not pushed.
  The tab's title is the thread's title, or "Loom", with "●" in front while the tab is hidden and the thread holds
  an unread reply.
- **Sign-in, and the addresses that are not this page's (2026-11-28, t-2428).** loom serves the sign-in gate
  (`web/next.html`, `web/src/shell/main.tsx` and `signin.tsx`, unchanged in look and behaviour from the desktop's)
  at every address that is not this page's and not an asset or API path (`src/shared-web.ts`): the root, and every
  address the desktop had (`/p/…`). Signed out, it is the sign-in page. Signed in, it goes on to this page in place
  of its own address (`web/src/signin/gate-address.ts`): to the boards address it was sent from (`/?to=<address>`,
  which must be one of this page's or is ignored), to the thread a desktop address for a thread names
  (`/p/comms-preview/thread/<id>`, which held the id without its `th:`), or to `/app/boards`. This page, signed out,
  goes to the gate with its own address in `?to=` (none for `/app/boards`), so a member signs in on the gate and
  comes back where they were; it draws no sign-in of its own. A one-time sign-in link still ends at `/`
  (`src/core/signin/shared-links.ts`), which is the gate, which comes here.
- **Not on any page since the desktop went.** What this spec left to the desktop, and so is on no page now: enrolling
  and revoking a machine (`machines`); held work (`core.effect`, which this server does not serve either); the
  Appearance choices other than Reduce motion (`appearance`, which keeps them); and each "Not on the brick" item
  this spec names under a brick (among them Ask a person and Promote to epic on a ticket, "Discuss with <agent>" on
  an Inbox item, Activity's hour strip and filters by who, where and what, the Tasks board's epic filter and
  recently finished lane, the household's time zone and the desktop's display names). Each is a brick, or a part of
  one, to be built when wanted; until then the agent does it, or says it cannot.

## A restart

The owner, 2026-11-27: "we should survive a loom reboot without the user being excessively aware." The case that
matters: the member asks for something no brick shows, the agent hands off a session to build the brick, loom is
deployed with it, and the agent places it. The member sees a brick arrive. They do not reload anything.

- **The page.** It holds no state of its own (rule 3), so a reload opens the same board. When its live read comes
  back after loom was away, the page asks its own address for the current page; if that runs a different script from
  the one running, the page reloads, once the input is empty and nothing is being sent. A draft kept from before
  ("The draft") holds the reload as typed words do, and a reload by hand brings it back. Run 2026-11-27 against a
  restart with a new build: the page was on the new build, on the same board, about ten seconds after loom was back.
  While loom is away the board is drawn empty; that is a fault to fix.
- **A brick the page does not know.** A page that has not yet reloaded draws it as "not drawn yet" and nothing else
  changes.
- **The agent.** Nothing is asked of the job in the thread: it is not running while the session works. The session's
  result is a reply in the thread, which wakes the agent, and the agent places the new brick. Not run. Not known: what
  a deploy does to the session that started it, and whether its result still reaches the thread when loom restarts
  under it.

## The first bricks

The first demo is "everything about a project", and the set is what that pulls in by following references.

| Brick | Parameters | Actions | Link key |
| --- | --- | --- | --- |
| `project` | `project`: project id | none | the project id |
| `lanes` | `project`: project id | none | none |
| `trend` | `project`: project id; `days`: 7, 30 or 90, default 30 | none | none |
| `ticket` | `ticket`: ticket id | `claim {}`, `unclaim {}`, `close {}`, `reopen {}`, each the `tasks.command` action of that name | the ticket id |
| `comments` | `ticket`: ticket id | `comment {}`, by `tasks.command` | none |
| `pull` | `change`: change id, `github:owner/repo#number` | `refresh {}`, after `changes.refresh` (`/api/changes/refresh`, the desktop's Refresh of Changes) read GitHub again; a household owner's, as on the desktop. A merge is answered through its approval (the `approval` brick) | the change id |
| `repository` | `repository`: `owner/repo`, in any spelling `project_repositories` holds (a leading `github:`, capitals and a trailing `.git` are dropped); `project`: project id, optional | none | the repository id |
| `person` | `person`: `member:<member id>` or `contact:<contact slug>` | none | the same string |
| `agent` | `agent`: agent id | `stop {}`, by `runtime.jobStop` on one of its running jobs, after asking | the agent id |
| `question` | `item`: inbox item id | `answer {answer}`, by `inbox.answer`; `answer` is one of `yes`, `no`, `words`, `done`, `dismiss`. `volume {volume}`, by `inbox.volume`; `volume` is one of `full`, `dim`, `mute` | the item id |
| `approval` | `approval`: approval id | `approve {}`, `refuse {}`, each after `approvals.answer` took the answer; a reason for denying goes to `approvals.answer` and never to the board. `always {}`, after `approvals.always` took the standing answer | the approval id |
| `session` | `session`: conversation id | `stop {}`, by `runtime.jobStop` | the conversation id |
| `inbox` | `folder`: one of `needs`, `alerts`, `answered`, `fyi`, `all`, `errors`, default `needs` (what waits on the member). No record reference | `read {}`, by `inbox.read`; `dismissResult {}`, by `inbox.dismissResult` | none |
| `approvals` | `state`: `pending`, `answered`, `rules` (the standing rules) or `notices` (the reported steps), default `pending`. No record reference | none: a request is answered in its `approval` brick, and a standing rule is made, changed or removed by asking the agent | none |
| `ticket`, added 2026-11-27 | as above | also `edit {}`, `link {type}`, `unlink {type}`, each the `tasks.command` action of that name; `type` is `blocks` or `parent-child` | as above |
| `lanes`, added 2026-11-27 | as above | `pause {}`, `resume {}`, each after `work.setProjectClaims` took it | none |
| `new-ticket` | `project`: project id | `create {}`, by `tasks.command` `create` | none |
| `backlog` | `project`: project id | `priority {priority}`, by `tasks.command` `edit` with the priority alone; `priority` is one of `0` to `4` | none |
| `unfiled` | none | `project {}`, by `tasks.command` `edit` with the project alone | none |
| `knowledge-page` | `page`: a knowledge page's slug: a letter or digit, then up to 199 of letters, digits and `. _ / -` | `verify {}` by `mind.knowledgeVerify`, `recheck {}` by `mind.knowledgeRecheck`, `annotate {kind}` by `mind.knowledgeAnnotate`; `kind` is one of `note`, `outdated`, `intent`, `no-longer-owned`, `in-use`; the words go to the operation and never to the board | the page slug |
| `knowledge` | `show`: `all`, `recent` or `due`, default `all`; `domain`: a topic, optional: a lowercase letter or digit, then up to 119 of lowercase letters, digits and `. _ / -`. No parameter holds words to search for | `add {}`, by `mind.knowledgeAdd` | none |
| `people` | `folder`: `all`, `person` or `agent`, default `all`. No parameter holds words to search for | `add {}`, by `mind.personAdd` | none |
| `activity` | `days`: 1, 7 or 30, default 1 | none | none |
| `threads` | `scope`: `open` or `archived` (Comms' two folders), default `open` | `pin {}`, `unpin {}` and `delete {}` (asked first), each by `comms.change`, which lets in the thread's member alone | none |
| `agents` | none | none | none |
| `question`, added 2026-11-27 | as above | also `discuss {}`, after `inbox.discuss`; `taskAnswer {answer}`, after `tasks.command` `answer`, `answer` one of `yes`, `no`, `words`; `join {decision}`, after `runtime.workerJoinDecide`, `decision` one of `allow`, `block` | as above |
| `ticket`, added later on 2026-11-27 | as above | also `ask {}`, by `tasks.command` `ask`, and `promote {}`, by `tasks.command` `edit` with the type alone, after asking | as above |
| `tempo` | `agent`: agent id | `create {}`, after `tempo.set` took the desktop's Create trigger form as the member filled it (big form only); the board is told nothing typed. A trigger that exists is acted on in its `trigger` brick | none |
| `trigger` | `trigger`: a Tempo trigger's id: a letter or digit, then up to 119 of letters, digits and `: . _ / @ -` | `runNow {}`, `stop {}`, `start {}`, `pause {}`, `resume {}`, each after the `tempo.` operation of that name took it; running it now and stopping it ask first; `pause` and `resume` are of the trigger's agent, as on the desktop | the trigger id |
| `account` | none: it is the signed-in member's own | `removePasskey {}`, by `account.removePasskey`; `revokeSession {}`, by `account.revokeSession`; `removeDevice {}`, by `notifications.removeDevice`; `enableNotifications {}`, by `notifications.subscribe`. Each removal asks first. Adding a passkey, making a sign-in link and signing this device out go to the sign-in door, which is no operation, and the board is not told | none |
| `appearance` | none: it is the signed-in member's own | `set {}`, by `household.setPreferences` with the one choice pressed; the board is not told which | none |
| `secrets` | none: it is the household's, for an owner | `allow {}`, `deny {}`, `cancel {}`, `revoke {}`, each by `secrets.command`; `setValue {secret, outcome}`, by `secrets.set`, `outcome` `added` or `replaced`; `remove {secret, outcome}`, by `secrets.remove`, after asking, `outcome` `removed`. `secret` is the secret's name in the secrets store's own shape (`secretName`: a letter or digit, then up to 63 of letters, digits and `. _ -`). No detail holds a description or a value | none |
| `machines` | none: the machine opened is picked inside the brick | `proposeReader {allow}`, by `machine.proposeReader`; `allow` is `yes` or `no`. `answerReader {answer}`, by `machine.answerReader`; `answer` is `allow` or `deny`. `setAlertLines {}`, by `machine.setAlertLines` (a household owner). Enrolling or revoking a machine is not offered | none |
| `subscriptions` | none: the account opened and what is searched for are picked inside the brick | `signIn {}`, by `runtime.accountSignIn`; `create {}`, by `runtime.accountCreate`. The label typed goes to the operation and never to the board | none |
| `usage` | `days`: 1, 7 or 30, default 7. The conversation whose jobs are listed is picked inside the brick | none | none |
| `bridges` | none | `release {}` and `dismiss {}`, each after `/api/bridges/command` (`bridges.command`) took the review, and each asked first. A reply's words never reach the board. A connection, a channel rule and a person link are changed by asking the agent | none |
| `household` | none | `revokeToken {}`, by `token.revoke`, and `revokeSession {}`, by `sessions.revoke`, each asked first; `setGrants {}`, by `program.setGrants`; `token {label, kind}`, after the sign-in door (`signin.token`: `POST /api/signin/token`, or `/api/signin/program` for an outside program) made one, `label` the token's label in the shape of a reference and `kind` `member`, `agent`, `machine` or `program`; never its value; `setPortrait {agent, outcome}`, after `household.setPortrait` changed an agent's animated portrait, `agent` the agent's id (a `ref`) and `outcome` `uploaded` or `restored`; never a file's name, size or contents. A member, an agent's appearance and accounts and a restore are changed by asking the agent | none |
| `sharing` | none | none: a project's sharing is changed by asking the agent | none |
| `tickets` | `state`: `ready`, `in-progress`, `shelved` or `all`, default `ready` (what the desktop's Tasks opens on). No record reference, and no parameter holds words to search for | none: a ticket is acted on in its `ticket` brick | none |
| `projects` | none: the words searched for are typed inside the brick and are no parameter | none | none |
| `catchup` | `since`: `today`, `3-days` or `7-days`, default `today`. No record reference | none: a ticket is acted on in its `ticket` brick | none |

| Brick | Can be big | Flags itself when |
| --- | --- | --- |
| `project` | yes | never |
| `lanes` | yes | never |
| `trend` | yes: opened and closed per day over `days`, and a picked day lists its tickets | never |
| `ticket` | yes: also why and done when, and "Sessions", the sessions handed off for it, newest first, each a `session` chip with its title, state and when; small, a line counting them when there are any; folded, unchanged | it is closed or reopened by someone else |
| `comments` | yes | a comment arrives from someone else |
| `person` (a member or a contact) | yes: what People's reader shows (see below) | never |
| `agent` | yes: everything it is doing, its last thirty jobs, and its activity posts (its five latest threads of posts, each opening to its posts 25 a page) | it starts waiting on the member (a question of its own joins the Inbox's "needs you" when none was there) |
| `pull` | yes: also its branch and author, its failing and running checks by name, the people on it, whether it can be merged, its tickets with their titles, the files it changed with their added and removed lines, each opening in place to its patch (`changeFilePatch`, asked once each time it is opened, not live); when loom last read GitHub and whether that read failed, for a household owner; "Loom's reviews", a heading that opens in place to each round with its tier, verdict, commit and findings (`changeReviewHistory`, asked only while it is open); and "Read GitHub again", for the member loom says may use it | its checks go to failing, it is merged, it is closed |
| `repository` | yes: each open pull request with its title and where it stands | never |
| `question` | no | never: being on the board is the flag |
| `approval` | no: the page has a primary form for it, with the record's history, but the catalogue does not let it be big, so a board draws it side or compact | never: being on the board is the flag |
| `session` | yes: its state, the tools it has used, how it ended, and, as a conversation the member was not in (changed 2026-11-28, "A session as a conversation"): what it was asked as the asker's message; the agent's own words as its messages and its readable reasoning folded quietly, between its runs of tool steps, each run folded under one "N steps" line; its report as the last message once a handed-off session has one; and "Why it failed" (the plain words loom builds from the failed job's fixed reason, `JobRecord.failedWhy`, docs/runtime/worker.md "Why a job failed") ending a failed one, whose last run, holding the `Harness` step with what the harness itself last said, starts open; "Its steps are no longer kept." once they are past their keep time and deleted | it finishes, it fails, it is stopped by someone else |
| `inbox` | yes: every folder's count, and up to fifty of the folder's items newest first, each with its words as a chip that places its `question` brick, who asked, when, its state, read or unread, and Mark read on an unread one; the outcomes of the member's own actions where the Inbox lists them, each with Dismiss; Newer and Older for a longer folder. Small: the folder's count and its first four items as chips. Folded: one line of counts | more waits on the member than before (the count of `needs` goes up) |
| `approvals` | yes: every pending request oldest first, or every answered one newest first, each with its title as a chip that places its `approval` brick, its state, kind, agent, project, when it was asked, why, what it allows and, once answered, who answered; or every standing rule with what it covers, which kind of request, for whom, its answer and who set it when; or the reported steps newest first, the first fifty, each with the agent, kind, target and when. Small: the count and the first four (as chips where they are requests). Folded: one line of counts | a new request is waiting (the count of pending goes up), in every state |
| `ticket`, added 2026-11-27 | yes: also its description, its linked tickets with their titles, and the Edit and Links forms; small, its priority, who filed it, why it closed and its links as chips | as above; an edit or a link flags nothing |
| `ticket`, added later on 2026-11-27 | yes: also its pull requests, each a `pull` chip with its title and state; the conversation it was filed from; and two sections opened on a press, Reviews (loom's rounds and GitHub's reviews, newest first) and Story (what agents posted about it, newest first), each read only when opened, thirty at a time; small, its pull requests as `pull` chips by number | as above |
| `lanes`, added 2026-11-27 | yes: also how many of the project's questions wait on the member, and each agent's new claims with pause and resume | never |
| `project`, added 2026-11-27 | yes: also its name, what each agent calls it, and its repositories; and, opened on demand, the agents' notes on it with a search box and each note readable whole | never |
| `new-ticket` | yes: every field of the desktop's Create task form; small, title, goal and why with that form's defaults; folded, "File a ticket in <project name>" | never |
| `backlog` | yes: thirty tickets, and each one's priority can be set; small, six | never |
| `unfiled` | yes: the first fifty, and each can be filed into a project; small, six | never |
| `knowledge-page` | yes: the whole page, its checks, annotations, sources, the pages it links to and that cite it, and the annotation form | never |
| `knowledge` | yes: up to 40 pages, the search box, the topics, "Add a fact" | never |
| `people` | yes: up to 60 cards with who knows each, the search box, "Add a person" | never |
| `activity` | yes: the range by day, and an entry opened in place | never |
| `threads` | yes: every row of Comms' first page, with when each was last used, Pin or Unpin and Delete… on each (no Delete on the conversation the page is open on), and Comms' search | never |
| `agents` | no | never |
| `tempo` | yes: every trigger of the agent, the day's recorded firings, and New trigger…, which opens a Create trigger form (the desktop's fields) in their place; small, the first six | a firing of one of the agent's triggers fails (more of them have a failed last firing than before) |
| `trigger` | yes: also its project, machine needs, requested model, program, lessons and saved state where the member may read them, every recent run and its recent history; small, its source, target, words, three runs and its buttons | it fails, or its newest run fails |
| `account` | yes: each passkey, signed-in browser and notification device with its state and dates, and every change; small, the three counts and no control | never |
| `appearance` | yes: every choice of the desktop's Appearance app as a row of buttons, and a press saves it; small, the choices as words and no control | never |
| `secrets` | yes: every secret with its rule, grants and use, the requests, and every change; small, the counts, who is asking for what and the names, and no control | a new request arrives |

**The member's own settings, 2026-11-27.** Three bricks with no parameter, each the desktop app's reads, words and
calls through modules both sides import.

- `account` (the desktop's Account): the member's passkeys, signed-in browsers and notification devices from Account's
  one selection (`pieces/account/query.ts`). Big: each with its state and dates; a passkey, a browser and a
  notification device are each removed after a question ("Keep" sends nothing); a passkey is added by Account's own
  ceremony (`pieces/account/passkey.ts`, the sign-in door's `/passkeys/options` and `/passkeys`); this device's
  notifications are turned on by the hook the page's bell uses (`boards/notify-device.ts`); a one-time sign-in link
  for another device is asked for once, never retried, shown until hidden and kept nowhere
  (`signin/device-link.ts`); this device is signed out after a question. Signing a browser out goes through
  `signin/session-change.ts`: when it was this browser the page reloads to the sign-in screen and the board is told
  nothing. The server does not forbid removing the last passkey and neither does the desktop; the question says when
  it is the only active one. **Not marked:** which signed-in browser is this one. The read does not say, and a
  viewer carries no session. The notification device that is this one is marked.
- `appearance` (the desktop's Appearance): look, desk background, reduce motion, higher contrast, pixel faces, sound,
  haptics, one window at a time and zoom, each a row of buttons with the saved one pressed. A press sends that one
  choice to `household.setPreferences`; what is pressed is the record's, so it changes when the record does.
  **What the boards page honours.** Reduce motion, and nothing else. The page starts by following the device; once
  the member's own row is read it wears their choice (on, off, or the device's while they follow it) on
  `<html data-motion>` through the desktop's `wearMotion`, and again whenever the row changes
  (`boards/wear.ts`). The page's build now routes every motion media query onto that attribute, as the desktop's
  does (`accessMedia` in `vite.boards.config.ts`), so its stylesheets and its moving portrait obey the choice and
  not the device alone. **What it ignores.** The look: this page has one look of its own, light or dark as the
  device is, and none of the desktop's three is it; a saved look is a default (`neon`) for every member with a row,
  so following its light or dark would turn the page dark for anyone who had only ever changed a switch. Higher
  contrast: the page has no higher-contrast styling. Desk background, pixel faces, sound, haptics, one window at a
  time and zoom: each was a thing of the desktop's shell, and since the desktop went (2026-11-28) no page uses them.
  The brick says this in one line and lists Reduce motion under "Takes effect on this page" and the rest under
  "Kept, not used by a page yet".
- `secrets` (the desktop's Settings): for a household owner, by the server's rule: `secretsReader` answers an owner
  only and the three secrets operations take an owner only; for anyone else the brick is its unavailable line and
  no row or control. Big: the household default; each secret by name with its description, when and by whom it
  changed, its standing rule and the agents it names, who may use it now (each grant, with Revoke), and its last
  three recorded uses; each waiting request with why, for how long, "Always answer this way for this agent", Allow,
  Deny and Cancel; the last ten answered requests. Removing a secret asks first. **A value** is typed into one
  uncontrolled password field (`autocomplete="new-password"`, no spell check, as the desktop's) and leaves the
  browser once, in the body of `POST /api/secrets/set`, through the desktop's `submitSecret`
  (`pieces/settings/commands.ts`), which empties the field before the request is made. It is never in React
  state, never in a parameter or a detail, never sent to `boards.act`, and no reply's words are shown: a change is
  "Saved." or "Change not confirmed". A value that was not confirmed is not kept and not sent again. **What the
  board is told** (the owner's ruling, 2026-11-27, reversing the earlier rule that a secret's name never reached a
  board: "return the result of that to chat. so the agent knows oh ok we saved a new key in this-key-place but
  never saw the key itself"): once loom acknowledged it, a value set is reported as `setValue` with the secret's
  name and `added` or `replaced`, and a removal as `remove` with the name and `removed`, so the agent reads, for
  instance, "used setValue on secrets() on board B: outcome=added, secret=PUMP_TOKEN." The detail's schema takes
  those two fields and nothing else, so a description or a value sent in a field of its own is refused; the name
  must be in the store's shape. What the schema cannot tell is a value typed INTO Name: a name-shaped string is told
  as the name. So the form refuses, before anything is sent, a Name that has the shape of a credential, with "That
  looks like a secret value, not a name.", and `boards.act` refuses the same names in this detail on the server, by
  the same function (`looksLikeSecretValue`, `src/core/boards/value-shape.ts`, a module with no imports: a known
  credential prefix in its real case followed by a random-looking body, or a long random run of letters and digits;
  the rules exactly, and what still passes, are in docs/accepted-tradeoffs.md). A value of no such shape is
  still told; that is an accepted trade-off (docs/accepted-tradeoffs.md, "A secret value typed as a secret's name or
  a token's label reaches the agent's brief"). A stored secret whose name already has that shape can still be
  replaced or removed here, and the board is not told of it. A change that is refused or not confirmed tells the board
  nothing: the member reads "Change not confirmed" in the brick, as before, and a name the store would refuse is
  not sent at all. `src/core/boards/bricks/secrets.test.ts` holds each detail to its two fields and follows a report through
  `boards.act` into the stored rows, `boards.read` and the agent's brief, where no value or description sent in its
  own field is found, refuses each credential shape there with nothing stored, and shows that a name-shaped value of
  no known shape IS told; `web/src/boards/bricks-secrets.test.tsx` checks each outcome, that a refused or unconfirmed
  change reports nothing, that a typed value reaches no report, flag, data-hook call or drawn prop, that a
  credential-shaped Name sends nothing, and that a stored one is replaced and removed without a report.
  **Not on the brick:** changing the household default or a secret's standing rule. No member operation does
  either (nor did the desktop's Settings): a message asks an agent to propose the change and the owner answers the
  proposal. The brick shows both and says to ask the agent in the conversation.
| `machines` | yes: a machine can be opened: its owner, hosting, listed agents, slots, the jobs on it now (each a `session` chip where the job has a conversation), and on the member's own machine its read grants, pending requests and read history; below, the household's alert lines, which a household owner can change. Small: each machine with whether it is the loom machine, when it was last seen, its open alerts and readings. Folded: the count of machines and of open alerts | never |
| `subscriptions` | yes: the search box and "Needs attention", an account opened for its usage windows, weekly usage by agent, trigger or conversation, sign-ins with "Sign in on this machine" where loom allows it, and settings; each agent's models in order; "Add a subscription". Small: each service and account in one line with its windows. Folded: the count, how many are almost full and how many sign-ins are needed | another sign-in is needed (the count of sign-ins needing attention goes up) |
| `usage` | yes: up to 60 conversations with reported tokens, jobs, retries and peak context, and one picked conversation's jobs, each opened for its measurements. Small: the first six. Folded: tokens, jobs and conversations in the period | never |
| `bridges` | yes: every waiting reply with its words, thread and state, with Release (a held one) and Dismiss; for a household owner each connection with its state, activity, filters and the names of its stored secrets, the channel rules and the person links. Small: the first four waiting replies and the connections. Folded: the counts | another reply is held (the count of held replies goes up) |
| `household` | yes: members with their roles and agents, agents with their owners, description and accounts, removed agents, each agent's Portrait (upload a PixelLab sheet and its JSON, or restore the generated face); every token and signed-in browser by label and state, never a value, with revoke and sign out: the live ones first, thirty at a time, the revoked, expired and signed-out ones folded under one heading with their count and opened thirty at a time, the tokens bound to jobs (a body's own) apart from the rest in one fold, "Job tokens", whose heading counts the running and the ended, opened thirty at a time, a token whose job has ended said to be "Ended with its job" (sign-in refuses it) with no revoke, and a search over label, kind and owner of the rows already read; Make a token at the top of the tokens, for a member, an agent, a machine or an outside program, whose value is then shown once; each outside program's grants, which can be changed. Small: members and agents. Folded: the counts, of tokens only those that can still sign in. Anyone who is not a household owner is told it is unavailable | never |
| `sharing` | yes: up to 60 projects, each with its goal, its members and agents as chips and its repositories as `repository` chips. Small: the first six with who is on them. Folded: the counts. Anyone who is not a household owner is told it is unavailable | never |
| `tickets` | yes: thirty tickets at a time, each a chip that places its `ticket` brick, with its id, title, project, state and who has it; "Show 30 more", up to 300; chips for the other three states; the search box. Small: as many of the first thirty as fit, and how many more. Folded: the count | never |

**The household's ticket list, 2026-11-27.** `tickets` is the desktop's Tasks list (`pieces/tasks/query.ts`,
`shared-view.tsx`) across every project the member may read, one state at a time, read through the generated
`readyTasks` and `tasks` and so by the tasks rule alone (`policy.ts` `task`). `ready` is `readyTasks` (open, no
unclosed blocker, not an epic, not shelved, decided in SQL); `in-progress` is `tasks` in progress in no project or
one not retired; `shelved` is `tasks` not closed in a retired project, which is how loom decides shelved
(`taskShelved`); `all` is every ticket, closed ones included, latest change first. The other three are in the
desktop's order: priority, position, id. In progress and Shelved first read the projects with loom's word for
each one's state (`projects { id lifecycle }`) and keep the retired ones; the page never reads the column that says so
(`src/single-home.contract.test.ts`). The projects rule gives a project to exactly those who may read a
ticket in it, so this widens nothing and misses nothing. With none retired, Shelved asks nothing. The desktop reads every ticket and
splits them on the page; the brick asks for thirty and one more, and "Show 30 more" asks for thirty more each time,
up to 300, past which it says to search. **Reads:** the list and the retired projects are live, relaxed. The search
(big form only) is one request (`useDataOnce`) on Enter or Search, never while typing, asked again only on "Show 30
more", and the live list is paused while a search is shown. The words go to that read as a `like` over id, title,
goal, why, description, project and who has it (each word in turn, case ignored for ASCII). They are never a
parameter, never told to the board and kept nowhere. Checked: `web/src/boards/bricks-tickets-queries.test.ts` runs
each state's selection, and the search, against the generated schema under the real tasks and projects rules (a
member, a household owner and a member on no project); `web/src/boards/bricks-tickets.test.tsx` checks the variables
asked for each state, rows as `ticket` chips, empty, loading, unavailable, paging to the cap, and the search (once
on submit, results, nothing matches, unavailable, back to the list, nothing to the board).
| `projects` | yes: up to 200 projects by name, each with its goal and where it stands, and a search box. Small: the first six. Folded: the counts | never |
| `catchup` | yes: every project with something since `since`, by name, its three newest moved tickets, each a `ticket` chip with what moved it (an agent's update with the agent's chip, a comment, closed, started, opened) and when, the project's chip, and chips for the other two times. Small: as many moved tickets as fit across projects, newest first, with their project. Folded: how many tickets moved in how many projects | never |
| `trend`, added later on 2026-11-27 | yes: also "Backlog history", opened on a press: what was open at the start and the end of the chart's window, and the desktop's groups with their counts, a picked group's tickets as rows that place the `ticket` brick, each its title and id, fifty at most | as above |

**The catch-up and the backlog history, 2026-11-27 (t-2428).** `catchup` is the desktop's Work catch-up
(`pieces/work/catch-up.tsx`) across every project the member may read, through the desktop's two reads, by the brick's
own names: the projects with their tickets changed since a time, four a project, each with its latest comment
(`projects { tasksByProject }`, the generated schema, so by the tasks and projects rules alone), and the agents'
latest updates on tickets, four a project (`projectActivityHighlights` with no project: only tickets the member may
read, in projects they may read, from sources they may read, `core/conversations/project-posts.ts`). They are put
together as the desktop puts them: a ticket says the newest of its update, its comment or what happened to it, a
ticket only an update names is listed too, and a removed project is left out. The desktop's time is "since your last
visit on this desktop", kept in the browser's storage; a board keeps nothing there (rule 3), so the time is the
parameter, and `today` is the default because it is the nearest fixed choice to a daily visit and the smallest read.
`today` is from the start of the member's day in the device's zone, and `3-days` and `7-days` from the start of the
day two and six days before it, as `trend` counts its days; the time is worked out when the brick is drawn and when
its parameter changes, not again at midnight. **Reads:** both are live, relaxed; if the updates fail the changed
tickets are still shown, with a line saying the updates are unavailable. The project names are `project`
chips; an update's agent is an `agent` chip; a comment's author is its id, in words.

`trend`'s backlog history is the desktop's `projectBacklogWindow` (`core/data/backlog-window.ts`, the desktop's
`pieces/work/backlog-window.tsx`) for the project and the window the chart shows: from the start of the first of its
`days` to the moment it is opened. It is drawn in the big form only and is closed until the member opens it. **Reads:**
none live. Each opening is one read of the counts (`useDataOnce`), and each group picked one read of that group's
first fifty tickets, by title; past fifty it says how many there are. Hiding it,
the brick leaving its big form, or its project or `days` changing forgets what was read. Who may read it is the
server's rule: a project the member may read, and in it only the tickets the member may open today; any other project
is no answer, and the section says the history is unavailable. Before loom kept the history (migration 44) it says
where history starts. Checked: `web/src/boards/bricks-catchup-queries.test.ts` runs the catch-up's two reads and the
backlog history against loom's generated schema and the server's own fields under the real rules (a member, a
household owner and a member on no project); `bricks-catchup.test.tsx` and `bricks-trend-backlog.test.tsx` check
each time's variables, each form, empty, loading, unavailable, the updates failing alone, opening and closing, a
picked group, and forgetting on a change.

**The conversations and agents bricks, 2026-11-27.** Each reads what the desktop's Comms, Home and Agents apps read.

- `threads`: the list the page's own switcher reads (`commsThreads` for the member, one folder, with `unread`), each
  row an ordinary link to `/app/t/<thread id>` with the agent's name and "Working" and "Unread". Side: the first six
  and how many more. Compact: one line of counts. Primary (2026-11-27): each row has Pin or Unpin and Delete…, named
  for the row and quiet (the kit's `RowTools`, at the row's end before its time: seen when the row is pointed at or
  holds the keyboard, always seen where nothing can point, never out of the tab order), by `comms.change` (pin with `pinned`, or `delete`), the operation and permission Comms' More menu
  uses: the thread's member and nobody else (`src/shared-conversations.ts`). Delete asks first in place of the
  row's controls, naming the conversation by its title, and sends nothing until answered yes. The board is told
  `pin`, `unpin` or `delete` with an empty detail, after the change saved; a refused or failed one says so under
  the row and tells the board nothing. Above the rows is Comms' search, as the panel's: asked on submit in the
  brick's own folder, once (`useDataOnce`, never a live selection), and asked once more after a pin or delete
  among its results, since its answer does not follow changes. The list itself is the brick's one live read, as
  before; search adds none. What was typed is never a parameter or a detail (rule 1). Comms' later pages are not on
  it. Delete is Comms' delete: what it removes and keeps is under "What ends a trace before 90 days". The
  conversation the page is open on (`Here` in `brick-kit.tsx`, which the page provides) has no Delete in the brick,
  in the list or among search results: deleting it from there left the page on a thread that was gone. The header's
  panel still deletes it, and then goes to `/app/boards`.
- `agent`: Home's card for one agent. Its directory name; its state line in Home's words (Working, Waiting, Quiet,
  Unavailable, and how many of its questions need the member); its own report (`agentStatus.work`); its description
  (`agents.about`); what it is doing now (`agentDoing`, in Home's sentences; the desktop's addresses for those are
  not drawn); its jobs (`jobHistory`: side, up to three running and the two latest ended; big, the last thirty), each
  a `session` chip where the job has a conversation, a running one with Stop (asked first, `runtime.jobStop` with
  `write-off`, as the `session` brick); its open tickets as `ticket` chips; and a link to its conversation with an
  unread reply, else its latest (`homeComms.summaries`), for an agent the member may give work to. Big
  (2026-11-27, t-2428): its activity posts, as the desktop's Agents app reads them: `agentActivityFeed` (its five
  latest threads of posts, each with its latest post as plain words; one live read, relaxed, drawn and read in the
  big form only), and a thread's posts, `agentActivityHistory`, read only once its row is opened, one thread at a
  time, 25 a page with Earlier posts and Newer posts; a post made for a ticket is that ticket's chip. Opening is the
  drawn brick's own, never a parameter or a detail, and an opened thread is dropped when the brick is no longer the
  big one. The desktop's work links on a post are not drawn, and earlier threads than the five are "in the Agents
  app". The two selections are the desktop's, written out in the brick (so its chunk does not take the desktop's kit)
  and pinned to the desktop's text by the suite. Not drawn: an agent's private-machine jobs, its last steps, and the
  machine a job ran on. `currentJobs` is not read:
  `jobHistory` holds the running jobs too, with their conversations.
- `agents`: Home's roster (the member's own agents, in its order), one line each: the name as an `agent` chip, the
  state line, the first thing it is doing and how many more. Compact: how many agents, how many have work in hand
  (`agentsAtWork`, the desktop bar's read) and how many wait on the member.

**The Tempo bricks, 2026-11-27.** Each reads what the desktop's Tempo app reads and says it in that app's words
(`web/src/pieces/tempo/model.ts`, `query.ts`), through the same visibility: a trigger the member may not see is in
neither.

- `tempo`: the `Tempo` read (`triggers`, `agentPauses`, the household's timezone), kept to the triggers that wake
  or belong to the agent, as the desktop's "Whose" filter keeps them, in its list's order (next firing first). Each
  trigger: its name as a `trigger` chip (its name alone when its id is not one a board can hold), Tempo's word for
  its state (Standing, Due, Firing, Held, Spent, Stopped, Failed), its kind, its source in words, its next firing,
  when it last fired, and what that firing came to where the day's read holds it. "Paused since" when the agent is
  paused. Big: "Today", the household day's recorded events for these triggers, newest first, as Tempo's "Recent
  history" lists a day (`TempoDayHistory` and `tempoCalendarOutcomes`, read for the household's today by `deskTime`).
  The last firing's outcome is known only inside that read (yesterday to tomorrow); an older one shows its time alone.
  It has no search, no day picker, no week and no subscription readings. Big, it ends in **New trigger…**, the
  desktop's Create trigger (`web/src/pieces/tempo/create.tsx`), added 2026-11-27 for parity (t-2428): pressed, the
  form takes the place of the list and the day, with that form's fields in its order and words, its choices drawn
  as `Segmented` rows in place of its select controls, "Set by" an agent and the recipient this agent until the
  member changes them, and Create trigger disabled until a label, a time or a watched record, an owner where one is
  named, and the words, file or operation are there. It sends that form's input through the desktop's call
  (`tempo.set` by `web/src/pieces/tempo/commands.ts`); who may set what was asked is loom's answer to that call
  (policy.ts, `maySetTrigger`, and the watched record's own read rule), so a member is offered the form and refused
  in words where the operation refuses them. Then the board is told `create` and the list returns, saying it was
  created; a refusal keeps the form and what was typed.
- `trigger`: the desktop reader's reads (`TempoCard`, `TriggerHistory`, `ProgramDetails`, `JournalDetails`). What it
  fires on, when it is due, who set it, its target, its words or repository file, its recent runs (what each was,
  how it ended, how long it took, and a `session` chip for a run with a conversation), and in the big form its
  project, machine needs, requested model, program, lessons and saved state (loom answers the journal to an owner
  only), and its recent history. Its buttons are the desktop's, by the desktop's calls to `/api/tempo/…`
  (`web/src/pieces/tempo/commands.ts`): Run now and Stop (Cancel for one that is not standing) ask first; Start for
  a stopped standing trigger whose schedule was not removed; Pause agent and Resume agent. Whether the member may
  is loom's answer to the call. **It cannot edit or delete a trigger.** The desktop's Tempo app has no editor and no
  delete (`tempo.edit` is called by agents and the command line only, and loom has no operation that deletes a
  trigger: Stop is the end of one), so the brick says "To change its times or words, ask its agent". A new trigger
  is created from the `tempo` brick, as the desktop's Create trigger sits above its list.

**What the five bricks drawn on 2026-11-27 show.** Each reads what the desktop reads for the same record, and says
it in the desktop's words.

- `pull`: the `changes` row and its `change_checks`, `change_people`, `change_files` and `change_tasks` rows. Title, number,
  repository (a `repository` chip), open, draft, merged or closed, checks, review, who it waits on, and its tickets as
  `ticket` chips; a link that opens the pull request on GitHub in a new tab, drawn only for a `https://github.com/`
  address; and, big, the files it changed, each with its added and removed lines, or a note that they are not known
  yet. `change_files` is kept from the same read of GitHub as the checks (at most the first 100 files GitHub lists)
  and is read with the same rule: seen with its change. Each file's name opens its row in place to that file's patch
  ("The pull brick's file patches", below). A ticket the member may not read is left out. `changes.answer` exists and a
  member the household lets answer may call it, but it is a merge approval's answer and needs the approval that is
  waiting for that commit; it is answered with the approval, in the `approval` brick. Added later on 2026-11-27, in the big form only:
  - **When loom last read GitHub.** The brick's last quiet line (`board-foot`): "Last read from GitHub" and the time,
    from `changeSync` (`readAt`), and "The last read failed: this is the copy from before it." where `failed` is set;
    "Read GitHub again" stands on the same line.
    `changeSync` is a household owner's read (`src/policy.ts`); anyone else reads no row and nothing is said. It rides
    on the brick's existing selection, so it adds no selection.
  - **Loom's reviews.** The desktop's own read of a pull request's review rounds (`changeReviewHistory(change)`,
    `src/pieces/changes/review-query.ts`, under the change's and the review job's rules). It is behind the
    heading "Loom's reviews" (`Fold`), asked only while that is open and live while it is (relaxed, like every brick read), and
    forgotten, with the opened files, when the brick leaves its big form or its change or head commit moves. Each round:
    "Round N · tier", the verdict in the desktop's words (Pending, Clear, Blocking, No verdict), "Current commit" or
    "Earlier commit" with the commit's first seven characters, and its findings as plain text. None: "Loom has not
    reviewed it."; a read that fails: "Loom's reviews are unavailable. Close them and open them again to try again."
  - **Read GitHub again.** The desktop's Refresh of Changes (`refreshChanges`, `web/src/data/work-refresh.ts`: one
    POST to `/api/changes/refresh`, operation `changes.refresh`, `src/shared-work-refresh.ts`), which reads every pull
    request loom follows again; there is no read of one pull request alone. Its permission is the desktop's and nothing
    wider: the operation's `may` is `workAnswersAllowed`, a current household owner (`src/shared-work-access.ts`), and
    the button is drawn only where the desktop draws it, for a member to whom `workChangesRefresh` says yes (loom has a
    GitHub source and the member is a household owner; `useWorkAccess`, `web/src/data/work-approvals.ts`). Pressed, it
    says "Reading GitHub…" and cannot be pressed again; done, "Loom has read GitHub again." and the board is told
    `refresh` with an empty detail; refused by loom (403, as when the member stopped being an owner since the page drew
    it), "Loom refused: only a household owner may have it read GitHub again."; any other failure, "GitHub could not
    be read just now. Try again in a moment." Neither failure tells the board anything, and the button stays.
    `refreshChanges` now throws a `RefreshError` carrying the door's status so the brick can tell the two apart; the
    desktop's message is unchanged.
- `repository`: the open `changes` rows of that repository, in one project when `project` is given, latest first, at
  most 30, each a `pull` chip. Loom gives a member no read of `project_repositories`, so the brick cannot tell a
  repository that is bound to a project and has never had a pull request from one that does not exist: both draw
  "unavailable". It shows nothing else about a repository because loom keeps nothing else a member may read.
- `question`: the Inbox's own read of one item (`inboxItem`). Its words, why, what yes and no mean, who asked, what
  it is about as chips, and its state. It is answered by `inbox.answer` with exactly what the Inbox sends: Yes and No
  where the question takes them, an answer in words, Mark done, Dismiss. The controls are drawn only where the
  desktop draws them: the item waits, takes an answer, still has its words, loom says the member may answer it, and
  it is not one answered somewhere else (an approval, a task question, a secret request). Words the member types go
  to `inbox.answer`; `boards.act` is told `answer=words` and never the words. An answered question shows its answer
  and no controls. `inbox.discuss` (open a conversation about an FYI) and `inbox.dismissResult` (clear the notice of
  one's own action) are not about a question and are not on the brick. The brick does not mark the item read.
- `approval`: answered from the board, by the code the desktop's card runs. There is one copy of each safeguard:
  the decisions are in `web/src/pieces/approval-view/answering.ts` (functions and one hook, no component) and the
  composition is in `web/src/data/work-approvals.ts`; the desktop's view and the brick both draw from them, and the
  brick adds only markup. The boards bundle lists those modules by path and still refuses the desktop's kit.
  - **Who may answer.** Allow and Deny are drawn only for a member loom says may answer (`workAnswerOwner`, a live
    yes), on a request that still waits. Anyone else sees the request and no control. `approvals.answer` rechecks.
  - **What is shown first.** The title, the question where it says more than the title, why, the agent, the
    project, who it is for, what allowing and denying do, the stored summary of the change, exactly what it allows
    (kind and target), and the details, headed "Full command" where the request was filed as a literal command. A
    Tempo or Measuring settings change that checks against its stored summary is drawn as before and after in the
    desktop's words, in place of the stored JSON. What already stands against the request is said above the buttons.
  - **A household change.** Without the owner's reading, the title, why and state only. For a member who may
    answer, the brick asks `household.proposalPreview` and draws that reading: its title, facts, what each answer
    does and the exact request. It is read again after a refused Allow and, in a browser, when the window is looked
    at and every minute. Where the reading carries a version (`review`), Allow sends that version, the one on screen.
    Until the reading arrives, an owner has the buttons over the title and why alone, as on the desktop; the
    operation then checks the change against what was filed.
  - **A dangerous action.** Allow sends nothing and asks again ("This cannot be undone."); only "Yes, allow it"
    sends, with `confirm`. A new version of the request starts this over.
  - **Deny.** One press. A reason, up to 2000 characters, is optional and goes to `approvals.answer` only.
  - **A refused answer.** loom's own refusal is shown in its words and the controls stay; any other failure is one
    fixed line. While a call is in flight every control is disabled and a second press is dropped.
  - **Answered.** Once the request no longer waits, whoever answered it, the brick shows the state and who
    answered, and no control. The compact form is one line with no control in any state, and does not ask loom
    whether the member may answer.
  - **Always.** The desktop's standing answer for a merge ("Always for <project>") is offered where the desktop
    offers it, by the one rule both use (`useStandingAnswer` in `web/src/data/work-approvals.ts`): to a member who
    may answer, for a waiting merge request with a project, made for a member of the household, whose pull request
    loom reads as open, the same agent's, in the same project, at the commit the request names. The brick asks
    first: the press says what a standing rule is and sends nothing; "Yes, always allow" sends `approvals.always`
    and Cancel takes the question back. The two steps are the shared hook's (`askStanding`). The desktop sends on
    one press, as before.
  - **Not on the brick.** The desktop's display names for agents (the brick shows ids as chips), and the
    household's time zone (times are in the device's). After `approvals.answer` succeeds the board is told
    `approve` or `refuse`, and after `approvals.always` succeeds `always`, each with an empty detail.
- `question` also shows what the desktop's opened item shows around the answer: the approval of a household change
  by its plain title in place of the words stored with the item, "Open linked page" for a web address or a path of
  this site, everything the item is about (a chip for a ticket or an approval, the id for anything else), and
  "Notify" (Normal, Quiet, Hidden, by `inbox.volume`) for an item the member may set it on, with what the chosen
  one means and when it ends. Not on the brick: marking the item read when it is opened (the `inbox` brick has
  Mark read), "Discuss with <agent>" (`inbox.discuss` opens a Comms thread, which this page has no brick for), the
  answer to a task's question and to a machine asking to join (both are answered where they were asked), and the
  household's time zone.
- `inbox`: the Inbox's own selection (`inboxSelection` in `web/src/pieces/attention/inbox-query.ts`) and its own
  rules for which rows a folder holds, their order and their words (`web/src/pieces/inbox-view/model.ts`). Not on
  the brick: the search, a folder for one agent (neither is a choice from a fixed list), the link from an outcome
  to the desktop page it happened on, and answering, which is the `question` brick's.
- **Added later on 2026-11-27, and in place of what the two entries above leave out.** The `inbox` brick's big form
  has the desktop's search: a field, "Search asks", whose words are this page's state and go to the Inbox's own read
  as its `search`, from the first page, as the desktop sends them; no parameter and nothing told to the board holds
  them, and the small forms and the Errors folder have none. The `question` brick has the three answers the
  desktop's opened item gives beside the Inbox's own. "Discuss with <agent>", for an item loom names an agent for
  (`discussionAgent`): `inbox.discuss` with the item and that agent, then the page goes to the thread it answers
  (`/app/t/<thread>`). A task's question (`source` and `waitsOnKind` both `task`): Yes, No or words through
  `tasks.command` `answer` with the task, the item and the answer, as the desktop's card sends it, with no Mark
  done or Dismiss. A machine asking to join (a waiting notice whose key is `worker-join:<request>:<code>`): "Let
  it in" and "Block" by `runtime.workerJoinDecide`, each after asking, which the desktop does not do; loom refuses
  anyone but an owner. Still not on either brick: a folder for one agent, and marking an item read when it is opened.
- `approvals`: the desktop's own selection (`approvalsQuery`) and its rule for the two lists
  (`rows` in `web/src/pieces/approval-view/model.ts`). A household change is listed by its title, reason, state and
  agent; who answered it is not said, as on the desktop for a member with no reading of it. Not on the brick: the
  search. Added later on 2026-11-27, the desktop's other two folders, as two more states:
  - `rules`: the standing rules (`approvalRules`), in the order loom gives them, each as the desktop's Rules folder
    says it: its scope (`scopeWord`: Everything, Project <id>, or the pattern), the kind of request (`kindChoice`),
    "for <person>" where it is for one, its answer (`tierWord`: Ask me, Tell me after, Just do it) and, big, who set it
    and when. Read only: a rule is made, changed or removed by asking the agent, which the big form says.
  - `notices`: the reported steps, as the desktop's Reported steps lists them (`approvalSnapshot`,
    `web/src/data/work-query.ts`): the `approvalNotices` rows (what an agent did under a "tell me after" rule), the
    steps reported on a request and the answers quoted from a conversation, both from the record, newest first. Big,
    the first fifty and a line counting the rest; small, as many as fit and "and N more".
  - **What each state reads.** The desktop's `approvalsQuery` reads the requests, the rules, the notices and the
    record at once; the brick now reads per state, with the desktop's fields: `pending` and `answered` the requests
    and the record (no longer the rules and notices they never drew); `rules` the rules, and of the requests only
    `id` and `state`, for the count of pending it flags itself by; `notices` the notices, the requests and the record,
    which the desktop's composition of Reported steps needs. One live selection a placement in every state, as
    before.
- `person` with `contact:<slug>`: the shared card People opens (`memoryPerson`, id `commons:<slug>`): name, summary,
  how to reach them, linked projects. A member is drawn by their open tickets. Since made fuller: see "What loom
  knows" below.

**Work written from the board, 2026-11-27.** Every write below is the desktop's own `tasks.command`, sent through
the desktop's door for it (`web/src/data/task-command.ts`, which now also hands back loom's answer), with the input
the desktop's form sends. What a member types goes to that command; `boards.act` gets the action's name and at most
one fixed choice. A refusal shows loom's words, keeps the form and tells the board nothing. The page has no native
picker, so a fixed choice is a row of buttons and another ticket is typed by id, with the tickets the member may
read offered as they type; an id that is not one of them is not sent.

- `ticket`: beside what it showed, its priority, who filed it and when, why it was closed, and its parent, children,
  blockers and the tickets it blocks as `ticket` chips (a linked ticket the member may not read is its id and no
  chip). The big form has Edit (title, goal, why, done when, description, priority, project: `edit` with all seven,
  refused on the page while title, goal or why is empty) and Links (Parent and Blocked by: `link` and `unlink`; a
  ticket with a parent is offered no second one). Not on the brick: Ask a person and Promote to epic, and the
  desktop's display names. Comments are the `comments` brick.
  Since made fuller with the desktop's own reads of a ticket (web/src/pieces/tasks/index.tsx), visibility being
  what each of those reads already enforces:
  - *Its pull requests* (`changeTasksByTask`, one the member may not read left out): asked with the ticket's own
    read, so they add no read of their own. Big, a `pull` chip by number with the title and state (open, draft,
    merged, closed); small, the chips alone on the meta line. An id a board cannot hold is its number, no chip.
  - *Where it was filed from*, big only (`taskSourceQuery`: `conversationsSingle` for its `sourceId`), asked only
    for a ticket whose source is a conversation, and asked once, not live: the conversation a ticket names does not
    change. A conversation of the app's own or a terminal's links to its thread on this page; a handed-off session
    is a `session` chip; any other is named by its venue. One the member may not read is not drawn.
  - *Reviews*, big only and only for a ticket with a pull request the member may read, as on the desktop: loom's
    rounds (`taskReviewHistory`) for those pull requests, each "Review N · #number · head", its verdict and its
    findings; then GitHub's reviews (`taskGithubReviews`), who, the verdict, the body and "Open on GitHub" for a
    `https://github.com/` link alone.
  - *Story*, big only: the agents' activity posts about it (`ticketActivityPosts`), each by its agent as an `agent`
    chip, with when and its words.
  Reviews and Story are closed until the member opens them, and nothing of either is read until then; hiding one
  forgets what was read. Each is read once when opened (`useDataOnce`, as a pull request's file patch is), not as a
  live read: a long history read again for every commit in the household would cost the most of any read on the
  brick for what changes least. GitHub's reviews and the story are read thirty-one at a time, thirty drawn, and the
  thirty-first shows a control (Older GitHub reviews, Older posts) that reads the next page, once. Loom's rounds are
  one read, as on the desktop. Loading, empty and unreadable each say so in the section.
- `new-ticket`: the desktop's Create task form for the brick's project: title, goal, why, done when, description,
  priority, type, owner (the household, a member or an agent in use) and parent. After filing it shows the new
  ticket as a chip and clears. It does not record a conversation as the ticket's source.
- `backlog`: the project's tickets that are open, not shelved with a retired project and not on the project's board
  (`projectBoardTickets`, at most 100 read), in the desktop backlog's order: priority, hand-kept position, id. The
  big form sets a priority with the desktop's Set priority. It has no search, folders or reordering by hand.
- `unfiled`: the first page of the desktop's Unfiled view (its selection, `workUnfiledQuery`): tickets under no
  project, latest change first, closed ones included. The big form files one into a project with the desktop's Set
  project. It has no further pages.
- `lanes`: each card also says its priority and who has it; why it waits was already there. `projectBoardTickets`
  gained `priority` for this (the same rows, to the same readers). The big form adds "Needs you · n" from
  `inboxProjectNeeds` when n is above zero, and, from `projectClaimStates`, each agent whose claims the member may
  direct with whether it takes new tickets there; Pause and Resume ask first and then call `work.setProjectClaims`
  with the revision on screen. The board is told `pause` or `resume`, not which agent. Not on the brick: the
  desktop board's epic filter, its recently finished lane and its pages; the questions themselves (the line is a
  count).
- `project`: its goal and lifecycle, its members as `person` chips (the project's own member rows) and its agents
  as `agent` chips (those in `projectClaimStates` and those with a card for it in `workProjectContributions`). The
  big form adds its name, each agent's card for it (name, goal, summary) and the repositories that card names
  (`memoryProject`), each a `repository` chip in this project. Loom still gives a member no read of
  `project_repositories`, so a repository bound to the project that no agent's card names is not shown. It has no
  action; the desktop's project discussion is not on it. **Its agents' notes (2026-11-27)**: the big form has
  "Agents' notes", closed until the member opens it, and nothing of it is read before then. Opened, it asks once, in
  one request, each agent's card for the project (`memoryProject`) for its Memories section: the previews loom gives a
  project's card (its latest twenty notes and its ten most used, each the title and the start of the words), with
  how many there are in all. The search box filters those previews on Enter or Search (every word, in any case); the
  words stay in the box. A note opened is read once by `memoryProjectMemory` and shows its whole words. Loom has no
  read that searches all of an agent's notes on a project, and none was added: a note outside the previews is not
  found. What may be read is the server's: an agent's notes answer a household owner and a member with that agent on
  their own list (`maySee`, `type: 'memory'`), and a card or note anyone else asks for answers nothing. Closing the
  section, the brick leaving its big form or its project changing drops what was read.
- `projects`: the desktop's Work project directory (`projects`, ordered by name; `workHomeQuery`), one live read of
  the first 200 and one more to know there are more, each a row placing the `project` brick, with its lifecycle and,
  big, its goal. The table's own rule decides what is listed: every project for a household owner, the projects a
  member is in for anyone else, so unlike `sharing` it is not an owner's brick. Big, a search box filters the rows
  read, on Enter or Search, by every word in the name, id or goal; the words are never sent. Past 200 it says the
  rest are not listed or searched.

**Still not drawn, 2026-11-27.** No brick has a hover form. Writing a brick in words as `[label](loom:<brick>/<key>)`
is not built; only a bare ticket id becomes a chip. A merge cannot be answered from its `pull` brick; its approval can, from the `approval` brick.
Whether `memoryPerson` updates live is answered under "What loom knows" below. None of the five has been looked
at in a browser: they are drawn with the classes the other bricks use, and their look is unjudged.

**What loom knows, on the board (2026-11-27).** Four bricks and a fuller `person` show what the desktop's Knowledge,
People and Activity apps show. Each reads with the desktop's own selections (`web/src/memory/queries.ts`), says it
in the desktop's words (`web/src/pieces/knowledge/model.ts`, `people/model.ts`, `activity/model.ts`, all three plain
modules the boards bundle now lists by path) and calls the operations the desktop calls with the inputs it sends.
No read, operation or table was added.

- `knowledge-page`: `memoryKnowledgePage`. Title, topic (a `knowledge` chip), "Fresh", "Getting old" or "Due a
  check" as loom works it out, when it was verified or written, and its words drawn as a reply is. A `[[slug]]` link
  in the words is drawn as its label, and the pages linked are `knowledge-page` chips under the words. Big: also how
  often it is checked and who checked it last, the recent checks and annotations, the sources (a source's link opens
  in a new tab), the pages that cite it as chips, how it was sourced and who wrote it. "Still true"
  (`mind.knowledgeVerify {slug}`) and "Check again" (`mind.knowledgeRecheck {slug}`) are on the big and the side
  form, each enabled only where `memoryKnowledgeAccess` says the member may; until that read answers there is no
  control. Big, a member who may add has the annotation form: one of the five kinds, as buttons, and words
  (`mind.knowledgeAnnotate {slug, kind, words}`). Side: the title, the state and the first three lines. The
  desktop's reader does not show a page's earlier versions, and neither does the brick. Times are in the device's
  zone, not the household's.
- `knowledge`: `memoryKnowledge`, filtered and ordered as Knowledge's lists are (all and recently verified newest
  first, due by the oldest check first), within `domain` and the topics under it when one is given. Each page is a
  `knowledge-page` chip with its state. A count of pages due a check is a chip that places the brick with
  `show: due`. Big: Knowledge's topics as chips that place the brick for one topic; a search box whose words are
  held by the drawn brick, sent to `memoryKnowledgeSearch` (within `domain` when given, 30 results) when the member
  presses Search, and never stored, never a parameter and never told to the board; and, for a member
  `memoryKnowledgeAccess` lets add, "Add a fact" (`mind.knowledgeAdd {title, domain, body, source}`), after which the
  new page is offered as a chip. The desktop's search box filters titles and topics as the member types; the brick's
  asks loom's search, which also reads the pages' words and needs every word to match.
- `person`, fuller. A contact (`contact:<slug>`): the shared card, and from the directory People lists
  (`memoryPeople`) the relationship cards of the agents this member may read. Small: name, summary, where they are
  reached, the agents that know them as `agent` chips, linked projects as `project` chips. Big, as People's reader:
  a merge that led here, what a member owns, each address as People links it with its state, when it was verified
  and its source, where they were last seen, the card's facts, each agent's relationship card (summary, how old it
  is, its facts, the permissions it records and "These records do not grant access.", and the notes behind it, each
  folded under its title), linked projects, the member's own conversations with them as `session` chips, and
  "Contact details and relationship notes do not grant access.". A member (`member:<id>`): the same card when there
  is a shared card under their member id, which is how loom marks a member's card, and under it their open tickets
  as before; with no card, their open tickets alone. The brick has no action, like People's reader.
  Known limits: a linked project is an agent's project card, and its chip places `project` with the card's slug,
  which is the loom project's id only where they were named alike; a conversation with no job the member may read
  draws `session` as unavailable. The desktop's links to Sharing are not on the brick.
- `people`: `memoryPeople` and `memoryPeopleAccess`, grouped, ordered and searched by People's own function. Each
  person is a `person` chip (`member:<slug>` for a card that says what a member owns, otherwise `contact:<slug>`),
  each agent an `agent` chip, with "Stale contact details" where People says it. Big: who knows each, a search box
  that filters the list as the member types (inside the drawn brick; nothing is sent, stored or told to the board),
  and for a member loom lets add, "Add a person" (`mind.personAdd {name, summary, channel, handle}`, the channel
  chosen from the operation's six), after which the person is offered as a chip; otherwise People's hint about the
  default agent. The desktop's "Known to agent" filter is not on the brick.
- `activity`: `memoryActivityAccess` for the household's day, zone and the three-day windows Activity reads, then
  `memoryActivity` for as many windows as the range needs (1, 3 or 10), keeping the newest `days` days. Each row:
  time in the household's zone, the agent as a chip, the title, "Work done" or "System", and a `ticket` chip for
  each ticket id in its title or line. Big: grouped by day, with where it happened and "with you"; a row's title
  opens that entry in place (`memoryActivityEntry`): what it needs, what was asked, what happened, what was decided
  or shipped, its tickets as `ticket` chips and its pull requests as `pull` chips where the link names a change loom
  could hold (a GitHub pull request address or loom's own change address), any other link as a link that opens in a
  new tab if Activity would follow it, its last eight steps, and Activity's lines for a source that is missing.
  Read-only, and it never flags. Not on the brick: Activity's filters by who, where and what, its hour strip, the
  agents' faces, and "Earlier in this conversation".

A slug or id that is not shaped like a reference (a page slug with a space, say) is drawn as words with no chip,
because no board could hold it.

**Are they live (rule 8)?** Yes, for every change loom makes. These reads are fields of the same live query layer
as the tables, and loom reruns every live read after each committed operation, whichever store it wrote
(`src/shared-root.ts`: the operations' commit signal goes to `installMemorySignals`, which calls the data layer's
`changed()`), and at each time a page's state, a contact detail or the household's day turns over
(`nextDeadline`). So a check, an annotation, a new page or person, by this member, another member or an agent,
is drawn with no reload: `src/shared-memory-socket.test.ts`, `src/shared-memory.test.ts` and
`src/shared-startup.test.ts` hold this for `memoryKnowledgePage`, `memoryPerson`, `memoryActivity` and a
`mind.knowledgeAdd` over HTTP. The one case that is not immediate: a program other than loom writing a memory
file directly. Loom is not told, and the bricks show it at the next committed operation of any kind or the next
deadline. Nothing was added to the bricks for this; the page's own tests use a fake data hook and do not test it.

**Sessions.** A job in the thread hands work off with `conversation.handoff` (a work role or a harness), which loom
has today: it opens a child conversation for the same agent, member and project and returns that conversation's id,
and the child's result comes back to the thread as a reply that wakes the agent. `session` takes that id. It shows the
latest job in that conversation, or in any conversation with jobs that the member may read. Small: its title, its
state, how long it has run, the tools it has used most, and (the side form, for a handed-off session) its latest
step as one line. Big: also what it was asked, what it runs on, how it ended, and its steps. The member can stop it, by `runtime.jobStop`, which loom allows a member for an agent on their list. A harness's
own subagents inside one job are not sessions and loom keeps no record of them for an ordinary job.

**A session's steps.** The body of a job handed off from a member's thread (the worker's assignment says `review`)
on the owners' word reports each tool call and each result as a card, and (since schema 55) the agent's own words and
its readable reasoning between them, by the same decoding of the harness's output
and the same disclosure check as the pairing thread's cards (`src/runtime/body-program.ts`,
`src/runtime/pair-events.ts`): a tool name or a step's words that say a secret the body holds, one of its own credentials, or a
token shaped like one are replaced by "Tool" and by "Output withheld."; words past 16,000 characters are cut. Loom keeps each card in `job_trace` under the child conversation (`src/core/conversations/job-trace.ts`),
not in the thread: the thread's transcript, its turns and its unread state are untouched, and the child's final
reply is relayed to the thread exactly as before. A retried report writes one row.

**A step's kind** (`job_trace.kind`, schema 55): `tool` (a tool call or its result, what every step was before; every
row kept before schema 55 reads as one), `words` (what the agent said between its tool calls, its own message text) or
`reasoning` (its reasoning, where the harness gives it as readable text). The kind is a column because nothing else
could carry it: `tool` is the body's name for a tool and Codex names an MCP tool by its bare name, so any value
reserved there could be a real tool's, and an old row could not be told apart; `card_state` is a state; `client_id`
is a retry key; and a marker inside the sealed words would have to be opened to draw even the side form, and would
misread an old step whose output began with it. Loom writes a `words` or `reasoning` step's tool line itself (`Words`,
`Reasoning`) and its state (`done`), whatever the body sends; a thread's card that names a kind other than `tool` is
refused, so words and reasoning never enter a thread, a pairing room's included. What each harness gives, read
2026-11-28 (`src/runtime/pair-events.ts`):

- Claude Code (`stream-json`): each top-level `assistant` event carries one block. `{type:"text",text}` is words.
  `{type:"thinking",thinking,signature}` is reasoning, but on Claude Code 2.1.326 with Opus 5.5 `thinking` is always
  empty with a signature only, `--settings {"showThinkingSummaries":true}` included, so no reasoning step comes from it
  today; `redacted_thinking` is never readable. An empty or redacted block makes no step. A subagent's own words
  (`parent_tool_use_id` set) are not the session's: its answer is its tool result.
- Codex (`exec --json`): `item.completed` with `{type:"agent_message",text}` is words, and `{type:"reasoning",text}` is
  the reasoning summary Codex prints as readable text; it never prints the encrypted reasoning. Read from Codex's event
  shape and loom's own fixtures, not from a live run.

The body keeps them for a handed-off session only, through the one disclosure check every step passes ("Output
withheld."), and bounds them (`src/runtime/body-program.ts`): one step's text is cut at 8,000 characters and says
where it was cut; one job keeps 200,000 characters of words and reasoning in all, and then one `Session` step in
loom's words says later words and reasoning are not recorded. Tool steps keep their own bound and still count against
the 2,000 steps of a job. Sealing, keep time, the sweep and who reads them are exactly a tool step's.

The page reads them with `sessionTrace(conversation, job, kind, limit, after, before)` (`kind`, where given, keeps only
steps of that kind; each step says its `kind`): the latest `limit` steps (100 by default,
200 at most), oldest first; or, with `after`, the earliest `limit` steps whose `seq` is greater, so a reader that
has some steps asks only for newer ones and no step is opened twice (a stored step never changes); or, with `before`,
the latest `limit` steps whose `seq` is smaller, oldest first, which is how the page loads earlier steps. `after` and
`before` together are refused. The page does not use `after` yet: it re-reads its latest 100, and so re-opens up to
100 steps, each time a step arrives. `sessionTraceCount(conversation, job)` is how many steps the trace holds in all,
under the same rule (nought for anybody else).
`sessionTraceExpired(conversation, job)` is true when that job has no step and was queued more than 90 days ago: an
expired step's row is deleted, and this is how the page tells "its steps are no longer kept" from "it reported
none". It is worked out from the job's age and nothing is stored for it; a job that old that never reported a step
is told the same, and steps that went early at a limit stamped before 2026-11-27 read as "No steps were recorded."
Both reads answer the same people. It answers only a signed-in member who is the member of that handoff conversation, which is
the member of the originating thread, and only while the conversation rule every Comms read uses lets them see it.
Another member, a household owner who is not that member, an agent and the job's own body all read an empty list.
Words are opened only when asked for, and are null on a read past their keep time that comes before the sweep has
deleted the row. The read is live like any other.

The session's final report, the reply its job relays to the originating thread (`review-result.ts`, client id
`review:` and the child conversation's id), is read with `sessionReport(conversation)` by the child conversation's
id (`src/core/conversations/comms-query.ts`). It is that thread's message and is read exactly as the thread's
messages are, under the same conversation rule and nothing wider: anybody who may not read them gets null, the same
null as a session with no report yet. That rule lets the job's own body read the thread, so it reads the report too.
It costs three statements, each on a key: the child conversation by id, the parent job by id with its conversation's
one thread (`threads_conversation_unique`), and the reply by `messages_client_id_unique`. Nothing is stored for it.
The big form draws the report's words under "Report", above "Steps", with the rendering the thread uses for a
message's words (`web/src/pair/reply.tsx`), and draws nothing for it when there is none.

**A session as a conversation** (Jonathan, 2026-11-28: "a session should look a lot like a conversation I just wasn't
involved in that's 90% tool calls"). The big form draws, under "Conversation" (`web/src/boards/session-trace.tsx`),
in one log that scrolls on its own: the brief the job was given (the job's own `brief`, read by the brick's
`jobHistory` read as before, not copied into the trace) as the asker's message; then the steps in the order they were
reported, each of the agent's `words` as its message, each `reasoning` as a quiet "Reasoning" line folded until
opened, and each run of tool steps between them as one "N steps" line (with "working" and how many failed) that opens
in place to the steps; then the report (`sessionReport`) as the agent's last message, and, where the job failed, "Why
it failed" after it. A trailing `words` step whose words are the report is drawn once, as the report. The messages and
folds are the chat's own parts (`web/src/pair/ui/message.tsx`, `bubble.tsx`, `trace.tsx`, and `pair/reply.tsx`,
markdown with no raw HTML, so markup in an agent's words is shown as text), composed as the thread's transcript
composes a message (`pair/transcript.tsx`). The latest run of a working session starts open, and so does a failed
session's last run; any other run is folded until opened. A session recorded before schema 55 has tool steps only and
draws as its brief, one run and its report. A session whose venue is not `handoff` reads no trace and draws its brief
and how it ended. The side form's latest step is asked for among tool steps only (`kind: "tool"`), so it reads as it
did; the compact form is unchanged.

Inside a run, steps are drawn as the conversation's own work-trace cards read them (`web/src/pair/work-trace.tsx`):
a call and its result are one card, a subagent's steps sit inside its card, the newest is at the bottom and stays in
view unless the member has scrolled up. It asks for the trace only when the conversation's venue is `handoff`.
A step's line is the first line of its command (or its tool) and its state; it opens in place to the whole command,
where that is longer than its first line, and its output. Above the list a note says how many steps there are in
all, and, where the page holds fewer, "Load earlier steps" reads the 100 before the oldest it has; the steps already
read are kept. In a step's output each `https:` address is a link that opens in a new tab (`rel="noopener
noreferrer"`); nothing else becomes a link.

**How long a step is kept: 90 days, on its own clock.** Decided by the owner, 2026-11-27: "record things period,
because we might want to review the session that made something later on... if we look at a closed ticket, having
the session that made it makes sense to me. at least for a while." and, on how long, "90 sounds good". A step's
words are kept 90 days from when the step was written. The household's Comms keep time (`comms_days`, 14 days at
most) does not shorten or lengthen that: it is a message's keep time and no longer a step's. The number is written
once (`TRACE_KEEP_DAYS`, `src/core/conversations/trace-keep-days.ts`) and every deadline is worked out in
`src/core/conversations/retention.ts`: `keep_until` is stamped from it when the step is written; the sweep that
erases expired message words deletes a step's row at the earlier of `keep_until` and 90 days after `at`; the timer
that runs that sweep is set for the next such time; and a read past it gives no words even before the sweep has
run. Nothing of an expired step stays: not its tool, its state or its time (changed 2026-11-27; before, the row
stayed without its words, and such rows go at the next sweep). The big form then says "Its steps are no longer
kept." Rows stored before this rule keep their earlier `keep_until`; nothing was backfilled.

**What this costs, said plainly.** A step holds what the session did and saw: the command it ran and what the
command printed, the file it read and the lines read, a subagent's brief and answer, each up to 16,000 characters.
The body replaces a secret it holds, its own credentials and anything shaped like a token before it reports
(above), but it cannot know that a file's contents or a command's output are private in some other way, so a step
can hold anything the session read or printed. These words now outlive the chat's own words: the thread's messages,
and the relayed result with them, are erased at the Comms keep time, and the steps of the work behind them stay up
to 90 days. Against that: a step's words are sealed at rest with the household's words key, the one a message's
words are sealed with, and the database file holds no step in the clear; they are read only by the member of the
originating thread (below: not another member, not a household owner who is not that member, not an agent, not the
job's own body); at 90 days the rows are deleted, not hidden; and deleting the originating thread deletes
the rows at once, words and all. A member who wants a session's steps gone before 90 days deletes the thread. There
is no other way to remove them early, and no setting for the 90 days. The one place loom tells a person the Comms
keep time, the household settings card (`src/proposal-words.ts`), now says that it is a message's keep time and
that these steps are kept 90 days whatever it is set to.

**What ends a trace before 90 days, and what does not.**

- Deleting the originating thread (`comms` delete): the rows are deleted at once. This is the only early end.
  The same delete takes the thread's boards with their placements and changes, its `board_threads` row, the reply
  notices queued for it, and the ticket links (`conversation_tasks`) of the sessions handed off from it, so a ticket
  no longer lists such a session. It leaves the member's blueprints, the handoff conversations and their job rows
  (nothing in loom deletes those; a job's title and brief stay readable to that member by the ordinary job reads).
- A row stamped before this rule: at its stamped `keep_until`.
- Archiving the originating thread: no new step is kept from then on (and the result is not relayed, as before).
  Steps already kept stay and stay readable.
- The chat's words expiring at the Comms keep time (`conversations.expire`, `CommsMessages.expire`): the same sweep
  runs the trace's own rule and takes nothing from a trace early. The brief a session was handed (an inbox item's
  words) and the result relayed to the thread do go at the Comms keep time. What the `session` brick shows under
  "Asked" is the job's own `brief` column, which is not swept.
- The conversation row and the job row: nothing in loom deletes either. The 90-day rollup in `history.ts` deletes
  `turns` rows only, and no trace read uses them. So the trace's foreign keys and its read rule lose nothing to an
  expiry. If something ever deletes a handoff conversation or a job, `job_trace` references both with no cascade
  and that delete would be refused by the foreign key while a step remains; `conversation_tasks` cascades from the
  conversation and the ticket. The keys were left as they are on 2026-11-27 (changing them rebuilds the tables);
  `src/shared-session-trace.test.ts` pins what a thread's deletion takes and leaves.
- The member leaving the conversation: the read rule is the member's own conversation rule, so once the
  conversation is another member's, or the member no longer has the agent, they read nothing. The rows stay.

**A ticket's sessions.** Loom recorded no link between a piece of agent work and the ticket it was for. What there
was, found 2026-11-27: a ticket filed from a conversation names that conversation (`tasks.source_kind`,
`source_id`), which says where it was filed and not who worked it; a review job is tied to a pull request and
through it to the tickets the pull request mentions (`change_review_rounds`, `change_tasks`); an agent's activity
post may reference a ticket (`agent_post_work_refs`), with no job; and a claim sets `tasks.assignee` to the agent
and starts no job. None of them says "this session worked this ticket", so one link was added and nothing is
inferred from words.

`conversation.handoff` takes an optional `tickets`: 1 to 20 ticket ids, for a work role, a harness or a brief to
another agent (not for a note to the agent's own body, `to`, which opens no session). Each must be a ticket the
handing-off body may read at that moment, working for the conversation's member, by the tasks rule; an id that is
no ticket or that it may not read refuses the whole handoff with "Unknown ticket: …" and nothing is written. The
ids are stored in `conversation_tasks` against the child conversation when it is opened. A retry of the same brief
returns the same conversation and writes nothing. The agent is told about the field where it is told about
handoffs (`src/runtime/body-program.ts`, and `boardsMail` in `src/core/boards/brief.ts`).

The page reads them with `ticketSessions(ticket)`: for each linked conversation its id, its agent, and its latest
job's id, title, state and queued time (the conversation's label and opening time where it has no job yet), newest
first. It answers a signed-in member, for a ticket that member may read, and lists only conversations the
conversation rule lets them read and only jobs the job rule does (`policy.ts`, `conversation` and `inTalk`). A
handed-off conversation is its member's alone, so another member who reads the same ticket, a household owner who
is not that member, an agent and a job's body all read an empty list. Closing the ticket changes nothing.

The `ticket` brick draws them in the big form under "Sessions", each a chip that places the `session` brick, with
its state and when; "No session is recorded for this ticket." when there is none. The small form has one line,
"N sessions worked this", only when there is at least one. The folded form is unchanged.

Its limits, 2026-11-27:

- Only a handoff whose agent named the ticket is listed. Whether an agent names it is judgment; no suite checks it.
- Ordinary ticket work is not covered: an agent that claims a ticket and works it in its own thread, a wake or a
  lane, a terminal session, and a review job have no link and are not listed. Nor is any session handed off before
  schema 50.
- A brief to another agent joins the one conversation that agent has for the handing-off job, so two briefs from
  one job share one session and its tickets are all those any of them named.
- The link is made at the handoff and never changed: there is no way to add a ticket to a session afterwards or to
  take one off, short of deleting the ticket.
- A session listed on a ticket outlives its steps: after 90 days the chip still opens the session, which says its
  steps are no longer kept. It does not outlive its thread: deleting the thread it was handed off from unlinks it.
- Two members never see each other's sessions on a shared ticket. That is the conversation rule, kept as it is.

Its limits, 2026-11-27:

- Only work handed off with a work role or a harness from a member's own thread has steps. A wake, a bridge
  conversation, a brief handed to another agent, and an ordinary thread's job outside the pairing thread have none.
- Only a harness whose output `pair-events.ts` decodes reports any, and only what it decodes: tool calls, shell
  commands and their output, subagent calls, plans. Not the model's words between calls, and not its reasoning.
- A body built before this change reports none. A loom built before it refuses them, and the body ignores the refusal.
- The big form shows the latest 100 steps of the latest job and says so when there are more; there is no paging back.
- An archived originating thread stops new steps being kept; the result is also not relayed then, as before.
- Every such handed-off job reports its steps, whether or not a `session` brick is on a board. Nothing reads them but
  the brick.
- Not run: a real model. The body's part is tested with fed harness output and with a recorded Codex stream run
  through the real harness adapter; the page's part with fake data; nobody has watched a live session in a browser.

Two things loom does not have today, found 2026-11-27, each its own change if wanted:

- **No way to speak to one.** `comms.send` needs a thread. The member commands a session by stopping it, or by asking
  the agent in the conversation.
- **It does not flag itself for "waiting on the member".** A question or an approval from a session arrives in the
  inbox as it does today; it is its own brick.

### The pull brick's file patches

Added 2026-11-27 (t-2428). In the `pull` brick's big form each changed file's name (`Opens`) opens its row in place
(`Opened`) to that file's patch. Nothing of a patch is stored: no table, no schema step.

| Read | Who gets an answer | Cost | Live |
|---|---|---|---|
| `changeFilePatch(change, path)` (`src/pieces/changes/file-patch.ts`): `{ state, patch, cut }`, `state` one of `patch`; `none` (GitHub lists the file with no patch: a binary file, a diff too large for GitHub to give, a rename with no change in it, an empty file); `unlisted` (GitHub's list does not have the file just now, as after a push the poll has not stored yet); and `unavailable` (GitHub could not be read: no credential for the owner, a failed, malformed or too large answer, too slow, or too many reads waiting) | exactly whoever may read the change's `change_files` rows (seen with its change, as #2356 set it), and only for a `path` that is one of them. Anybody else, a path that is not one of the change's files and a change that does not exist all get the same null; anybody not signed in is refused by the door (401, no data) | one keyed statement (the `change_files` row joined to its change, under the viewer's rule), then, unless the page is kept, one GitHub request a page of the files list (`GET /repos/{owner}/{repo}/pulls/{number}/files`, a hundred files a page, stopping at the file, at most three pages; `change_files` holds the first hundred, so it is nearly always on the first). A page is shared by every path and viewer of that pull request at that head | no: asked once each time a row is opened, by one POST (`useDataOnce`, `web/src/data/graphql/index.ts`). The server refuses it as a live selection: the field is marked as read from outside the database (`outsideRead`, `src/core/data/outside-read.ts`) and `observe` refuses any selection that names one, fragments included, so no write reads it again |

- **GitHub.** The same credential and request function as the changes poll that fills `change_files`
  (`githubListingReader` beside `githubReader` in `src/pieces/changes/github.ts`, given `sharedForgeSecrets` of the
  same `changes.github` options in `src/shared-root.ts`): the owner's bound token, a fixed host and an address made
  from the stored repository and number only (the path is never sent; a name of dots alone is refused, names are
  encoded). GitHub's REST files list reads the same pull request the GraphQL read does, under the same permission;
  no scope or token was added. A renamed or moved repository: GitHub's REST API answers a redirect to the stored
  name and asks that it be followed ("Best practices for using the REST API"); one is followed, only to
  `https://api.github.com/repositories/{id}/pulls/{number}/files` with the same page, anything else is a failed read.
- **Token.** It goes only into the authorization header of these requests: never into an address, a body, an error,
  a log or an answer. A pull request can itself hold that token (a committed `.env`, a pasted log), so its exact
  value is replaced by `[redacted]` in what GitHub answers before anything is parsed. Nothing is replaced by shape:
  searching source code for token shapes would turn `weighs_in` into `wei[redacted]`. Every failure is one bare
  error. The poll's own reads (`githubReader`) still redact by value and by shape as before.
- **Bounds.** At most 2 GitHub requests from this read at once, across every change and viewer; at most 8 pages wait
  for one, and past that an ask is `unavailable` at once, with nothing sent and nothing kept. A page's body is read
  only to 8 MiB (more fails the page, unread past it); each page has 20 s from its request to its last byte. One
  answer takes at most 20 s, waiting included: past that it is `unavailable`, and a page still being read finishes
  on its own limit and is kept for the next ask. One page's read holds its place at most 25 s, the read of the
  credential included; past that the place is given up and the page is a failed read. The two places and eight
  waiting are shared by everybody: one member opening many pull requests at once can make another's open
  `unavailable` until those reads end (not divided by member; a household is a few people).
- **Over the socket.** A one-shot read over the socket is answered, but the socket closes a client whose answer a
  commit landed during ("Data changed; reconnect"), and this read waits on GitHub, so that is likely. The page asks
  over POST and retries once instead.
- **Cap.** At most 200 KB (204,800 UTF-8 bytes) of patch text an answer. A longer patch is cut at its last whole line
  within that, or inside a line where cutting at a line end would keep less than half of it (a minified file: a hunk
  header, then one very long line), a character the cut splits left out whole, and `cut` is true; the page says "Only the first 200 KB of this patch is shown.
  The whole of it is on GitHub."
- **Kept.** In memory, one page of the files list keyed by repository, number, the change's stored head commit and
  page number, so a new push (a new `head_commit` from the poll) is read afresh. Patches are kept already cut. At
  most 32 MiB, counted as JavaScript holds text (two bytes a character), the oldest page dropped first; a page kept 5
  minutes. A failed read is kept 30 s, and so is a page that does not list an asked-for file, so a push not polled
  yet is not pinned. Asks for the same page at once share one request. The kept pages are checked only after the
  viewer's rule has been. Between a push and the poll storing its head (at most a poll's interval) the patch read is
  GitHub's newer one, kept under the older head; once the poll stores the new head it is read again.
- **A commit during the read.** The door answers one version of the data an answer, and says "Data changed; retry the
  query" (503) when a commit landed while a read ran (`src/core/data/http.ts`); this read waits on GitHub, so that is
  common. `useDataOnce` asks again once, at once, on exactly that answer; the page read is kept by then, so the
  second ask does not go to GitHub. The door's rule is not loosened for it.
- **Drawn.** Plain monospaced text in a `pre` (a named region), one line to a span, never markup: no `dangerouslySetInnerHTML`, no
  markdown, no links. Added and removed lines keep their `+` and `-` and are marked `board-patch-add` and
  `board-patch-remove`, hunk headers `board-patch-hunk` (`board-kit.css`). A line longer than the
  placement wraps (Jonathan, 2026-11-28, after a pass that scrolled it sideways: "ok lets wrap"; GitLab wraps a diff's
  long lines by default), and what runs over hangs two characters in from the line's sign, so a wrapped line is never
  taken for a new one. Nothing on a board scrolls sideways. Loading says
  "Loading…"; `none` says "GitHub has no patch for this file: it may be binary, too large for GitHub to show, renamed
  with no change in it, or empty."; `unlisted` says "GitHub does not list this file for the pull request just now: it
  may have changed since. Close the file and open it again in a moment.";
  `unavailable` says "GitHub could not be read for this file. Close the file and open it again to try
  again."; a failed request or a null answer says "This file's patch could not be read. Close the file and open it again
  to try again." Closing the row drops the answer; opening it again asks again (answered from the kept page while it
  is kept). The opened files belong to one change at one head commit in the big form: leaving the big form, or a
  new change or head commit, forgets them before anything is drawn, so coming back asks nothing and no patch stays
  open on an older head than the rows beside it.
- **Checked.** `src/shared-change-file-patch.test.ts` (the real root, door and credential path, GitHub faked):
  the member who can see the change gets the patch; another member and another agent get null and GitHub is not
  asked; nobody signed in gets 401 and no data; a path not among the change's files gives null; the cap cuts at a
  whole line, inside a line longer than the cap, and leaves a split character out; patch text that looks like a
  token is given unchanged; `none` for a file listed with no patch (left out or null), `unlisted` for one not
  listed and kept 30 s; the same head is answered from the kept page, a new head and an expired page are not; a
  failed read is `unavailable` and kept 30 s; a hundred aliased paths of one pull request in one POST are one
  request; paging past page 1 and the stop at three; two requests at once and an immediate `unavailable` past eight
  waiting; the 20 s answer bound; the oldest pages dropped past the bound on what is kept; a commit during the read
  answered 503 and the next ask kept; `observe` refuses the field, alone and in a fragment, over the real socket,
  while an ordinary selection opens and a direct read is answered; the redirect followed only to the same list on
  the same host; the 8 MiB read bound, declared or streamed; a repository name of dots refused.
  `src/core/data/outside-read.test.ts`: a marked field is found anywhere in a document and `observe` refuses it
  reading nothing. `web/src/boards/bricks-pull.test.tsx`: a row opens and draws added, removed and hunk lines with
  their class and sign; a patch holding markup is drawn as its text; the cut, none, unlisted, unavailable, failed
  and loading states; leaving the big form, a new head and a new change forget the opened files and ask nothing.
  `web/src/data/graphql/once.test.tsx`: one POST, again only for new variables, no socket; one more ask on "Data
  changed", and only one. The gallery has the scenes `file-opened` and `file-no-patch`. Not checked: a browser, and
  a real GitHub (its redirect for a renamed repository is taken from its documentation).

### Adding a brick

A brick has one home on each side and is listed once on each side. Adding one touches:

1. **Its definition**, `src/core/boards/bricks/<name>.ts`: a default export made with `brick` from `bricks/kit.ts`
   (name, `shows`, strict `params`, `references`, `linkKey`, `big`, `flags`, `actions`), and beside it
   `src/core/boards/bricks/<name>.test.ts`, which pins what the definition commits loom to (`pins`) and what its
   parameters and details refuse.
2. **One line in the catalogue**, `src/core/boards/bricks.ts`: its import and its place in `bricks`, at the end.
   That array is the catalogue's order and the only place the order is stated.
3. **Its page module**, `web/src/boards/bricks-<name>.tsx`, exporting its body, and its suite
   `web/src/boards/bricks-<name>.test.tsx`. The module imports what bricks share from `brick-kit.tsx` (`Chip`,
   `Loading`, `Unavailable`, `useOwnFlag`, `words`, the types, and the design kit below, which its body is made
   of) and never another brick's module. Its scenes go in the gallery's fixtures (below), so it can be seen.
4. **One line in the registry**, `web/src/boards/bricks.tsx`: `fits`, `title`, `sub`, and
   `...later(() => import('./bricks-<name>').then((m) => m.<Body>))`.
5. **Its rows in the two tables above.**

Nothing else lists the bricks. `src/core/boards/catalogue.test.ts` holds what must be true of every brick and names
none: the catalogue and the registry hold the same names, each once; every brick has a rectangle for each form it
has, and one that can be big has a primary one; every parameter that is not a reference has a default; no action's
detail takes anything but a fixed choice or the one id shape declared for that property of that brick's action
(`detailIds` in the suite: today a token's label, a `ref`, in `household.token`, the agent whose portrait changed, a `ref`, in `household.setPortrait`, and a secret's name, `secretName`, in
`secrets.setValue` and `secrets.remove`; none admits a blank, and a shape the kit has but no action declared is
refused); every action's operation is one loom registers (found by its registration in the source; those whose names
are put together where they are registered, and the sign-in door's two token routes, are listed there); every brick has the
four files above, with a short commented list of older bricks whose page checks are in a shared suite; and both
tables have its row. A suite that draws every brick makes each one's parameters from its own schema
(`web/src/boards/samples.test.helper.ts`).

**A body is loaded when a board first shows its brick.** The registry holds, for each brick, what the page needs at
once to lay a board out and head a placement, and a body whose module is fetched the first time it is drawn. Until
it arrives the placement, already in its rectangle and under its heading, says "Loading…"; from then on that brick
draws at once. A body that fails, as when loom was deployed while the page stayed open and its module is gone, is drawn
again by its own placement after 0.7 s and again after 2.5 s, saying only "Getting this brick again…"; a failed fetch
is not kept, so each try asks for the module again. The rest of the board stays drawn. If it still fails the
placement says "Sorry, this brick didn't load." with "Try again", and the board's header row counts it ("N bricks
didn’t load", with Try all again); the page meanwhile looks for a newer build and takes it as "A restart" says, once
nothing typed would be lost, and until then the header row, not the placement, says loom was updated and offers
"Reload now" (the kit's `Fetching` and `Lost`: a quiet line and the kit's own actions). Under the sorry line the
placement shows what was caught, in the program's own words cut to 200 characters, so that a brick that fails on
one screen and not another can be mended from what it said. The
page's first script holds no brick and nothing only a brick needs. The bundle guard (`web/boards-guard.ts`, run by
`web/vite.boards.config.ts`) reads the whole module graph the build loaded, the fetched chunks too: a file under
`web/src` must be the page's own or one the bricks share with the desktop, a file of the server's `src/` must be
named in its `outside` list, and one marked plain there (`src/core/boards/value-shape.ts`) must import nothing;
anything else, a `node:` module included, fails the build (`web/boards-guard.test.ts`).

### The design kit

Every brick's body is made from one small vocabulary, `web/src/boards/brick-kit.tsx`, styled in
`web/src/boards/board-kit.css`. A brick writes no markup of its own where the kit has a word for it. The look is
quiet and typographic: one accent, hairlines in place of boxes, air in place of rules, nothing heavier than a
medium weight. The page's tokens stay at the top of `board.css`; the kit adds a type scale of five sizes
(`--bk-xs` to `--bk-xl`), one spacing scale (`--bk-0` to `--bk-5`: every padding, margin and gap in the kit is on it) and
the tones.

**A side form is a glance (design pass 2, 2026-11-27).** It holds the few facts that say where the record stands and
at most its main action, and it fits its height without scrolling for ordinary content; everything else is in the
primary form. A list in a side form draws as many rows as the placement has room for (`Few` measures and never draws
fewer than one) and ends in `More`, "and N more", which makes the brick the big one where it can be (the frame's own
maximize). Prose in a small form is an `Excerpt`: its first lines, fading at the end of the last, with no ellipsis
and no word cut in half; the compact brief and a compact header's long reference fade the same way. The one
exception is the `approval` brick: its side form keeps everything the answer is weighed by above the answer, as the
primary form does, and so may scroll. Times are written by `Time` on every brick; a brick whose times are statements
about the household's clock (a trigger's schedule, Activity's days) keeps them and says the zone once, quietly.
An agent's face is one component (`agent-face.tsx`): the household's stored sprite, Art's built-in sprite, or the
face made from the agent's colours.

| Word | What it is |
|---|---|
| `Lead` | The one line a form is about: the record's own title, or the sentence that says where things stand. |
| `Note` | A quiet line: a count, an empty list, a reason. `Loading` and `Unavailable` are notes. |
| `Problem` | Something that did not work, said where it happened (an alert). |
| `State` | Where a record stands: a mark and the record's own word. Six tones and no others: neutral, working, waiting (on the member), good, bad, muted. Each brick maps its record's states onto them. |
| `board-meta` | The line under a lead: state, who, where, when. |
| `Section` | A part of a brick under a small heading, with a count where it lists things. |
| `Facts`, `Fact` | Label and value pairs. A short value sits beside its label; prose (`wide`) sits under it. |
| `Rows`, `Row` | A list of records parted by hairlines: title, a quiet line under it, a state or time at its end, controls below. A row that places a brick is one hit area. |
| `Few`, `More`, `Excerpt` | What makes a small form fit: as many rows as there is room for, the quiet "and N more" that maximizes, and prose cut to its first lines with a fade. |
| `Confirm`, `Asking`, `Asks`, `AskRow` | Asking before acting, drawn one way: `Confirm` opens a question; `Asking` is the question alone, for a brick that keeps its own asking (the trigger's, the secrets' remove, the approval's second yes and standing answer, whose steps stay the shared ones). |
| `Opens`, `Opened` | A row's name as the control that opens the rest of it under the row. |
| `Fold` | A section that is read only once it is opened: its heading is the control and says which way it stands (`aria-expanded`). One name for the part, open or closed ("Reviews", "Story", "Loom's reviews", "Backlog history", "Agents' notes"), never "Show…" and "Hide…"; what could not be read says "Close it and open it again to try again." |
| `RowTools` | A row's own controls at its end: unseen until the row is pointed at or holds the keyboard, always seen where nothing can point (a phone), always in the tab order, and keeping their room so nothing moves. |
| `Group` | A few fields of a long form under one small heading (a `fieldset`); where the placement is wide its short fields stand two to a row, and a choice stands like a field, its label over it. |
| `Lost`, `Fetching` | A placement whose brick did not load: "Getting this brick again…", then sorry with "Try again". (`Lost` can still offer "Reload now"; since 2026-11-28 the page does not ask it to, because the header row says loom was updated.) |
| `board-prose`, `board-foot` | Prose that is the thing itself (a session's report), in ink; and a brick's last quiet line (when it was last read, and the control that reads it again). |
| `Actions`, `Action` | A brick's controls, last in the form. One `primary` at most; `quiet` steps back; `danger` cannot be undone. |
| `Confirm` | Asking before acting, the same everywhere: the control ("Stop…") opens the act in full ("Stop this session") beside the way back. |
| `Field` | A field of words under its label; `board-form` stacks them. |
| `Segmented`, `Menu` | One of a few fixed choices, all in view; or one of many, the chosen one in view and the rest in a list that opens in place. The page has no native picker. |
| `Meter` | How full something is: a thin bar whose tone turns as it fills. |
| `Time`, `when` | The one way a brick writes a time: how long ago while it is recent (or how soon), the date after that, in the member's device zone; the whole date and time is its title. |
| Steps | A session's log (`session-trace.tsx`): one line a step, a mark for where it stands, what ran, and what it said when opened. In the big form a run of them is folded under one "N steps" line between the agent's messages (the chat's own `Message`, `Bubble` and `Trace` parts), its reasoning a quiet folded "Reasoning" line. |

The three forms are decided the same way for every brick. The primary form leads with the one thing the brick is
about, then its meta line, facts, sections and, last, its actions; a form that opens on a press takes the place of
the action bar while it is open. The side form keeps the lead, the few facts or rows that matter and the main
action, and leaves the rest to the primary. The compact form is one `board-brief` line: a state and a few words.
A placement is a container (`container-type: inline-size`), so a brick answers to its own width, not the window's.

### The gallery

`npm --prefix web run gallery:build` builds a development-only page (`web/gallery.html`,
`web/vite.gallery.config.ts`, `web/src/boards/gallery/`) that draws every brick in its three forms, at the sizes the
layout gives them, from fixtures (`gallery/fixtures/`) and never from loom: the build puts a fixture-backed
`useDataQuery` in the place of `web/src/data/graphql`, and every operation is answered as saved. A fixture names a
brick's scenes (well filled, empty, unavailable, flagged, closed, a form opened by a press), and each scene what
every read answers. `node web/scripts/gallery-shots.mjs <dir>` photographs the built gallery in dark and light: one
image per brick, per scene and form, and contact sheets of every side, compact, primary and phone-width form.
`npm --prefix web run gallery` serves it for looking. The gallery is no part of `npm --prefix web run build` and no
shipped page loads it; `src/ui/web-reach.test.ts` names its entry as the one development-only one.

**Design pass 3 (2026-11-28)**, with eyes, over the parts added since pass 2. What it settled: a patch scrolled
sideways (since changed: it wraps, see "The pull brick's file patches"); a part opened on demand is a `Fold`; a row's controls are `RowTools`; the tempo brick's New
trigger form is three `Group`s ("When it fires", "Whose it is", "What it does"); a session's report stands in ink
straight under how it ended; a session's count of steps and "Load earlier steps" share a line; a chip under a row is
a chip and not a bar; nothing said aloud on the page floats (the shared sheet's shadow on `role="alert"` is taken
off inside a placement and the chat); the chat's Stop asks on a line of its own under the presence; the bridge
receipt is one small line in the header's margins; in the panel the list scrolls and this conversation's controls
stay in view under it. The gallery draws these page parts too (`?brick=page`, `gallery/fixtures/page.ts`), and
`gallery-shots.mjs --tall yes` photographs a primary form whole.

## Live reads and their cost

Measured 2026-11-27 on the example household (`src/example-home.ts`: four tickets, one project), through the real
composition and one socket, counting SQLite statements and the server's processor time.

**What happens.** Loom has one signal for "something was committed" (`DataLive.changed`, `src/core/data/live.ts`),
raised after every committed write that changed a row (`DataWrites.run`). Nothing records which tables a write
touched or which a selection reads: `ctx.changed(type, id)` in an operation is collected and never reaches the
live reads. So every commit has **every open selection of every open window** run its whole query again. The
result is compared with the last one sent, and only what changed is sent; a selection whose answer is the same
sends nothing, but has been read. On the page, two hooks with the same selection and variables share one
selection on the socket, a paused hook holds none, and a folded placement draws no body and so reads nothing.

**What a board holds.** Each brick's small form opens between one and seven selections before its record has
loaded (`agent` seven, `agents` four, `project` and `person` three), and more once it has (a ticket's links and
sessions, a session's steps). A board of ten (lanes, ticket, comments, agent, pull, question, inbox, session,
trend, project) holds 18; all 23 bricks at once hold 36. The page and the conversation hold their own beside these. Only
the board on screen holds its bricks' reads (since 2026-11-27: see item 2 below); before that every board on the trail
added its own.

**What one commit costs.** For that board of ten: 198 statements and 23 ms of processor for a write to a table
no brick reads (a machine's name), and no frame sent; 204 statements, 27 ms and one small frame for a comment
on the ticket shown. That is about eleven statements and 1.3 ms for each open selection, on a household with
almost nothing in it. Commits in the same turn of the server's loop were already read together (twenty were two
readings). Commits in separate turns were not: twenty of them 5 ms apart were twenty readings of each selection,
3,960 statements and 540 ms.

**What was changed.** A selection is read again at most once in 100 ms (`LIVE_SETTLE_MS`): a commit that comes
alone is read at once, and faster ones are read together, always once after the last
(docs/accepted-tradeoffs.md). The same twenty commits 5 ms apart are now six readings of each selection, 1,265
statements and 180 ms. Commits 100 ms or more apart cost what they did.

**What was not built, and why.**

1. *Wake a selection only for writes to what it reads.* **Built 2026-11-28 (t-2431), on by default: "Scoping"
   below.** This is the real saving: most commits change nothing a given brick shows. It needs the write side to
   say which tables it wrote, and every selection to know which tables it reads, including the tables that decide
   who may see a row: a selection must still be read again when access changes. A wrong answer here is a brick
   showing old data, or data the member may no longer read, so it is a change to the data layer with its own
   checks, not a change to boards.
2. *Stop reading for boards that are off screen.* **Built 2026-11-27, as the owner decided** ("we absolutely treat
   everything not on the current screen as paused"). Only the board on screen mounts its bricks' bodies, so a
   trail of three boards holds the reads of one ("The page", "Off screen"). The board the page slides away from
   keeps its bricks until the slide ends. The three costs named here before were weighed: words half typed in a
   brick's form on a board the page slid away from are lost (accepted); coming back does not show the loading
   line, because the page remembers each brick's last answer in memory and shows it, marked as getting new data,
   until the fresh one arrives ("The page", "What the page remembers"); and a brick flags itself when that fresh
   answer differs from the remembered one, so a change made while its board was off screen is still flagged. The
   rule that a window hides what it holds the moment its feed ends is kept: a remembered answer is dropped at
   once when its selection is refused or its feed closes, it is never written to disk, it is emptied when the
   signed-in member changes or the session ends, and the server is still asked every time.
3. *A longer settle time.* 250 ms would hold a board of ten to four readings a second whatever is written, and
   would make every window, the conversation as it streams included, up to a quarter of a second late. What was
   built instead (below) is a longer time for the reads that can bear it, chosen read by read.

**Two paces, and "now" (built 2026-11-27, as the owner decided).** "As long as chat is quick, which it already is,
the rest can be faked however makes efficient sense"; a brick is as fresh as mail: "I get it quickly. ish. most of
the time."

- *The paces* (`src/core/data/live-pace.ts`). A live selection is **eager** (what every selection was: at most one
  reading in `LIVE_SETTLE_MS`, 100 ms) or **relaxed** (at most one in `LIVE_RELAXED_MS`, 5 s). Relaxed keeps every
  promise of the settle time, on the same loop (`DataLive.watch`): the first answer never waits; a commit that
  comes alone after five quiet seconds is read at once; there is always a reading after the last commit; a commit
  that lands during a reading or during the wait is in the next reading; ending a selection or closing loom does
  not wait and leaves no timer.
- *On the wire.* The client chooses, selection by selection. The subscription envelope
  (`observe(query, variables, operationName)`) has two optional arguments: `pace`, a word, and `key`, the client's
  own name for the selection on its socket. Only the word `relaxed` is relaxed. Leaving it out, misspelling it,
  or sending a number or anything else is eager, so no client can ask for anything faster than eager, and a client
  that sends neither argument (the desktop, every program, every older page) sends and gets exactly the bytes it
  did. The page sends them only for a brick's reads, and opens a relaxed read as its own selection, so the same
  query read eagerly by the page is never slowed by a brick, nor the other way round.
- *Now.* The socket's schema has one mutation, `now(keys)`. It writes nothing. It asks loom to read again the
  selections of that socket that carry those names, and answers with the names that were open. A selection asked
  for is read without waiting out its five seconds, and it answers even when nothing changed: a revision with no
  patches, which is how the page knows the reading was made and takes its mark away.
- *The limit on asking.* A selection asked for now is still read no sooner than the settle time (100 ms) after
  its last reading began, however often it is asked, and one asking is one reading. So a client that asks without
  pause gets each of its own selections read at most ten times a second: what an eager selection already costs
  under a stream of commits, and no more. A name reaches only the selections of the socket that gave it; one
  asking names at most 200 selections, and a name is at most 64 characters.
- *Who is relaxed, when the page asks, and what the member sees*: "The page", "How fresh a brick is".

**What it costs now.** Measured 2026-11-27 with `src/ui/boards-live-cost.integration.test.ts` (run on request; its
head says how): the built page in Chrome over a fictitious household, a board of ten bricks (session big with its
job running, ticket, lanes, comments, agent, pull, question, inbox, trend, project), which holds 28 selections: 18
of bricks, now relaxed, and 10 eager (nine of the page and the conversation, and the running session's steps).
"Before" is the same page with every selection made eager and no asking sent. One commit read by all 28 is 410
statements and about 55 ms of loom's processor.

| Case (three runs each) | Before: statements, processor | Now: statements, processor |
|---|---|---|
| 20 commits to a table no brick reads, 300 ms apart | 8,479 to 8,853, 1,087 to 1,173 ms | 4,413 to 4,681, 434 to 617 ms |
| One click of the member's (claim a ticket: its command, then the report to the board) and the 6.5 s after it | 1,209 to 1,872, 186 to 245 ms | 1,477 to 1,599, 172 to 354 ms |
| A session reporting 30 steps over 10 s, its brick big on screen | 12,270 to 13,152, 1,565 to 1,705 ms | 6,435 to 6,668, 674 to 969 ms |

A click costs what it did: it is read at once, as it must be. The processor figures include the writes themselves
and vary from run to run; the statement counts are the steadier measure. One commit that comes alone still costs
410 statements, because a relaxed read that has been quiet for five seconds is read at once.

What is left is the eager ten: about 200 statements a commit, half of what all 28 cost, and they are read for
every commit as before. They are the conversation and the page's own reads, and making them cheaper is item 1
above (wake a selection only for what it reads), not a pace.

**Checking item 1 before it acted (t-2431).** `LOOM_LIVE_SCOPE=shadow` (`src/core/data/live-scope.ts`) tracks which
tables each live reading read and each commit wrote, still reads every selection, and checks each answer against
what scoping would have done. `npm run test:shadow` runs the whole server suite that way. Passing means no test
produced a reading scoping would have skipped whose answer changed (a violation throws under vitest, and
`src/test-setup.ts` fails a test that leaves one behind), and that every test still passes with the tracker's own
statements running beside it. A test that counts a connection's statements leaves those out with
`trackerStatement` (`src/core/data/table-tracker.ts`). It passes only as far as `npm test` does: a test failing in
both is not a shadow failure.

**Scoping (built 2026-11-28, t-2431; on by default, as the owner decided: "just send it. we're the only users
right now").** Shadow ran about fourteen hours on the real household with no violation first. `LOOM_LIVE_SCOPE`
is `on` when unset, and `off` or `shadow` when set so; anything else stops loom at startup.

- *What it does.* Each commit says which tables it wrote (`src/core/data/table-tracker.ts`, from each statement's
  EXPLAIN program, triggers, cascades, views and indexes included), and each reading of a live selection
  records which tables it read, the visibility rule's joins included. A commit wakes a selection only when it
  wrote one of those tables (`wouldSkip`, `src/core/data/live.ts`). A commit during a reading is matched against
  that reading's tables when it ends: the reading is made again if it read any of them, and is otherwise
  published as current.
- *What is always read again, as before.* A selection whose last reading depended on anything a table of the
  shared connection does not hold: the clock (`clock.now()` in next-data's own fields, `'now'` in SQL,
  `loom_now()` and any function not marked deterministic), another database file (memory, notes, knowledge,
  people), a virtual table or `sqlite_schema`, the cache of model accounts shared between selections, and every
  field the composition is given (`fields` of `nextData`: memory, inbox, kits, programs, accounts, desk time and
  the rest) that has not been inspected. Inspected so far, and read only by their tables: Comms' own fields
  (`homeComms`, `commsThread`, `commsMessages`, `commsThreads`, `commsFolders`, `commsRefs`, `sessionReport`) and a
  session's trace and count; their use of the clock is the words' keeping time, and the conversation lifetime
  sweep writes each message and step at that time (`src/core/conversations/lifetime.ts`). A session's
  `sessionTraceExpired` turns on the job's age alone, which nothing writes at, so it stays unscoped. And every
  commit whose tables are not known: anything run through `exec`, a pragma, DDL, a write to a virtual table,
  `changed()` called without tables (deadlines, the runtime, tempo, memory signals), a stamp
  (`metadataChanged`), and any commit after another connection or process wrote the file (SQLite's
  `data_version` moved).
- *What cannot be missed.* Only a committed `DataWrites.run` reports its tables; one that throws tells nobody, as
  before. A savepoint rolled back inside a commit is still reported (over-reporting, never under). A write made
  outside any `DataWrites.run`, told to nobody or told without tables, is carried into the next commit's tables.
  A writing statement counts only when SQLite's count of changed rows moved while it ran, which includes what its
  triggers, cascades and INSTEAD OF triggers wrote: the sweeps that run after every commit and match no row
  (tempo's inbox volume, expired results) no longer wake every reader of their tables.
- *What it saves.* The cost harness above, `LOOM_LIVE_SCOPE=off` against `on`, same build, the board of ten
  (28 selections, 10 eager) as the page is now:

  | Case (two runs each) | off: readings, statements, processor | on: readings, statements, processor |
  |---|---|---|
  | One commit to a table no brick reads (a machine's name) | 28, 421, 60 to 134 ms | 8, 184, 37 to 38 ms |
  | 20 such commits, 300 ms apart | 264, 4,645 to 4,651, 396 to 871 ms | 80, 2,308 to 2,314, 268 to 302 ms |
  | A session reporting 30 steps over 10 s | 354 to 364, 6,378 to 6,582, 550 to 638 ms | 100, 3,205 to 3,220, 396 to 424 ms |
  | One click (claim a ticket) and the 6.5 s after it | 56 to 66, 1,341 to 1,514, 129 to 314 ms | 56, 1,401 to 1,404, 146 to 156 ms |

  The processor figures include the writes themselves and vary from run to run; readings and statements are the
  steady measure. A click costs what it did: what it writes is what the bricks on screen read.
  The eight still read for an unrelated commit are the unscoped ones: the agent directory (memory), the running
  session's steps (its expiry flag), the session brick (a virtual table), the desk's doing list (the clock) and
  four reads of the inbox, whose fields are not yet inspected. Inspecting those is the next saving.
- *If something looks stale.* Set `LOOM_LIVE_SCOPE=off` in the service's environment and restart loom: every
  commit reads every open selection again, exactly as before scoping, and no table is tracked.
  `LOOM_LIVE_SCOPE=shadow` reads everything too and logs `live scope violation: …` for any reading scoping would
  have skipped whose answer changed, naming the selection, what it read and what was written.
  `npm run test:live-scope` and `npm run test:live-off` run the suite in either mode.

**The session brick's reads, since it reads as a conversation (2026-11-28).** No read was added. Live, as before:
the job and conversation (`BrickSession`), the job's detail with its brief (`BrickSessionJob`, big form), the report
(`BrickSessionReport`, big form of a handoff) and the latest page of steps with their count (`BrickSessionTrace`,
eager while the job runs, relaxed once it has ended); each step of that page now also carries its `kind`, a column of
the row it already reads, and the page holds words and reasoning steps among its 100. The side form's latest step
(`BrickSessionStep`) is asked for with `kind: "tool"`, one more condition on the same indexed read, and opens no words.
On demand only: earlier steps (`BrickSessionEarlier`, paused until "Load earlier steps" is pressed). Opening a folded
run or reasoning line reads nothing: their words came with the page. A session that keeps no trace leaves the trace
read paused. With scoping on (below) the trace's reads stay scoped: a step's kind is a column of `job_trace`, the
table they already read, so a step of any kind wakes them and nothing else new does.

## What goes

Gone from the branch, 2026-11-27: the contexts prototype (`web/src/contexts/` but for Art's portrait), the ticket
screen (`web/ticket.html`, `web/src/pair/main.tsx` and what only it used), and their build steps. Kept from
`web/src/pair/`: the transcript, the reply renderer and the controls the boards page uses. The desktop is untouched
and stays the way to reach what boards do not yet show. Still there and not used by any page: the server queries the
ticket screen read (`context-tickets.ts`, `epic-work.ts`, `workspace-directory.ts`, `work-jobs.ts`).

## Checks

Operations are called at the operation layer with a constructed viewer: a job's body in the thread ("as the agent") or
the thread's member. No model is involved. Each check sets up its own board unless it says otherwise.

**The board and its order**

1. As the agent: `boards.open`, then `boards.change` placing `lanes`, then a second call placing `trend`. The page
   draws `lanes` after the first call and before the second is made. `lanes` is rank 0 and in the primary form. The
   board is at revision 3.
2. Place a third brick. The address is unchanged, and the first two placements are the same DOM nodes as before.
3. Remove the primary: the placement that was rank 1 is rank 0 and takes the primary form; ranks are 0 to n−1.
   `place` with `rank` 0 on a board of three: the new one is primary and the others are 1, 2, 3. `rank` moving the last
   to 0 does the same. A rank of n+1 on `place`, or n on `rank`, is refused.
4. One `boards.change` with a valid `place` followed by a `place` of an unknown brick: refused, and the first is not
   stored. `title` longer than 80 characters: refused. A `title` change writes a row with `from` and `to`.
5. Refused, with no row: an unknown brick; params that fail the schema; `trend {project}` when `trend {project,
   days: 30}` is live. Accepted and drawn "unavailable": a `ticket` whose id does not exist.
6. A repeat of any write with the same command id changes nothing and returns the first result. The same id with a
   different input is refused. `boards.close` on a closed board and `boards.reopen` on an open one are refused. As the
   member, `boards.change` with `title`, with `rank`, or with a `place` that has a `rank`, is refused. A `place` of
   `trend` with no `project` is refused.

**Who may**

7. The board's address in a second browser as the same member draws the same placements. As a different member it
   draws the nothing-here line, the live read returns no rows, and each member operation on it is denied. As a job in
   another thread, each agent operation on it is denied. A member's live read of `blueprints` returns no rows.
   `boards.open` with another agent's blueprint is denied.

**The member's hand, and what the agent hears**

8. With a `ticket` placed whose assignee is an agent: as the member, click the assignee chip. An `agent` placement is
   stored with `placed_by_kind` `member`, at the last rank, and no job is started. Clicking again stores nothing.
9. With a board of `lanes` and `trend` that the agent has been handed: as the member, remove `trend`.
   `boards.brief` returns text with the board's id, `lanes` with its placement id, and the remove sentence naming
   `trend(project=…, days=30)`. `agent_seen` then equals the revision, and a second `boards.brief` has no change
   sentences.
10. As in 9, but in place of the brief the agent calls `boards.change`: its result's meanwhile holds the remove
    sentence, and a following `boards.brief` does not.
11. A member change on a board that is not the shown one appears in `boards.brief` as a sentence naming that board.
    With an empty trail the text says no board is open.
12. As the member: close a ticket from its brick. The ticket changes through `tasks.command`, an `act` row is
    written, and the brief has the act sentence with the ticket id. `boards.act` with an action the
    brick does not have, with a `detail` that fails the action's schema, or on a closed board, is refused. A comment
    added from `comments` writes an `act` row whose `detail` is `{}`.
13. `comms.send` with `shows` naming a board of another thread is refused. The stored words of a send equal what the
    member typed. In a thread with no `board_threads` row, every agent board operation and `boards.brief` is denied;
    after one send with `shows`, they are allowed.

**Blueprints**

14. On a board of `lanes`, `trend` and `ticket`: `blueprints.save` keeping `lanes` and `trend` with `project` opened on
    both. The design has two entries and one parameter of kind `project`. Changing the board afterwards leaves the
    design as it was. Saving again under the same name leaves one blueprint with the same id and `uses`. Refused:
    opening `days`; a `name` over 80 characters; on a board with `lanes` for two projects, both opened onto one name;
    a `project` param and a `ticket` param opened onto one name.
15. `boards.open` with that blueprint and another project: revision 1, two placements for that project, both
    entering in the same frame, `uses` up by one. Refused: `arguments` missing, or with an extra name. A blueprint of
    `lanes` fixed to one project and `lanes` with `project` open, opened with that same project, is refused.

**The trail**

16. With one board open, the agent opens a second: the page moves to it, and it is last in `boards.list`. Close it:
    the page shows the first with its placements unchanged. Close the first: the page is at `/app/t/<thread id>`. The
    closed board's address draws it with a reopen control and no remove or action controls; `boards.change` on it is
    refused; a chip click there opens a new board. Reopen it: a `reopen` row, and it is last on the trail.
17. `boards.read` with `since` set to a revision returns only later rows.

**The page**

18. Through checks 1, 2, 8 and 16, `location.search` and `location.hash` are empty, and no key written to local or
    session storage holds a board id, a placement, or which board is shown.
19. With `lanes` on screen, a ticket's status is changed by an operation outside the page. The ticket moves lanes
    with no reload and no job.
20. `bricks.catalogue` lists every brick in the table above with its schema, link key and actions. For every brick in
    it: it places given its record reference and nothing else; its schema refuses a value outside a list or range
    where it has one. For every brick that is drawn (see "The first bricks"): its small forms and, if it can be big,
    its primary form render. Not built: `[x](loom:<brick>/<key>)` in a reply. `t-123` in a reply is drawn as a
    `ticket` chip, and inside a code span it is not.
21. With reduced motion set, check 2 completes with no running animations.
22. At 1280 px the conversation and the board are both visible and there is no control that hides the conversation.
    The same at 640 px. At 390 px, with no board, the conversation fills the screen above the bar. At 390 px, in
    checks 1 and 16, the presence and the input are inside the viewport, pushing the bar shows the
    conversation and closing it shows the board, the primary is drawn, and placements that do not fit are in the
    folded row.
23. Recorded harness output for a job in a thread that is not the pairing thread produces work-trace cards.

24. `maximize` on a small placement whose brick can be big gives it the big placement's rank; the placement that was
    big has the next rank; the others keep their order; one `maximize` row holds the old and new rank. On a small-only
    brick, and on the big placement, it is refused. As the member it is allowed, and the agent's next brief has its
    sentence.
25. With a small-only brick at rank 0 and a brick that can be big at rank 1, the layout gives the primary form to rank
    1. With only small-only bricks, no placement has the primary form.
26. The catalogue says which bricks can be big, and for each brick what it flags itself for.
27. `flag` as the agent sets `flagged_at` and changes no rank. As the member it is refused. `boards.seen` as the
    member clears it and leaves the revision as it was; as anyone else it is denied.
28. A reference that is not shaped like an id is refused: words joined by underscores after `contact:`, a letter
    from another alphabet, a space, more than 120 characters.
29. A job in a thread with the second window is handed the boards text ahead of its mail; where `boards.brief` is
    refused it is handed nothing about boards; in any other venue the call is not made.

**Which checks have a suite, 2026-11-27.** In `src/core/boards/model.test.ts` and `operations.test.ts`: 1 (the rows), The session brick's "Why it failed" fact has `web/src/boards/bricks-session-why.test.tsx`: it draws loom's words for a failed session, asks for them in the job read the brick already makes, and draws nothing for a failure with no reason, a session that did not fail, or a small form; that the words reach exactly those who may read the job is in `src/runtime/job-summary.test.ts`.
3 to 6, 7 (operations only), 8 to 12, 14 to 17 (operations only), 20 (the catalogue only), 24, 26, 27, 28. In
`web/src/boards/layout.test.ts`: 25 and the layout's rules. In `src/runtime/body-program.test.ts`: 29. In
`web/src/boards/trend.test.ts` and `build.test.ts`: the trend's days and the new-build test.
In `web/src/boards/threads.test.tsx`: the list of conversations (closed until asked for, Comms' order, working and
unread, the launcher's keys, arrows, Enter and Escape, a new conversation and its retry), its search (on submit only,
found, nothing matches, failed, back to the list, nothing stored), the thread's title, rename, pin and unpin (refused
or failed), archive (asked first), delete (asked first by title, cancel sends nothing, refused or failed keeps the
question), the presence of the thread's own agent, marking read, and the address across threads
(one id, nothing stored, back and forward, a board of the same thread keeps what was typed, not yours). In
`bricks-threads.test.tsx` and `bricks-agent.test.tsx`: the `threads`, `agent` and `agents` bricks in every form, the
threads brick's pin, unpin and delete (asked first, cancel, refused, failed) and search (one ask on submit, found,
none, failed, asked again after a write),
their loading and unavailable lines, the agent's stop (asked first, `runtime.jobStop`, nothing in the detail) and its
flag. In `agents-queries.test.ts`: their own selections against the fields loom serves. In
`src/core/conversations/comms-query.test.ts`: `unread` on a thread row. In `src/shared-conversations.test.ts`: the threads brick's
pin, unpin and delete reach `comms.change` and are refused to another member, the household owner and an outside
request (no session, a cookie or token loom never issued).

**The two paces and "now", 2026-11-27.** In `src/core/data/live.test.ts`: a relaxed selection is read at once
when it opens, at most once in its time under a stream of commits, once after the last, at once for a commit that
comes alone, and loses nothing committed during a reading or a wait; asked for now it is read at once, changed or
not, never sooner than the settle time however often it is asked; its timer and its name are gone when it ends
or loom closes; an eager selection is as it was; any pace but the word `relaxed` is eager, and a relaxed time is
never shorter than the settle time; a name reaches only its own socket's selections. In `socket.test.ts`: the same
over a real socket, which stays open. In `web/src/data/graphql/client.test.ts`: the two envelopes, and a revision
with no patches. In `web/src/boards/pace.test.tsx` (the real hook and placement over a faked client): brick reads
are opened relaxed and the page's eager; the running session's steps eager, relaxed once ended, with no loading
line between; the refresh control asks for its own placement only; the page's asking names every placement on
screen and no page read; the mark and its "as of" words; a board that returns opens its reads anew; the own flag
once for a net change and not for the member's own action. In `page.test.tsx` ("now"): the page asks after any
write loom answered through any door, not after a refused one, a read, `boards.seen` or `boards.act`, and when
the tab is seen again. In the real-browser suite: an outside change reaches a brick within the relaxed time and
not at once, the refresh control brings one in at once for its placement alone, an asking with nothing changed
still ends the mark, and the member's own click shows at once in its brick and the one beside it.

**The bricks for running the household, 2026-11-27.** `machines`, `subscriptions`, `usage`, `bridges`, `household`
and `sharing` each read what the desktop's app of that name reads, through modules with no component that the
desktop now imports too (`pieces/runtime/machines-query.ts`, `machine-hosting-model.ts`, `model-query.ts`,
`pieces/household/alert-lines-model.ts` and `model.ts`, `pieces/usage/model.ts`, `pieces/bridges/command.ts` and
`data.ts`, `pieces/sharing/model.ts`). Who may read and act is loom's rule each time: `household` and `sharing`
answer a household owner and say "unavailable" to anyone else; `bridges` shows a member who does not run the
bridges only the replies loom sends them; `machines` shows a member their own machines and an owner every one,
and offers the alert lines' form to a household owner alone; `subscriptions` shows an account the member may not
read in full as a label and a level. Each has `src/core/boards/bricks/<name>.test.ts` (its pins, what its
parameters refuse, that no detail takes an id or a word, apart from the household's `token` and `setPortrait` below) and `web/src/boards/bricks-<name>.test.tsx` (every form
from fake data, the compact form one line with no control, the loading and unavailable lines, the heading, and
every action: the request loom receives, that it is asked first where it cannot be undone, and that `act` is told
nothing typed and no id, apart from a new token's label). `admin-queries.test.ts` runs the two selections `machines` wrote for itself against the
fields loom serves. Not on a board: enrolling or revoking a machine (it was on the desktop, and is on no page since it went); and
what is done by a message to the agent, which a brick says in one line. There is no `held-work` brick: the
desktop's Held work view read `core.effect` records over a `/live` socket and called `core.releaseEffect`, and this server serves none of
the three, so there is nothing to draw or release.

**A token made from the board, 2026-11-27** (the owner's ruling for the secrets brick, in the same shape: the
brick does the work through loom's existing door and the agent is told what now exists, never the secret). The
household brick's Make a token is Household setup's Create token: the same door, `POST /api/signin/token` for a
member's (`owner`), an agent's or a machine's (`runner`) token and `POST /api/signin/program` for an outside
program's, with the same body, and the same reading of the answer
(`src/core/signin/shared-links.ts`, `issueForOwner`). The door's rule is the permission: a current household owner,
whose browser signed in within the last ten minutes and is not an automated one (`newProof`), on a same-origin
request; there is no new server operation. The answer is read by its status before its body. A 4xx is a refusal,
whatever its body. A 400 or a 409 made nothing. A 401 or a 403 nearly always made nothing, but the door checks the
sign-in once more after it has written the token (`shared-links.ts`), so it can refuse a token it did make: the
brick adds "If a token with this label is in the list now, loom made it before it refused: revoke it, because its
value was never shown.", a notice already left for that request stays, and the board is not told (the page cannot
know). The refusals are Household setup's words ("Sign in again to make a token…" for the door's
fresh-sign-in refusal, "Token creation refused…" for any other). Only no reply, a 5xx, or a 2xx whose body is not
a token leaves it unknown, and only then is the member told, by the header row's token notice, "Token creation for “…” (kind) may have completed. Check
its label in the token list and revoke it before trying again." Neither tells the board anything. **Once loom answers that it made
it, the board is told `token {label, kind}`** whatever changed on the page meanwhile (the form gone, an owner
change), by one `boards.act` call that is not tried again: if that call fails the agent is not told, as with any
brick action; `boards.act` itself still refuses it, as any action, if the placement was removed or the board
closed meanwhile. The label is told,
so the brick takes one only in the shape of a reference (one word of up to 120 letters, digits and `: . _ / @ -`,
starting with a letter or digit), narrower than the desktop's, and says so; the desktop still takes any one line.
A label in the shape of a credential (a bearer pasted into Label) is refused before anything is sent, with "That
looks like a secret value, not a name.", and refused again by `boards.act`, by the secrets brick's function (above;
the same accepted trade-off).
**When the form cannot say it.** What the member must be told of a token whose fate the form could not follow is
kept outside every brick's body, in memory for the page's life and never in storage, by label and kind and never a
value (`web/src/boards/token-notices.ts`), and the board's header row says it with Dismiss, whatever board is shown
(since 2026-11-28; before, every household brick drawn afterwards showed it). A household brick's read of the token
list is still what ends a notice of unknown fate, so with no household brick on screen such a notice stays until it
is dismissed or one is drawn. The form lets go of a request when its body goes away while loom is asked (the brick drawn small or
compact, folded, removed, another board shown, the setup no longer answered) or loom reports another signed-in
owner: the notice says it may have been made, and loom's late answer settles it: a refusal ends it, a token made
turns it into "Token “…” (kind) was made after its form went away, so its value cannot be shown. Revoke it if you did
not save it, and make another.", and no reply or a 5xx leaves it. A notice that it may have been made also ends when
the token list holds a new token of that label; one that it was made ends only when dismissed. A reload forgets them.
**The value** is held in one component's state inside the big form and drawn once, under "Save this token now", with
Copy (the clipboard) and Hide. It is forgotten when the member hides it, when the body is drawn anew (the brick is
placed again or the board redrawn), when the brick leaves its big form, when the household setup stops answering
for the member, when loom reports a signed-in owner (`programSetup.owner`) other than the one it reported when the
token was asked for, as on the desktop, and when the page reloads. A moment with no program setup answer is not an
owner change; and if there was none when the token was asked for, this does not apply, but the page's own sign-in
check reloads the page when the signed-in member changes (`web/src/signin/use-session.ts`). A fresh answer of the
same setup keeps it, so the member can still copy
it after the token list grows by one. It never reaches `act`, a flag, the data hook (so no remembered answer), a
log, the address or the browser's storage. `src/core/boards/bricks/household.test.ts` (over `src/core/boards/house.fixture.ts`, a real household) holds the detail to those two
fields and follows a report through `boards.act` into the stored rows, `boards.read` and the agent's brief;
`web/src/boards/bricks-household-token.test.tsx` checks the requests per kind, shown once, Copy (and its words
with no clipboard), each way it is forgotten (an owner change too, and not a gap in the program setup's answer),
each status read (every 4xx refused, a proxy's non-JSON 403 too; no reply, 5xx and an unreadable 2xx unknown), a
label the board could not be told, a credential-shaped label (the fixture list), and the form going away in flight
with each late answer; `web/src/boards/page.test.tsx` draws the real page and checks the notice outlives the body
folded, removed and behind another board, and that a token made is told to the board; the clipboard is written only
on Copy.

**The household's tokens and browsers, 2026-11-28** (t-2428; a real household holds over a hundred). The big form
draws the live ones (a token neither revoked nor expired, a browser not signed out) first, each with its control as
before. The rest are folded under one heading that opens on click (the kit's `Fold`) and says how many it holds ("Revoked or expired ·
12", "Signed out · 3"); opened, it draws thirty and "Show 30 more" until every one is drawn. An expired token keeps
its "Revoke token…", asked first, and a revoked one has none, as before. Each section's heading counts its live ones.
Make a token sits at the top of the tokens, above the search and the list. Above each list is a search over label,
kind and owner (a browser's name, Browser or Agent browser, its sign-in label and member): applied on Enter or Search
to the rows `householdSetup` already sent, as the `projects` brick searches; every word must be in one of them; the
counts and the fold follow it. **Reads:** the same two as before, `householdSetup` live (relaxed, kept) and
`programSetup` live in the big form; the search and the fold ask nothing. The words are the brick's state: no
parameter, no read, no request, no `act`, no flag, the address or storage (rule 1). The page tests
(`web/src/boards/bricks-household-lists.test.tsx`) check the order, the fold and its counts, paging by thirty, the
search over each field and that it reaches no read, request, report, address or storage, and Make a token first.

**A file chosen in a brick, 2026-11-28** (t-2428: an agent's animated portrait, the first brick to take a file). The
household brick's agent rows (big form) each have Portrait, opening Household setup's portrait change under the row.
**Chosen** by two file inputs in the brick, the desktop's: "PixelLab sprite sheet" (`accept="image/png"`) and
"PixelLab animation JSON" (`accept=".json,application/json"`). **Bounded** before anything is sent, by the desktop's
own reader and limits, imported and not copied (`readPortraitFiles` in `web/src/pieces/household/portrait-request.ts`, a module with no component that
the desktop's form, `portrait.tsx`, calls too): the sheet must be `image/png` and at most `SPRITE_MAX_BYTES` (4 MiB,
`src/desk-sprite-layout.ts`), the JSON a `.json` or `application/json` file of at most `DOOR_REQUEST_BYTES` (1 MiB,
`src/core/data/door-limit.ts`) that `manifestFromPixelLab` reads as a PixelLab sheet's; the type check is the brick's
(the desktop leaves it to its `accept`), the rest is the desktop's. Anything else is refused in the desktop's words
and nothing is sent. **Sent** from the page straight to the desktop's operation, `household.setPortrait`
(`POST /api/household/setPortrait` by `memberOperation`, the sheet as base64 and the layout read from the JSON, with
the agent's current portrait version; src/shared-agent-portrait.ts), whose rule is the permission: a household owner
in a signed-in browser window (`windowOnly`; src/shared-root.ts also bounds the body at `PORTRAIT_REQUEST_BYTES`).
"Use generated face" sends it with no portrait. A 4xx is a refusal in the desktop's words (`portraitRefusal`: a 409
the portrait changed, a 401 or 403 an owner's sign-in, any other an invalid sheet) and clears the files; no reply, a
5xx or an answer that is not loom's keeps the request and its id, and "Retry portrait change" sends it again, as on the
desktop. The files are held in the component's state and nowhere else: never in board state, a read, `act`, a flag,
the address or storage. **The board is told** `setPortrait {agent, outcome}` once loom answers that it was done:
the agent's id and `uploaded` or `restored`, never a file's name, size, type or contents; the agent can read the
agent's record itself. An agent whose id a board cannot hold has no Portrait. `src/core/boards/bricks/household.test.ts`
holds the detail to those two fields and follows a report into the stored rows, `boards.read` and the brief;
`web/src/boards/bricks-household-portrait.test.tsx` checks accepted files and the request loom receives, each file
refused before sending (wrong type, over the limit, empty, missing, JSON not PixelLab's), restore, each 4xx, a failed
request retried with the same id, and that nothing of the files reaches the board, a read, a flag, the address or
storage. Not checked: a real browser's file chooser and `FileReader` (the tests fake the reader).

A session's steps have their own suites, outside the numbered checks: `src/shared-session-trace.test.ts` (kept,
sealed, read by the thread's member alone and not by a full owner, absent from the thread, the relay unchanged; a
step written now still read with its words at day 89 and at the last millisecond before day 90, withheld on a read
at day 90 before the sweep, and deleted by loom's own sweep at day 90, with `comms_days` at 1 and at 14, while the
thread's message is erased at `comms_days`; `sessionTraceExpired` false until then and true after, for the member
alone; a row with an earlier stamped limit ending at that limit; an archived
thread keeping what it has; the rows deleted with the thread; a step past the cap for a job and for a session
refused with its message; a tool that is not one clean line refused; `after` reading only newer steps and opening
only those; `before` reading the latest steps before one, and the count, for the member alone; a job on anybody else's word refused at the door; and what a deleted thread takes and leaves), `src/single-home.contract.test.ts` (the 90 written
once, the trace's arithmetic, and `job-trace.ts` asking nothing of the Comms keep time), `src/proposal-words.test.ts`
(the settings card saying the keep time is a message's and that steps are kept 90 days),
`src/runtime/body-program.test.ts` (which jobs report steps, and the redaction),
`src/shared-conversation-handoff.test.ts` (a recorded Codex stream through the real adapter and doors) and
`web/src/boards/session-trace.test.tsx` (the big and small forms from fake data, and the "no longer kept" line when
loom says the job is past the keep time).

A ticket's sessions: `src/shared-ticket-sessions.test.ts`, over the real doors (a handoff with `tickets` stores the
links once; an unknown id, a ticket the body may not read, an empty list, more than 20 and a note to its own body
are refused with nothing written; `ticketSessions` lists the linked sessions newest first by latest job for the
member they belong to, still on a closed ticket, and nothing for another member who reads the ticket, an agent, the
body, an unreadable ticket and an unknown one; deleting a ticket removes its links). `web/src/boards/bricks.test.tsx`
(the ticket brick's Sessions on a closed ticket from fake data: the big form's chips, states and empty and
unavailable lines, the small form's count line, the folded form asking for nothing). `src/core/data/upgrade.test.ts`
and `schema.test.ts` hold schema 50 to its pinned shape. Not tested: a handoff with `tickets` through a work role
or a harness (the suite hands off to a peer agent; the link is written by the same lines for all three, and the
listing test builds role-shaped conversations by hand); the page's `ticketSessions` selection against a running
server; live redrawing when a link or a job changes; anything in a browser; a real agent choosing to name a ticket.

What loom knows, each brick in its own file with a fake data hook and a fake `fetch`: `bricks-knowledge-page.test.tsx`
(all three forms, unavailable and loading, the heading rule, the chips, verify and recheck reaching
`/api/mind/knowledgeVerify` and `knowledgeRecheck` with the slug and then `boards.act` with an empty detail, an
annotation reaching `/api/mind/knowledgeAnnotate` with its kind and trimmed words while the board is told the kind
alone, a failed call reporting nothing, and no control beyond what loom says the member may do),
`bricks-knowledge.test.tsx` (the lists and their order, one topic, the forms, the search asking
`memoryKnowledgeSearch` only on Search and reaching no act, the add reaching `/api/mind/knowledgeAdd` with what
Knowledge sends, who is offered it), `bricks-person.test.tsx` (a contact big and small, the empty lines, a member
with and without a card, the compact member form not asking for the card), `bricks-people.test.tsx` (the directory,
the folders, the search sending nothing, the add reaching `/api/mind/personAdd`, People's hint) and
`bricks-activity.test.tsx` (the rows and their chips, the windows asked for each range and the days kept, an opened
entry and its chips and links, the missing-source lines, and nothing ever sent). `src/core/boards/model.test.ts`
holds the five catalogue entries: the shapes refused, no parameter for search words, the actions and their details,
which can be big. Not tested: any of them against a running server or in a browser.

In `web/src/boards/bricks-drawn.test.tsx`, with a fake data hook and a fake `fetch`: for `pull`, `repository`,
`question`, `approval` and a contact, all three forms, the compact form as one line, the unavailable and loading
lines, the heading rule, a pull request's own flag being raised, a question's answers reaching `/api/inbox/answer`
and then `boards.act`. In `brick-queries.test.ts`: the
pull and repository selections run against the generated schema.

The approval's answer has two suites, both without a browser, and neither answers a real approval.
`web/src/pieces/approval-view/answering.test.tsx` checks the shared decisions with no view: who is offered an
answer, the reviewed version in an Allow, the second yes, the reason for denying, the words of a refusal, what
stands against a request, what is read of an ordinary request, a literal command, a household change with and
without the owner's reading, and a Tempo or Measuring change. `web/src/boards/bricks-approval.test.tsx` draws the
brick over a fake data hook and a fake `fetch`: every kind, state, form and viewer for whether controls are drawn;
what is shown before a decision; Allow in one press for a merge, a command and a setting, and never in one for a
dangerous action; the version sent being the one on screen, after a refusal and a second reading; Deny with a
reason; a refused answer and its controls; the controls disabled in flight; the outcome when it is answered
elsewhere; and `boards.act` told `approve` or `refuse` with an empty detail and no typed word. The desktop's own
approval suites pass unchanged. Not tested: the page in a browser, `approvals.answer` itself from the board (its
own suites cover it from the desktop's door), the reading being asked again on window focus and every minute
(the tests have no window), and how any of it looks.

The standing answer: `answering.test.tsx` (with `askStanding` a send that was not asked about does nothing, Cancel
takes the question back, and the yes sends once) and `web/src/boards/bricks-approval-always.test.tsx` (it is
offered in the big and small forms for exactly the desktop's case and for none of sixteen others; the first press
and Cancel send nothing; the yes sends `/api/approvals/always` with the request, the pull request, its commit, the
project and the person, then `boards.act` `always` with an empty detail; a refusal tells the board nothing). The
desktop's suites pass unchanged. Not tested: `approvals.always` itself from the board (its own suite covers it).

The two lists and the question's additions, each over a fake data hook and a fake `fetch`.
`web/src/boards/bricks-inbox.test.tsx`: the selection asked for each folder and for none; rows newest first with
words, who, when, state and a `question` chip; a quiet item as one line and a hidden one left out; the three
forms, the compact one as one line with no control; loading and unavailable; the heading rule; Mark read reaching
`/api/inbox/read` and Dismiss `/api/inbox/dismissResult`, each then `boards.act` with an empty detail, and nothing
told when the write fails; the outcomes listed in FYI, All items and Errors only; paging by fifty; a household
change's approval said by its plain title; the flag raised only when the count of `needs` rises.
`web/src/boards/bricks-approvals.test.tsx`: pending oldest first and answered newest first with what, why, agent,
target, outcome and who; a household change without its stored words; no control and no handler in any form; the
three forms; loading and unavailable; the heading rule; the flag raised only when the pending count rises. Since
the `rules` and `notices` states (added later on 2026-11-27): each state asks only for the lists it draws, and
`rules` only `id` and `state` of the requests; the rules with scope, kind, person, answer and who set them, no
control or handler; the reported steps newest first, the record's reported step and quoted answer among them, the
first fifty and the rest counted; the small and folded forms, none, loading and unavailable for both; the flag in
both. `web/src/boards/brick-queries.test.ts`: each state's selection against the generated schema, naming exactly
its lists. `src/core/boards/bricks/approvals.test.ts`: the four states, `pending` by default, nothing else.
The pull brick's later additions: `web/src/boards/bricks-pull.test.tsx`: when loom last read GitHub and that it
failed, in the big form only and only where the row is read; loom's reviews asked only once opened, each round
drawn, none, loading and unavailable, and forgotten on leaving the big form; "Read GitHub again" drawn only where
`workChangesRefresh` says yes and never in the small forms (which do not ask it), its one POST, "Reading GitHub…" with a
second press dropped, done telling the board `refresh {}`, refused (403) and failed (503, no answer, an answer that
is not `refreshed`) each saying so and telling the board nothing, and the refusal still said once the button is gone.
`web/src/data/work-refresh.test.ts`: the error carries the door's status. `src/shared-changes.test.ts`: through the
real root and door, a member who can read the pull request but is no household owner reads no `changeSync` row and
a false `workChangesRefresh`, and `/api/changes/refresh` answers 403 with GitHub not read; made an owner, the same
member may. `src/core/boards/bricks/pull.test.ts`: the action and its empty detail. Not tested: a browser, and a
real GitHub. The gallery has `owner`, `last-read-failed`, `reviews-opened`, `no-reviews` and `refresh-failed` for the
pull brick and `rules`, `no-rules`, `notices` and `no-notices` for the approvals brick.
`web/src/boards/bricks-question-more.test.tsx`: the linked page for a safe address only; what the item is about;
the plain title; Notify reaching `/api/inbox/volume` and then `boards.act` with the volume, only where the member
may set it. `model.test.ts` and `operations.test.ts`: the two bricks' parameters refusing anything off their lists,
their actions and empty details, that both can be big, and their flags. Not tested: either list against a running
server or in a browser, and live redrawing when an item or a request arrives.

Work written from the board: in `model.test.ts` and `operations.test.ts`, the three new bricks' parameters (a
project, or nothing for `unfiled`; anything else refused), that each can be big and flags nothing, every new action
with an empty detail or its one fixed choice and every typed word refused, the choices held to `tasks.command`'s
own lists, and the sentences the agent is told. In `src/core/data/work-board.test.ts`: a card's priority and
assignee, for a reader of the project and for no one else. In `web/src/boards/bricks-ticket-edit.test.tsx`,
`bricks-new-ticket.test.tsx`, `bricks-backlog.test.tsx`, `bricks-unfiled.test.tsx`, `bricks-lanes.test.tsx` and
`bricks-project.test.tsx`, with a fake data hook and a fake `fetch`: each brick's three forms from fake data, the
compact form as one line with no control, the unavailable and loading lines, the headings, what is listed and in
what order, the chips, each action's exact request to `/api/tasks/command` or `/api/work/setProjectClaims`
followed by `boards.act` with nothing typed in its detail, a pause asking before it sends, an empty title or an
unknown ticket id not being sent, and a refusal showing loom's words and reporting nothing. In
`bricks-work-queries.test.ts`: the new selections, the desktop's unfiled selection and its choices run against the
generated schema, with the backlog's order. The desktop's Tasks and task-command suites pass unchanged. Not tested:
any of it in a browser or against a running server, `projectBoardTickets`, `inboxProjectNeeds`, `projectClaimStates`,
`workProjectContributions` and `memoryProject` as the page selects them (they are not in the generated schema the
query suite builds; the names and fields are the desktop's), live redrawing after a write, the suggestions list of
the ticket field, and how any of it looks.

In `web/src/boards/bricks.test.tsx` and `page.test.tsx`, the page drawn by a test renderer, with no browser: the data
hook, the operations, the conversation, and the window's location, history and storage are fakes, and the layout is
given an area. What they pin:

- The page halves of 1 (the big placement is in the primary form, the others side or compact), 8 (a chip click calls
  `boards.change` with `place` on the open board on screen), 12 (a ticket or comments action calls `tasks.command`,
  then `boards.act`), 13 (`comms.send` carries the words as typed, trimmed, and `shows` with the board on screen or
  null), 24 (which placements and folded chips have the maximize control, and what it calls) and 20 (each drawn
  brick's compact form is one line, its side and primary forms draw, and a brick that is not drawn or not known says
  so).
- Of 16: a board that joins the trail is shown and is in the address; with no trail the address is the thread's; the
  closed board in the address is drawn with Reopen, no remove or maximize control and its bricks in an `inert`
  container; a closed board that is not in the address gives way; a chip click with a closed board or none calls
  `boards.open`.
- Of 18: after placing, maximizing, a chip click, a send and a move along the trail, the page has written nothing to
  local or session storage but the composer's draft, which the acknowledged send removed, `location.search` and `location.hash` are empty, and each address it went to is a path
  with one id.
- The heading rule; the names rule (a heading is the brick's name, the reference is in the monospace line); a stored
  flag (marked, labelled, `boards.seen` on pointing or focus, the folded chip and row marked); a brick's own flag
  (raised when the ticket, comments or session read changes, not after the member's own action, cleared on pointing
  with no call); the session brick's stop asking first; the reload onto a new build, only with the input empty and
  nothing being sent. The draft ("The draft" under "The page"): back after a reload, one per conversation and member,
  the desktop's own, cleared on an acknowledged send and kept with its client id on a failed one, a long one kept
  whole, storage that refuses it harmless, in no request, address or session storage, and holding the reload.

In `bricks-account.test.tsx`, `bricks-appearance.test.tsx` and `bricks-secrets.test.tsx`, with
`src/core/boards/bricks/account.test.ts`, `appearance.test.ts` and `secrets.test.ts`: the three bricks of the
member's own settings. Each definition takes no parameter, and no detail except the secrets brick's `setValue` and
`remove`, which take the secret's name and outcome (above). `account`: every form from Account's
selection, the small forms without a control, loading and unavailable; each removal sends nothing until the
question is answered and then calls its operation with the reference and reports an empty detail; a browser signed
out that was this one reloads and reports nothing; the device that is this one is marked and turning it on asks
the browser only on the press; a passkey is added through the sign-in door with the name typed and nothing is
reported; a sign-in link is asked for once, hidden on request, never drawn from a refusal or a reply that is not a
link. `appearance`: the saved choices pressed, another member's row never read, the defaults for a member with no
row, each press sending one choice, the pressed button following the record, a refused save. In `wear.test.tsx`:
the page wears the member's own Reduce motion and again on a change, follows the device for a member with no row,
keeps what it wore when the record cannot be read, sets no other attribute, and the page's build routes motion
media queries. `secrets`: every form from Settings' selection, the unavailable line and no row for a member who is
not an owner, each command's input, removal after asking, an unacknowledged change showing nothing of the reply,
the flag on a new request, and a value: the field's attributes, no value or handler of React's on it, the field
emptied before the request, one request to `/api/secrets/set`, and the value absent from what is drawn, from what
the board is told, from the data hook's calls and from the console; once acknowledged, a value set or a removal
reported with the secret's name and `added`, `replaced` or `removed`, and nothing for a refused or unconfirmed
change; a Name in the shape of a credential refused before anything is sent, and the same names refused by
`boards.act` with nothing stored (`secrets.test.ts`). Not run: a real authenticator, a real push
service, and the sign-in door itself, which are the server's suites.

**No suite:** what needs a browser or a server under the page: 2 (the same DOM nodes), 7 (a second member), 15 (both
entering in one frame), 19, 21, 22, 23, the `t-123` chip in a reply (20), and whether an `inert` container in fact
stops its controls, which is the browser's. Those were run by hand in a browser on an example household and on the
owner's own, and are not pinned.

**One home per brick, 2026-11-27.** `src/core/boards/catalogue.test.ts`: what "Adding a brick" says must hold of
every brick. `src/core/boards/bricks/<name>.test.ts`, one per brick: its pins, and the checks of one brick's
parameters and details that were in `model.test.ts` (knowledge-page, knowledge, person, people, activity, threads,
agent, agents, and the lanes' pause and resume); the checks that span several bricks stay in `model.test.ts`.
`web/src/boards/bricks-loading.test.tsx`: a body says loading until its module arrives, then draws at once, and is
fetched once. `web/src/boards/page.test.tsx`: a body on its way keeps its placement's rectangle and heading and
holds no other placement back, and one that cannot be fetched says so in its own placement and has the page take
a newer build unless something is typed. The header row ("The page"), in `page.test.tsx` ("the header row", "the
page's notices, said once in the header row"): a chip for each flagged placement in rank order with the brick's name,
reference and flag word; `+N` and the count and the lists they open; a chip pressed scrolls to and focuses its
placement (or its folded chip) and calls no operation, makes no request and clears no flag; each notice is said once,
on the board on screen, and not in a brick; Try all again; Close an icon named "Close board"; the row's fixed block
size, its one line and its lists outside it (`board-kit.css` read). `board-head.test.tsx`: how many chips a width shows,
a chip's words, the one mark. `pace.test.tsx`: a placement tells the board while it is getting new data, and when it
stops or goes. No suite holds a list
of the bricks, of those that can be big, or a count of them.

In `web/src/boards/notify.test.tsx`, `title.test.tsx` and
`web/src/pieces/account/notifications.test.ts`: the notifications control (beside the presence, closed, nothing asked
of the browser when the page opens or the panel does; every state it says; turning on asks once and enrols by
`notifications.subscribe`; a refusal enrols nothing; turning off removes this device's own reference and no other;
no choice of where a notification opens, and nothing kept in the browser), and the tab's title and its mark. In
`src/next-pwa-boards.test.ts`, `src/next-pwa.test.ts` and `src/core/signin/shared-notification-boards.test.ts`: the
served worker run with faked browser objects (every click opens the boards page: the thread's address from either
field, or `/app/boards`; an open boards page first, then any other loom window, then a new one; a push or a shown
notification from before that names the desktop's address lands there too; an outside or non-boards address is
dropped; a new worker deletes every old cache, `loom-device` among them), both manifests opening at `/app/boards`,
and the real root's push payload (`/app/boards` key for key for an item with no thread; the thread's boards address,
in both fields, only for the member's own thread). In `web/src/signin/gate-address.test.ts`: where the gate sends a
member once signed in, and where this page sends one who is signed out.
In `src/core/signin/shared-notification-replies.test.ts` (real root, in-process transport),
`src/core/data/upgrade.test.ts` and `web/src/boards/notify-replies.test.tsx`: a device that chose replies gets
exactly one push for a reply, after the wait and not before, with the exact payload and no words; a device that
did not gets none; a thread marked read inside the wait gets none; another member's device gets none; a card, a
progress message and the member's own message get none, and the reply that adopts the progress gets one; two
replies inside one wait are one push and a later one is another under the same tag; an archived thread, another
venue, a removed member and a signed-out browser get none; the choice survives enrolling again, does not follow
a browser to another person and cannot be set by a bearer token; a deleted thread takes its row with it; a
household at schema 50 comes to 51 with its devices off; and the checkbox's states (offered only when on, off
until chosen, loom's record shown, changed by `notifications.subscribe` with this browser's own subscription,
a refusal said). The Inbox push's suites are unchanged and pass.
Nothing here receives a real push or runs in a real browser.

**The Tempo bricks, 2026-11-27.** `src/core/boards/bricks/tempo.test.ts` and `trigger.test.ts`: their pins, what
their parameters refuse (a sentence, blank space, a look-alike letter, anything beside the one id) and that every
action's detail is empty. `web/src/boards/bricks-tempo.test.tsx`: the list from the desktop's read in its order and
words for one agent only, the chips, the day's firings in the big form, a failed last firing and its reason, the
pause line, one folded line that reads no history, the flag (raised when a failure appears, not for one already
there nor when the day's read arrives), none, unavailable and loading. `web/src/boards/bricks-trigger.test.tsx`:
every form from fake data, the four reads asked with the trigger's id, the chips (agent, tempo, project, session),
each button's request to `/api/tempo/…` with the desktop's input and the board told the action with an empty
detail, Run now and Stop sending nothing until confirmed, which buttons each state offers, a refusal telling the
board nothing, the flag, unavailable and loading. The desktop's Tempo suites pass unchanged over the modules its
pure parts moved to (`day-model.ts`, `runs.ts`, two selections in `query.ts`). Not checked: these bricks against a
running loom.

**The Inbox's search and the question's other answers, 2026-11-27.** `web/src/boards/bricks-inbox-search.test.tsx`:
what is typed reaches the Inbox's read as `search` at offset 0, the rows redraw, "Nothing matches", nothing is sent
or told to the board, and the small forms and Errors have no field. `web/src/boards/bricks-question-answers.test.tsx`:
"Discuss with" sends `inbox.discuss`, tells the board `discuss {}` and goes to the thread, and a refusal does
neither; a task's question sends `tasks.command` `answer` and tells `taskAnswer` with the choice and never the
words; a join request sends nothing until confirmed, then `runtime.workerJoinDecide` with the notice's request and
code; and which items offer none of these. `src/core/boards/bricks/question.test.ts`: what the three details refuse.

**The ticket picker, asking a person and promoting, 2026-11-27.** A ticket to link (a parent or a blocker, in the
`ticket` and `new-ticket` bricks) is chosen in `web/src/boards/ticket-picker.tsx`: the member types words of its
title or its id, the tickets found are listed (the first six) and one is chosen; an id typed exactly is taken as
before. The search is the rule of the desktop's "Search tasks" (every word typed is somewhere in the ticket), over
the tickets the brick already read by id and title; loom has no ticket search read, and none was added. What is
typed stays on the page. The `ticket` brick's big form also has the desktop's "Ask a person" (a member, the
question, what yes and no mean, yes or no or words; an open ticket only) and "Promote to epic" (not offered to an
epic; it asks first, which the desktop does not). `web/src/boards/bricks-ticket-picker.test.tsx`: what the search
finds, a link made from a chosen result with the request loom receives, the ask form's request and its refusal,
the promotion sending nothing until confirmed, and which tickets and forms offer neither.
`src/core/boards/bricks/ticket.test.ts`: both details are empty.

**Activity's filters, 2026-11-27.** The `activity` brick's big form has the desktop's "Filter activity": its three
groups (Who: the agents and the owner; Where: its five listed venues and any other an entry holds; What:
Conversations, System, Work done), each choice a button with how many of the range's entries it holds, kept by
Activity's own rule (`passes` in `web/src/pieces/activity/model.ts`), and "Show everything". Who and Where are not
fixed lists, so none of the three is a parameter: which are on is state of the drawn brick, as which entry is open
is, and an agent cannot set them. The small forms show everything. Not on the brick: the desktop's hour strip, and
the filters in the address. `web/src/boards/bricks-activity-filters.test.tsx`: the groups and counts, what each
choice keeps, two of one group, the owner's entries, nothing matching, showing everything again, nothing sent or
told, and no control in the small forms.

**In a real browser, 2026-11-27.** `src/ui/boards.integration.test.ts` drives the built page in Chrome against
loom's normal startup over a fictitious household with no model, with the other browser suites
(`LOOM_BROWSER_TESTS=on`, after `npm run build`). It pins what no suite above can see: `/app/boards` opens the
thread's address; a message sent with Enter is stored as typed, once, and the input clears; a board opened by the
member's operation is drawn with no reload and the address becomes its own; bricks placed one a call are each drawn
as they land and the placements already there are the same DOM nodes (checks 1 and 2, as the member); a brick's
chunk is fetched only when a board first shows it; through all of it the address holds one id and no storage holds
a board, a placement or a thread (18); a reload is the same board; the conversation's rows stand clear of its
column's edges, no placement's name is squeezed to a letter a line, nothing on the board is drawn past the side of
the window, the big placement is the widest and both halves are on screen at 1280 px; at 390 px the board is one
column with the big placement alone, the presence and the input are inside the window, and the bar opens and
closes the conversation (22, without the folded row's contents); maximize from the page, offered only on a small
placement whose brick can be big, with the old big one first among the small and no node redrawn (24); a ticket
claimed, released, closed with a reason and reopened from its brick, the lanes beside it following, each reported
to the board's log in order with nothing typed in it (12, 19 through the page); a chip in a lane placing its
brick last, by the member, once, with no job (8); a second board taking the page, a board closed by the member
staying on screen with Reopen and no placement control, nothing in it answering a click or the keyboard and no
operation leaving the page, the same after a reload, its action working again once reopened, and the thread's
address going to the board before it (16, as the member); and with reduced motion asked for by the device, a
placement arriving with no transition or timed animation on any placement (21). Not there: anything done as the
agent (the household has no job, so every board is opened and changed by the member's own operations), another
member's view (7), the 640 px width, and a restart with a new build, which this harness, serving one build for its
life, cannot do.

**Rules with no check at all:** writes to one board applied in arrival order; a blueprint description's limit; a
brick's own flag going when its condition ends (no drawn brick has such a condition); what the page does when the
board on screen is closed and the page had come to it as the last on the trail at load, where the code gives way to
the board before it and "The trail" says it stays (the code keeps it only when it was in the address at load or was
followed to); no flag queueing a job (nothing in the flag path can queue one, and no test proves a negative); rules
10 and 11 and the standing instructions, which are judgment.

## The demo

Run by the owner against the real household, after the checks pass. He judges it; nothing here is automated.

In a new thread he types "what's up with loom lately?". The agent answers in words and builds a board he watches come
together. He leaves it up and watches a ticket move while they talk. He asks about one ticket and it joins the same
board. He clicks a person. He removes something and asks what is on the board. He changes a ticket's status. The agent
saves the board. In another thread he asks the same of another project and the board arrives whole. He starts
something unrelated, and a second board opens to the right and closes back to the first.

## Decided by the owner, 2026-11-26

1. **A blueprint belongs to the agent.** Whether to reuse one as it is or change it for the person asking is the
   agent's judgment. Narrowed on 2026-11-27 after a security review, not yet confirmed by the owner: it belongs to
   the agent and to the member of the thread it was saved in, because an agent-wide blueprint carried one member's
   words (its name and description) and design into another member's jobs. See "Records".
2. **A board saves as it goes; a blueprint is a promotion.** The agent promotes, or the member asks.
3. **The narrow screen** has an always-present bar for the agent, and the conversation opens from it as a sheet.
4. **What leaves a board** is the agent's judgment, and the member's asking.

## Decided by the owner, 2026-11-27

5. **Big is a feature of the brick.** "anything with a big version must have a small one. the limitation has to be
   what can maximize, not what can minimize." Either party may maximize.
6. **The agent may change the big one after the member chose it**, by judgment, and has a quieter way to point: the
   flag. A brick's own flag is silent: it wakes nobody.
7. **The agent in the thread is the one who decides and dispatches.** Long work is a session handed off through loom
   and shown as a brick; quick subagents for reading are fine and are shown in the conversation.

8. **A session's steps are recorded and kept 90 days.** "record things period, because we might want to review the
   session that made something later on... if we look at a closed ticket, having the session that made it makes
   sense to me. at least for a while." "90 sounds good". The steps have their own clock, apart from the Comms keep
   time; see "Sessions" for what that costs and what ends a trace early.

## Open

1. **Memory and knowledge.** They are kept in files, not in the shared schema's tables, but the page can already
   query some of them: `src/transport/memory-queries.ts` joins knowledge pages, knowledge search, people and identity
   into the same query layer every page reads (`memoryKnowledge`, `memoryKnowledgePage`, `memoryKnowledgeSearch`,
   `memoryPeople`, `memoryPerson`). So `knowledge` and a fuller `person` can be bricks by rule 2 with no new read path.
   Answered 2026-11-27 for the first question: they are live for every change loom makes (see "What loom knows").
   Still not checked: whether an agent's own memories (as opposed
   to shared knowledge) are exposed at all. Written as: not in the first set; those two questions are answered before
   the bricks are specified.
