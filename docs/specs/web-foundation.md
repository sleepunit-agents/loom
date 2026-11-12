# The web foundation: one process, one database, one API, one live feed

*2026-11-12. Status: **draft, for the owner's read**. A design doc in the `docs/specs/` sense: it says what loom
will build and what its tests must pin. It follows a review of the web side at main `73c0063` (the browser client,
the page server, the piece boundary, and all 623 commits since 2026-10-24; loom note
`loom/2026-11-12-web-side-review`) and a conversation with the owner the same day. Where it conflicts with an
earlier spec, this one wins; "What this replaces" lists them.*

## Why

> "we keep having a ton of issues for something that's barely more complex than a heavy duty todo list." — the
> owner, 2026-11-12

The review found three listeners repeating jobs, child programs serving page data, and repeated cache and lock
machinery. Separate first-party repos turn one change into several PRs. Nine delivery paths and five write paths
coexist in the browser. Repeated renderers and desktops were followed by process that slowed work without
removing those causes. The historical evidence is in the review note above; the acceptance measures are below.

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
8. **A stranger with Node and npm installs and starts it with the two commands below,** with no other software.
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

**Deploying is a restart.** Stop accepting requests, finish transactions within five seconds, then roll back any
unfinished transaction and exit. Persist job intent before starting work; on restart resume local work from its
checkpoint or retry by operation id. Uncertain outside effects stay held for a person. Worker threads stop at the
deadline; tests interrupt each phase and check committed work once, rolled-back work absent and held effects not
resent. A window reconnects and subscribes again.

**Nothing on a request's path starts a process or waits on a lock.** Slow work (embedding, backup, encrypting a
large file) runs on a worker thread. A piece that must run a program (a body, `git`) does so asynchronously, as a
job, never inside a request.

**The CLI is only a client.** `loom <piece> <operation>` calls the daemon's API with a token, from loom's machine
or from a house on another one, and has no other way to reach app data. It holds no logic of its own: its
commands and help are generated from the operation registry. With the daemon down it says so; across a restart it
retries for a few seconds, which is safe because a write carries an operation id. Only the continuity commands (`loom wake` to load identity, `recall`, `remember`, `mcp`) keep direct
access to the mind stores. The separate `wake` command schedules work through the API and needs the daemon.

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
files. Static JSON assets (faces and icons) are files too; the ban is on mutable app state.

**Stdio reads household metadata without the daemon.** It opens `loom.db` read-only for agent names, the default
agent, ownership and commons paths; it neither writes app tables nor starts jobs. This is the sole exception to
API-only app reads. A standalone context directory still needs no `loom.db`. Migration tests remove the old JSON,
stop the daemon, and check identity, owners, memory, knowledge and people for two agents and a standalone home.

**SQLite calls stay synchronous.** In one process with a connection kept open a read takes microseconds; the
stalls came from child processes, lock waits and opening a connection per call, and all three are removed.

**Each piece owns its tables,** named `<piece>_<table>`, with its own numbered migrations that the daemon runs at
start. A piece reads and writes only its own tables; another piece's data is reached through that piece's
interface ("Pieces").

**Moving existing data** is one importer per old file or store, run by `loom migrate` with the daemon stopped,
after a backup. Importing is a one-way door for that store: the owner is present for each. The importer commits
its data and source checksum together, or neither; a retry of that checksum is a no-op and a different source is
refused. The old writer stays stopped. Before cutover, compare ids, counts and canonical exported content (including
links, ownership and timestamps), and read encrypted data with its existing keys. A failed check blocks cutover;
restore the backup to resume the old version. Only a verified import retires its old store and writer.
Comms uses a local maintenance snapshot of encrypted rows and keys, excluded from normal export/backup. Before
import, save it with owner-only file access; compare decrypted rows locally in memory, never in exported reports.
On failure restore it with the normal backup. Delete it after verified cutover. Tests prove both success and rollback.

The data rule is complete here: loom owns app data; pieces own tables inside its database. Mutable app state
in a JSON or lock file is a bug. Historical review counts in "Why" are background, not acceptance measurements.

## The API

**An operation** is the only way to read or change app data, except stdio's read-only household metadata above:

```ts
operation({
  name: 'tasks.close',
  input: z.object({ id: z.string(), reason: z.string().optional() }),
  may: (viewer, input, db) => …,     // calls the central policy; no local permission rule
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
- **A write carries an operation id** scoped to the authenticated principal, shared across doors. In one transaction,
  store the operation name, canonical input and result with the change. Same id and input returns that result;
  different name or input returns `conflict`. Keep receipts until that principal is removed, including across
  restarts. Recheck current permission before returning a receipt. Jobs use the id for any outside delivery too;
  where the receiver cannot deduplicate, an uncertain delivery is held for a person, never retried blindly.
  Comms receipts live in its encrypted, export-excluded tables; generic receipts keep only opaque ids and keyed
  input hashes, never words or word-bearing results. Only the thread's authorized member/runtime may replay them.
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
3. For every subscription of that type, compare its delivered ids with current visibility AND scope membership:
   `put` in the new scope, `del` in any old scope. Each time-bounded type supplies its next departure time;
   a daemon timer expires it without polling. Tests move a record between parents and advance past a time limit.

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

**The rule,** in one module (`src/policy.ts`): the private row is a complete decision, not a filter before the
other rows. With no private member, choose the viewer row; empty scope further limits members. Deny wins.

| Case | Read | Act |
|---|---|---|
| `member` is set | matching member only (Comms also requires current agent ownership), or bound runtime delivery | matching member within agent/household limits; bound runtime may append replies/activity and update delivery status only, never answer member asks |
| Household owner, no private member | all | all |
| Other member, no private member | if project is set, must match; otherwise must own its agent | what they can read, except household setup and work/setup for agents they do not own |
| No project, agent or member | household owners only | household owners only |
| Agent token | non-private: if project is set, must be listed on it; otherwise record must name that agent | same scope; never member answers, household setup, or work/setup for another agent |
| Runner token | only that runner's assigned job inputs and status | claim/report its assigned jobs; no general app access |
| Service token (key holder or outside piece) | only declared types and operations granted by a household owner | same; no member impersonation or Comms words |

For agent tokens, ownership grants no inherited member powers: the rule is independent of the union or intersection
of owners. An agent with no owners is disabled until a household owner assigns one. Household setup means members,
secrets grants, runners and piece registration. Runtime delivery is an internal role bound to a thread and its agent,
not an agent token or a runner's general credential. Comms' ask-routing exceptions are implemented here, never
by exposing private words. Private-record tests cover agent ownership removal. Other internal calls preserve the original viewer; a scheduled
job uses its registered service viewer. Every call still enters the same registry and policy.

The second-member fixture includes Pond-bot records in another project (both Pollock and Pond-bot are denied): Jonathan owns Art and Mark. Pollock owns Pond-bot; both Pollock and Pond-bot
are listed on `pond` only. They see pond tasks, changes and non-private conversation metadata, but not another
member's private threads or words. Pollock may give Pond-bot work, never Art or Mark. Pollock and Pond-bot may also
see their own agent's unprojected records; "nothing outside pond" means no other project's or agent's records,
not denial of their own private or unprojected agent records. A member-only record is never owner-only by default.
Creating a record checks the proposed scope; updating checks both old and proposed scopes. Changing a private
record's member is forbidden. Project assignment requires membership in the target project; agent assignment
requires ownership (an agent token can assign only itself). Household project membership and agent-project lists
are household setup. Policy tests reject unauthorized create, move, reassignment and self-enrollment.

**Where applied:** every operation's `may` and every record's `read` call this module. Any change to membership,
agent ownership or projects, project sharing or record scope rebuilds affected subscriptions and replaces their
sets, evicting old records. Removed members and revoked/expired sessions close their sockets. No independent rule
lives in a piece. No per-frame check or hiding that activity exists is required.

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

**What becomes an in-repo piece:** tasks (taskstore), approvals, clock, changes, the runtime's state and
screens, and the bridges (Discord, Slack, and shuttle, which is about 60 Python files and is rewritten in
TypeScript at its step). A bridge's connection drops for the few seconds of a restart and reconnects. Approvals, the clock and Changes are Python today and are rewritten in TypeScript; taskstore already is
TypeScript and moves in with its contract and conformance suite (`spec/taskstore-core`), which keep governing the
`tasks` role. The source is [taskstore's contract](https://github.com/sleepunit-agents/taskstore/tree/main/spec/taskstore-core)
and its fixture corpus. Step 3 must vendor that exact pair at a recorded commit and run all its cases unchanged;
the API wraps its domain results without changing their error codes. Its import source is the store in `~/Art/.taskstore`. Their repos are archived once their piece has cut
over, and the catalog's pins go with them. The commands people and agents already type (`taskstore`, `approvals`,
`wake`) remain as generated API-client executables in the npm package's `bin` map. Each is an alias into
one registry client (`wake` maps to clock operations); `loom wake` remains the distinct identity command.
Step 3 tests installed taskstore parity; the clock step tests both wake spellings with the daemon stopped.

**What stays outside the process,** each speaking the same API with a token, and nothing else does:

- **The secrets key holder.** A separate process holding the age key is a real security property.
- **A runner:** the program on a machine that starts bodies. It is on other machines and trusted less.

**Someone else's piece** has one door: a program with a token that calls the API, publishes records of its own
types, and may describe pages in the block vocabulary (`src/ui/vocab.ts` and the app's block renderer, both kept).
It ships no script and no markup, as the ruling on data-only pieces says
(the complete rule here is: the page runs only loom's shipped script; outside pieces supply data). Nothing more is built
for this until someone outside wants it.

**What goes:** running a piece's program to get its page, manifest or data; manifests and their polling; the
piece socket, the persistent piece server and the pools; the catalog pins for first-party pieces; "any
`loom-*` program on the PATH is a piece".

## Jobs

Background work (a wake coming due, Changes syncing from GitHub, a backup, memory upkeep) is a job the daemon
runs: a table of what is due and when, and timers in the one process. One process means one owner, so the leases,
the owner lock and the per-job lock databases go. A job that starts a program does so asynchronously and records
the result with an operation, which is how its effect reaches windows.

At the clock's cutover, due wakes move into the job table and all old systemd wake timers are disabled and removed.
Restart tests prove a due wake is neither lost nor fired twice. No in-repo piece requires systemd.

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

The supported starting environment is Node 22 or later with npm (as package.json requires). The first start makes
the home, database and household of one, and prints a one-time sign-in link. Beyond Node and npm nothing is required: no Python, no `age` binary (encryption uses the library already in the tree), no container, no
systemd. `loom service install` is an optional convenience that writes one unit.

**The base install is the desk and every in-repo piece.** Secrets is the one optional addition that brings its
own requirements (`sops` and `age` today), until its step settles whether loom can ship them.

The contributing guide and positioning doc still describe loom as memory for one agent with no daemon. They are
rewritten when step 2 lands: the stdio side is still that; the daemon is the household's desk.

## Tests

- **`startLoom({home, clock})`** starts the whole daemon in the test's own process on a temporary home, with a
  clock the test controls. Every server test uses it; none needs an installed loom.
- **A fixture home** (`loom fixture <dir>`) builds Jonathan (household owner), Pollock, Art, Mark and Pond-bot
  with the ownership and pond membership above, plus records of every type. Tests and staging start from it.
- **Outside pieces are faked in-process.** No test writes a shell script to stand in for a program.
- **The server suite runs in under three minutes** in the reference environment below, with no fixed sleeps. Time moves only when a test
  moves the clock.
- **A handful of browser tests** (ten at most) cover what only a browser can: sign-in, the desk opening and tiling
  two apps, a change arriving in a second window, the phone shell, an outside piece's block page. They wait on
  conditions, never on time.
- **Tests that match source text are deleted.** The architecture test instead parses imports and checks the seams
  above. The vocabulary's "every block has a fixture" test stays.
- **A staging instance:** `loom serve --staging --home <copy> --port <other>` on a copy of the real home,
  refreshed on demand, so a change is used under real data before it reaches the owner's loom. `--staging` holds
  everything that reaches outside the process: wakes, bridge sends, starting bodies, push. Held work shows as due
  and can be let through one item at a time by hand. Nothing in staging acts on the world by default.

## What must be true when this is done

Use the fixture home for reproducible checks; the owner's home is an additional acceptance run, never a test
prerequisite. Step 2 adds a benchmark command and records machine specs, command, raw samples and percentiles.
Reference environment: Linux x86-64, four dedicated CPU cores, 8 GiB RAM, local SSD, Node 22; record exact hardware
with results. Workload: 1,000 tasks, 100 pending approvals, the three fixture agents, two viewers and three windows;
for 60 seconds, read lists at 10 requests/second and commit one task edit/second while two fake bodies report
status each second. Measure API latency and commit-to-render delay; then sample idle CPU for 60 seconds with
those windows connected and no writes. All thresholds below must hold; ten under-load suite runs use that workload:

- One `loom` process is listening. No `spawnSync` is reachable from a request.
- `$LOOM_HOME` holds `loom.db`, the agents' and commons' stores, and key files; no JSON or lock file holds state.
- A page's data is answered in under 50 ms at the 95th percentile with bodies running; the daemon idles under 5%
  of one CPU with three windows open.
- A change made in one window appears in another within 200 ms, with no timer involved.
- With old household/token JSON removed and the daemon stopped, stdio passes the two-agent and standalone tests.
- Policy table tests cover mixed private/project/agent fields, empty fields, both owners and every token kind;
  the second-member fixture passes for reads and writes over every allowed door and denied door.
- Revoking a session closes its socket; ownership, sharing and scope changes evict records already sent.
- Retry tests cover duplicate ids, mismatches, principals and restart; export scans find no Comms words in receipts.
- Import tests interrupt before/after commit, retry and compare content; Comms snapshot rollback and job shutdown tests pass.
- A clean supported Node/npm environment reaches a signed-in desk with the two commands above.
- A change to one first-party piece is one PR in one repo.
- The server suite takes under three minutes in the reference environment and passes ten under-load runs.

## Moving there

No new screens until step 3 lands; bug fixes only. Every step has a gate; do not begin the next before it passes.
Legacy paths are allowed only for apps not yet cut over. An app's cutover removes all of its old reads, writes,
streams and storage adapters in that same change. Imports are maintenance stops, not live coexistence. Step 2
replaces legacy readers of household, token and settings files with adapters to the same `loom.db` tables;
external unmoved pieces obtain that metadata through the API. No mirror JSON or second writer survives.
A staging gate exercises every unmoved app after old metadata files are removed. Each adapter dies with its last
caller. Shared machinery remains only while an unmoved app uses it;
its last caller's cutover deletes it. Step 6 verifies deletion, rather than permitting deferred parallel paths.

1. **This spec,** agreed.
2. **The foundation:** `loom serve` as one process on Hono; `loom.db` with sign-in state, members and settings
   moved in (including push subscriptions); the operation registry; the policy module; the live feed; `startLoom` and the fixture home. The
   present page keeps working for unmoved apps in the same process. Gate: one listener process; offline continuity,
   policy table, registry retry, socket/reconnect, sign-in and staging hold tests pass; the benchmark is runnable.
3. **Tasks, end to end:** the `tasks` piece in-repo, its data imported, its app on the desk reading records. This
   proves the whole path. Gate: unchanged taskstore conformance cases, canonical import comparison, two-window
   updates and CLI/API parity pass; no tasks legacy read, write, poll, piece program or old store remains active.
4. **The rest, one piece at a time:** approvals, changes, clock, then core's own apps (Inbox and what needs you,
   Comms, People, Projects, Knowledge, Activity). Each piece cuts over whole: its data, its operations, its
   screens, and deletion of its old path, in one change. Comms imports read marks; Activity imports audit.db. Gate per piece: verified import, policy and live-feed
   tests, operation parity and no legacy callers; the clock also passes daemon-only scheduling and restart tests.
5. **Runtime and the bridges.** The runtime is the largest piece and the riskiest; its runner stays outside. The
   bridges come in-process. Gate: delivery, reconnect and assigned-job token tests pass, with one active adapter
   per venue and all old runtime/bridge services stopped. Secrets' app state moves here too; only its key holder stays out.
   Before each step 4/5 cutover, enumerate every public verb/route and job from the old implementation in a parity
   matrix: old entry, new operation, input, expected result, permission and test. No entry may be silently omitted;
   a removal needs an explicit spec change. Each row passes against both implementations before the old one stops.
   Include scheduled fire/cancel, approval answer/denial, change sync, body start/report, and bridge receive/send/reconnect.
   The step's gate includes all assigned store imports, this matrix, and interruption/restart cases.
6. **Deletion:** whatever of the old contract nothing uses (the manifest machinery, the pools, the collections
   code, the old shells, the catalog). Gate: no legacy entry points or first-party pins remain; all completion
   measures pass. The same apps on the phone use the new path; its visual redesign is still separate.
7. **The phone's redesign,** as its own project.

## What this replaces

- [collections.md](collections.md) and its two inventories: the record types and the viewer model carry over;
  providers, pulls, the log, cursors and leases are withdrawn.
- [extensions.md](../extensions.md), [pieces-install.md](pieces-install.md) and
  [piece-storage.md](piece-storage.md): the command-line contract, manifests, the catalog and the piece store are
  withdrawn for first-party pieces. The block vocabulary stays as written.
- [ui-app.md](ui-app.md): "Live, and fast" and the page-view JSON are withdrawn; the rest stands.
- [owners.md](owners.md): members gain projects; viewer and the policy table replace its caller, manifest opt-in
  and per-piece visibility rules. Ownership and first-answer-wins behavior otherwise stay.
- [household.md](household.md): `household.json` and `tokens.json` move into `loom.db`; "where core ends" stands
  for continuity, with the read-only stdio metadata exception above; the desk is no longer a frame around pieces.
- [comms.md](comms.md): its privacy, retention and ask ownership stand; old routes/streams become registry
  operations and the single socket. Its `comms_thread` MCP tool no longer returns words; the runtime delivers
  a thread's words only to its bound body, as today. No project membership widens private thread access.

## Left to the builder

- The socket's message shapes. All browser app-data calls use that socket; HTTP is for other API clients and sign-in.
- Table layouts and the order of importers within a step.
- Which parts of today's client runtime, kit and Comms code are kept as they are.
- How a job's timers are held and resumed across a restart.
- The exact live scope of each record type, within "small enough to send whole".

## Settled with the owner after the first draft (2026-11-12)

- **Taskstore comes in.** Its code and contract move into loom and its repo is archived.
- **The bridges come in.** "we're bringing everything else in so leaving them out feels strange."
- **The CLI repeats nothing.** "the minute we repeat anything across those two places I'm out." It is a client
  generated from the registry, and it must work from a house on another machine, so it never opens the database.
