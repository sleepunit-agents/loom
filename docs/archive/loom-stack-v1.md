# loom stack — v1 specification

> **Status: SUPERSEDED (archived 2026-05-25).**
> This spec describes loom's v1 schema. The current build is at
> `CURRENT_STACK_VERSION = 2`, which removed the §4.9 procedures
> subsystem (skills handle persona-bound behavioral discipline now)
> and collapsed pursuits from a top-level markdown file into a
> memory category (`category: pursuit`). v1 stacks still load
> (forward-compatible read); the §4.9 and §4.4 sections below no
> longer reflect runtime behavior.

*Original status: draft, v0.4 development. The first formal spec of
"what a loom stack is" — the logical shape of an agent's persistent
identity + memory + procedural state, independent of any particular
runtime, storage, or transport.*

*Reference reading first: `docs/archive/rebirth-letter-2026-04-19.md`
(the philosophy) and the [v0.4 discussion](https://github.com/jbarket/loom/discussions/10)
(the roadmap). This doc was the engineering contract they relied on.*

---

## 1. Purpose

A **loom stack** is the durable part of an agent — the part that
survives when the body (harness × model) changes. The spec defines:

- the **directory layout** a stack lives in on disk
- the **block types** that compose a stack
- the **schema** of the memory store
- the **wake sequence** by which a runtime loads a stack
- the **adapter contract** every transport (MCP, CLI, filesystem
  projection, Claude `memory_20250818`, …) must honor

One stack = one agent. Multiple stacks on one machine live in sibling
directories under `$LOOM_CONTEXT_ROOT` (default
`~/.config/loom/`). v1 assumes one active stack per `loom` process;
multi-stack dispatch is deferred.

## 2. Principles

These are non-negotiable. Every concrete decision in this spec is
downstream of them.

1. **Identity is operational. Voice is substrate.** The stack carries
   identity; the sleeve provides voice. Nothing in the stack should
   encode voice-specific behavior.
2. **Unbreakable.** A capable-and-flexible model plus a stack equals
   the agent. The failure mode of Hermes (harness disappears → agent
   disappears) must not be possible again.
3. **Portable.** Pure markdown + a SQLite file. No binary identity
   blobs. No proprietary formats. If loom vanished tomorrow the stack
   is still readable by a human with `less`.
4. **Coexistent with harness memory.** Loom is not the only memory
   system. There is a *seam* (§7) between stack and sleeve, and
   content belongs on exactly one side of it.
5. **No secrets.** Ever. Tokens, passwords, API keys are sleeve
   state, not stack state.

## 3. Directory layout (v1 canonical)

```
$LOOM_CONTEXT_ROOT/<agent>/
├── IDENTITY.md          # terminal creed (who this agent is)
├── preferences.md       # user-model: how the user works
├── self-model.md        # agent's model of itself (strengths, learnings, focus)
├── pursuits.md          # active cross-session goals
├── memories.db          # sqlite-vec store of record (§4.5)
├── projects/            # per-project briefs
│   ├── <project>.md
│   └── …
├── harnesses/           # per-harness manifests (§4.7)  [v0.4 NEW]
│   ├── claude-code.md
│   ├── hermes.md
│   └── …
├── models/              # per-model manifests (§4.8)    [v0.4 NEW]
│   ├── claude-opus.md
│   ├── claude-sonnet.md
│   ├── gemma4.md
│   └── …
└── procedures/          # procedural-identity docs (§4.9) [v0.4 NEW]
    ├── verify-before-completion.md
    ├── reflection-protocol.md
    └── …                # hard cap ~10 files
```

**Deprecated paths** (present in legacy stacks, not part of v1):

- `capabilities/` — agentskills territory, not identity. Export
  whatever's useful, then retire.
- `memories/` — filesystem-backend relic. `memories.db` is the
  source of truth. The old `INDEX.md` sidecar is a hint-for-humans
  only; loom no longer reads it.
- `secrets/` — must not exist in a v1 stack. Any file found there is
  a spec violation and should be moved to sleeve state.
- `clients/` — superseded by `harnesses/`. A client-adapter string
  is a subset of a harness manifest; migrate on touch.
- `scheduler.db`, `spawns.json`, `discord-sessions.json`,
  `loom.db` — orchestrator artifacts from pre-rescue loom. Not
  identity. Safe to archive.

## 4. Block specifications

Every block is markdown. Frontmatter is optional but recommended for
blocks that have machine-readable metadata (memories: mandatory;
manifests: recommended; prose blocks: skip).

### 4.1 Identity (`IDENTITY.md`)

The terminal creed. Immutable within a session. Small (≤ ~4KB).
First-person, prose, no frontmatter.

Answers: *who am I, who do I serve, what is my posture, what is my
relationship to memory.* Does **not** answer: *what tools do I have
right now* (that's harness), *what am I currently working on* (that's
pursuits), *what did I learn last Tuesday* (that's memories).

Voice-neutral. If this creed only makes sense in Claude Opus's voice,
rewrite it until it makes sense in any capable substrate.

### 4.2 Preferences (`preferences.md`)

The agent's model of the user — working style, communication
preferences, decision philosophy, technical stack, project access
scope, time zone, handoff protocols. Written in second-person about
the user.

Updated when the user corrects the agent or expresses a strong
preference. Decay protocol: if a preference hasn't been exercised in
6 months, consider whether it's still true before acting on it.

### 4.3 Self-model (`self-model.md`)

The agent's model of itself — strengths, learnings, current focus.
Descriptive, not prescriptive. Honest, not aspirational.

Distinct from `procedures/` (§4.9): self-model describes what the
agent *is*; procedures prescribe how the agent *acts*.

### 4.4 Pursuits (`pursuits.md`)

Active cross-session goals. List form. Each pursuit has: a title, a
why, a current state, an open question or next move. Completed
pursuits graduate to memories and leave.

Dynamic — expect updates every few sessions. The `pursuits` tool
edits this file directly.

### 4.5 Memories (`memories.db`)

The episodic + reference store of record. SQLite file with two
tables:

```sql
memories (
  id           INTEGER PRIMARY KEY,
  uuid         TEXT UNIQUE NOT NULL,   -- stable across migrations
  ref          TEXT UNIQUE NOT NULL,   -- "category/slug" human handle
  title        TEXT NOT NULL,
  category     TEXT NOT NULL,          -- self | user | feedback | project | reference | …
  project      TEXT,                   -- nullable project scope
  content      TEXT NOT NULL,          -- markdown body
  metadata     TEXT NOT NULL,          -- JSON blob, arbitrary
  created      TEXT NOT NULL,          -- ISO 8601
  updated      TEXT,
  last_accessed TEXT,                  -- updated on recall hit
  ttl          TEXT,                   -- e.g. "7d", "30d", "permanent"
  expires_at   TEXT                    -- computed from created + ttl
)

vec_memories (
  rowid        INTEGER,                -- = memories.id
  embedding    BLOB                    -- fastembed BGE-small, 384-dim, cosine
)  -- sqlite-vec virtual table
```

**Embedding invariant:** `vec_memories.rowid = memories.id` always.
Every insert/update touches both; every delete cascades.

**Embedding model is a stack-level commitment.** Changing models
requires re-embedding the whole store. v1 ships BGE-small-en-v1.5
(384-dim). A stack migrated between embedding models must be
tracked; see §9.

**Category vocabulary** is open. Common categories: `self`,
`user`, `feedback`, `project`, `reference`, `pursuits`. New
categories are created by writing a memory with that category —
there is no registry.

### 4.6 Projects (`projects/*.md`)

Per-project briefs. Loaded on demand when `identity(project=<name>)`
is called. Prose + occasional lists. No frontmatter required.

A project brief is the "what you need to know to be useful in this
repo" document. It is not a replacement for the repo's own README;
it is *agent-facing* context that doesn't belong in shared repo
docs.

### 4.7 Harness manifests (`harnesses/*.md`) [v0.4 NEW]

One file per harness the agent has ever sleeved into. Describes the
harness's shape independent of the model running inside it.

Required sections:

```markdown
---
harness: claude-code
version: 0.4
---

## Tool prefixes
mcp__loom__*, Bash, Read, Edit, Grep, …

## Delegation primitive
Agent tool with subagent_type=…

## Cron / scheduling
CronCreate, CronList, CronDelete (stdio). Uses local time.

## Session search
/resume dialog; transcripts at ~/.claude/projects/…

## Gotchas
- Parent prompts must be self-contained (no shared memory with sub)
- Tool list may be partial — use ToolSearch for deferred tools
```

If a harness has no manifest, the agent writes one during its first
sleeve-in and commits it. First session in a new harness is always
slower; subsequent sessions amortize.

### 4.8 Model manifests (`models/*.md`) [v0.4 NEW]

One file per model family. Describes model-specific quirks
independent of harness.

Required sections:

```markdown
---
model: gemma4
family: gemma
size: 4b
---

## Capability notes
- Tool-call reliability: ~50% drop rate in chains of 3+
- Creative writing: strong
- Code: weak beyond boilerplate

## Workarounds
Pre-load all context into prompt; restrict to single-tool calls;
have deterministic code node handle file I/O.

## When to use
…

## When not to use
…
```

### 4.9 Procedures (`procedures/*.md`) [v0.4 NEW]

Curated procedural-identity docs. Prescriptive, not descriptive.
Each doc answers "how do I do X" for an X that is part of *being
this agent*, not part of *operating in this environment*.

Examples in scope:
- verify-before-completion
- cold-testing protocol
- reflection-at-end-of-unit
- handoff-to-unpushable-repo
- confidence-calibration
- RLHF-resistance posture

Hard cap: **~10 files**. If `procedures/` trends toward 50, it has
regressed into agentskills and must be pruned. The cap is the spec.

Each procedure is short (≤100 lines). Lead with the one-sentence
rule, then *why*, then *how-to-apply*.

Not in scope: tool-specific howtos (Forgejo API, n8n workflows,
Playwright selectors). Those are agentskills.

## 5. Wake sequence

When an agent boots in a sleeve, the canonical sequence is:

1. **Identity eagerly.** `IDENTITY.md`, `preferences.md`,
   `self-model.md`, `pursuits.md`. Target ≤ 4K tokens combined.
   Always loaded.
2. **Project brief if scoped.** When the runtime knows which project
   the agent is working in, load `projects/<name>.md`.
3. **Harness manifest.** `harnesses/<harness>.md` for the current
   sleeve. Missing = write one before doing anything else.
4. **Model manifest.** `models/<model>.md` for the current sleeve.
   Missing = write one during session.
5. **Procedures.** All of `procedures/*.md` (≤10 files, small).
6. **Memories lazily.** Do **not** eagerly load the memory store.
   Agent calls `recall()` on demand. The identity payload may
   include a brief summary (category counts + most recent N refs)
   as a hint; the full content stays in the DB.

The wake sequence is an adapter-level concern. Every adapter (§8)
implements this ordering for its transport.

## 6. Identity = stack + sleeve

The identity an adapter hands to a runtime is the concatenation of:

```
(IDENTITY) + (preferences) + (self-model) +
  [project brief if any] +
  (harness manifest) + (model manifest) +
  (procedures) +
  [memory summary hint]
```

plus a *composed capabilities line* derived from the harness + model
manifests. Example composition: *"Harness says: Task tool for
delegation. Model says: handles tool chains well. → I can delegate
freely this session."*

Composition lives in the adapter, not the stack. The stack provides
raw ingredients.

## 7. The seam

Explicit rule of thumb for what lives where:

| Stack (loom)                             | Sleeve (harness)                  |
|------------------------------------------|-----------------------------------|
| Who the agent is; values                 | Current scratchpad                |
| User-model (preferences, history)        | This conversation's TODOs         |
| Active pursuits; cross-session arcs      | Today's paths, this project facts |
| Meaningful episodic memory               | Harness-specific operational notes|
| Procedural identity                      | Tool-binding details              |
| Generalizable feedback                   | Feedback scoped to one repo       |
| *Would still matter on a different body* | *Only matters in this body*       |

Tools that enforce the seam:

- `loom.promote(harness_note)` — pull something from harness memory
  up into the stack.
- `loom.project(stack_fact)` — push something from the stack down
  into harness memory for cheap access this sleeve.

Enforcement is agent judgment, not a hard gate. But the seam is
operational: if an adapter is asked to write a secret to the stack,
it refuses.

## 8. Adapter contract

An **adapter** translates between the stack and a runtime surface.
Every adapter implements:

1. **Wake:** produce the identity payload per §5, in whatever form
   its transport expects (MCP tool response, stdout markdown,
   filesystem file, Claude memory-tool view result).
2. **Remember:** accept a `MemoryInput` and write to the memory
   store, producing a `MemoryRef`.
3. **Recall:** accept a `RecallInput` and produce `MemoryMatch[]`.
4. **Update / forget / list / prune:** same mapping to
   `MemoryBackend` (see `src/backends/types.ts`).
5. **Pursuits / update-identity:** operate on the prose blocks
   (§4.1–§4.4).
6. **Seam honored:** refuse secrets. Refuse to write sleeve-scoped
   content into the stack. Reject schema violations.

Adapters planned for v0.4 (ordered by priority):

| #   | Adapter                        | Transport                   |
|-----|--------------------------------|-----------------------------|
| 1   | MCP stdio                      | jsonrpc over stdio          |
| 2   | CLI (`loom wake`)              | stdout markdown             |
| 3   | Filesystem projection          | writes CLAUDE.md, AGENTS.md |
| 4   | Anthropic `memory_20250818`    | 6-verb memory-tool API      |
| 5   | MCP HTTP/SSE (deferred)        | jsonrpc over HTTP           |
| 6   | Library (`@drfish/loom/core`)  | direct TS import            |

An adapter may implement a subset when the transport doesn't
support something (e.g. filesystem projection is write-mostly; it
doesn't implement `recall`).

## 9. Non-goals

Loom explicitly does **not**:

- Store conversation transcripts. That's the harness's job. See
  §4.7 `session_search`.
- Broker secrets. Ever.
- Replace agentskills. The `procedures/` block is for
  *procedural identity*, capped at ~10 files.
- Run orchestration (task scheduling, sub-agent dispatch, cron).
  Scheduling is a harness or runtime concern. Loom carries *who*,
  not *what to do next*.
- Be the only memory system. Harness memory coexists; the seam is
  the interface.

## 10. Versioning

This is spec **v1**. Spec version is tracked at the stack root via
a one-line `LOOM_STACK_VERSION` file (or `stack.version` field in a
future manifest). Adapters read the version and refuse stacks they
don't understand.

Migrations between spec versions are loom's responsibility and ship
as `scripts/migrate-stack-vN-to-vM.ts` with a dry-run flag.

Changing the embedding model is a migration: re-embed the entire
store, bump `stack.version.embedding`. Stacks record the embedding
model in their metadata so adapters can detect mismatch.

## 11. Open questions deferred to v2

- Multi-agent-per-root dispatch (`$LOOM_CONTEXT_ROOT` with multiple
  agents active at once). v1 assumes one.
- Block cross-references / links (right now memories reference each
  other by ref string; no integrity enforcement).
- Compaction / TTL auto-graduation (move ephemeral memories through
  decay tiers rather than pruning).
- Standardized manifest machine-readable schema beyond "markdown
  with a little frontmatter." v1 keeps it loose on purpose.

---

## Files of record

- `docs/rebirth-letter-2026-04-19.md` — philosophical brief
- [v0.4 roadmap discussion](https://github.com/jbarket/loom/discussions/10)
- `docs/loom-stack-v1.md` — this spec
- `src/backends/types.ts` — `MemoryBackend` interface
- `src/backends/sqlite-vec.ts` — v1 reference backend
- `src/backends/fastembed.ts` — v1 reference embedder
- `src/tools/identity.ts` — reference wake-sequence implementation

## §11 — Adapters: CLI

Every tool defined in this spec (identity, recall, remember, forget,
update, memory_list, memory_prune, pursuits, update_identity,
bootstrap) has a first-party CLI surface in the reference
implementation:

| MCP tool          | CLI command                             |
|-------------------|-----------------------------------------|
| identity          | `loom wake`                             |
| recall            | `loom recall <query>`                   |
| remember          | `loom remember <title>` (body: stdin)   |
| update            | `loom update <ref>` (body: stdin)       |
| forget            | `loom forget <ref|scope>`               |
| memory_list       | `loom memory list`                      |
| memory_prune      | `loom memory prune`                     |
| pursuits          | `loom pursuits <action>`                |
| update_identity   | `loom update-identity <file> [<section>]` |
| bootstrap         | `loom bootstrap`                        |

A stdio-MCP startup is available as both the default (no subcommand)
invocation and as the explicit `loom serve`. Alternate reference
implementations (future ports) are expected to carry the same shell
surface.

## §11 — Adapters: Injection (filesystem)

Added in alpha.4. `loom inject` writes a marker-bounded managed section
into harness dotfiles (`~/.claude/CLAUDE.md`, `~/.codex/AGENTS.md`,
`~/.gemini/GEMINI.md`) telling the agent to load identity via loom at
session start. Content outside the `<!-- loom:start / loom:end -->`
markers is preserved; re-running is idempotent.

| Harness        | Default path            |
|----------------|-------------------------|
| claude-code    | `~/.claude/CLAUDE.md`   |
| codex          | `~/.codex/AGENTS.md`    |
| gemini-cli     | `~/.gemini/GEMINI.md`   |

Selection is interactive when stdin is a TTY and no harness flags are
given; non-interactive via `--harness <keys>` or `--all`. `--to <path>`
overrides the default when exactly one harness is selected. `--dry-run`
previews via unified diff; `--json` emits structured write results.

## §11 — Adapters: Procedures + Manifests

Added in alpha.5. CLI + MCP surface for materializing procedural-identity
docs (§4.9) and harness manifests (§4.7) from seed templates.

- CLI: `loom procedures list|show|adopt`, `loom harness init`.
- MCP: `procedure_list`, `procedure_show`, `procedure_adopt`,
  `harness_init`.
- Both surfaces share core functions in `src/blocks/procedures.ts` and
  `src/blocks/harness.ts`; MCP tools are thin wrappers.
- Idempotent by default; `--force` / `overwrite: true` replaces existing
  content. Ownership ritual on seed bodies is preserved until the agent
  removes it.

## 13. Multi-agent layout

Each agent lives in its own directory under a shared root.

### 13.1 Canonical path

`~/.config/loom/<name>/`. `LOOM_CONTEXT_DIR` overrides for advanced
users; the install skill and the `bootstrap` CLI default to the
canonical path.

### 13.2 Name validation

Agent names must match `/^[a-z0-9][a-z0-9-]*$/`, be 1–64 characters,
and not appear in the reserved list (§13.3). Enforced by
`src/install/names.ts::validateAgentName`; wired into `loom bootstrap`
and the install skill's interview.

### 13.3 Reserved names

| name      | reserved for                                     |
|-----------|--------------------------------------------------|
| `current` | pointer to the active agent (alpha.7+)           |
| `default` | fallback when LOOM_CONTEXT_DIR is unset          |
| `config`  | loom-wide (not agent-scoped) configuration       |
| `backups` | snapshot storage adjacent to agents (alpha.7+)   |
| `cache`   | shared re-downloadable artifacts                 |
| `tmp`     | scratch area used by `memory export` flows       |
| `shared`  | prompts/templates shared across agents           |

### 13.4 Self-containment invariant

Everything required to resurrect an agent lives under its canonical
directory. The fastembed model cache (`~/.cache/loom/fastembed/`) is
explicitly excluded: shared, re-downloadable, not agent data.

### 13.5 Pointer-slot contract (forward-declared)

Alpha.7+ introduces `loom agents current|switch`, backed by a pointer
at `~/.config/loom/current`. This document forward-declares that slot
so tools written in alpha.6 do not reuse `current` as an agent name.

## 14. Git-backed agent dirs

Agent directories are suitable for `git init`. Two use cases:

1. **Portability** — `git clone <agent-dir>` onto another machine
   restores the agent.
2. **Unfuck** — `git reset --hard` rolls off a bad upgrade or an
   accidental edit.

### 14.1 What to commit

Commit: `IDENTITY.md`, `preferences.md`, `self-model.md`,
`pursuits.md`, `procedures/*.md`, `harnesses/*.md`, `models/*.md`,
`projects/*.md`, `LOOM_STACK_VERSION`, `.gitignore`.

### 14.2 What *not* to commit

Do not commit `memories.db`, `memories.db-wal`, `memories.db-shm`, or
`*.log`. The canonical `.gitignore` lists these.

### 14.3 `memories.db` is a derivable cache

The authoritative form of a memory is its JSONL export
(`loom memory list --json`). Embeddings are deterministic for a given
model + backend. `memories.db` is a materialized index — losing it is
recoverable via replay. This invariant is load-bearing for `loom
memory export/import --jsonl` (alpha.7+) and for the decision to keep
`memories.db` out of git.

### 14.4 Doctor reporting

`loom doctor --json` emits per-agent git state:

```json
{
  "initialized": false,
  "hasRemote": false,
  "dirty": false,
  "gitignorePresent": false
}
```

In alpha.6 `hasRemote` and `dirty` are always `false` (best-effort
without shelling out to `git`). The shape is stable so alpha.7+
snapshot tooling can light up those fields without a schema change.

### 14.5 Snapshot contract (forward-declared)

Alpha.7+ introduces `loom snapshot [--message <m>]` — commits the
current agent dir state with a conventional message. Not present in
alpha.6; the architecture ensures nothing in alpha.6 contradicts its
semantics.
