# Boards: a conversation with a second window the agent fills from bricks

*2026-11-27. Status: **built and running on the owner's household**, on the branch `art/boards`; draft as a document.
Cold-reviewed four times (three rounds on 2026-11-26, one on 2026-11-27 against the code); every round was blocking
and the last one's findings are folded here without a further round. This fixes the records, the operations and the
behaviour. It does not fix the look. What is built, what was only run by hand and what does not exist are said where
they apply, and gathered at the end of "Checks".*

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
   reference that may hold a `#`. It is checked for shape only, so
   it may name no record, and it is shown only as an id (see "Names" under "The page"). The only free text the agent
   gives a board is its title. Known limit: an id-shaped string such as `contact:call-me` is still accepted and is
   shown, small and in monospace, beside a brick that says it is unavailable.
2. **A new brick is a change to loom.** It arrives with side, compact, chip and hover, and with primary if it can be
   big; a fit for each board form it has; the changes it flags itself for; a parameter schema with a default for every parameter that is not a record reference, its actions, its link key if it
   has one, tests and a catalogue entry.
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
8. **Bricks are live.** A brick's data changes on screen when the records change, with no reload and no job.
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

**`boards`**: `id`; `thread`; `title` (at most 80 characters, may be empty, stored exactly as given);
`blueprint` (the one it was opened from, or null); `revision` (1 when opened; goes up by exactly one for each later
operation that writes a `board_changes` row); `agent_seen` (a revision; 0 until the agent has been handed the board);
`opened_at`; `trail_at` (when it last joined the trail: set on open and on reopen); `changed_at`; `closed_at` (null
while it is on the trail); `shown_at` (when the member last sent a message with this board on screen, or null). A
board is readable by its thread's member and its thread's agent and by nobody else. A
board is always between one member and one agent. Two members never share one.

**`board_placements`**: `board`; `id` (unique across all boards, never reused); `brick`; `params` (JSON, valid for that brick's schema, stored
with every default filled in); `rank`; `placed_by_kind` (`agent` or `member`); `placed_at`; `removed_at` (null while
live); `flagged_at` (when the agent last flagged it, null once the member has seen it). Among a board's live placements the ranks are exactly 0 to n−1. No two live placements on a board have the same
brick and the same params. A board may have no live placements. Removed placements stay as rows. Visibility follows the
board.

**`board_changes`**: `board`; `revision`; `seq` (order within one revision, from 0); `at`; `actor_kind` (`agent` or
`member`); `change` (`open`, `place`, `remove`, `rank`, `title`, `close`, `reopen`, `act`, `maximize`, `flag`);
`placement` (for `place`, `remove`, `rank`, `act`, `maximize` and `flag`, otherwise null); `from_value` and `to_value`
(text, read back as text: the old and new rank for `rank` and `maximize`, the old and new title for `title`, the rank
taken in `to_value` for `place`, otherwise null); `action` (for `act`: the name of one of the brick's actions) and
`detail` (for `act`: JSON matching that action's declared schema, which holds only choices and ids). Placements
shifted by another's `place`, `remove`, `rank` or `maximize` get no rows of their own. Visibility follows the board.

**`blueprints`**: `id`; `agent`; `name` (unique per agent, at most 80 characters); `description` (at most 300
characters); `parameters` (JSON: a list of `{name, kind}` in order of first use in the design; kind is one of `session`, `project`,
`ticket`, `change`, `repository`, `person`, `agent`, `inbox item`, `approval`);
`design` (JSON: an ordered list of `{brick, params}` in rank order, where a record-reference param's value is either
fixed or `{"open": "<parameter name>"}`); `created_at`; `used_at`; `uses`. A blueprint is readable and usable by its
agent in any of that agent's threads. No member reads `blueprints`.

**`job_trace`** (schema 49): `conversation`, `seq`, `job`, `at`, `tool`, `card_state` (`running`, `done`, `failed`),
`client_id`, `words`, `keep_until`. One row for each work step the body of a handed-off job reports, under the child
conversation and numbered within it. `keep_until` is 90 days after `at` for a row written since 2026-11-27; a row
written before that keeps the limit it was stamped with then (the Comms keep time of that day, 14 days at most). It is not a board record: it is what the `session` brick's big form reads (see
"Sessions"). `words` is sealed with the household's words key, as a message's words are. A row is written only for a
conversation whose venue is `handoff`, that has a member, and whose result returns to that member's open thread; a
step for any other handoff is refused, as every such step was before. No row is written to `messages`, `turns` or
`threads` for a step.

**`conversation_tasks`** (schema 50): `conversation`, `task`. One row for each ticket a handed-off session was said
to be for: the ids the handing-off agent gave as `tickets` in `conversation.handoff`. It holds no words. It is not a
board record: it is what the `ticket` brick's "Sessions" reads (see "A ticket's sessions"). A row goes when its ticket
or its conversation row is deleted; nothing in loom deletes a conversation row today. Nothing writes a row but
`conversation.handoff`.

A board holds no record data and none of a conversation's words.

## Operations

All are registered in the operation layer. A repeat with the same command id and a different input is refused. Writes
to one board are applied one at a time in the order they arrive; a rank given in a call is read against the board as it
is when that change is applied, the changes of one call being applied in order.

### For the agent

These are the operations as a job's body may call them, and only for boards in that job's own thread, only when
that thread has a `board_threads` row, and only for blueprints of that job's own agent; anything else from a body is
denied. Where a member may call an operation of the same name, what
the member may pass is under "For the member".

- `bricks.catalogue()` → for every brick: name, one line on what it shows, parameter schema with defaults, which
  parameters are references and of what kind, link key, whether it can be big, what it flags itself for, and its
  actions. Any member may call it too; it holds nothing private.
- `blueprints.list()` → every blueprint of this agent: id, name, description, parameters, uses. The agent chooses by
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
- `boards.read({board, since?})` → the board, and the `board_changes` rows with a revision greater than `since`
  (default 0).
- `boards.close({board})`, `boards.reopen({board})` → each writes its row and raises the revision. Closing a closed
  board, or reopening an open one, is refused. Reopening sets
  `trail_at`, so the board is last on the trail.
- `blueprints.save({board, name, description, placements})` → `placements` is an ordered list of `{placement, open?}`
  naming which live placements to keep, in the order given. `open` maps a record-reference param of that placement to
  a parameter name, for example `{"project": "project"}`; other params cannot be opened and keep their values. Two
  params may share a parameter name only if they are of the same record kind. The save is refused if two entries of
  the resulting design have the same brick and the same params. Saving under a name this agent already uses replaces
  that blueprint's description, parameters and design and keeps its `id`, `uses` and `used_at`.

`boards.open`, `boards.change`, `boards.close` and `boards.reopen`, called by the agent, return: the board's id (as
`board`), title, revision, whether it is closed, its live placements in rank order, each with its id (as `placement`),
brick, params, rank and whether it is flagged; the same as text; and **meanwhile**, the member's `board_changes` rows
with a revision greater than `agent_seen`, as sentences. The call then sets `agent_seen` to the board's revision. So a
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
and the only reader is that member's agent, which can read the record itself.

The page reads `boards` and `board_placements` through live reads: the thread's boards for the trail, and the shown
board's live placements.

### What is refused, and what is not

A `place` with an unknown brick, or params that fail the schema, is refused with the reason. A `place` whose params are
well formed but name a record that does not exist, is of another kind, or that the member may not read, is accepted:
the brick draws "unavailable", the same in each case. Operations check shape. Visibility stays in the read.

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
- `act`: "The member used close on ticket(ticket=t-2441) on board B." An action whose detail is not empty
  ends ": " and the detail, as `answer` does: "…on board B: answer=yes."

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
id in its reply; and hand off work that writes code or runs long, placing a `session` brick for it. The text is
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
- **The conversation.** Words and the work trace. The work trace is drawn in every Comms thread the member owns, not
  only the pairing thread.
- **The board.** The layout is a pure function `layout(placements in rank order, fits, area) → for each placement a
  form and a rectangle, or folded`. The big placement gets the primary form and never folds; below its minimum width it
  takes the full width. The rest get side, then compact, in rank order, as room allows. With no big placement, all of
  them do. A placement there is no room
  for is **folded**: shown as its chip in one expandable row at the end of the board. The exact rule is the design
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
- **Chips.** Clicking a chip places that brick, with the params its key gives and defaults for the rest, last on the
  open board on screen. If that placement is already live, the call is refused and nothing changes. If the board on
  screen is closed, or there is none, the click opens a new board.
- **The trail.** The page follows the thread. When any board in the thread is opened or reopened, by either party, the
  page moves right to it. When the board on screen is closed by the member, it stays on screen, closed, until they
  go elsewhere; a closed board that is not the one in the address gives way to the last board on the trail, and with
  none to `/app/t/<thread id>`. `/app/t/<thread id>` for a thread with a trail goes to the last board on it. A change
  to a board that is not on screen is stored and drawn when the member goes there.
- **A closed board.** Its address draws it as it was, with no remove or maximize controls and one control to reopen
  it. Its bricks are drawn and do nothing: no action, no chip, no input in them responds.
- **Not yours.** A board or thread id that does not exist, or that the member may not read, draws one line saying
  there is nothing here, and no presence and no input.
- **Threads.** The switcher from the branch is kept as it is. Renaming and archiving a thread are not part of this
  spec.

## A restart

The owner, 2026-11-27: "we should survive a loom reboot without the user being excessively aware." The case that
matters: the member asks for something no brick shows, the agent hands off a session to build the brick, loom is
deployed with it, and the agent places it. The member sees a brick arrive. They do not reload anything.

- **The page.** It holds no state of its own (rule 3), so a reload opens the same board. When its live read comes
  back after loom was away, the page asks its own address for the current page; if that runs a different script from
  the one running, the page reloads, once the input is empty and nothing is being sent. Run 2026-11-27 against a
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
| `pull` | `change`: change id, `github:owner/repo#number` | none: a merge is answered through its approval, on the desktop | the change id |
| `repository` | `repository`: `owner/repo`, in any spelling `project_repositories` holds (a leading `github:`, capitals and a trailing `.git` are dropped); `project`: project id, optional | none | the repository id |
| `person` | `person`: `member:<member id>` or `contact:<contact slug>` | none | the same string |
| `agent` | `agent`: agent id | none | the agent id |
| `question` | `item`: inbox item id | `answer {answer}`, by `inbox.answer`; `answer` is one of `yes`, `no`, `words`, `done`, `dismiss` | the item id |
| `approval` | `approval`: approval id | `approve {}`, `refuse {}`, each after `approvals.answer` took the answer; a reason for denying goes to `approvals.answer` and never to the board | the approval id |
| `session` | `session`: conversation id | `stop {}`, by `runtime.jobStop` | the conversation id |

| Brick | Can be big | Flags itself when |
| --- | --- | --- |
| `project` | yes | never |
| `lanes` | yes | never |
| `trend` | yes: opened and closed per day over `days`, and a picked day lists its tickets | never |
| `ticket` | yes: also why and done when, and "Sessions", the sessions handed off for it, newest first, each a `session` chip with its title, state and when; small, a line counting them when there are any; folded, unchanged | it is closed or reopened by someone else |
| `comments` | yes | a comment arrives from someone else |
| `person` (a member or a contact), `agent` | not yet | never |
| `pull` | yes: also its branch and author, its failing and running checks by name, the people on it, whether it can be merged, its tickets with their titles | its checks go to failing, it is merged, it is closed |
| `repository` | yes: each open pull request with its title and where it stands | never |
| `question` | no | never: being on the board is the flag |
| `approval` | no: the page has a primary form for it, with the record's history, but the catalogue does not let it be big, so a board draws it side or compact | never: being on the board is the flag |
| `session` | yes: what it was asked, its state, the tools it has used, how it ended, and its steps as they are reported; "Its steps are no longer kept." once every step's words have been erased | it finishes, it fails, it is stopped by someone else |

**What the five bricks drawn on 2026-11-27 show.** Each reads what the desktop reads for the same record, and says
it in the desktop's words.

- `pull`: the `changes` row and its `change_checks`, `change_people` and `change_tasks` rows. Title, number,
  repository (a `repository` chip), open, draft, merged or closed, checks, review, who it waits on, and its tickets as
  `ticket` chips. A ticket the member may not read is left out. It has no action. `changes.answer` exists and a
  member the household lets answer may call it, but it is a merge approval's answer and needs the approval that is
  waiting for that commit; it stays on the desktop with the approval.
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
  - **Not on the brick.** The desktop's standing answer for a merge ("Always for <project>"), the desktop's
    display names for agents (the brick shows ids as chips), and the household's time zone (times are in the
    device's). After `approvals.answer` succeeds the board is told `approve` or `refuse` with an empty detail.
- `person` with `contact:<slug>`: the shared card People opens (`memoryPerson`, id `commons:<slug>`): name, summary,
  how to reach them, linked projects. Relationship cards, evidence, sightings and conversations are People's and are
  not on the brick. A member is drawn as before, by their open tickets.

**Still not drawn, 2026-11-27.** No brick has a hover form. Writing a brick in words as `[label](loom:<brick>/<key>)`
is not built; only a bare ticket id becomes a chip. A merge cannot be answered from its `pull` brick; its approval can, from the `approval` brick. Not
checked: whether `memoryPerson` updates live as rule 8 requires (open question 1). None of the five has been looked
at in a browser: they are drawn with the classes the other bricks use, and their look is unjudged.

**Sessions.** A job in the thread hands work off with `conversation.handoff` (a work role or a harness), which loom
has today: it opens a child conversation for the same agent, member and project and returns that conversation's id,
and the child's result comes back to the thread as a reply that wakes the agent. `session` takes that id. It shows the
latest job in that conversation, or in any conversation with jobs that the member may read. Small: its title, its
state, how long it has run, the tools it has used most, and (the side form, for a handed-off session) its latest
step as one line. Big: also what it was asked, what it runs on, how it ended, and its steps. The member can stop it, by `runtime.jobStop`, which loom allows a member for an agent on their list. A harness's
own subagents inside one job are not sessions and loom keeps no record of them for an ordinary job.

**A session's steps.** The body of a job handed off from a member's thread (the worker's assignment says `review`)
on the owners' word reports each tool call and each result as a card, by the same decoding of the harness's output
and the same disclosure check as the pairing thread's cards (`src/runtime/body-program.ts`,
`src/runtime/pair-events.ts`): a tool name or a step's words that say a secret the body holds, one of its own credentials, or a
token shaped like one are replaced by "Tool" and by "Output withheld."; words past 16,000 characters are cut. Loom keeps each card in `job_trace` under the child conversation (`src/core/conversations/job-trace.ts`),
not in the thread: the thread's transcript, its turns and its unread state are untouched, and the child's final
reply is relayed to the thread exactly as before. A retried report writes one row.

The page reads them with `sessionTrace(conversation, job, limit)`: the latest `limit` steps (100 by default, 200 at
most), oldest first. It answers only a signed-in member who is the member of that handoff conversation, which is
the member of the originating thread, and only while the conversation rule every Comms read uses lets them see it.
Another member, a household owner who is not that member, an agent and the job's own body all read an empty list.
Words are opened only when asked for, and are null once they are no longer kept. The read is live like any other.

The big form draws them under "Steps" with the conversation's own work-trace cards (`web/src/pair/work-trace.tsx`):
a call and its result are one card, a subagent's steps sit inside its card, the newest is at the bottom and stays in
view unless the member has scrolled up. It asks for the trace only when the conversation's venue is `handoff`.

**How long a step is kept: 90 days, on its own clock.** Decided by the owner, 2026-11-27: "record things period,
because we might want to review the session that made something later on... if we look at a closed ticket, having
the session that made it makes sense to me. at least for a while." and, on how long, "90 sounds good". A step's
words are kept 90 days from when the step was written. The household's Comms keep time (`comms_days`, 14 days at
most) does not shorten or lengthen that: it is a message's keep time and no longer a step's. The number is written
once (`TRACE_KEEP_DAYS`, `src/core/conversations/trace-keep-days.ts`) and every deadline is worked out in
`src/core/conversations/retention.ts`: `keep_until` is stamped from it when the step is written; the sweep that
erases expired message words erases a step's words at the earlier of `keep_until` and 90 days after `at`; the timer
that runs that sweep is set for the next such time; and a read past it gives no words even before the sweep has
run. The row without its words (tool, state, time) stays, as a message's row does, and the big form then says "Its
steps are no longer kept." Rows stored before this rule keep their earlier `keep_until`; nothing was backfilled.

**What this costs, said plainly.** A step holds what the session did and saw: the command it ran and what the
command printed, the file it read and the lines read, a subagent's brief and answer, each up to 16,000 characters.
The body replaces a secret it holds, its own credentials and anything shaped like a token before it reports
(above), but it cannot know that a file's contents or a command's output are private in some other way, so a step
can hold anything the session read or printed. These words now outlive the chat's own words: the thread's messages,
and the relayed result with them, are erased at the Comms keep time, and the steps of the work behind them stay up
to 90 days. Against that: a step's words are sealed at rest with the household's words key, the one a message's
words are sealed with, and the database file holds no step in the clear; they are read only by the member of the
originating thread (below: not another member, not a household owner who is not that member, not an agent, not the
job's own body); at 90 days they are erased from the row, not hidden; and deleting the originating thread deletes
the rows at once, words and all. A member who wants a session's steps gone before 90 days deletes the thread. There
is no other way to remove them early, and no setting for the 90 days. The one place loom tells a person the Comms
keep time, the household settings card (`src/proposal-words.ts`), now says that it is a message's keep time and
that these steps are kept 90 days whatever it is set to.

**What ends a trace before 90 days, and what does not.**

- Deleting the originating thread (`comms` delete): the rows are deleted at once. This is the only early end.
- A row stamped before this rule: at its stamped `keep_until`.
- Archiving the originating thread: no new step is kept from then on (and the result is not relayed, as before).
  Steps already kept stay and stay readable.
- The chat's words expiring at the Comms keep time (`conversations.expire`, `CommsMessages.expire`): the same sweep
  runs the trace's own rule and takes nothing from a trace early. The brief a session was handed (an inbox item's
  words) and the result relayed to the thread do go at the Comms keep time. What the `session` brick shows under
  "Asked" is the job's own `brief` column, which is not swept.
- The conversation row and the job row: nothing in loom deletes either. The 90-day rollup in `history.ts` deletes
  `turns` rows only, and no trace read uses them. So the trace's foreign keys and its read rule lose nothing to an
  expiry. If something ever deletes a handoff conversation, `job_trace` has no cascade and that delete would be
  refused by the foreign key.
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
  steps are no longer kept.
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

**Which checks have a suite, 2026-11-27.** In `src/core/boards/model.test.ts` and `operations.test.ts`: 1 (the rows),
3 to 6, 7 (operations only), 8 to 12, 14 to 17 (operations only), 20 (the catalogue only), 24, 26, 27, 28. In
`web/src/boards/layout.test.ts`: 25 and the layout's rules. In `src/runtime/body-program.test.ts`: 29. In
`web/src/boards/trend.test.ts` and `build.test.ts`: the trend's days and the new-build test.

A session's steps have their own suites, outside the numbered checks: `src/shared-session-trace.test.ts` (kept,
sealed, read by the thread's member alone and not by a full owner, absent from the thread, the relay unchanged; a
step written now still read with its words at day 89 and at the last millisecond before day 90, withheld on a read
at day 90 before the sweep, and erased by loom's own sweep at day 90, with `comms_days` at 1 and at 14, while the
thread's message is erased at `comms_days`; a row with an earlier stamped limit ending at that limit; an archived
thread keeping what it has; the rows deleted with the thread), `src/single-home.contract.test.ts` (the 90 written
once, the trace's arithmetic, and `job-trace.ts` asking nothing of the Comms keep time), `src/proposal-words.test.ts`
(the settings card saying the keep time is a message's and that steps are kept 90 days),
`src/runtime/body-program.test.ts` (which jobs report steps, and the redaction),
`src/shared-conversation-handoff.test.ts` (a recorded Codex stream through the real adapter and doors) and
`web/src/boards/session-trace.test.tsx` (the big and small forms from fake data, and the "no longer kept" line when
every step's words are gone).

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
  local or session storage, `location.search` and `location.hash` are empty, and each address it went to is a path
  with one id.
- The heading rule; the names rule (a heading is the brick's name, the reference is in the monospace line); a stored
  flag (marked, labelled, `boards.seen` on pointing or focus, the folded chip and row marked); a brick's own flag
  (raised when the ticket, comments or session read changes, not after the member's own action, cleared on pointing
  with no call); the session brick's stop asking first; the reload onto a new build, only with the input empty and
  nothing being sent.

**No suite:** what needs a browser or a server under the page: 2 (the same DOM nodes), 7 (a second member), 15 (both
entering in one frame), 19, 21, 22, 23, the `t-123` chip in a reply (20), and whether an `inert` container in fact
stops its controls, which is the browser's. Those were run by hand in a browser on an example household and on the
owner's own, and are not pinned.

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
   agent's judgment.
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
   Not checked: whether those fields update live as rule 8 requires, and whether an agent's own memories (as opposed
   to shared knowledge) are exposed at all. Written as: not in the first set; those two questions are answered before
   the bricks are specified.
