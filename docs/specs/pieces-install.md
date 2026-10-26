# Installing pieces from loom

**Status:** draft, 2026-10-25. Builds on [extensions.md](../extensions.md),
which says what a piece *is*. This says how one gets onto a machine, gets set
up, keeps running and gets replaced, without anyone editing loom's
environment by hand.

The goal: a new owner installs loom, signs in, makes their agent, opens
**Pieces**, and clicks *Install* next to Tasks. A minute later Tasks has a tab.
Updating, rolling back and removing are clicks too. A piece from somewhere else
is a GitHub repo and a commit, with a clear warning.

## Terms

| Term | Means |
|---|---|
| **catalog** | The pieces loom knows about. First-party pieces ship in loom's own `pieces.json`, each pinned to a commit. |
| **managed piece** | A piece loom installed. It lives under `$LOOM_HOME/pieces/<name>/`. A piece found on `PATH` is **unmanaged**: it still works, and loom doesn't touch it. |
| **piece home** | `$LOOM_HOME/pieces/<name>/`: the piece's versions, its settings and its data. |
| **setting** | A value the piece needs (`TASKSTORE_OWNER`), declared by the piece and asked for on the page. |
| **service** | A long-running process the piece needs (`loom-box run --local`), declared by the piece and supervised for it. |

## What a piece package is

An npm package, installed from a git commit:

```
npm install --prefix <dir> github:<owner>/<repo>#<40-char commit>
```

No registry and no npm account are needed. The repo must be public, because
the install has no credentials (in the first catalog, shuttle is private:
it would have to be made public first). The commit is the pin: git checks
the content against it, so the same commit always installs the same code.
npm already handles dependencies, a build step (`prepare`), and linking
executables (`bin`), for any language a `bin` can start (Node, Python with a
shebang, a shell script).

The package's `package.json` must have:

- **`bin`** with `loom-<name>`. It may list more (`taskstore`), and all of
  them are linked.
- **`loom`**: what loom needs to know about it, with every field optional.

```json
"loom": {
  "role": "tasks",
  "label": "Tasks",
  "description": "A work store: tasks, links, the ready queue.",
  "settings": [
    { "name": "TASKSTORE_DB", "label": "Store file", "default": "${LOOM_PIECE_HOME}/data/store.db" },
    { "name": "TASKSTORE_OWNER", "label": "Whose call a task is", "hint": "a person's slug", "required": true }
  ],
  "services": [
    { "name": "run", "argv": ["loom-box", "run", "--local"] }
  ]
}
```

A setting's `name` is the environment variable it becomes (uppercase letters,
digits and `_`; never `LOOM_*`, `PATH` or `HOME`). `kind` is `text` (the
default) or `choice` (with `options`). **There's no secret kind.** A piece that
needs a secret asks for it on its own page and keeps it itself, as the
authority rule says. A setting's value never holds one.

## The catalog

`pieces.json` ships inside loom:

```json
{ "v": 1, "pieces": [
  { "name": "tasks", "repo": "sleepunit-agents/taskstore", "commit": "<sha>", "version": "0.4.0",
    "label": "Tasks", "description": "…" } ] }
```

A loom release can move a piece to a newer commit. An installed piece whose
commit isn't the catalog's shows **Update**. Nothing updates by itself.

## The piece home

```
$LOOM_HOME/pieces/
  bin/loom-tasks -> ../tasks/current/node_modules/.bin/loom-tasks   (and every other bin)
  tasks/
    piece.json        what's installed: source, commit, version, when, the previous commit
    settings.json     the owner's values, 0600
    versions/<sha>/   one npm prefix per installed commit (the current one and the one before)
    current -> versions/<sha>
    data/             the piece's own store, if it uses LOOM_PIECE_HOME
    install.log       the last install's output
```

## Finding a piece

`$LOOM_HOME/pieces/bin` is searched before `PATH`, so a managed piece wins over
an unmanaged one with the same name. `loom pieces` says which is which.
Everything else in extensions.md ("How `loom <piece>` finds a piece") stays the
same.

## A piece's environment

When loom runs a managed piece (from the CLI, for the page, or for the API), it
adds:

- `LOOM_PIECE_NAME` and `LOOM_PIECE_HOME`;
- each setting from `settings.json`, or its `default` if the owner didn't set
  one, with `${LOOM_PIECE_HOME}` expanded.

Those values go to **that piece only**. Today every variable has to be in the
daemon's environment, where every piece can see it. A variable the daemon
already has, such as one in `loom-http.env`, still reaches the piece, and a
setting overrides it. The rest of the environment rules in extensions.md stay
the same.

## Services

Each declared service becomes a systemd user unit,
`loom-piece-<name>-<service>.service`. It runs the argv with the piece's
environment, restarts on failure, and is enabled and started on install,
restarted on update and rollback, and stopped and removed on remove. Its output
goes to the journal. In the first version this is Linux and systemd only. On
another system, install says the service has to be started by hand, and how.

## Install, update, rollback, remove

```
loom pieces install <name>                         from the catalog
loom pieces install --from github:<owner>/<repo>#<commit> [--yes]
loom pieces update <name>                          to the catalog's commit
loom pieces rollback <name>                        to the previous commit
loom pieces remove <name> [--purge]                --purge also deletes data/ and settings.json
loom pieces set <name> NAME=value…                 settings
loom pieces [--json]                               installed, managed or not, and what can be updated
loom pieces catalog [--json]
```

Install, in order:

1. Resolve the source to `owner/repo` and a full 40-character commit.
   Anything else is refused: no branches, tags or short commits, because those
   can move.
2. `npm install --prefix versions/<commit> github:<owner>/<repo>#<commit>` into
   a temporary directory, renamed into place only once it succeeds.
3. Read the installed `package.json`: it must have `bin` with `loom-<name>`, and
   a `loom` block that validates.
4. Point `current` at it, relink `bin/`, and write `piece.json`.
5. Write and start the services.
6. If a required setting has no value, the piece shows on the Pieces page as
   needing setup, and it's listed under "Your call".

A failed install leaves the previous version current and untouched.
**Rollback** points `current` back at the previous commit (kept on disk) and
restarts the services. An update keeps two versions; an older one is deleted
once the new one is current.

## The Pieces page

The Pieces page is one of loom's own pages, like People, and the owner's only.

- **Installed:** each piece with its version, managed or not, and whether it's
  OK, needs setup, or has an update. Managed pieces have *Update*, *Roll back*,
  *Remove* and a settings form, drawn from the piece's declared settings.
- **Available:** catalog pieces that aren't installed, each with *Install*.
- **From GitHub:** a form taking a repo and a commit. Its answer is a preview
  (what the package says it is, its settings, its services) plus the warning
  below and a *Install anyway* button.

An install takes longer than an action may (15 seconds), so the action starts
it in the background and returns. The page then shows *Installing…* until it's
done, from `piece.json` and `install.log`.

## Trust

A managed piece is still trusted code. It runs as the daemon's user, and
`npm install` runs its build scripts at install time, so installing a piece is
running it. For the catalog that's the same trust as installing loom itself.
For **From GitHub** the page says so in plain words, and only the owner can do
it. Running a third-party piece in a house (loom-box) instead of on the
machine is the follow-up, and it's what makes that click less of a leap. It
isn't in this version.

## What changes in extensions.md

- "**No configuration.**" becomes: installing a piece is still what makes it
  appear, and a piece may declare settings, which loom asks the owner for (see
  this spec).
- "Finding a piece" gains `$LOOM_HOME/pieces/bin` ahead of `PATH`.

## Not in this version

- A registry, or updates that happen by themselves.
- Services on macOS or Windows.
- Third-party pieces in a house.
- Seams (`ask`, `notify`): they're still defined the first time two pieces
  need them.

## Order of work

1. **loom:** the piece home, `loom pieces install/update/rollback/remove/set`,
   managed pieces found first, each piece's own environment.
2. **taskstore** as the pilot: `bin` (`loom-tasks`, `taskstore`), `prepare`,
   and a `loom` block. Then on a fresh `LOOM_HOME`, `loom pieces install tasks`
   gives a working Tasks tab.
3. **loom:** the Pieces page and its background install.
4. **loom:** services. **loom-box** is the pilot.
5. **loom-secrets**, then **shuttle**, the hardest: it has bridges, secrets and
   its instance file.
