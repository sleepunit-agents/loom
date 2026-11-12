# The web foundation: one process, one database, one API, one live feed

*2026-11-12. Status: **draft, for the owner's read**. A design doc in the `docs/specs/` sense: it says what loom
will build and what its tests must pin. It follows a review of the web side at main `73c0063` (the browser client,
the page server, the piece boundary, and all 623 commits since 2026-10-24; loom note
`loom/2026-11-12-web-side-review`) and a conversation with the owner the same day. Where it conflicts with an
earlier spec, this one wins; "What this replaces" lists them.*

## Why

> "we keep having a ton of issues for something that's barely more complex than a heavy duty todo list." — the
> owner, 2026-11-12

The review found the product small and the system under it large. Four causes account for nearly all of the pain:

1. **The server is the MCP program with a page bolted on.** Three listener processes share one home and each runs
   every background job. Stores are opened and closed per call, with synchronous waits on the event loop. A
   piece's data arrives by running its command-line program and reading JSON off its output. Around that sit about
   15 cache layers, 9 process pools, 56 timeout constants, leases, tick files and a lock gate. After the last
   round of fixes the listener still stalled 116 times in ten minutes.
2. **First-party features pay a third-party plugin tax.** Tasks, approvals, the clock and Changes are separate
   programs in separate repos behind a JSON contract that has nine coexisting generations. Core names their roles
   in a dozen places and they call each other, so the independence isn't real. A change spanning one piece and
   core is a piece PR, a pin PR, a deploy, and often another core PR; pin bumps are a quarter to a third of core's
   commits.
3. **The browser has no single data path.** Nine ways for data to reach the screen, five ways for a write to go
   back, reconciled by hand per screen. Shared collections were added beside the page fetches, not instead of
   them: `useCollection` has no callers.
4. **Direction was set by reaction, then guarded by process.** The renderer was built three times, the desktop
   four, live data five. The guard that followed (a merge queue, multi-round reviews on every merge) slowed every
   change without removing a cause.

## What the owner decided (2026-11-12)

- **Someone else can install this quickly.** "the goal is for this to be something that somebody else could
  install quickly on their own."
- **One API.** "I was thinking we were exposing a single api path that anything talking to loom, whether that's
  the cli or the web app or an agent, was hitting."
- **Replaceable parts, not a plugin economy.** "we should design the app where individual chunks can be replaced
  if we change our mind. I don't want to toss this if we decide to change taskstore or how we talk to discord."
- **The tiled desktop is the product.** "once we've determined things like, we're going to tile things, we should
  simplify and only support that." The phone later becomes that desktop's phone counterpart, in a project of its
  own.
- **A small team that trusts each other.** One real user today; two to four at most. The **project is the sharing
  unit**: "you've already implied so much trust when you're sharing work across your agents with someone else
  that it's insane to think they'd want to be super granular after that level."
- **No zero-downtime requirement.** A restart is an acceptable deploy.
- **The data path is simple on purpose.** "pick any random database, use websockets to vomit tiny data changes,
  done." TanStack DB goes.
- **Tests bring their own loom.** "we absolutely need to be able to run a loom instance as part of firing up the
  test suite rather than expecting mine to exist."

## Goals

1. **One process serves everything.** `loom serve` is the page, the API, MCP over HTTP, the live feed and the
   background jobs.
2. **One app database, one writer.** No JSON state files, no lock files, no cross-process coordination.
3. **One API.** The page, the CLI, agents and anything outside the process call the same operations through the
   same permission check.
4. **One live feed.** A committed change reaches every window that may see it as a small message, and nothing
   polls.
5. **One permission rule,** in one module.
6. **Pieces are parts of one program** with declared seams, so one can be replaced without touching the rest.
7. **Two shells:** the tiled desk and the phone.
8. **A stranger installs it with one command** and no other software.
9. **A change is tested in minutes against a loom the suite starts itself.**

## Non-goals

- **The phone's redesign.** The phone keeps its present screens on the new data path.
- **Memory, knowledge, people and identity.** Their stores and MCP tools are untouched. This spec covers what the
  page shows and what serves it.
- **A marketplace of pieces,** or any installer for someone else's piece beyond what "Pieces" below keeps.
- **Hardening against a hostile member.** Members are trusted teammates. The boundary is who is meant to see and
  do what, enforced on the server; it is not built to hide that hidden activity exists.
- **Scale.** The design assumes one household, a handful of people and agents, and record sets in the thousands.

## Anti-goals

These make the work a failure even if it runs:

- An old path left beside its replacement. Every step deletes what it replaces in the same change.
- A second way to do anything on the lists above: a second fetch path, a second store for a fact, a second place
  that decides who may see something.
- A continuity regression: an agent's identity and memory must still load over stdio with no daemon running.
- An install that needs systemd, Python, a container, or a binary loom doesn't ship.

## How it runs

loom has two ways to run, and only the second is new.

- **Over stdio, with no daemon** (`loom mcp`, as today). A harness starts it and gets identity, memory, knowledge
  and people. This is the continuity promise in [household.md](household.md) and it doesn't change.
- **As the daemon** (`loom serve`). One Node process. It listens on every address it is configured for (today's
  Tailscale, LAN and localhost listeners become three addresses of one process). It serves the built app, the API,
  MCP over HTTP, and one WebSocket endpoint, and it runs every background job. There is one of it per home; a
  second `loom serve` on the same home refuses to start.

**Deploying is a restart.** The daemon stops taking requests, finishes what is running (a few seconds at most),
exits, and the new one starts. A window's socket reconnects and asks again for what it shows.

**Nothing on a request's path starts a process or waits on a lock.** Slow work (embedding, backup, encrypting a
large file) runs on a worker thread. A piece that must run a program (a body, `git`) does so asynchronously, as a
job, never inside a request.

**The CLI is a client.** `loom <piece> <operation>` calls the daemon's API with a token. When no daemon holds the
home, the CLI runs the same operation itself, in its own process, against `loom.db`: the registry is a library,
and the daemon's start-up lock is what tells the two cases apart. So `taskstore close` works with loom stopped,
and there is still only ever one writer. The continuity commands (`loom wake`, `recall`, `remember`, `mcp`) keep
working directly against an agent's stores, as now.

The HTTP layer moves to Hono. The 2,900-line `src/ui/handler.ts` goes; its jobs split into the static files, the
sign-in routes, and the API below.

## Storage

**One app database: `$LOOM_HOME/loom.db`** (SQLite through better-sqlite3, WAL). The daemon opens it once and
keeps it open. It holds everything the page shows that isn't an agent's mind:

| Today | In `loom.db` |
|---|---|
| `household.json`, `household.db` | members, agents, projects' sharing, settings |
| `tokens.json`, `tokens.used.json`, `ui-sessions.json` | tokens, sessions, passkeys, push subscriptions, a member's preferences and read marks |
| `comms.db`, `comms.tick` | threads and messages |
| `collections/live.db`, `periodic-owner.db`, `periodic-jobs/*.db` | gone (see "The live feed" and "Jobs") |
| `commons/stores/<piece>.db`, each piece's own state file or store | that piece's tables |
| `audit.db` | the audit table |
| `pieces/<name>/piece.json`, `settings.json`, `pieces.tick` | a settings table; the tick goes |

**What stays where it is:** each agent's context directory (`memories.db`, `notes.db`, its identity files) and
the commons' `knowledge.db` and `people.db`. They are the portable self, they must work with no daemon, and they
are out of this spec's scope. Key files (`comms.key`, `store.key`, `ui-cookie.key`, the review key pair) stay
files.

**SQLite calls stay synchronous.** In one process with a connection kept open a read takes microseconds; the
stalls came from child processes, lock waits and opening a connection per call, and all three are removed.

**Each piece owns its tables,** named `<piece>_<table>`, with its own numbered migrations that the daemon runs at
start. A piece reads and writes only its own tables; another piece's data is reached through that piece's
interface ("Pieces").

**Moving existing data** is one importer per old file or store, run by `loom migrate` with the daemon stopped,
after a backup. Importing is a one-way door for that store: the owner is present for each.

The ruling "loom owns the data" (`~/Art/notes/decisions/2026-10-28-loom-owns-the-data.md`) stands and this is its
completion: a JSON or lock file holding state is a bug.

## The API

**An operation** is the only way anything reads or changes app data:

```ts
operation({
  name: 'tasks.close',
  input: z.object({ id: z.string(), reason: z.string().optional() }),
  may: (viewer, input, db) => …,     // the permission rule; see "Who may see and do what"
  run: (ctx, input) => …,            // one transaction; returns a result
})
```

- **One registry.** Every piece registers its operations at start. The registry is the published surface: its
  names, inputs and results are what the docs and the CLI's help are generated from.
- **Four doors, one implementation:**
  - `POST /api/<piece>/<operation>` with JSON, for the CLI, scripts and anything outside the process.
  - A call over the window's socket, for the app.
  - An MCP tool, for the operations a piece marks as offered to agents.
  - A direct function call from another piece, through that piece's interface.
- **Every door resolves the caller to a viewer first,** then `may`, then `run`. No door has a rule of its own.
- **An operation names its doors.** The default is all four. Comms' operations that carry a message's words are
  open only on the window's socket, to the thread's member, and to the runtime delivering to the thread's agent
  (below).
- **A write is one transaction** and names what it changed (`ctx.changed(type, id)`), which is what feeds the live
  feed.
- **A write carries an operation id** from the caller. The same id sent twice returns the first result, so a retry
  after a dropped connection never acts twice.
- **Errors are values:** `{ok: false, code, message}` with a small fixed set of codes (`denied`, `not-found`,
  `invalid`, `conflict`, `unavailable`). The app shows them inline; nothing uses `alert()`.

Reads are operations too (`tasks.list`, `comms.messages`), for what isn't live or is too large to keep in a
window: history, search, a closed task from last month.

## The live feed

**A record type** is a kind of thing windows watch: a task, an approval, a wake, a thread, a message, an agent's
status, a change, a project. A piece declares each type with:

- how to read one record for a viewer (`read(id, viewer)` returns the record, or nothing if the viewer may not
  see it), and
- its **live scope**: either the whole set a viewer may see (tasks that are open or changed in the last week,
  every pending approval, the thread list), or the records under one parent (the messages of one thread).

**How a change travels:**

1. An operation commits and has named `(type, id)` pairs.
2. After the commit, the daemon's in-process emitter announces them.
3. For each window subscribed to that type and scope, the daemon reads the record as that window's viewer and
   sends `put` with the record, or `del` if it is gone or no longer visible.

**A window:**

- opens one WebSocket (`/live`), authenticated by its session;
- subscribes to the types and scopes its open apps need, and receives the current set for each, then changes;
- keeps one in-memory store: a map of records per type. Screens read it through one hook,
  `useRecords(type, scope)`, and filter and sort in the browser;
- on reconnect, subscribes again and replaces what it held. There are no cursors, revisions, resets or repair
  checks: the sets are small enough to send whole.

**There is no change log table, no polling, and no "something changed, ask again" event.** `loom.db` has one
writer, so nothing in it changes behind the daemon's back.

**The agents' own stores are the one exception, and they tell the daemon.** Memory, knowledge, people and an
agent's project cards are written by `loom mcp` over stdio and by the continuity commands, with or without a
daemon. After such a write, the writer calls one operation, `core.touched(type, id)`, if a daemon is up; the
daemon reads the record from the agent's store and sends it on. A missed call costs a stale tile until the next
one; nothing is lost. The daemon never watches or polls those stores.

**Conversations and asks belong to the desk, so they live in `loom.db`.** A conversation's turns, its digest and
what it needs from the owner are written through operations and need a daemon. A body with no daemon to reach
writes an episode to its agent's store instead, which is what bodies already do when the runtime gives them no
conversation.

**Writes from a window** are operations over the same socket. A screen gets `pending`, then the result; the
changed record arrives through the feed like anyone else's change. A screen draws its own change before the
answer only where waiting would be felt (sending a message, ticking a box), through one shared helper.

**The liveness rule for asks stays** (`web/src/ask-open.ts`): an Allow is only drawn for an ask the daemon has
just confirmed is open.

What goes: `src/collections/` and `web/src/collections/` as built, TanStack DB, `/events`, the per-thread stream,
every refresh timer, the page cache and its service-worker copies of page data, and the manifest round. The
record-type vocabulary and the viewer model from [collections.md](collections.md) carry over; its machinery does
not. The builder may reuse `web/src/collections/runtime.ts` where it fits the simpler protocol.

## Who may see and do what

**A viewer** is who is asking:

| Viewer | What it is |
|---|---|
| A member | a signed-in person: household owner, or a member with a list of projects and the agents they own |
| An agent | a token that is one agent |
| A runner | a token for a machine that runs bodies |

**Records carry what the rule needs:** an optional `project`, an optional `agent`, and an optional `member` for
something private to one person (a Comms thread).

**A project, for sharing, is a household thing.** `loom.db` holds the list: a slug, a name, the repositories it
covers, its members and its agents. An agent's own project card ([projects.md](projects.md)) stays in that agent's
store as what the agent knows about the project, and points at the household project by slug; a card with no
household project behind it is shared with nobody.

- **A record gets its project when it's made:** a task from the field it's given (or its parent's), a change from
  its repository, a thread or an approval from the conversation it came from.
- **An agent's projects are the ones it's listed on,** set by a household owner. They aren't worked out from its
  owners.
- **Importing:** an existing task takes the project of its epic where the epic names one; everything else arrives
  with no project and is the household owner's until someone files it.

**The rule,** in one module (`src/policy.ts`), is the only place these decisions are made:

- A **household owner** sees and does everything, except read another member's private records.
- A **member** sees a record when it belongs to one of their projects, or to an agent they own, or to them. They
  act on what they see, with two limits: they give work to, and change the setup of, only agents they own; and
  household things (members, secrets, runners, pieces) are the household owner's.
- An **agent** sees and does what its owners' rule allows for its own records and its projects.
- A record with no project and no agent is the household owner's.

The owner's example is the test case: a second member is invited with the project `pond`. He and his agent see
pond's tasks, changes and threads; he can't give Art or Mark work, and he sees nothing outside pond.

**Where it's applied:** in `may` for every operation, and in `read` for every record sent to a window. A window's
subscriptions are dropped and re-made when its member's projects or agents change. There is no per-frame recheck,
no hiding of counts or revisions, and no second copy of the rule in a piece.

**Comms keeps today's promise** ([comms.md](comms.md)): a thread's words are read only by its member and its
agent. Each message stays encrypted in its row with the Comms key, now by the library in-process. No MCP tool, CLI
command or other token can read one. Export and backup write the database table by table and leave the Comms
tables out, as the bundle leaves `comms.db` out today.

Sign-in is unchanged in behaviour (passkeys, one-time links, sessions, CSRF on form posts); its state moves into
`loom.db`.

## Pieces

**A piece** stays loom's word for a part that can be replaced. What changes is that a piece is, by default, a
module inside loom:

```
src/pieces/<name>/
  schema/        numbered migrations for its tables
  index.ts       its operations, record types, jobs and what it offers agents
  role.ts        the interface other pieces may call (optional)
web/src/pieces/<name>/
  index.tsx      its apps: each a screen, an icon, and how much room its tile can use
```

**Seams, enforced by a test** (`src/architecture.contract.test.ts` grows to cover it):

- A piece imports from `src/core/` and from another piece's `role.ts`, and nothing else of another piece.
- Core imports no piece. Core learns what exists from the registry.
- A piece's screens import the kit, the data hook and their own piece.

**A role** is a named interface with one implementation at a time: `tasks`, `approvals`, `clock`, `changes`,
`runtime`. Replacing taskstore is writing another module that implements the `tasks` role, including an adapter
onto someone else's tracker, and switching which one is registered.

**What becomes an in-repo piece:** tasks (taskstore), approvals, clock, changes, and the runtime's state and
screens. Approvals, the clock and Changes are Python today and are rewritten in TypeScript; taskstore already is
TypeScript and moves in with its contract and conformance suite (`spec/taskstore-core`), which keep governing the
`tasks` role. Its import source is the store in `~/Art/.taskstore`. Their repos are archived once their piece has cut
over, and the catalog's pins go with them. The commands people and agents already type (`taskstore`, `approvals`,
`wake`) remain as names that call the API.

**What stays outside the process,** each speaking the same API with a token:

- **The secrets key holder.** A separate process holding the age key is a real security property.
- **A runner:** the program on a machine that starts bodies. It is on other machines and trusted less.
- **Bridges** (Discord, Slack, and shuttle, which is about 60 Python files) are decided at their step: in-process
  unless keeping one alive across a daemon restart proves worth a process, and rewritten only if they come
  in-process.

**Someone else's piece** has one door: a program with a token that calls the API, publishes records of its own
types, and may describe pages in the block vocabulary (`src/ui/vocab.ts` and the app's block renderer, both kept).
It ships no script and no markup, as the ruling on data-only pieces says
(`~/Art/notes/decisions/2026-10-26-loom-page-runs-its-own-script.md`). Nothing more is built
for this until someone outside wants it.

**What goes:** running a piece's program to get its page, manifest or data; manifests and their polling; the
piece socket, the persistent piece server and the pools; the catalog pins for first-party pieces; "any
`loom-*` program on the PATH is a piece".

## Jobs

Background work (a wake coming due, Changes syncing from GitHub, a backup, memory upkeep) is a job the daemon
runs: a table of what is due and when, and timers in the one process. One process means one owner, so the leases,
the owner lock and the per-job lock databases go. A job that starts a program does so asynchronously and records
the result with an operation, which is how its effect reaches windows.

Whether wakes stop using systemd's timers is settled at the clock's step; the install goal says they should.

## The app

**Two shells, chosen once by width:** the tiled desk from 1024 px, the phone below it. The sidebar shell, the
framed-window leftovers, the no-shell header and the in-between tablet variant go.

- **The desk** is as [desk-tiling.md](desk-tiling.md) and [agent-desk.md](agent-desk.md) describe it. An app is
  what a piece registers; the desk knows nothing about any particular app.
- **One router** owns the address: which apps are open, and each app's own path. Tiles, history and the trail read
  it; nothing else holds a copy.
- **First-party screens are ordinary typed React components** reading records. The block vocabulary draws only an
  outside piece's pages.
- **Every screen is built from the kit** (`web/src/kit`, [building-a-loom-app.md](building-a-loom-app.md)). The
  kit lint stays and its legacy list empties as apps move.
- **One chunk per app,** loaded when the app first opens; the shell and the kit load first. The first-page budget
  is checked on the shell alone.
- **What a member chose** (look, sound, accessibility) is one record of theirs, read like any other; local
  storage holds only what belongs to the device (open tiles, drafts).
- The looks, pixel faces, motion and sound stay. They read state; they don't hold or fetch it.

## Installing

```
npm install -g @jbarket/loomai
loom serve
```

The first start makes the home, the database and a household of one, and prints a one-time sign-in link. Nothing
else is required: no Python, no `age` binary (encryption uses the library already in the tree), no container, no
systemd. `loom service install` is an optional convenience that writes one unit.

**The base install is the desk and its own pieces.** Secrets (which needs `sops` and `age` today) and the bridges
are optional additions and may bring their own requirements until step 5 settles them.

The contributing guide and positioning doc still describe loom as memory for one agent with no daemon. They are
rewritten when step 2 lands: the stdio side is still that; the daemon is the household's desk.

## Tests

- **`startLoom({home, clock})`** starts the whole daemon in the test's own process on a temporary home, with a
  clock the test controls. Every server test uses it; none needs an installed loom.
- **A fixture home** (`loom fixture <dir>`) builds a household with two members, two agents, a shared project and
  a few records of every type. Tests and the staging instance start from it.
- **Outside pieces are faked in-process.** No test writes a shell script to stand in for a program.
- **The suite runs in under three minutes** on loom's machine, with no fixed sleeps. Time moves only when a test
  moves the clock.
- **A handful of browser tests** (ten at most) cover what only a browser can: sign-in, the desk opening and tiling
  two apps, a change arriving in a second window, the phone shell, an outside piece's block page. They wait on
  conditions, never on time.
- **Tests that read source files as text are deleted.** The vocabulary's "every block has a fixture" test stays.
- **A staging instance:** `loom serve --staging --home <copy> --port <other>` on a copy of the real home,
  refreshed on demand, so a change is used under real data before it reaches the owner's loom. `--staging` holds
  everything that reaches outside the process: wakes, bridge sends, starting bodies, push. Held work shows as due
  and can be let through one item at a time by hand. Nothing in staging acts on the world by default.

## What must be true when this is done

Each is measured on loom's machine with the owner's real home, and each has a test or a recorded measurement:

- One `loom` process is listening. No `spawnSync` is reachable from a request.
- `$LOOM_HOME` holds `loom.db`, the agents' and commons' stores, and key files; no JSON or lock file holds state.
- A page's data is answered in under 50 ms at the 95th percentile with bodies running; the daemon idles under 5%
  of one CPU with three windows open.
- A change made in one window appears in another within 200 ms, with no timer involved.
- With the daemon stopped, a harness still loads Art over stdio.
- The second-member case above passes as a test.
- A fresh machine goes from nothing to a signed-in desk with the two commands above.
- A change to one first-party piece is one PR in one repo.
- The server suite runs in under three minutes and passes ten times in a row under load.

## Moving there

No new screens until step 3 lands; bug fixes only.

1. **This spec,** agreed.
2. **The foundation:** `loom serve` as one process on Hono; `loom.db` with sign-in state, members and settings
   moved in; the operation registry; the policy module; the live feed; `startLoom` and the fixture home. The
   present page keeps working on its present paths during this step, in the same process.
3. **Tasks, end to end:** the `tasks` piece in-repo, its data imported, its app on the desk reading records. This
   proves the whole path and sets the pattern every later piece copies.
4. **The rest, one piece at a time:** approvals, changes, clock, then core's own apps (Inbox and what needs you,
   Comms, People, Projects, Knowledge, Activity). Each piece cuts over whole: its data, its operations, its
   screens, and the deletion of its old path, in one change.
5. **Runtime and the bridges.** The runtime is the largest piece and the riskiest; its runner stays outside.
6. **Deletion:** whatever of the old contract nothing uses (the manifest machinery, the pools, the collections
   code, the old shells, the catalog).
7. **The phone's redesign,** as its own project.

## What this replaces

- [collections.md](collections.md) and its two inventories: the record types and the viewer model carry over;
  providers, pulls, the log, cursors and leases are withdrawn.
- [extensions.md](../extensions.md), [pieces-install.md](pieces-install.md) and
  [piece-storage.md](piece-storage.md): the command-line contract, manifests, the catalog and the piece store are
  withdrawn for first-party pieces. The block vocabulary stays as written.
- [ui-app.md](ui-app.md): "Live, and fast" and the page-view JSON are withdrawn; the rest stands.
- [owners.md](owners.md): members gain projects; the caller that pieces receive becomes the viewer.
- [household.md](household.md): `household.json` and `tokens.json` move into `loom.db`; "where core ends" stands
  for continuity, and the desk is no longer described as a frame around pieces.

## Left to the builder

- The socket's message shapes, and whether the app's calls go over the socket or plain HTTP.
- Table layouts and the order of importers within a step.
- Which parts of today's client runtime, kit and Comms code are kept as they are.
- How a job's timers are held and resumed across a restart.
- The exact live scope of each record type, within "small enough to send whole".

## Open, for the owner

- **Bridges in or out of the process** is settled at step 5 on evidence; say now if you already have a view.
- **Taskstore's repo:** this spec moves its code and contract into loom and archives the repo. The alternative is
  keeping it as a published library loom depends on, which keeps it usable by someone who doesn't run loom and
  keeps one pin.
