# Pieces: extending loom without growing it

loom is identity, memory and knowledge for one agent. It keeps that job small
on purpose. Everything else an agent leans on (a task store, secrets, a clock
that wakes it, a chat bridge, an approval page) is a **piece**: a separate
program that works with loom without becoming part of it.

```
core       loom: identity, memory, knowledge, person cards, project cards, conversations. Nothing else.
piece      a swappable extension: its own program, its own store, reached as `loom <piece>`.
instance   glue for one agent: its routines, hooks, which pieces it installs and how they're set up.
```

The test for which tier something belongs in: **does it manage the agent's
continuity, identity or knowledge?** If yes, it's core. If it's authority
(secrets, permissions), scheduling, transport, or work tracking, it's a piece
that sits on top. A shared command namespace doesn't make a piece part of
loom.

And for every piece, of each thing it keeps: **is this data about the agent's
life, or about a mechanism?** ([specs/conversations.md](specs/conversations.md))

- Life (who, what was said or decided, what happened) must outlive the piece,
  in one of two ways: it is a core record, or the piece's role contract gives
  it a portable export that a replacement implementation imports (for tasks,
  `spec/taskstore-core` in the public taskstore repo).
- Mechanism (tokens, queues, timers, session-resume state, caches) is the
  piece's, and may die with it.

So the bridges' conversations and the agents' relays are core records
(conversations), tasks stay the tasks piece's under its contract, and secrets,
box and the model subscriptions are mechanism.

## The rules

A piece:

1. **Is its own program.** loom never imports or links a piece's code. A piece
   runs as its own process.
2. **Never writes loom's stores.** It doesn't open `memories.db` or
   `knowledge.db` or edit the context dir. If it needs memory, it uses loom's
   public surface (the MCP tools, the HTTP daemon, or the `loom` CLI) like any
   other client. Its own state lives in its own store.
3. **Works alone.** A piece's tests pass with no other piece installed. Its
   absence never breaks loom or another piece: a missing piece is a feature
   that isn't there, not an error somewhere else.
4. **Composes when others are installed, without requiring them.** Pieces meet
   through named seams, never by calling each other's internals (see below).
5. **Has a contract.** Each piece *role* has one. "Tasks" is a role; taskstore
   is one implementation of it. The contract says what any implementation of
   the role must do, so a replacement can be checked against it before the
   swap. A contract is a spec that ships with the piece: commands and results
   with fixtures, not prose promises. `spec/taskstore-core` in
   [taskstore](https://github.com/sleepunit-agents/taskstore) is the pattern.
6. **Keeps secrets out of argv.** Values come from stdin or a prompt, never from
   a command-line argument, so they don't land in `ps` or shell history.

## How `loom <piece>` finds a piece

Like `git <cmd>`: `loom tasks list` runs the first executable named
`loom-tasks` on `PATH`, with the arguments after the piece name
(`list`).

- **Core commands always win.** A `loom-recall` on `PATH` is never run for
  `loom recall`.
- **Piece names are checked before `PATH` is searched.** A name is lowercase
  letters, digits and dashes, starts with a letter, and is at most 40
  characters long. Nothing else is looked up.
- **The piece gets loom's environment unchanged**, so `LOOM_URL`,
  `LOOM_TOKEN_FILE` and the rest reach it the way they reach the CLI.
  Run from a terminal, it inherits the terminal and can prompt.
- **The exit code is the piece's own**: 128+n if it was killed by signal n,
  127 if it couldn't start.
- **loom's global flags don't apply to a piece.** `loom --json tasks list` is
  refused, so `--json` must go after the piece name, as the piece's own flag.
- **`loom pieces` lists what's installed**, each name with the path it
  resolves to.
- **Not installed here, with `LOOM_URL` set, the loom there runs it.** In a
  house, `loom tasks ready` with no `loom-tasks` (managed or on `PATH`) sends
  `POST /api/tasks/run {"argv": ["ready"]}` to the loom `LOOM_URL` names, as
  the token in `LOOM_TOKEN_FILE`, and prints the answer's stdout and stderr
  and exits with its exit code (see `run` under [The API](#the-api-a-piece-thats-called-from-elsewhere)).
  A local piece always wins: managed first, then `PATH`, then the remote
  loom. An unreachable loom, or an answer that isn't a 200, exits 1 with
  loom's words; stdin isn't sent.

To install a piece, put an executable named `loom-<name>` on `PATH`. A
package can ship one as an npm `bin`, as a script, or as a binary. Swapping
implementations means installing a different `loom-<name>`.

Or let loom install it: `loom pieces install <name>` from loom's catalog, or
`--from github:<owner>/<repo>#<commit>`. A **managed piece** lives under
`$LOOM_HOME/pieces/<name>/`, its executables are linked into
`$LOOM_HOME/pieces/bin`, and that's searched **before** `PATH`. It runs with
its own environment (`LOOM_PIECE_NAME`, `LOOM_PIECE_HOME`, and the settings it
declares). See [specs/pieces-install.md](specs/pieces-install.md).

### Local pieces

A piece that will never be public (an agent's homelab wrappers, say) can still
be a managed one: `loom pieces install --from path:/abs/dir --yes`, where the
directory holds the same npm package a GitHub piece would (a `bin` with
`loom-<name>`, and an optional `loom` block). loom installs a **snapshot** of
it (`npm pack`), not a link to it, so editing the directory changes nothing
until `loom pieces update <name>` reads it again. Its version is the
snapshot's sha256, so update notices a change, and rollback, remove, settings
and services work as they do for any managed piece. `loom pieces` lists it as
`managed <version> (local)`. It's arbitrary code like any piece from outside
the catalog, so install asks for `--yes`. See
[specs/pieces-install.md](specs/pieces-install.md#local-pieces).

### Old names

A piece that's renamed keeps working under its old name for the callers that
still use it. Core's alias table, `PIECE_ALIASES` in
`src/cli/pieces-managed.ts`, holds one entry today: **`box` is `runtime`**
(loom-box's repo, renamed). The table is applied in one place,
`resolvePieceName` in `src/cli/pieces.ts`, wherever a piece name comes in from
outside:

- `POST /api/box/…` (`/api/box/run` included) reaches the runtime;
- `/p/box/…` and `/a/<agent>/p/box/…` answer a 308 to the runtime's page,
  with the path and query kept;
- a `piece:box/<subject>` credential (a joined box's) acts as
  `piece:runtime/<subject>`, with the subject unchanged, so the own-API, store
  and grants checks see `runtime`;
- a house's remote `loom box …` (`LOOM_URL`) is `/api/box/run`, so it runs on
  the runtime too;
- the first-run starters name `runtime`.

An alias stands aside while a piece with the old name itself is installed: a
managed `box`, or a `loom-box` on `PATH` that isn't one of the runtime's own
bins. A piece can't be installed as `box` while `runtime` is.

**Switching an installed `box`.** `loom pieces update box` (and the page's
Update) doesn't swap it for you. It refuses, says the piece is now `runtime`,
and gives the steps:

```bash
loom pieces remove box        # its settings and data are kept
loom pieces install runtime
loom pieces set runtime LOOM_RUNTIME_…=…   # the settings' names carry the piece's; the old values are in pieces/box/settings.json
```

The swap is left to the owner because the two can't be installed side by side
(both are `role: runtime`, and both ship `loom-box`). The new piece's settings
are named after it, and its store is its own.

## Seams: how pieces compose

Two pieces that are both installed should be able to work together. Neither
should need the other. Take an approval piece that asks a human "may I do X?":
by itself it offers a web page and a notification. If a chat-bridge piece is
also installed, "ask me on chat instead" should be a setting, not new code.

The shape:

- **A piece declares what it offers and what it can use.** For example, an
  approval piece *uses* `ask` (get a yes or no from a person). A chat bridge
  *offers* `ask` and `notify`. The approval piece's own page also offers
  `ask`, and that's its fallback when nothing else is installed.
- **Routing is configuration, and it lives at the piece holding the
  authority.** The approval piece's settings say which channels may ask, and
  which may answer.
- **A piece that offers a seam keeps its own data.** loom-http may host a
  shared UI frame that pieces add pages to. The approval queue still lives in
  the approval piece's store, not loom's.
- **Each pairing gets its own test, on top of each piece's solo suite.**
  "Composes" is checked, not assumed.

The seam vocabulary between pieces (`ask`, `notify`, …) isn't built yet. It
gets defined the first time two real pieces need it. These rules exist so
that day doesn't need a redesign. What a piece offers through **core** is
built: see "Offers" below.

### Offers

A managed piece (specs/pieces-install.md) declares in its package's `loom`
block what it offers through core. These are five sibling keys, each with its
own schema:

| Key | What core does with it | Its schema |
|---|---|---|
| `sections` | runs `sections.project` as a project's section feed | [specs/projects.md](specs/projects.md), "Section feeds (the seam)" |
| `venues` | keeps the piece's venues, and runs each one's `render` and `send` | [specs/conversations.md](specs/conversations.md), "Venues" (`send` from [specs/agent-runtime.md](specs/agent-runtime.md)) |
| `mcp_tools` | adds up to 8 tools to an agent's MCP session | [specs/agent-runtime.md](specs/agent-runtime.md), "Seams this needs from core" |
| `grants` | asks this piece before running a piece call for an agent | [specs/agent-runtime.md](specs/agent-runtime.md), "Permissions" |
| `delivery` | forwards [`POST /api/loom/deliver`](#deliver-anything-addressed-to-an-agent) to this piece | [specs/agent-runtime.md](specs/agent-runtime.md), "Delivery" |

```jsonc
"loom": {
  "role": "runtime",
  "sections":  { "project": { "label": "Houses", "argv": ["loom-runtime", "project-feed", "--json"] } },
  "venues":    { "relay": { "label": "Relay", "kind": "agent", "send": ["loom-runtime", "send"] } },
  "mcp_tools": { "house": { "description": "Ask for a house", "input_schema": { "type": "object" },
                            "argv": ["loom-runtime", "house", "--json"] } },
  "grants":    ["loom-runtime", "grants", "ask"],
  "delivery":  ["loom-runtime", "deliver", "--json"]
}
```

- **One validation path, at install.** Each rule in those specs rejects the
  whole `loom` block, so nothing is installed. Every argv is 1-16 strings of at
  most 200, and its `argv[0]` must be one of the package's own `bin` names. Unknown keys
  are rejected.
- **`mcp_tools`:** each tool's name is `[a-z][a-z0-9_]*` (at most 64), with a
  `description` (at most 1000), an `input_schema` (a JSON schema with
  `"type": "object"`, at most 16 KB) and an `argv` that gets the arguments
  as JSON on stdin. It can't be named after one of core's tools, or anything
  `loom_*`. A session has a piece's tools only while the piece offers them
  (read as the session opens). Core runs one as the session's agent: it asks
  the grants authority first (path `tools/<name>`), then runs the argv plus
  `--agent <agent>` (and `--house <id>`, `--service <name>` for a house's token), with that agent's store grant. It answers
  `{text, isError?}` (text at most 64 KB); a non-zero exit with such an answer
  is that answer, as an error (`src/offered-tools.ts`).
- **`grants`:** an argv; it makes the piece the grants authority (`false`
  offers nothing; `true`, the placeholder before core could ask, is refused).
  Before an agent's call to a piece (`/api/<piece>/…`, `/api/<piece>/run`, an
  offered MCP tool, `tools/<name>`) and before forwarding a delivery for an
  agent, core runs it with `{agent, piece, path}` on stdin (`path` is what
  follows `/api/<piece>/`, or `deliver`). It has 2 s, in a pool of its own
  (eight at once, thirty-two waiting), to answer `{allow: true}` or
  `{allow: false, reason}`. A no is a 403 with that reason, and the piece never
  runs. A timeout, an error, an answer that isn't that, or the authority removed
  while it was asked is a 503 with the reason (fail closed). Owner calls never
  ask. With no authority installed, each piece decides by its own agent list
  (`src/grants.ts`).
- **`delivery`:** an argv. Only a piece whose block says `"role": "runtime"`
  may declare it, and a second installed piece offering it is refused.
- **`venues`, `"wake": {}`:** `wake` is core's own venue. A piece that
  delivers on it (the clock) declares an empty entry for it, which defines
  nothing and only lets it [deliver](#deliver-anything-addressed-to-an-agent)
  there. Any number of pieces may.
- **`venues`:** core keeps a copy of every installed piece's venues in
  `$LOOM_HOME/household.db` (`src/household-store.ts`). Install and update
  replace the piece's rows; removing it (even with `--purge`) keeps them,
  marked orphaned, without `render`, so its conversations still show; reinstalling
  clears the mark. `render` runs with `--conversation <id>` and answers the
  section-feed schema; without one, or once orphaned, core's generic render
  shows the conversation.
- **Against what's installed:** a venue or tool name another installed piece
  declares is refused, and so is a second piece offering `grants` or `delivery`. A piece's
  own update, or a rollback, is checked the same way.
- **One runner.** Core runs an offer's argv, plus that offer's arguments (and
  stdin, where it has one), in the piece's own environment, through the
  manifest's runner: 3 s, the process group killed afterwards, at most 6
  pieces at once. The answer is one JSON value on stdout (64 KB unless an
  offer says otherwise), checked against the offer's output schema. A
  timeout, a non-zero exit, or an answer that isn't valid is an error for that
  piece alone (`src/offers-registry.ts`, `runOffer`). Each kind has its own
  limits (`OFFER_LIMITS`): `delivery` and `mcp_tools` have 120 s and 64 KB,
  and each has a pool of its own, apart from the page's pieces and from each
  other: `mcp_tools` four at once and sixteen waiting, `delivery` eight at
  once and thirty-two waiting (more than one calling piece's share, so one
  piece at its cap leaves room for the rest). `grants` has 2 s. A non-zero exit keeps its
  code and its stdout, so an offer can say why it failed.
- **Only a managed piece offers.** A piece found on `PATH` has no package for
  loom to read, so it is never run as an offer. piece.json keeps a copy of the
  declarations, and core reads them from there (`offersOf`, `piecesOffering`,
  `grantsAuthority`, `deliveryPiece`).

### Sections

A project's hub ([specs/projects.md](specs/projects.md), "The hub") is core's
sections (memories, notes, people, conversations) and then one section per
installed managed piece that declares `sections.project`. The piece keeps its
own data. Core only runs the feed and shows what it answers, keyed
`piece:<name>`, after the core sections, by piece name.

- **The arguments**, in this order: `--project <slug> --since <iso>`, then
  `--epic <id>` when the card has one, `--name <alias>` for each alias,
  `--venue <v>` for each venue and `--repo <r>` for each repo selector, in the
  card's order. `since` is no earlier than
  8 days ago and is passed as UTC, `YYYY-MM-DDTHH:MM:SSZ`.
- **The answer** is `{"groups": [{"title", "waiting", "items": [{"title", "when", "who",
  "person", "status", "ref", "page", "href", "body"}]}]}`: at most 8 groups and 50 items, every
  key known, each string within its cap (projects.md, "Output"). `{"groups": []}`
  is a present, empty section.
- **A failure is that section's alone.** An answer that isn't valid, a non-zero
  exit or a timeout becomes `{key, error}`, and every other section still
  returns.
- **`unfiled: true`** says the feed can also be asked `--unfiled --since <iso>`
  (7 days ago) for items that belong to no project: Home's "Unfiled" list.
- The feeds run through the one runner above, each time a hub is asked for
  (`project_hub`, `loom project hub`), never for the project list, and are
  not cached (`src/project-feeds.ts`).

## The page: how a piece shows up on loom's page

loom-http serves a page at its root (`/`). loom draws the frame (navigation, sign-in,
styles, the guard on every button) and its own pages: **Home** (the tape,
plus what needs you), **Mind** (top of mind and why), one memory, and
**People**. Everything else comes from the pieces that are installed. loom's
code never names a piece. Uninstall one and its tab, its tile on Home and its
items under "Your call" are gone.

A piece takes part by answering up to three commands. Each one is optional.

```bash
loom-<piece> ui --json                # the manifest: tab, Home tile, asks
loom-<piece> ui page --json           # stdin {"path": "...", "query": {...}, "caller": {...}} → one page
loom-<piece> ui act --json            # stdin {"action": "...", "path": "...", "fields": {...}, "caller": {...}} → a result
```

In a household, `caller` says who is looking or acting:
`{"kind": "owner", "who": "jonathan-barket", "agents": "*"}`, the member and
what they own ([specs/owners.md](specs/owners.md)). A piece records `who` as
whoever decided (`by: "jonathan-barket"`), rather than a bare "owner". A piece
that ignores it keeps working. Outside a household there's no `caller`.

### The manifest

```json
{ "v": 2,
  "tab":  { "label": "Tasks" },
  "tile": { "label": "Work", "value": "20 in progress", "detail": "15 ready at p0–p1", "tone": "warn", "page": "" },
  "asks": [ { "text": "Pick how the key gets recovered", "meta": "t-1482 · p3", "page": "task/t-1482", "label": "Decide" } ] }
```

- **`tab`** puts the piece in the navigation. Its pages are served under
  `/p/<piece>/`. Without a tab the piece has no pages. Optional `kind`:
  `"place"` (the default) puts it in Places, beside Knowledge and People;
  `"setting"` puts it under Setup, for what's visited rarely (adding a box, a
  subscription, a secret). A piece that doesn't say gets the catalog's default
  (`kinds` in loom's `assets/pieces.json`), else a place. Optional `level`: `"loom"` (the default) keeps the
  tab on the household's pages. `"agent"` puts it on each agent's own pages,
  where the piece is called with `LOOM_SCOPE` set. A page's section may carry
  the same `level` when it's about one agent within a household page. Optional `icon`: a
  [lucide](https://lucide.dev/icons) icon's name (`"alarm-clock"`, `"key-round"`) for the
  piece's tile and tab; without one, loom's own for its label, else a plain circle.
  Optional `accent`: the piece's one colour, used wherever it's drawn: its tile
  in Places or Setup, its dock tile, its page's header tile, and its page's
  accents (primary buttons, switches, selection). It must be one of loom's palette
  tokens: `"pink"`, `"blue"`, `"yellow"` or `"olive"` (the green). A hex value or
  any other name is refused with the manifest. Each palette and light or dark
  mode has its own shade of each one, and the ink on it stays readable (at least
  8.6:1 on every palette). A piece that names none gets loom's own colour when
  it's one of the catalog's (Boxes blue, Clock olive, Secrets yellow, Tasks olive,
  …: `APP_TINTS` in `web/src/tint.ts`), else a stable colour from its label. The
  colour never comes from the tile's position, so installing a piece doesn't move
  any other piece's colour.
  ```json
  { "tab": { "label": "Garden", "icon": "sprout", "accent": "olive" } }
  ```
- **`agentTab`** (`{ "label": "Clock" }`) puts a tab on each agent's own pages
  too, beside Today, Mind and Setup: served at `/a/<agent>/p/<piece>/<path>`,
  the piece called with `LOOM_SCOPE=<agent>`, its links and actions staying
  under that agent (`/a/<agent>/act/<piece>`). For a piece whose things are
  mostly each agent's with a little of the household's (a clock: each agent's
  schedule, and loom's own lanes). The household's rule (2026-10-28): what's
  shaped like a list of agents belongs to each agent, not the household. A link on such a page can reach the
  piece's own pages elsewhere: `agent:<id>[/<path>]` (this piece's tab on that
  agent's pages) and `household:<path>` (this piece's household pages).
- **Links into loom** are `loom:<page>`: loom's own pages (`loom:inbox`, `loom:conversation/<id>`,
  `loom:people/<slug>`, `loom:knowledge/<slug>`…) and another piece's page,
  `loom:p/<piece>[/<path>]` (a conversation naming the task it closed). Only
  pages: never an action, sign-in or a JSON endpoint, and the piece linked to
  still decides who may see it.
- **`tile`** is one summary on Home: a label, a value, an optional detail line
  and tone, and the page it opens.
- **`owners`** (optional, `2`): the piece understands agent owners
  ([specs/owners.md](specs/owners.md)). It reads the caller's `who` and
  `agents`, shows only those agents' things and refuses what isn't theirs.
  Without it, a member who owns only some agents doesn't see the piece at all:
  no tab, tile, asks or readings, and its API answers them 403. Even with it,
  loom passes such a member only the asks, notices, answered items and readings
  that name one of their agents, and no tile.
- **`scope`** (optional, `true`): the piece narrows to one agent. When the
  owner has an agent selected (the page's scope selector), loom runs every
  `loom-<piece>` call with `LOOM_SCOPE=<agent id>` in its environment. A piece
  that declares `scope: true` should show that agent's data only. One that
  doesn't is shown as it is, under one line saying it shows the whole
  household.
- **`asks`** are things only the owner can decide. They're listed under
  "Your call" on Home (at most 10 a piece). Optional on each: `tone` (tints
  its card), `at` (an ISO date-time, shown as its age), `agent` (an agent's
  id, whose mark it carries) and `actions` (up to two `buttons` items, drawn on
  its card in place of the link: Ratify and Reject, Renew and Later). An ask is a decision, not news:
  what happened belongs on the tape.

  For the Inbox (each optional):
  - `kind` files the ask. `"permission"` means something to allow (an approval, a secret, a box
    asking to join). `"decision"` means a choice. `"reply"` means words, not a button. `"alert"` means
    something is wrong and worth a look, with nothing to choose (a bridge gone dark). `"todo"` means a
    task waiting on the owner. With no `kind`, an ask with `actions` is a decision; one without is an alert.
  - `expires` (an ISO date-time) is when it stops mattering.
  - `attention: false` files the ask without counting it as unread. Use it for a memory proposal
    that nothing waits on. Otherwise an ask needs the owner: it counts on the Inbox and may notify.
  - **Laid out** (Jonathan, 2026-11-05: "explain the whole thing in human friendly text"): `text` is the one plain
    question, read whole; `why` (≤ 300) is one line; `if_yes` and `if_no` (≤ 300 each) say what happens on its primary
    button (Allow, Yes) and on its danger one (Deny), and loom draws each beside its button on Home and in the Inbox;
    `details` (≤ 2,000) is longer text for its sheet; `fine` (≤ 400) is the small print, exactly what the yes allows
    (the machine's kind and target), under "Exactly what this allows". An ask with buttons is never drawn cut.
  - `conversation` (a `cv-` id) is the conversation the ask was made from: a Comms thread shows a permission ask
    inline when its `conversation` is the thread's and its `agent` is the thread's agent ([specs/comms.md](specs/comms.md),
    "Asks inline"). Its first action's `fields.id` names it. The id is the requesting body's claim: loom binds it by
    the agent it authenticated, and draws it only for pieces the viewer may hear from (as the Inbox does).
- **`notices`** (at most 20) are news the owner may want: a box joined, a bridge
  restarted. Each needs `text` and `at`, and may carry `meta`, `agent` and `page`.
  They're filed under FYI and are never unread. Breakage is a state, so a piece
  reports it on the agent (below), not as a stream of notices.
- **`answered`** (at most 20) is the piece's recent history. Each has `text`,
  `outcome` ("Allowed once", "Blocked") and `at`, and may carry `kind`, `agent`
  and `page`. It fills the Inbox's Answered folder.
- **`agents`** (optional) is how each agent is, as this piece sees it, for that
  agent's card on Home. It maps an agent's id to:
  - `state`: `working`, `available`, `unavailable` or `broken`;
  - `reason`: one line;
  - `readings`: up to four `{label, value, detail?, tone?, page?}`;
  - `doing`: up to eight things it has going right now, `{text, kind?, where?, since?, page?}`, `kind` one of
    `talk` (a conversation a body is in), `lane`, `task`, `session` or `other`, `since` when it started (ISO 8601).
    Home's card lists them, simply ("are they up, are they working, what's happening, but that's it"); the
    details are the piece's own page. A reading marked `bad` or `warn` is the card's trouble line; the rest
    stay off the card.

  ```json
  "agents": { "art": { "state": "working", "reason": "house h-52 on one",
                       "readings": [ { "label": "Bridges", "value": "Discord ✓ Slack ✓", "tone": "ok" } ] } }
  ```

  Loom combines the pieces, taking the worst state: broken, then unavailable, then working, then available.
  A piece says nothing about an agent it doesn't know.
- **`add`** (optional): `{ "page": "new", "label": "New task" }`. loom draws it as
  a "+" beside the page's title, linking to that page (one of the piece's, or
  loom's own with `loom:`).
- An answer with only `"sections"` (the first version of this contract) is
  still accepted. Its sections become the piece's page, under a tab named
  after the piece.

### Pages

`ui page --json` reads `{"path": "task/t-1482", "query": {"tag": "pond"}}`
on stdin. `""` is the piece's main page. **A page must not change
anything:** only an action may. (loom refuses to load a page for an embed or
a fetch from another site, but a link can still open one.) It answers:

```json
{ "title": "Work", "intro": "One line under the title.",
  "sections": [
    { "id": "yours", "title": "Your call", "tone": "warn", "blocks": [ ... ] },
    { "id": "facts", "side": true, "blocks": [ ... ] }
  ] }
```

A page may set `"refresh"`: whole seconds from 2 to 300. It then reloads itself
that often, even with a form on it (never while a field in it is in use) and
even while the app's live stream is open. loom doesn't keep a stale copy of
such a page: each reload sees the piece's state as it is. Use it only while
something is changing (an install running, a sign-in being checked), and drop
it once it's settled. A `callout` with `"busy": true` says what's under way,
with a spinner in its icon's place.

A section with `"side": true` goes in the side column. One with `"fold": "open"` or
`"closed"` folds under its title (it needs one), starting that way; the viewer's
last open or close on that page sticks, on that device. `tone` gives the whole
section that tone's look, such as amber for "needs you".

Paths are lowercase letters, digits and `. _ ~ / -`, at most 200 characters,
with no `..` segment. Query keys are lowercase letters, digits, `_` and `-`
(at most 10, and keys starting with `_` are loom's). Values are at most 200
characters. A path the piece doesn't know should answer with
`{"title": "Not found", "sections": []}`.

### Blocks

Every section is a list of blocks. A link inside a block is either `page`
(a page of the same piece, or `loom:<path>` for one of loom's own pages:
Home, `mind`, `people`, `people/<slug>` or `memory/<ref>`; either with an
optional `?key=value` query, such as `?replace=sentry-dsn`) or `href` (an absolute `http(s)` URL that opens
outside the page).

| Block | Fields |
|---|---|
| `stats` | `items`: `label`, `value`, optional `detail`, `tone`, `page`, `spark` (up to 30 numbers, oldest first: a small trend line under the value), `meter` (0 to 1: a bar under the value, like a disk's use). One item alone is the page's hero (its number at the top size) |
| `health` | `tone` (required), `text`, optional `detail`. A status screen's headline: how things are in a word or two ("All good", "One bridge is down"), big, with an icon for its tone (never colour alone). Put it first, tiles (`stats`) under it, and the engineering proof in a `details` |
| `panel` | `rows`, optional `title`, `action` (one `buttons` item: the panel's primary action, at its foot). Settings as an app's panel; see Panels below |
| `list` | optional `numbered` (true: a rank before each row), `wrap` (true: a row's text wraps instead of being cut to a line), `items`: `text`, optional `meta`, `badge`, `tone`, `agent` (an agent's id: the row carries its mark), `avatar` (one or two letters, a person's initials, in a plain circle), `person` (a People slug: that person's avatar, round, in their colour), `page` or `href`, `act` (one button on the row, at its right: a `buttons` item, e.g. a Revoke that asks first) |
| `table` | `columns`, `rows`; a cell is a string or `{text, page}` |
| `kv` | `items`: `label`, `value`, optional `page`. A record, like a task's details |
| `text` | `text`, optional `tone` |
| `prose` | `text`: markdown (CommonMark plus tables), up to 20,000 characters. Any HTML in it is shown as text, never run; links go only to `http(s)`; no images |
| `callout` | `text`, optional `title`, `tone`, `busy` (true: something is under way, drawn with a spinner). A boxed note |
| `profile` | `name`, optional `initials` (one or two letters), `agent` (an agent's id: its mark and colour) or `tone` (`pink`, `yellow`, `olive`, `blue`), `summary`, `badges` (up to 6 words), `stats` (up to 4 `label`/`value`), `links` (up to 4 `text` with `page` or `href`). Someone, as a profile card: a cover in their colour, their avatar, name and summary; when it leads a page, the page's own title gives way to it |
| `link` | `text`, and `page` or `href` |
| `filters` | `param`, `options`: `value`, `label`. Links to this page with `?<param>=<value>`; `""` means all. Optional `search` (its placeholder) adds a search field above the pills that comes back as `?q=` |
| `details` | `summary`, optional `meta`, `blocks`. Folded until clicked; can't contain another `details` |
| `form` | `action`, `submit`, `fields`, optional `title`, `note`, `hidden` (name → value), `submits` (up to 3 more ways to send it, beside `submit`: `label`, optional `fields` (name → value, sent with the form's) and `tone`; a task's Yes and No over a box of words). Words typed in a `textarea` are kept on the device until the form is sent, and the form says "Not sent yet" meanwhile, so leaving the page or pressing another button loses nothing |
| `buttons` | `items`: `action`, `label`, optional `tone` (`primary`, `danger`), `confirm` (what happens, one sentence: a `danger` button asks first in a sheet that says it), `fields` (name → value) |
| `meter` | `items`: `label`, `value` (a number from 0 to 1), optional `detail`, `tone`. A bar with its percent, like a usage window |
| `code` | `text`, optional `label`. Monospace, with a Copy button: a command, a link to hand someone |
| `status` | `items`: `label`, optional `tone` (the dot's color; muted by default), `text`, `meta`, `page`. One row per thing that's up, down or stale |
| `chart` | `kind` (`bar`, `area` or `line`), `series` (1 to 5: `key`, lowercase letters, digits and `_`; `label`; optional `color`: `pink`, `blue`, `olive`, `yellow`, `ink`), `data` (up to 60 points: `label`, and a number or `null` per series key). Optional `variant` (bar: `grouped`, the default, or `stacked`; area: `smooth` or `stacked`; line: `smooth` or `step`), `caption` (what it shows, for a screen reader too), `summary` (`label`, `value`, optional `detail`: the one number it adds up to). 000h's chart: hover or tap a point to read it; a missing value stays missing, never a zero |

#### Panels

A setting is a `panel` row, not a form (Jonathan, 2026-11-03: "app panels, not web forms"). A row says
what the setting is now, in words people use, and holds **at most one** way to change it:

| Row field | |
|---|---|
| `label` | what it is ("When", "Who gets it") |
| `value`, `detail` | what it is now, as a sentence ("5:17 AM, weekdays"), and a quieter line under it. Both wrap; nothing is cut |
| `tone`, `agent` | a status dot (with the words saying the same), an agent's mark |
| `toggle` | `{action, on, fields?}`: a switch that applies at once. It posts `action` with `fields` and `on` set to `"on"` or `""`; if the piece answers `ok: false`, the switch goes back |
| `choice` | `{action, name, value, options (2 to 5: value, label), fields?}`: a segmented control that applies at once, posting `name` = the chosen value |
| `edit` | `{action, fields, title?, submit?, note?, hidden?}`: a tap opens a sheet with these fields (a form: keep it to the one or two that change together) |
| `sheet` | `{title?, blocks}`: a tap opens a sheet of detail: the proof, a log, the raw record. A sheet can't hold a row with another sheet |
| `page` or `href` | a tap goes there |
| `act` | one button at the row's end (a danger one asks first) |

A panel longer than 15 rows is drawn a page at a time, like a list (below): its first 15 rows, then numbered pages,
with its `action` under the pager. Put what needs attention first; a panel that's really a long list of things (a
store's secrets) is better as a summary that links to them, and paging is the floor under it, not the design.

A row with two of these is refused, and so is the page it's on. Raw ids, hashes and JSON never go in a
`label` or `value`: name things the way people do, and put the id in a `sheet` for whoever asks for it.

Fields gain three kinds for sheets and forms: `toggle` (a switch, posted `on` or empty), `segmented`
(2 to 5 `options` side by side, one chosen) and `stepper` (a whole number with − and +; optional `min`,
`max`, `step` and `unit`, such as `"days"`). A `checks` field of up to seven short options (four letters
or fewer, like the days of a week) is drawn as a row of chips.

A row in a `list` runs to two lines; a row that goes nowhere opens to its whole text when tapped, and
`wrap` shows it whole from the start (comments, notes). A row that goes somewhere shows it all there.

A `list` or `table` longer than a page can send one page at a time and say so with
`pages`: `{param, at, count, total?}`, the query key it reads (`"page"`), this
page (from 1), how many pages there are and, optionally, how many rows in all.
loom draws the pager and asks for `?<param>=<n>`, keeping the page's other query
keys (its filters). Without `pages`, loom pages a long list or table itself, 15
rows at a time, over whatever the piece sent.

A list row says who with `agent`, `person` or `avatar`, and `agent: "loom"` is loom's own
mark (its icon) for something loom or the system did. When any row of a list says who,
a row that doesn't is drawn as nobody's yet (a dashed circle), never a gap. A list with
`"who": true` draws that lead on every row even when none says who (a queue of unassigned work).

Tones are `ok`, `warn`, `bad` and `muted`. A form field is
`{name, label, kind, hint?, value?, required?, options?}` with kind
`text`, `textarea`, `choice` (with `options`: `value`, `label`, optional
`detail`), `toggle`, `segmented`, `stepper` (see Panels), `time`, `secret`, `check` (one checkbox: posted as `on`, or empty when it's
not ticked; `value` `on` starts it ticked) or `checks` (any number of its
`options`: posted as the ticked values joined with commas, so an option's
value can't hold one; `value` the same way). A `secret` field never carries a `value` and is drawn
as a masked input that asks the browser and password managers not to save or
fill it. Browsers don't promise to honour that, so a secret typed on the page
may still be offered for saving.

### Actions

A form or a button posts to loom, never to the piece directly. loom checks
the sign-in and an anti-forgery token tied to it, refuses cross-site requests,
and then runs `ui act --json` with
`{"action": "add", "path": "", "fields": {"name": "sentry-dsn", "value": "..."}}`
on stdin. The piece answers:

```json
{ "ok": true, "message": "sentry-dsn is encrypted and stored.", "page": "" }
```

loom shows the message once, labeled with the piece's name, as a toast on
`page` (with its query, if it has one) or on the page the form was on, which
refreshes in place. `ok: false` shows it as an error. A toast fades after a
few seconds; `"keep": true` holds it until it's closed, for a message that
carries something to copy. `"undo": {"action", "label"?, "fields"?}` puts an Undo on the message: it posts that action to the piece, like a button. A `danger` button with a `confirm` sentence asks
first, in a sheet that says it. Field values travel only on stdin. loom
never logs them, stores them, or puts them in a URL, so a secret typed into a
form goes straight to the piece holding the authority. The piece validates
every field itself: loom passes on whatever was posted, up to 50 names (30
fields and 20 hidden values) and 64 KB. More than that is refused, never cut
short.

### Rules for all three

- **Data, never markup.** loom's app (`web/`) draws every block from its data,
  as text, and the only script on the page is loom's own, loaded from loom (the
  app under `/app/`; the CSP allows `script-src 'self'`, never inline). A piece
  can't put HTML or JS on loom's page.
  A manifest that doesn't validate is dropped whole and the piece is listed
  in the footer as "no page"; a page that doesn't validate shows an error in
  its place.
- **Limits:** 10 sections a page, 20 blocks a section, 200 items or rows, 12
  columns, 2000 characters a string. 512 KB per answer. 3 seconds for the
  manifest and a page, 15 for an action. After every run, the piece's whole
  process group is killed, so nothing it started outlives its answer (a piece
  that calls `setsid` on purpose escapes that). At most 6 pieces run at
  once; more wait their turn. The manifest is cached for 45 seconds,
  concurrent page loads share one run, and an action clears its piece's
  cache.
- **A piece is trusted code.** It runs as the daemon's user. loom leaves its
  own bearer tokens out of the piece's environment, but that's hygiene, not a
  boundary: a same-user process can read the daemon's environment, and every
  piece sees the other pieces' variables in it. Install only pieces you'd
  trust with the daemon itself.
- **No configuration on loom's side.** Installing a piece is what makes it
  appear. A piece with no `ui` verb, or one that times out or fails, simply
  isn't there. A managed piece may declare settings, which loom asks the owner
  for and hands to that piece alone (specs/pieces-install.md).
- **loom-http's environment is the piece's environment**, minus loom's own
  bearer tokens. `PATH` decides which pieces exist for the page, and the
  piece's own variables (for example `TASKSTORE_DB`, `SHUTTLE_INSTANCE`) have
  to be in the daemon's environment. A piece can't be named `loom`, because
  that name is loom's own.

## The API: a piece that's called from elsewhere

Some pieces are called by things that aren't a browser: a box calling home
to the runtime piece, a body asking for a house. In a household, loom-http
forwards `POST /api/<piece>/<path>` to the piece:

```bash
echo '{"caller": {...}, "path": "<path>", "body": {...}}' | loom-<piece> api --json
# stdout: {"status": 200, "body": {...}}    (status optional, 200-499)
```

- **loom authenticates, the piece authorizes.** The caller is what the bearer
  resolved to: `{"kind": "owner", "who": "<member>", "agents": "*"}` (the
  household member and what they own, [specs/owners.md](specs/owners.md); a
  piece that only checks `kind` keeps working), `{"kind": "agent", "agent": "art"}`
  (with `"service": "slack"` when it's a service house's token, and
  `"house": "h-104"` when it's a house's: role `agent:art/slack@h-104`. A piece
  can then tell the agent's bridge from its other bodies, or grant one house
  something and none of the agent's others), or
  `{"kind": "piece", "subject": "thor"}` for a **piece credential**, a token
  with the role `piece:<piece>/<subject>` (`loom token create --piece
  box/thor`). A piece credential reaches its own piece's API and nothing
  else, but for two core routes: [`deliver`](#deliver-anything-addressed-to-an-agent),
  and [`people/ensure`](#peopleensure-a-persons-card-when-a-piece-adds-someone) with an owner's grant:
  no MCP, no `/cli`, no page, no other piece. Peer tokens and no token
  get nothing. The piece decides what each caller may do.
- **Strangers, only where a piece says.** A call with no token at all reaches
  a managed piece only on a path its package's `loom` block lists in
  `strangers` (at most 4, fixed when it's installed), as
  `{"kind": "stranger", "address": "<the caller's IP>"}`, with a body of 8 KB at
  most. It's for a box asking to join (the box piece's `join-request` and
  `join-poll`): the piece holds the request until the owner allows it on the
  page. Any other tokenless call is a 401, and a wrong token is never taken for
  a stranger.
- **Like `/cli`:** POST only, `application/json`, no `Origin` header (a browser
  always sends one, and the route grants no CORS), within the daemon's body
  cap. The piece's own status passes through; an answer that isn't
  `{status?, body}`, or a status outside 200-499, is a 502.
- Bounded: 15 seconds and 8 MB per answer (an API answer is data for a program, so it may be bigger than a page), at most four API calls running
  and eight waiting (past that, a 503), in a pool of its own, so a flood from
  a box can never starve the page's pieces. A caller that hangs up while
  waiting gives its place back. The path is `[A-Za-z0-9._~-]` segments, with
  no `.` or `..`.
- A piece without an `api` verb answers nothing, and the caller gets a 502.

### `run`: the piece's CLI, from elsewhere

One path is standard: **`run`**, the piece's own CLI for a caller that isn't
on loom's machine. `loom <piece> …` in a house sends it when the piece isn't
installed there ([above](#how-loom-piece-finds-a-piece)).

```bash
# POST /api/<piece>/run, so the piece gets:
{"caller": {...}, "path": "run", "body": {"argv": ["ready"]}}
# and answers:
{"status": 200, "body": {"exit": 0, "stdout": "...", "stderr": "..."}}
```

- **Request:** `{"argv": [...]}`, the arguments after the piece's name. No
  stdin and no environment travel.
- **Answer:** `{exit, stdout, stderr}`. `exit` is an integer and the
  command's exit code; an answer without one is never read as success. A
  stdout too big to send plain may come as `stdoutGz` instead (gzipped, then
  base64), as the tasks piece's `list` does.
- **A piece answers `run` only for argv it allows,** for each caller: the
  same verbs, flags and exit codes as the local CLI, minus whatever reads or
  writes loom's machine (a file path there, its own `api` and `ui` verbs). A
  refusal is the piece's own 4xx with `{"error": "..."}`, which the caller
  prints. A piece that doesn't want remote use doesn't answer `run`.

### `deliver`: anything addressed to an agent

One core route every piece credential reaches, as its own piece: **`POST
/api/loom/deliver`** ([specs/agent-runtime.md](specs/agent-runtime.md),
"Delivery"). A source (a venue adapter, the clock, the runtime relaying) calls
it with its own token; the runtime's `runtime:<piece>` token reaches it too.
Owner, agent, peer and review tokens get a 403. Core checks the call, then
forwards it to the piece offering [`delivery`](#offers) (the runtime) and
passes its answer back (`src/delivery.ts`).

```bash
# POST /api/loom/deliver
{"id": "1730551200.000100", "agent": "art", "venue": "slack", "place": "dm:U123",
 "label": "Loren (DM)", "from": {"kind": "person", "slug": "loren"},
 "kind": "message", "at": "2026-11-02T12:00:00Z", "text": "..."}
# core runs the delivery argv with {"source": "<calling piece>", ...that body} on stdin
# and answers what the runtime answered:
{"conversation": "cv-3f9a0c12d4e5", "seq": 4, "body": "started"}
```

- **The body:** `id` (the source's own id for the message, at most 200,
  required); `agent`, `venue`, `place` (conversations.md's key); `from`,
  `kind` (`message` or `wake`: a `note` is the agent's own turn, which a
  source doesn't write), `at` (ISO-8601 UTC); `label`
  (optional, at most 80); `text` (1-40,000 characters). Any other key, or a
  field out of bounds, is a 400. The body is 256 KB at most.
- **Who may deliver what,** each refused with a 403 and the reason before
  anything runs, so nothing is written:
  - the calling piece is an installed managed piece;
  - the `venue` is one it declares (`venues`). `wake` is core's, so a piece
    knocks on it only if it declares `"wake": {}`, and only with
    `from: {kind: schedule}`. Nothing is delivered into `session`;
  - the `agent` is the household's and granted to the piece. With no grants
    authority installed, the piece's own agent list decides (the source
    applied it before calling). With one, core asks it (path `deliver`): a no
    is a 403, an authority that can't answer a 503 (fail closed). The
    authority's own deliveries (the runtime's relays) aren't asked of itself;
  - `from: {kind: person}` comes only from a venue adapter on a venue it
    declares (not `relay`); `from: {kind: agent}` only from the runtime, the
    installed piece offering `delivery` (a block's `role` alone isn't it).
    A second `role: runtime` piece is refused at install.
  - core's own delivery (source `loom`: the owner's words from loom's page, the Inbox's Reply and Comms;
    `deliverAsOwner` in `src/delivery.ts`) isn't a piece's. It skips two piece checks above: a declared venue, and
    `from: {kind: person}` only from an adapter. The agent must still be the household's. It comes only from a
    signed-in member's page action. Comms delivers only for a member who owns the agent
    ([specs/comms.md](specs/comms.md)).
- **No delivery piece installed:** a 503 with the reason.
- **Idempotent:** the same calling piece and `id` within 24 hours,
  whichever of the piece's credentials calls (the runtime has two), gets the
  first answer back verbatim, and the runtime isn't called. The same pair with a
  different body is a 409. The answers are kept in `$LOOM_HOME/household.db`
  (`deliveries`, with a SHA-256 of the body, never its text), swept past 24
  hours.
- **Fair:** one piece has at most 2 forwards running and 4 waiting; past
  that, it gets a 503, and other pieces aren't held back. It keeps at most
  10,000 answers in 24 hours; past that, a 429.
- **The runtime's answer** is `{conversation, seq, body, reason?}`, `body`
  one of `fed`, `resumed`, `started`, `queued` or `failed` (which carries a
  `reason`). Its limits are 120 s and 64 KB. A runtime that fails says so by
  exiting 1 with `{"status": 5xx, "error": "..."}` on stdout, and the caller
  gets that status and error. Any other failure, or an answer that isn't the
  contract's, is a 502, a timeout a 504, the delivery pool full a 503. None of them is
  kept, so the source may retry with the same `id`.
- **`GET /api/loom/venues`,** for the runtime's token only: every venue,
  `{"venues": [{name, label, kind, piece, send?, adapter?, orphaned?}]}`. Core's own
  (`session`, `wake`, `loom`) come first, with piece `loom`. `loom` (Comms threads) has `adapter: "core"` in place of
  `send`: the runtime posts to it through `POST /api/loom/comms/adapter` ([specs/comms.md](specs/comms.md)). `send` is the venue's
  declared argv while its piece is installed, so the runtime never reads
  another piece's piece.json.

### `people/ensure`: a person's card, when a piece adds someone

A piece that lets a person in somewhere (an agent's gates, say) makes sure they have a
person card, so loom's People page shows them once however they were added: **`POST
/api/loom/people/ensure`** ([specs/person-cards.md](specs/person-cards.md), "Ensure").
With no card it makes a minimal one; with one, it only adds the `where` values the card
lacks. It never changes a name, summary, `how` or `may`.

```bash
# On loom's machine, in an owner's action (LOOM_STORE_GRANT is in the piece's environment):
echo '{"slug": "grace-aquino", "name": "Grace Aquino", "role": "Toxicologist", "agent": "art",
       "source": "shuttle gates (art'"'"'s people), allowed by the owner 2026-11-02",
       "where": {"slack": {"value": "U08C330F8AG (Onterris)"}}}' | loom person ensure --json
# {"slug": "grace-aquino", "created": true, "added": {"slack": ["U08C330F8AG (Onterris)"]}, "unchanged": false, ...}
```

- **Only in an owner's action.** loom checks the grant it gave the process (signed,
  unexpired, this piece's, an owner's), exactly as `loom store` does. A piece's own
  service, or its process serving an agent, gets exit 5 (a 403 on the route). Elsewhere,
  the piece's credential calls the route with that grant in `X-Loom-Store-Grant`.
- A household owner's token and the runtime's reach the route too; an agent writes its
  cards with `person_write`, and `person ensure` never runs over `POST /cli`.
- A value already on someone else's card is refused (409): one person, one card. The
  piece's own write (its gate) doesn't depend on the card: if the ensure fails, keep the
  write and say why the card wasn't made.

## Storage: a piece's data in loom

A piece keeps its data in **its own store in loom** (docs/specs/piece-storage.md),
not in files beside its code: collections of JSON documents by key, every write a
revision naming its writer, carried in loom's bundle with no verbs from the piece.

It declares its collections in its package, with who may write each:

```json
"loom": { "store": { "gates": { "writers": "owner" }, "convos": { "writers": "piece" }, "inbox": { "writers": "agent" } } }
```

- **`owner`**: only while the piece handles a household owner's page action (or an
  owner's API call). loom hands that one process `LOOM_STORE_GRANT`, signed and good
  for a few minutes.
- **`piece`**: the piece's own code, whoever it's serving.
- **`agent`**: written while serving an agent's call (its grant names the agent), that
  agent's keys only (`<agent>/…`).

Add `"history": false` to a `piece` or `agent` collection to keep no revisions: a
deleted document is gone, overwritten on disk too. It's for data in flight that must
not outlive its use, like a message on its way to a body. An `owner` collection always
keeps its history, since that's how a bad save is undone.

```bash
loom store <piece> get <collection> <key>
loom store <piece> list <collection> [--prefix P] [--limit N]
loom store <piece> put <collection> <key> [--if-rev N]      # the JSON document on stdin
loom store <piece> del <collection> <key> [--if-rev N]
loom store <piece> history <collection> <key>
loom store <piece> revert <collection> <key> <revision-id>
```

`loom store` reads the grant from the environment loom gave the process; the
piece's own services (`LOOM_PIECE_NAME`) write its `piece` and `agent` collections.
Exit codes: 0, 3 not found, 4 a stale `--if-rev`, 5 not allowed. Code running
elsewhere (a service house on another box) uses `POST /api/loom/store/<piece>/<op>`
with the piece's credential (`piece:<piece>/<subject>`), as the piece. 256 KB a
document, 64 MB a piece. Only a managed piece has a store.

## The bundle: a piece's part

`loom export` asks each installed piece for its part, and `loom restore`
hands it back (docs/specs/household.md, "Export and restore"). Both verbs are
optional, and they sit under `bundle` so they can't collide with a piece's
own `export`/`import` commands. A piece without them is listed in the bundle
as not included.

```bash
LOOM_EXPORT_RECIPIENTS=age1…,age1… loom-<piece> bundle export   > part   # stdout: the part, encrypted by the piece
LOOM_IMPORT_IDENTITY=/path/owner.key loom-<piece> bundle import < part   # stdin: the same bytes
```

- **The piece encrypts its own part** to the recipients it's given. loom
  never decrypts it, so a piece holding authority (secrets) keeps it.
- **On import, the piece re-keys for this machine.** It decrypts with the
  owner's identity and stores the result under its own local key, because
  the machine the bundle came from (and its keys) may be gone.
- **Import refuses to overwrite** an existing store unless asked to: a
  restore goes into a fresh place.
- 120 seconds and 256 MB per part.

## Pieces today

| Role | `loom <piece>` | Implementation | Contract |
|---|---|---|---|
| tasks | `loom tasks` | [taskstore](https://github.com/sleepunit-agents/taskstore) | `spec/taskstore-core` |
| secrets | `loom secrets` | [loom-secrets](https://github.com/sleepunit-agents/loom-secrets) (sops + age) | `ac-sec-*` in its README |
| shuttle | `loom shuttle` | [shuttle](https://github.com/sleepunit-agents/shuttle) (`tools/loom-shuttle`) | its README; today it's the Bridges page only |
| runtime | `loom box` | [loom-box](https://github.com/sleepunit-agents/loom-box) (boxes and houses) | [specs/runtime.md](specs/runtime.md) and its README; the first piece on the piece API |

Roles under consideration: `wake` (a clock that starts the agent) and an
approval page. Each one gets its contract when it gets built.
