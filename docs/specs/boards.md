# Boards: a conversation with a second window the agent fills from bricks

*2026-11-26. Status: **draft**, not accepted. Cold-reviewed three rounds, 2026-11-26; the third was still blocking and
its findings are folded here without a further round. This is a design doc in the `docs/specs/` sense: what loom
builds, and the checks its suites must pin. It replaces the direction of the `art/context-ticket-intents` branch
(`web/src/pair/`, `web/src/contexts/`). It fixes the records, the operations and the behaviour. It does not fix the look
or the motion; a design pass comes after this is accepted and before any code.*

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
  with a constructed viewer and no model. Everything under "Operations" below is built and tested this way.
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
folded placements. **Hover** is what pointing at a chip shows. Every brick has all five.
_Avoid_: variant, size, view

**Board**:
the second window: an ordered set of placed bricks inside one thread. It has an address. It is changed in place.
_Avoid_: view, page, canvas, workspace, context

**Placement**:
one brick on one board, with its parameters and its rank.

**Rank**:
a placement's position in its board's order, counted from 0. The placement at rank 0 is the board's **primary**. The
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
   whole number in a stated range; a schema may mark a parameter optional. The only free text the agent gives a board
   is its title.
2. **A new brick is a change to loom.** It arrives with all five forms, a fit for each of the three board forms, a
   parameter schema with a default for every parameter that is not a record reference, its actions, its link key if it
   has one, tests and a catalogue entry.
3. **The board is the record of what is in the second window.** The page draws the board's placements and nothing
   else there. The address holds one id. The page keeps no board state in the query string, the fragment or the
   browser's storage.
4. **The agent always knows what is on the boards.** Every change the member makes to any board in the thread is a
   row, and the agent is handed those rows as sentences: at the start of its next job, or sooner in the result of its
   next board call.
5. **The member decides and does not pilot.** A brick carries the actions loom already has for its record. The member
   can also remove a placement, and can place a brick by clicking a chip.
6. **A click never waits for a model.** Placing from a chip starts no job.
7. **A change is drawn when it lands.** Each stored change to the board on screen is drawn at once, while the job that
   made it is still running.
8. **Bricks are live.** A brick's data changes on screen when the records change, with no reload and no job.
9. **The presence and the input are always on screen** on the page of a thread the member owns, at every width, with
   or without a board.

There is no note brick. What the agent has to say goes in the conversation.

## Records

Five tables, all in the shared schema.

**`board_threads`**: `thread`, `since`. A thread that has the second window: its member has sent from this page.
Only in such a thread is an agent told about boards or allowed to open one. A board nobody can see is never made.

**`boards`**: `id`; `thread`; `title` (at most 80 characters, may be empty, stored as a thread's title is);
`blueprint` (the one it was opened from, or null); `revision` (1 when opened; goes up by exactly one for each later
operation that writes a `board_changes` row); `agent_seen` (a revision; 0 until the agent has been handed the board);
`opened_at`; `trail_at` (when it last joined the trail: set on open and on reopen); `changed_at`; `closed_at` (null
while it is on the trail); `shown_at` (when the member last sent a message with this board on screen, or null). A
board is readable by its thread's member and its thread's agent and by nobody else. A
board is always between one member and one agent. Two members never share one.

**`board_placements`**: `board`; `id` (unique across all boards, never reused); `brick`; `params` (JSON, valid for that brick's schema, stored
with every default filled in); `rank`; `placed_by_kind` (`agent` or `member`); `placed_at`; `removed_at` (null while
live). Among a board's live placements the ranks are exactly 0 to n−1. No two live placements on a board have the same
brick and the same params. A board may have no live placements. Removed placements stay as rows. Visibility follows the
board.

**`board_changes`**: `board`; `revision`; `seq` (order within one revision, from 0); `at`; `actor_kind` (`agent` or
`member`); `change` (`open`, `place`, `remove`, `rank`, `title`, `close`, `reopen`, `act`); `placement` (for `place`,
`remove`, `rank` and `act`); `from` and `to` (old and new rank for `rank`, old and new title for `title`, the rank taken in `to` for `place`,
otherwise null). Placements shifted by another's `place`, `remove` or `rank` get no rows of their own; and for `act`: `action` (the name of one of the brick's actions) and `detail` (JSON matching that action's
declared schema, which holds only choices and ids, for example `{"status":"closed"}`). Visibility follows the board.

**`blueprints`**: `id`; `agent`; `name` (unique per agent, at most 80 characters); `description` (at most 300
characters); `parameters` (JSON: a list of `{name, kind}` in order of first use in the design; kind is one of `project`,
`ticket`, `change`, `repository`, `person`, `agent`, `inbox item`, `approval`);
`design` (JSON: an ordered list of `{brick, params}` in rank order, where a record-reference param's value is either
fixed or `{"open": "<parameter name>"}`); `created_at`; `used_at`; `uses`. A blueprint is readable and usable by its
agent in any of that agent's threads. No member reads `blueprints`.

A board holds no record data and none of a conversation's words.

## Operations

All are registered in the operation layer. A repeat with the same command id and a different input is refused. Writes
to one board are applied one at a time in the order they arrive; a rank given in a call is read against the board as it
is when the call is applied, and the result always returns the board as it then stands.

### For the agent

These are the operations as a job's body may call them, and only for boards in that job's own thread, only when
that thread has a `board_threads` row, and only for blueprints of that job's own agent; anything else from a body is
denied. Where a member may call an operation of the same name, what
the member may pass is under "For the member".

- `bricks.catalogue()` → for every brick: name, one line on what it shows, parameter schema with defaults, link key,
  actions.
- `blueprints.list()` → every blueprint of this agent: id, name, description, parameters, uses. The agent chooses by
  reading. There is no search in this version.
- `boards.list()` → every board in the thread: id, title, open or closed, `trail_at`, primary placement.
- `boards.open({title, blueprint?, arguments?})` → a new board, last on the trail, at revision 1, with an `open` row.
  With a blueprint, `arguments` must name every parameter and nothing else, or the call is refused. Each open param is
  filled, each placement is checked against its brick's schema, and if any fails the call is refused and nothing is
  stored. If two filled placements have the same brick and params, the call is refused. The placements are made in
  revision 1, one `place` row each, and the blueprint's `used_at` and `uses` are
  updated.
- `boards.change({board, changes})` → `changes` is one or more of:
  - `place {brick, params?, rank?}`: a missing record-reference param is refused; other missing params take the
    brick's defaults. Without `rank` the placement goes last.
    With `rank` r, from 0 to n, it takes rank r and every live placement at r or later moves down one. Refused if,
    after defaults, a live placement has the same brick and params.
  - `remove {placement}`: live placements after it move up one.
  - `rank {placement, rank}`: rank from 0 to n−1; the ones between shift by one.
  - `title {title}`.

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

Every agent call that takes a board returns, with its result: the board's id, title, revision, whether it is closed,
and its live placements in rank order, each with its id, brick and params; and **meanwhile**, the member's
`board_changes` rows with a revision greater than `agent_seen`, as sentences. The call then sets `agent_seen` to the
board's revision. So a member change to a board made while a job is running reaches the agent in the next call it
makes on that board. A change to another board waits for the next job's brief.

### For the member

Each is denied unless the caller is the thread's member.

- `boards.open({thread, place})` → a board with an empty title holding that one placement, at revision 1, with an
  `open` row and a `place` row.
- `boards.change` with `place` (no `rank`: it goes last) and `remove` only. A member `title`, `rank`, or `place` with
  a `rank` is refused.
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

1. Picks the **shown** board: among the thread's boards, the one with the latest of its `shown_at` and, if it is
   open, its `trail_at`. So it is the board the member last sent from, unless one has joined the trail since.
2. Builds the text with the pure function `boardBrief(shown, boards)`, where each board comes with its placements
   (live ones, and removed ones named by an unseen change) and its member `board_changes` rows with a revision greater
   than its `agent_seen`.
3. Sets `agent_seen` to the current revision on the shown board and on every board with unseen member changes.

The text reads, for the shown board: its id, its title, whether it is open or closed, and its live placements in rank order, each as placement id,
brick and params. Then, for every board in the thread with unseen member changes, one sentence per row, naming the
board by id and the placement by brick and params:

- `open`: "The member opened board B." (its first placement follows as a `place` sentence)
- `place`: "The member placed person(person=member:jonathan) on board B."
- `remove`: "The member removed trend(project=loom, days=30) from board B."
- `close`, `reopen`: "The member closed board B." / "The member reopened board B."
- `act`: "The member used set status on ticket(ticket=t-2441) on board B: status=closed." With an empty `detail`
  the sentence ends at the board's id.

With no shown board the text says so. Apart from a board's title, everything in the text is an id, a brick name, a
choice or a whole number. If a job dies
before reading its mail, those sentences are not sent again; the agent can still call `boards.read`. That is accepted.

The agent's reply is words. What it shows is the `boards.*` calls it made during the job.

**References in words.** A ticket id written as `t-123` is drawn as a `ticket` chip. Any other brick with a link key
is written as `[label](loom:<brick>/<key>)` and drawn as that brick's chip. The brick turns the key into its params.
Both are drawn as chips in the agent's words and in the member's, and not inside code.

**Standing instructions.** The agent's dossier for this page tells it: build a new board one `boards.change` per brick
so the member watches it come together; change the board on screen when the subject is the same and open a new one when
it is not; remove what no longer serves; save a board worth returning to, and always when it finds itself building the
same board a second time; and when no brick shows what is needed, say so and file a ticket for the brick. These are
judgment. No suite checks them. The owner judges them in the demo.

## The page

One page per thread. Its address is `/app/b/<board id>`, or `/app/t/<thread id>`.

- **Two halves.** The conversation is one half and the board is the other. At 640 px and wider both are always open.
  With no board, the conversation has the page.
- **Narrow.** Below 640 px the board has the screen and a bar holding the presence and the input stays on it.
  Pushing the bar opens the conversation as a sheet over the board. Closing the sheet returns to the board. With no
  board the sheet is open and cannot be closed.
- **The input.** There is one, the same control with or without a board.
- **The conversation.** Words and the work trace. The work trace is drawn in every Comms thread the member owns, not
  only the pairing thread.
- **The board.** The layout is a pure function `layout(placements in rank order, fits, area) → for each placement a
  form and a rectangle, or folded`. Rank 0 always gets the primary form and never folds; below its minimum width it
  takes the full width. The rest get side, then compact, in rank order, as room allows. A placement there is no room
  for is **folded**: shown as its chip in one expandable row at the end of the board. The exact rule is the design
  pass's to write. Fixed here: it is pure, it reads only rank, fit and area, and the same input always gives the same
  output. A board with an empty title is headed by its primary's chip, and has no heading if it has no placements.
- **Motion.** Placements are keyed by id. One that appears enters, one that goes leaves, the rest move to their new
  rectangles without being redrawn. The page reads the board's `revision` with its placements and applies each
  revision's differences in one step, so everything that changed in one revision starts moving in the same frame. With reduced motion set, changes apply without
  movement.
- **Chips.** Clicking a chip places that brick, with the params its key gives and defaults for the rest, last on the
  open board on screen. If that placement is already live, nothing is stored and it is brought into view. If the board
  on screen is closed, or there is none, the click opens a new board.
- **The trail.** The page follows the thread. When any board in the thread is opened or reopened, by either party, the
  page moves right to it. When the board on screen is closed, the page moves to the board before it on the trail; if
  it was first, to the one after; if it was the only one, to `/app/t/<thread id>`. `/app/t/<thread id>` for a thread
  with a trail goes to the last board on it, and that is where the thread switcher lands. A change to a board that is
  not on screen is stored and drawn when the member goes there.
- **A closed board.** Its address draws it as it was, with no remove controls and no action controls, and one control
  to reopen it.
- **Not yours.** A board or thread id that does not exist, or that the member may not read, draws one line saying
  there is nothing here, and no presence and no input.
- **Threads.** The switcher from the branch is kept as it is. Renaming and archiving a thread are not part of this
  spec.

## The first bricks

The first demo is "everything about a project", and the set is what that pulls in by following references.

| Brick | Parameters | Actions | Link key |
| --- | --- | --- | --- |
| `project` | `project`: project id | none | the project id |
| `lanes` | `project`: project id | none | none |
| `trend` | `project`: project id; `days`: 7, 30 or 90, default 30 | none | none |
| `ticket` | `ticket`: ticket id | `set status {status}`, `assign {assignee_kind, assignee}`, both by `tasks.command` | the ticket id |
| `comments` | `ticket`: ticket id | `comment {}`, by `tasks.command` | none |
| `pull` | `change`: change id | none | the change id |
| `repository` | `repository`: repository id as `project_repositories` stores it; `project`: project id, optional | none | the repository id |
| `person` | `person`: `member:<member id>` or `contact:<contact slug>` | none | the same string |
| `agent` | `agent`: agent id | none | the agent id |
| `question` | `item`: inbox item id | `answer {choice}`, by `inbox.answer` | the item id |
| `approval` | `approval`: approval id | `approve {}`, `refuse {}`, both by `approvals.answer` | the approval id |

A brick with no link key cannot be written in words. Its chip, used when it is folded, reads as its name and its
record parameter ("Lanes · loom"). A ticket's assignee is drawn as an `agent` chip or a `person` chip by the ticket's
`assignee_kind`. `trend` draws tickets opened and tickets closed per day. `comments` is the one brick whose action
takes words; the words go to `tasks.command` and are not stored on the board, so its `detail` is empty. Pausing an
agent's claims is per project today (`work.setProjectClaims`) and is left for a later brick.

`lanes`, `trend`, `ticket`, `pull`, `person` and `repository` have working code in the branch to start from
(`BoardPanel`, `project-trends.tsx`, `TicketCanvas`, `EntityCanvas`, `PersonProfile`, `entity-preview.tsx`). Memory,
knowledge, activity, usage and the rest of loom come later as their own bricks, each by rule 2.

## What goes

The view ring and its tabs; the related-work tabs, the drill-in and the pager; Browse and the indexes; the
`web/src/contexts/` prototype and its build step; the message prefix and `conversation-text.ts`; the `th:pair-` gate on
work cards; the fixed ticket and thread ids in `main.tsx`; the view state in the fragment and in local storage. The
desktop is untouched and stays the way to reach what boards do not yet show.

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
12. As the member: set a ticket's status from its brick. The ticket changes through `tasks.command`, an `act` row is
    written, and the brief has the act sentence with the ticket id and the status. `boards.act` with an action the
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
    it: all five forms render; it places given its record reference and nothing else; its schema refuses a value
    outside a list or range where it has one; it declares a fit for primary, side and compact. For every brick with a link key:
    `[x](loom:<brick>/<key>)` in a reply is drawn as its chip, and clicking it places the brick. `t-123` in a reply is
    drawn as a `ticket` chip, and inside a code span it is not.
21. With reduced motion set, check 2 completes with no running animations.
22. At 1280 px the conversation and the board are both visible and there is no control that hides the conversation.
    The same at 640 px. At 390 px, with no board, the conversation fills the screen above the bar. At 390 px, in
    checks 1 and 16, the presence and the input are inside the viewport, pushing the bar shows the
    conversation and closing it shows the board, the primary is drawn, and placements that do not fit are in the
    folded row.
23. Recorded harness output for a job in a thread that is not the pairing thread produces work-trace cards.

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

## Open

1. **Memory and knowledge.** They are kept in files, not in the shared schema's tables, but the page can already
   query some of them: `src/transport/memory-queries.ts` joins knowledge pages, knowledge search, people and identity
   into the same query layer every page reads (`memoryKnowledge`, `memoryKnowledgePage`, `memoryKnowledgeSearch`,
   `memoryPeople`, `memoryPerson`). So `knowledge` and a fuller `person` can be bricks by rule 2 with no new read path.
   Not checked: whether those fields update live as rule 8 requires, and whether an agent's own memories (as opposed
   to shared knowledge) are exposed at all. Written as: not in the first set; those two questions are answered before
   the bricks are specified.
