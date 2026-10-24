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

## UI sections: how a piece shows up on loom's page

loom-http serves a page at `/ui`. It has loom's own sections (top of mind,
the last 24h of episodes, proposals waiting, people), followed by a group for
each installed piece that has something to show. A piece takes part by
answering one command:

```bash
loom-<piece> ui --json
```

```json
{ "sections": [
  { "id": "bridges", "title": "Bridges", "blocks": [
    { "type": "stats", "items": [ { "label": "chat", "value": "1/5 bodies", "tone": "ok" } ] },
    { "type": "list",  "items": [ { "text": "#general: Pat", "meta": "chat · active 2m", "tone": "warn" } ] }
  ] }
] }
```

- **Blocks:** `stats` (label, value), `list` (text, meta),
  `table` (columns, rows), `text`, and `link` (text, href, which must be
  `http(s)`). Tones are `ok`, `warn`, `bad` and `muted`.
- **Data, never markup.** loom renders every block and escapes every string,
  and the page carries no script. A piece can't put HTML or JS on loom's page.
  An answer that doesn't validate is dropped whole.
- **Limits:** 10 sections, 20 blocks a section, 200 items or rows, 12
  columns, 2000 characters a string. 3 seconds and 512 KB per answer.
  Answers are cached for 30 seconds.
- **No configuration.** Installing a piece is what makes it appear. A
  piece with no `ui` verb (or one that times out or fails) simply isn't on the
  page, and the footer lists it as "no page". The page is read-only. Actions,
  such as an approval button, come with the first piece that needs them.
- **loom-http's environment is the piece's environment.** `PATH` decides which
  pieces exist for the page, and the piece's own variables (for example
  `TASKSTORE_DB`, `SHUTTLE_INSTANCE`) have to be in the daemon's environment.

## Pieces today

| Role | `loom <piece>` | Implementation | Contract |
|---|---|---|---|
| tasks | `loom tasks` | [taskstore](https://github.com/sleepunit-agents/taskstore) | `spec/taskstore-core` |
| secrets | `loom secrets` | [loom-secrets](https://github.com/sleepunit-agents/loom-secrets) (sops + age) | `ac-sec-*` in its README |
| shuttle | `loom shuttle` | [shuttle](https://github.com/sleepunit-agents/shuttle) (`tools/loom-shuttle`) | its README; today it's a UI section only |

Roles under consideration: `wake` (a clock that starts the agent) and an
approval page. Each one gets its contract when it gets built.
