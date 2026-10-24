# loom stack — v2 specification

> **Status: current** (`CURRENT_STACK_VERSION = 2`).
> The previous spec is archived at `docs/archive/loom-stack-v1.md`.
> v1 stacks load forward-compatibly; see §8 for migration notes.

*What a loom stack is, what it contains, and what every adapter must
honor. Verified against `src/` at time of writing; trust the source
over this document if they diverge.*

---

## 1. Overview

A **loom stack** is the durable part of an agent — the identity,
memory, and behavioral context that survives when the body (harness ×
model) changes. Every concrete decision in this spec flows from three
invariants:

1. **Identity is operational; voice is substrate.** The stack carries
   who the agent is. The sleeve provides how the agent sounds. Nothing
   in the stack should encode voice-specific behavior.
2. **Portable by default.** Pure markdown files plus a single SQLite
   file. No binary identity blobs, no proprietary formats. A stack is
   readable with `less` if loom disappears tomorrow.
3. **No secrets.** Ever. Tokens, passwords, and API keys are sleeve
   state, not stack state.

### What changed from v1

Two structural simplifications:

- **`pursuits.md` removed.** Active cross-session goals are now stored
  as `pursuit`-category memories in `memories.db`. There is no
  top-level markdown file for pursuits.
- **`procedures/` removed.** Behavioral discipline that was in
  `procedures/*.md` is now carried by skills in the harness layer, not
  the stack. Agents that had a `procedures/` directory under v1 retain
  it as an ignored directory; loom does not load it.

Everything else — block layout, memory schema, MCP surface, CLI
surface — carries over from v1 with additions.

---

## 2. Stack model

### 2.1 Directory layout

```
~/.config/loom/<agent>/
├── LOOM_STACK_VERSION    # integer schema version stamp (currently "2")
├── IDENTITY.md           # terminal creed — immutable within a session
├── preferences.md        # agent's model of the user
├── self-model.md         # agent's model of itself
├── memories.db           # sqlite-vec episodic + reference store
├── projects/             # per-project briefs (loaded on demand)
│   └── <project>.md
├── harnesses/            # per-harness manifests
│   └── <harness>.md
└── models/               # per-model manifests
    └── <model>.md
```

The context directory resolves in this order (source: `src/config.ts::resolveContextDir`):

1. `LOOM_CONTEXT_DIR` environment variable — full path to the agent directory.
2. `--context-dir` CLI argument — same semantics.
3. Fallback: `~/.config/loom/default` — the literal agent dir `default/`, not the parent.

There is no `$LOOM_CONTEXT_ROOT`. The parent `~/.config/loom/` is implicit, not configurable as a variable.

Agent names must match `/^[a-z0-9][a-z0-9-]*$/` (1–64 chars); reserved names (`current`,
`default`, `config`, `backups`, `cache`, `tmp`, `shared`) are enforced
by `src/install/names.ts`.

The fastembed model cache is overridable via `LOOM_FASTEMBED_CACHE_DIR`; if unset, the
fastembed library chooses its own default location. There is no fixed loom-managed cache path.

### 2.2 Block kinds

Every file in the stack is markdown. Frontmatter is optional for prose
blocks and required for manifests.

#### `IDENTITY.md` — terminal creed

Immutable within a session. First-person, prose, no frontmatter.
Answers: *who am I, who do I serve, what is my posture*. Does not
answer: *what tools do I have right now* (harness), *what am I
working on* (memories), *what did I learn last Tuesday* (memories).
Target size ≤ 4 KB. Voice-neutral — should make sense in any capable
model's voice.

#### `preferences.md` — user model

Second-person about the user. Working style, communication
preferences, decision philosophy, technical stack, project scope,
time zone, handoff protocols. Updated when the user corrects the
agent or expresses a strong preference.

#### `self-model.md` — agent self-model

First-person about the agent. Strengths, learnings, current focus.
Descriptive, not prescriptive. Honest, not aspirational. Updated via
`update_identity` (MCP) or `loom update-identity` (CLI).

#### `harnesses/<name>.md` — harness manifest

One file per harness. Required frontmatter:

```markdown
---
harness: claude-code
version: 0.4
---

## Tool prefixes
## Delegation primitive
## Cron / scheduling
## Session search
## Gotchas
```

If no manifest exists for the current harness, create one with
`harness_init` (MCP) or `loom harness init` (CLI) before other work —
or let the runtime author its own via `harness_describe` (see below).

**Optional frontmatter — `answersTo`.** A comma-separated list of MCP
`clientInfo.name` values this manifest answers to. Peer→harness
resolution is data-driven from the files on disk: a connecting peer
matches a manifest when its normalized name equals the filename *or* one
of the `answersTo` aliases. A new harness is recognized by dropping a
file — no code change. (Example: Claude Desktop connects as `claude-ai`;
`answersTo: claude-ai` on `claude-desktop.md` routes it correctly.)

**Self-describe.** `harness_describe` (MCP) lets the *connected*
runtime write its own manifest, scoped to the peer's `clientInfo.name` —
a harness can only describe itself, never another harness or the creed.
When `identity()` is loaded for a runtime with no manifest, the harness
block is a self-describe onboarding prompt rather than a blank stub.

#### `models/<name>.md` — model manifest

One file per model family. Required frontmatter:

```markdown
---
model: <model-id>
family: <family>
size: <hint>
---

## Capability notes
## Workarounds
## When to use
## When not to use
```

#### `projects/<name>.md` — project brief

Loaded on demand when `identity(project=<name>)` is called. Agent-facing
context about a specific codebase or domain — what you need to know to
be useful there. Not a replacement for the repo's README.

### 2.3 Wake sequence

When a runtime loads a stack, the canonical order is:

1. **Identity eagerly.** `IDENTITY.md`, `preferences.md`, `self-model.md`.
   Always loaded. Target ≤ 4 K tokens combined.
2. **Project brief if scoped.** Load `projects/<name>.md` when the
   runtime knows the project.
3. **Harness manifest.** `harnesses/<harness>.md` for the current
   sleeve. Missing → recommend calling `harness_init` before deep work;
   not enforced.
4. **Model manifest.** `models/<model>.md` for the current sleeve.
   Missing → write one during the session via plain file edit. There is
   no tool for this; `harness_init` only handles harness manifests.
5. **Boot digest.** The identity payload injects a `# Top of Mind`
   block — a salience-tiered (Hot / Warm / Cool) view of episodic
   memory, assembled hottest-first to a token budget from existing
   authored memories. Never generated prose; a pure selection over
   authored atoms. Omitted when the store is empty or unmigrated.
6. **Memories lazily.** Do not eagerly load the memory store beyond the
   digest. The agent calls `recall` on demand.

The wake sequence is an adapter-level concern. Every adapter implements
this ordering.

---

## 3. Memory model

### 3.1 Categories

The `remember` tool accepts exactly these six categories
(enforced at the MCP layer as an enum):

| Category    | Stores                                                     |
|-------------|-------------------------------------------------------------|
| `user`      | Facts about the human — preferences, role, working style   |
| `project`   | Facts about a codebase, initiative, or piece of work        |
| `self`      | Agent capabilities, learnings, self-corrections             |
| `feedback`  | Corrections and confirmations from the user                 |
| `reference` | Pointers to external systems (Slack channels, dashboards)   |
| `pursuit`   | Active cross-session goals and creative threads             |

### 3.2 Memory lifecycle

**Write.** Call `remember` with a category, title, and content. An
optional `ttl` controls expiration (`"7d"`, `"30d"`, `"permanent"`,
or omit for no expiration). Returns a stable `ref` (`category/slug`)
for subsequent lookups.

**Recall.** `recall` runs a semantic search against the store. Results
are ranked by cosine similarity. Optional `category` and `project`
filters narrow the search. `memory_list` provides non-semantic
enumeration.

**Update.** `update` replaces content or metadata on an existing
memory. Find by `ref` or by `category` + `title`.

**Forget.** `forget` deletes by `ref`, by `category` + `title`, or
in bulk by `project` or by `title_pattern` (glob, requires a scope
guard).

**Prune.** `memory_prune` deletes memories whose TTL has elapsed and
reports those untouched beyond a stale threshold (default 30 days).

**Salience.** Each memory carries a stored salience temperature in
`(0, 1]` that decays by a per-category half-life (pursuit 7d, project
10d, self/feedback 30d, reference 45d, user 90d; default 30d) and
reheats on touch (recall / write / update). The boot digest
(`loom memory digest`) computes each memory's heat from its timestamps
when it is read, so a missed consolidation run can't freeze it. The
consolidation lane still refreshes the stored value
(`loom memory recompute-salience`) for anything that sorts in SQL.

**Propose / ratify.** The capture-propose queue stages *draft* memory
writes in a separate `proposals` table — invisible to recall,
`memory_list`, `find_similar`, and the digest. A draft becomes canon
only via `memory_ratify`, which commits through the validated `remember`
path (an invalid draft is refused and stays pending); `memory_reject`
discards one. Never auto-committed.

### 3.3 Storage layout

`memories.db` is a sqlite-vec database with two tables:

```sql
memories (
  id            INTEGER PRIMARY KEY,
  uuid          TEXT UNIQUE NOT NULL,    -- stable across migrations
  ref           TEXT UNIQUE NOT NULL,    -- "category/slug"
  title         TEXT NOT NULL,
  category      TEXT NOT NULL,
  project       TEXT,                    -- nullable project scope
  content       TEXT NOT NULL,           -- markdown body
  metadata      TEXT NOT NULL,           -- JSON blob
  created       TEXT NOT NULL,           -- ISO 8601
  updated       TEXT,
  last_accessed TEXT,                    -- updated on recall hit
  ttl           TEXT,                    -- e.g. "7d", "permanent"
  expires_at    TEXT,                    -- computed from created + ttl
  salience      REAL                     -- stored temperature (0,1]; lane-recomputed
)

vec_memories (                           -- sqlite-vec virtual table
  rowid  INTEGER,                        -- = memories.id (invariant)
  embedding BLOB                         -- fast-bge-small-en-v1.5, 384-dim, cosine
)
```

**Embedding invariant:** `vec_memories.rowid = memories.id` always.
Every insert/update touches both tables; every delete cascades.

**Embedding model commitment.** Changing embedding models requires
re-embedding the entire store. v2 ships `fast-bge-small-en-v1.5` (384-dim).
A migrated store must be tracked; mixing embeddings across models
silently breaks recall.

---

## 4. MCP tool surface

The server registers exactly 31 tools. All names use underscores
(MCP convention). When loaded via Claude Code the prefix is
`mcp__loom__`.

### Identity

| Tool              | Purpose                                                           |
|-------------------|-------------------------------------------------------------------|
| `identity`        | Load the full wake payload (creed, preferences, self-model, manifests). Call first. |
| `update_identity` | Update a section of `self-model.md` or `preferences.md` by H2 header. `IDENTITY.md` is immutable. |

### Recall / write

| Tool         | Purpose                                                               |
|--------------|-----------------------------------------------------------------------|
| `remember`   | Store an episodic memory with category, title, content, optional TTL. |
| `recall`     | Semantic search against the memory store.                             |
| `update`     | Replace content or metadata on an existing memory.                    |
| `forget`     | Remove memories — single by ref/title, bulk by project or pattern.   |

### Maintenance

| Tool            | Purpose                                                             |
|-----------------|---------------------------------------------------------------------|
| `memory_prune`  | Delete expired memories; report stale ones. Supports `dry_run`.    |
| `memory_list`   | Browse memories without semantic search. Category/project filters. |
| `find_similar`  | Surface semantically near memories. Anchor by `ref` or free text.  |
| `memory_audit`  | Read-only health report: counts, stale, duplicates, expired.        |

### Bootstrap

| Tool           | Purpose                                                              |
|----------------|----------------------------------------------------------------------|
| `bootstrap`    | Initialize a new identity (IDENTITY.md, preferences.md, self-model.md) from an onboarding interview, and emits runtime setup instructions per the `clients` arg. |
| `harness_init` | Scaffold a harness manifest from the standard template.              |

---

## 5. CLI surface

`loom` is a Node.js CLI that exposes the same functionality as the MCP
layer plus operational tooling.

### Top-level subcommands

| Subcommand        | Purpose                                                          |
|-------------------|------------------------------------------------------------------|
| `wake`            | Print the full wake output to stdout (same payload as `identity` MCP tool). |
| `recall`          | Semantic search, text output.                                    |
| `remember`        | Store a memory from stdin or flags.                              |
| `forget`          | Remove memories.                                                 |
| `update`          | Update an existing memory.                                       |
| `update-identity` | Update a section of `self-model.md` or `preferences.md`.        |
| `memory`          | Memory maintenance (see sub-subcommands below).                  |
| `harness`         | Harness manifest lifecycle.                                      |
| `bootstrap`       | Initialize a new identity from an onboarding interview.          |
| `serve`           | Start the MCP server. Default is stdio; `--http [--host --port]` runs the mesh-reachable HTTP daemon (bind-safety enforced; optional `LOOM_BEARER_TOKEN`). |
| `inject`          | Write the loom-managed block into harness dotfiles (e.g. CLAUDE.md). |
| `install`         | First-time installation and setup.                               |
| `doctor`          | Diagnose stack health; report version, missing files, git state. |

### `loom memory` sub-subcommands

| Subcommand | Purpose                                              |
|------------|------------------------------------------------------|
| `list`     | Browse memories; table or `--json`.                  |
| `prune`    | Report / remove expired and stale memories.          |
| `similar`  | Surface semantically near memories by ref or text.   |
| `audit`    | One-shot health report (counts, stale, dupes, expired). |
| `archive` / `restore` | Soft-retire a memory with a tombstone, or return it. |
| `recompute-salience` | Recompute and store each memory's salience (consolidation lane). |
| `digest`   | Preview the assembled boot digest.                   |
| `propose` / `proposals` / `ratify` / `reject` | The capture-propose queue: stage, list, ratify, or discard draft writes. |

### `loom harness` sub-subcommands

| Subcommand | Purpose                                                |
|------------|--------------------------------------------------------|
| `init`     | Write a manifest template for a named harness. Idempotent; `--force` overwrites. |

All subcommands accept `--context-dir` to override the stack root and
`--json` where applicable. Run `loom <subcommand> --help` for flags.

---

## 6. Storage layout summary

Everything required to resurrect an agent lives under its canonical
directory. The fastembed cache is explicitly excluded.

```
~/.config/loom/<agent>/
├── LOOM_STACK_VERSION    # "2\n" — version gate; loom refuses stacks with higher version
├── IDENTITY.md
├── preferences.md
├── self-model.md
├── memories.db           # sqlite-vec; WAL mode; do not commit to git
├── memories.db-wal       # WAL write-ahead log; do not commit
├── memories.db-shm       # WAL shared memory; do not commit
├── projects/
│   └── <project>.md
├── harnesses/
│   └── <harness>.md
└── models/
    └── <model>.md
```

**Git usage.** Agent directories are suitable for `git init`. Commit
all `.md` files and `LOOM_STACK_VERSION`. Do not commit `memories.db`
or its WAL companions — the authoritative form of a memory is the
content in the database; embeddings are deterministic and
re-derivable. The canonical `.gitignore` is:

```
memories.db
memories.db-wal
memories.db-shm
*.log
```

`loom doctor` reports per-agent git state (initialized, remote
presence, dirty index, gitignore present).

---

## 7. Extension points

### Custom harness adapters

Implement the wake sequence (§2.3) against the filesystem layout
(§6) and the MCP tool surface (§4). The protocol is standard MCP
over stdio; no loom-internal APIs need exposure. Declare the
harness in a manifest under `harnesses/` and call `identity` as
the first tool each session.

### Alternative storage backends

`src/backends/index.ts` exports a `createBackend(contextDir)` factory.
The backend interface (`src/backends/types.ts::MemoryBackend`) defines
eight methods: `remember`, `recall`, `forget`, `update`, `prune`,
`list`, `findSimilar`, `audit`. A conforming implementation can be
swapped in without touching the tool layer. v2 ships
`SqliteVecBackend` as the single opinion.

### Client context overrides

Place a markdown file at `<contextDir>/clients/<name>.md` to provide
harness-specific context injection. Activated by passing
`client=<name>` to `identity`. The file's content is appended to the
wake payload after the standard blocks.

---

## 8. Versioning and v1 compatibility

### Version gate

`LOOM_STACK_VERSION` is an integer stamp. At startup, `loom` reads
this file:

- Missing → write `2` and continue (graceful first-boot).
- Value ≤ 2 → compatible, proceed.
- Value > 2 → hard error: *"Stack is version N; this loom build
  understands up to v2. Upgrade loom."*

v1 stacks are **forward-compatible**: loom v2 reads a v1 stack
cleanly. `pursuits.md` is ignored if present (content not migrated
automatically — use `loom remember --category pursuit` to bring
across anything still active). `procedures/` is ignored if present.

### What migrated from v1 to v2

| v1 shape                    | v2 shape                              |
|-----------------------------|---------------------------------------|
| `pursuits.md`               | `category: pursuit` memories in `memories.db` |
| `procedures/*.md`           | Skills in the harness layer (not stack) |
| `clients/<name>.md`         | Retained as v1; continues to provide runtime tool-prefix overrides. Distinct role from `harnesses/<name>.md` (see §2.2). |

### Embedding model is a version commitment

`memories.db` carries embeddings from a specific model
(`fast-bge-small-en-v1.5` in v2). A store migrated to a different embedding
model is incompatible without full re-embedding. This is tracked
separately from the stack version stamp.
