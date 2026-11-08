# Harness + Model Manifests — design

*Status: shipped in v0.4.0-alpha.1, 2026-04-19. First piece of the
v0.4 arc; see the
[v0.4 discussion](https://github.com/jbarket/loom/discussions/10) for
the umbrella.*

*Target version: 0.4.0-alpha.1.*

---

## 1. Problem

v0.3.1's identity payload is missing two things the stack spec
(v1, §4.7 and §4.8) requires:

- **Harness manifest** — the shape of the current runtime
  (`harnesses/<client>.md`): tool prefixes, delegation primitive,
  scheduling, session search, known gotchas.
- **Model manifest** — the shape of the current model
  (`models/<model>.md`): capability notes, workarounds, when to use
  and when not to.

Without these, every sleeve-in forces Art to re-discover harness and
model quirks from scratch. The rescue letter names this explicitly:
*"First session in a new harness is always slower; subsequent
sessions amortize."* Amortization requires the manifests to exist and
the wake sequence to load them.

The procedures block (§4.9) gets plumbed here too, but its content
(curated procedural-identity docs) is a separate later piece. This
spec wires the *reader* for procedures; populating `procedures/*.md`
is piece #2 of the v0.4 arc.

## 2. Scope

**In:**

- New `src/blocks/` module with harness / model / procedures readers.
- `src/tools/identity.ts` integrates the three block types into the
  wake payload, in the order §5 of the stack spec prescribes.
- `LOOM_MODEL` env var support, with `identity({model})` tool param
  override.
- Missing-manifest nudge emitted in the identity payload when
  `LOOM_CLIENT` or `LOOM_MODEL` is set but the corresponding file is
  absent.
- `LOOM_STACK_VERSION` plumbing: lazy-write `1` on first stack read;
  refuse unknown versions.
- Seed `harnesses/claude-code.md` + `models/claude-opus.md` in Art's
  own context directory (useful immediately) and equivalent templates
  embedded in the codebase for the nudges.
- README updates (new env var, new block types, MCP config example).
- CHANGELOG entry under `[Unreleased]`.
- Tests for block readers + wake integration (target: ~25 new tests,
  suite goes from 149 → ~174).

**Out (deferred to later pieces of the v0.4 arc):**

- CLI adapter (`loom wake`).
- Filesystem projection adapter.
- Anthropic `memory_20250818` handler.
- Seam tools (`loom.promote`, `loom.project`).
- `loom.recall_conversation`.
- Adapter interface abstraction (§8 stays implicit until piece #3).
- Any `write_manifest` tool (agent uses native file-editing tools).
- Populated `procedures/*.md` content (reader ships; content is
  piece #2).
- Seed manifests beyond `claude-code` + `claude-opus` (others added
  as Art sleeves into them).

## 3. Architecture

### 3.1 Block reader module

```
src/blocks/
├── types.ts         # Block + BlockReader interfaces
├── harness.ts       # reads <context>/harnesses/<key>.md
├── model.ts         # reads <context>/models/<key>.md
└── procedures.ts    # reads <context>/procedures/*.md
```

Shared types:

```ts
export interface Block {
  key: string;                           // "claude-code", "claude-opus", etc.
  frontmatter: Record<string, string>;   // parsed YAML-lite
  body: string;                          // markdown after frontmatter
  path: string;                          // absolute path on disk
}

export interface BlockReader {
  read(contextDir: string, key: string): Block | null;
  list(contextDir: string): string[];
  template(key: string): string;         // scaffold for nudges
}
```

Each reader is a plain function module — no class, no adapter
interface. The three readers share a small frontmatter-parser helper
(manual line-by-line, not a YAML dep; the frontmatter is tiny and
strict).

`procedures.ts` differs slightly. A procedure's `key` is the
filename without the `.md` extension. It exports:

```ts
read(contextDir, key) → Block | null
list(contextDir) → string[]               // sorted alphabetically
readAll(contextDir) → {
  blocks: Block[],                        // all present procedures
  capWarning: string | null               // set when blocks.length > 10
}
template(key) → string
```

`readAll` is the main consumer for the wake sequence. `capWarning`
surfaces in the identity payload as a one-line prepend; nothing is
logged to stderr.

### 3.2 Wake-sequence integration

`src/tools/identity.ts` already assembles IDENTITY, preferences,
self-model, pursuits, and optional project brief. It gains four
additions, in §5 order:

1. **Harness manifest.** If `LOOM_CLIENT` is set:
   - `harness.read(contextDir, client)` → either include the body or
     emit a nudge with `harness.template(client)`.
2. **Model manifest.** Resolve model identifier:
   - If `input.model` param is present, use it.
   - Else if `LOOM_MODEL` env is set, use it.
   - Else skip the model section entirely (no nudge).
3. **Procedures.** `procedures.readAll(contextDir)` → concatenate
   bodies with `---` separators. Prepend cap-warning line if the list
   is over 10.
4. **Missing-manifest nudges.** Formatted as a dedicated section, not
   an error — see §4.

No changes to the other 9 tools.

### 3.3 Stack version plumbing

`src/config.ts` gains:

```ts
readStackVersion(contextDir: string): number | null;
ensureStackVersion(contextDir: string): void;  // lazy write "1"
```

On server startup in `src/server.ts`, the MCP factory calls
`ensureStackVersion(contextDir)` once. If the file is missing it is
written with `1`. If `readStackVersion` returns a value > 1, the
factory caches a refusal error and every tool handler short-circuits
with that error rather than executing. This keeps the check at one
place (boot), avoids per-tool overhead, and still refuses cleanly
when the stack is ahead of the installed loom. Example refusal:

```
loom v0.4.0-alpha.1 understands stack version 1 but
$LOOM_CONTEXT_DIR/LOOM_STACK_VERSION is 2. Upgrade loom or pin
LOOM_CONTEXT_DIR to an older stack.
```

Unparseable file content refuses similarly.

### 3.4 What doesn't change

- `src/backends/` — sqlite-vec + fastembed untouched.
- `src/tools/remember|recall|update|forget|memory-list|prune|pursuits|update-identity|bootstrap` —
  signatures and behavior unchanged.
- `src/server.ts` — the MCP server shape is unchanged; only the
  identity tool's input schema gains an optional `model` field.

## 4. Data flow and payload shape

### 4.1 Files on disk (fully populated stack after this ship)

```
~/.config/loom/art/
├── LOOM_STACK_VERSION          # "1\n"
├── IDENTITY.md
├── preferences.md
├── self-model.md
├── pursuits.md
├── memories.db
├── projects/
│   └── loom.md
├── harnesses/                  # NEW
│   └── claude-code.md
├── models/                     # NEW
│   └── claude-opus.md
└── procedures/                 # NEW (empty until piece #2)
```

### 4.2 Manifest file shape

Harness manifest (matches stack spec §4.7):

```markdown
---
harness: claude-code
version: 0.4
---

## Tool prefixes
mcp__loom__*, Bash, Read, Edit, Grep, Glob, Agent, ToolSearch, …

## Delegation primitive
Agent tool, `subagent_type` selector.

## Cron / scheduling
CronCreate / CronList / CronDelete. Local time.

## Session search
/resume dialog; transcripts at ~/.claude/projects/.

## Gotchas
- Sub-agents start with zero context — briefs must be self-contained.
- Deferred tools need ToolSearch before invocation.
```

Model manifest (matches stack spec §4.8):

```markdown
---
model: claude-opus
family: claude
size: opus
---

## Capability notes
- Strong tool-chain reliability.
- Strong code-review and architecture work.
- Creative writing: capable, tends toward conservative tone.

## Workarounds
None required.

## When to use
Deep architectural design, multi-system reasoning, code review.

## When not to use
Mechanical boilerplate (Sonnet suffices at lower cost).
```

Schema enforcement for v1: **frontmatter parses + at least one
section header.** Missing required sections produce no error — just a
thinner manifest. Future schema tightening can happen with a version
bump; v1 is permissive by design.

### 4.3 Identity payload structure

```
# Identity
<IDENTITY.md>

# Preferences
<preferences.md>

# Self-Model
<self-model.md>

# Project: <name>          # only when input.project is set
<projects/<name>.md>

# Harness: <client>        # when LOOM_CLIENT is set
<harness manifest body>

# Model: <model>           # when LOOM_MODEL or input.model is set
<model manifest body>

# Procedures               # when procedures/*.md exists
<body 1>
---
<body 2>
…

# Memories
<existing summary line + recent refs>
```

Section ordering is §5 of the stack spec. The `# Memories` summary
already exists in v0.3.1 and is unchanged.

### 4.4 Nudge format (missing manifest)

```
# Harness: claude-code (manifest missing)
No manifest found at /home/jbarket/.config/loom/art/harnesses/claude-code.md.
Write one — here's the template:

---
harness: claude-code
version: 0.4
---

## Tool prefixes
<tool-prefix list — see stack spec §4.7>

## Delegation primitive
<primary sub-agent mechanism>

## Cron / scheduling
<scheduling primitive if any, and local-vs-UTC note>

## Session search
<how transcripts are searched>

## Gotchas
<known quirks>
```

Same shape for model nudges, using the model-manifest template.

The nudge replaces the would-be `# Harness:` / `# Model:` section;
it is not additive noise.

### 4.5 Env var contract

| Variable | Status | Example | Source |
|---|---|---|---|
| `LOOM_CONTEXT_DIR` | existing | `~/.config/loom/art` | user |
| `LOOM_CLIENT` | existing | `claude-code` | MCP config per spawn |
| `LOOM_MODEL` | NEW | `claude-opus` | MCP config per spawn |

Per-call override: `identity({model: "claude-haiku"})` for this wake
only.

Because loom is stdio MCP, each harness spawns its own loom process
with its own env. Multiple harnesses reading the same stack at once
is fine: `LOOM_CLIENT` and `LOOM_MODEL` are per-process, so no
collision.

## 5. Edge cases and error handling

**Missing files (expected, not errors):**

| Situation | Behavior |
|---|---|
| `LOOM_CLIENT` unset | Omit harness section entirely. No nudge. |
| `LOOM_CLIENT` set, file missing | Emit "(manifest missing)" nudge with template. |
| `LOOM_MODEL` unset and no param | Omit model section entirely. No nudge. |
| `LOOM_MODEL` set, file missing | Emit "(manifest missing)" nudge with template. |
| `harnesses/` directory missing | Treat as LOOM_CLIENT-unset. No crash. |
| `procedures/` directory missing | Omit procedures section. Normal. |
| Procedures over cap (>10) | Include all; prepend one-line warning. |

**Malformed manifests (soft-fail):**

| Situation | Behavior |
|---|---|
| Frontmatter won't parse | Include body verbatim; log to stderr. |
| No frontmatter at all | Include body verbatim; no warning (frontmatter is optional). |
| Empty file | Treat as missing — emit nudge. |

Rule of thumb: **never block wake on a bad manifest.** A broken
manifest produces a degraded identity, not a broken session.

**Stack version refusals:**

| Situation | Behavior |
|---|---|
| `LOOM_STACK_VERSION` file missing | Lazy-write `1`. No prompt. |
| File contains `1` | Normal operation. |
| File contains a version > 1 | Refuse every tool call with the explicit message in §3.3. |
| File contains garbage | Refuse with "LOOM_STACK_VERSION unparseable: …". |

Refusals surface as MCP error responses. The stdio server stays up
so clients see the error.

**Override precedence for model resolution:**

1. `identity({model})` tool param.
2. `LOOM_MODEL` env.
3. Neither — omit model section.

No auto-detection, no heuristics. If both are unset, the omission is
intentional.

**Concurrency:**

- Block readers are pure reads. No locking.
- `LOOM_STACK_VERSION` lazy-write is first-write-wins; duplicates
  across concurrent processes are harmless (they all write `1`).
- sqlite-vec backend handles its own concurrency. Unchanged here.

## 6. Testing plan

New tests (target ~25):

| File | What it covers |
|---|---|
| `src/blocks/harness.test.ts` | read hit, read miss, malformed frontmatter, no frontmatter, empty file, `list`, `template` |
| `src/blocks/model.test.ts` | mirror of `harness.test.ts` |
| `src/blocks/procedures.test.ts` | `readAll`, cap warning at >10 files, missing directory |
| `src/config.test.ts` (extend) | `readStackVersion` hit/miss/garbage, `ensureStackVersion` lazy write |
| `src/server.test.ts` (extend) | server factory writes `LOOM_STACK_VERSION=1` on boot for a fresh context; factory short-circuits every tool when version > 1 |
| `src/tools/identity.test.ts` (extend) | harness section present/missing/nudge; model section present/missing/nudge; procedures section; `LOOM_MODEL` env; `{model}` param override |

Existing 149 tests must stay green — no regressions to sqlite-vec,
fastembed, or existing tool surface.

Smoke test: `scripts/smoke-test-mcp.ts` runs unchanged and passes.
Add a one-off verification step in the PR: set `LOOM_MODEL` in the
MCP config, launch Claude Code, call `identity()`, inspect output
for the new sections.

## 7. Build order

Branch: `feat/harness-model-manifests`.

Each commit stands alone and keeps the suite green.

1. **TOC doc.** v0.4 architecture umbrella (originally `docs/v0.4-architecture.md`; post-alpha.1 this content migrated to the [v0.4 discussion](https://github.com/jbarket/loom/discussions/10)). No code.
2. **Narrow spec.** This file.
3. **Stack version plumbing.** `src/config.ts` + tests. Wire
   `ensureStackVersion` + version-refusal into the `src/server.ts`
   factory per §3.3.
4. **Block readers.** `src/blocks/{types,harness,model,procedures}.ts`
   + tests. Pure functions, no tool wiring yet.
5. **Wake-sequence integration.** Update `src/tools/identity.ts` to
   compose harness / model / procedures into the payload, emit
   nudges, accept `model` param. Update `identity.test.ts`.
6. **Seed manifests + docs.** Write
   `~/.config/loom/art/harnesses/claude-code.md` and
   `~/.config/loom/art/models/claude-opus.md`. Embed corresponding
   templates in `src/blocks/harness.ts` / `model.ts`. Update README,
   `.env.example`, and `CHANGELOG` `[Unreleased]`.
7. **Version bump.** `package.json` 0.3.1 → 0.4.0-alpha.1. CHANGELOG
   entry naming this ship.
8. **Verification pass.** `npm test`, `scripts/smoke-test-mcp.ts`,
   manual Claude Code launch with `LOOM_MODEL` set. Commit fixes.

## 8. Definition of done

- Suite green, ~174 tests.
- `scripts/smoke-test-mcp.ts` green.
- Claude Code session with `LOOM_MODEL=claude-opus` in `.mcp.json`
  shows the new `# Harness:` and `# Model:` sections in the
  `identity()` payload, sourced from the seed manifests.
- `~/.config/loom/art/harnesses/claude-code.md` and
  `~/.config/loom/art/models/claude-opus.md` exist and match the
  documented schema.
- `LOOM_STACK_VERSION` file stamped `1` in Art's context dir.
- README mentions `LOOM_MODEL` in the env-var table and shows it in
  the Claude Code MCP config example.
- CHANGELOG `[Unreleased]` lists this ship.
- `package.json` at `0.4.0-alpha.1`.

## 9. Files of record

- [v0.4 discussion](https://github.com/jbarket/loom/discussions/10) — umbrella + roadmap
- [`docs/loom-stack-v1.md`](../loom-stack-v1.md) — stack schema v1
- [`docs/rebirth-letter-2026-04-19.md`](../rebirth-letter-2026-04-19.md)
- `src/tools/identity.ts` — wake-sequence implementation (extended here)
- `src/blocks/` — new module (created here)
- `src/config.ts` — stack version plumbing (extended here)
