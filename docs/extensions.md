# Pieces: extending loom without growing it

loom is identity, memory and knowledge for one agent. It keeps that job small
on purpose. Everything else an agent leans on (a task store, secrets, a clock
that wakes it, a chat bridge, an approval page) is a **piece**: a separate
program that works with loom without becoming part of it.

```
core       loom: identity, memory, knowledge, person cards. Nothing else.
piece      a swappable extension: its own program, its own store, reached as `loom <piece>`.
instance   glue for one agent: its routines, hooks, which pieces it installs and how they're set up.
```

The test for which tier something belongs in: **does it manage the agent's
continuity, identity or knowledge?** If yes, it's core. If it's authority
(secrets, permissions), scheduling, transport, or work tracking, it's a piece
that sits on top. A shared command namespace doesn't make a piece part of
loom.

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

To install a piece, put an executable named `loom-<name>` on `PATH`. A
package can ship one as an npm `bin`, as a script, or as a binary. Swapping
implementations means installing a different `loom-<name>`.

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

The seam vocabulary (`ask`, `notify`, …) and how pieces register offers isn't
built yet. It gets defined the first time two real pieces need it. These
rules exist so that day doesn't need a redesign.

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
loom-<piece> ui page --json           # stdin {"path": "...", "query": {...}} → one page
loom-<piece> ui act --json            # stdin {"action": "...", "path": "...", "fields": {...}} → a result
```

### The manifest

```json
{ "v": 2,
  "tab":  { "label": "Tasks" },
  "tile": { "label": "Work", "value": "20 in progress", "detail": "15 ready at p0–p1", "tone": "warn", "page": "" },
  "asks": [ { "text": "Pick how the key gets recovered", "meta": "t-1482 · p3", "page": "task/t-1482", "label": "Decide" } ] }
```

- **`tab`** puts the piece in the navigation. Its pages are served under
  `/p/<piece>/`. Without a tab the piece has no pages.
- **`tile`** is one summary on Home: a label, a value, an optional detail line
  and tone, and the page it opens.
- **`asks`** are things only the owner can decide. They're listed under
  "Your call" on Home (at most 10 a piece). An ask is a decision, not news:
  what happened belongs on the tape.
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

A section with `"side": true` goes in the side column. `tone` gives the whole
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
| `stats` | `items`: `label`, `value`, optional `detail`, `tone`, `page` |
| `list` | `items`: `text`, optional `meta`, `badge`, `tone`, `page` or `href` |
| `table` | `columns`, `rows`; a cell is a string or `{text, page}` |
| `kv` | `items`: `label`, `value`, optional `page`. A record, like a task's details |
| `text` | `text`, optional `tone` |
| `callout` | `text`, optional `title`, `tone`. A boxed note |
| `link` | `text`, and `page` or `href` |
| `filters` | `param`, `options`: `value`, `label`. Links to this page with `?<param>=<value>`; `""` means all |
| `details` | `summary`, optional `meta`, `blocks`. Folded until clicked; can't contain another `details` |
| `form` | `action`, `submit`, `fields`, optional `title`, `note`, `hidden` (name → value) |
| `buttons` | `items`: `action`, `label`, optional `tone` (`primary`, `danger`), `fields` (name → value) |

Tones are `ok`, `warn`, `bad` and `muted`. A form field is
`{name, label, kind, hint?, value?, required?, options?}` with kind
`text`, `textarea`, `choice` (with `options`: `value`, `label`, optional
`detail`) or `secret`. A `secret` field never carries a `value` and is drawn
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

loom shows the message once, labeled with the piece's name, at the top of
`page` (with its query, if it has one) or of the page the form was on.
`ok: false` shows it as an error. Field values travel only on stdin. loom
never logs them, stores them, or puts them in a URL, so a secret typed into a
form goes straight to the piece holding the authority. The piece validates
every field itself: loom passes on whatever was posted, up to 50 names (30
fields and 20 hidden values) and 64 KB. More than that is refused, never cut
short.

### Rules for all three

- **Data, never markup.** loom renders every block and escapes every string,
  and the page runs no script. A piece can't put HTML or JS on loom's page.
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
- **No configuration.** Installing a piece is what makes it appear. A piece
  with no `ui` verb, or one that times out or fails, simply isn't there.
- **loom-http's environment is the piece's environment**, minus loom's own
  bearer tokens. `PATH` decides which pieces exist for the page, and the
  piece's own variables (for example `TASKSTORE_DB`, `SHUTTLE_INSTANCE`) have
  to be in the daemon's environment. A piece can't be named `loom`, because
  that name is loom's own.

## Pieces today

| Role | `loom <piece>` | Implementation | Contract |
|---|---|---|---|
| tasks | `loom tasks` | [taskstore](https://github.com/sleepunit-agents/taskstore) | `spec/taskstore-core` |
| secrets | `loom secrets` | [loom-secrets](https://github.com/sleepunit-agents/loom-secrets) (sops + age) | `ac-sec-*` in its README |
| shuttle | `loom shuttle` | [shuttle](https://github.com/sleepunit-agents/shuttle) (`tools/loom-shuttle`) | its README; today it's the Bridges page only |

Roles under consideration: `wake` (a clock that starts the agent) and an
approval page. Each one gets its contract when it gets built.
