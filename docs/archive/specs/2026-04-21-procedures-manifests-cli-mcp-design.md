# Procedures + Manifests: CLI + MCP Surface

**Date:** 2026-04-21
**Target release:** v0.4.0-alpha.5
**Stack spec sections:** v1 §4.7 (harness manifests), §4.8 (model manifests), §4.9 (procedures), §11 (Adapters).

---

## Problem

The procedures, harness-manifest, and model-manifest blocks are all readable
and composable into the identity payload today (`src/blocks/procedures.ts`,
`harness.ts`, `model.ts`; wired into `src/tools/identity.ts`). When any of
these are missing, `identity()` emits a nudge (`seedNudge()` for procedures,
inline "manifest missing" warnings for harness/model).

But **the agent has no ergonomic way to act on the nudge.** To adopt a
procedure, the agent today must:

1. Remember the `SEED_PROCEDURES` map exists.
2. Write `<contextDir>/procedures/<key>.md` via the harness's own filesystem
   tools (Write/Edit in Claude Code, shell in Gemini CLI, etc.).
3. Open and edit the ⚠ ownership ritual out of the seed body.

That's not portable across harnesses, isn't observable from the MCP server,
and can't be scripted cleanly. Same story for initializing a missing harness
or model manifest.

This spec closes that gap with a first-class CLI + MCP surface for adopting
procedures and initializing harness manifests, plus content authoring to
materialize the six seed procedures into the Art stack as a UX validation.

## Non-goals

- **Master first-boot wizard** ("what's your name? what procedures do you
  want? describe yourself") — that's v0.5+ and will compose out of the
  primitives this PR ships.
- **Preferences / IDENTITY.md / self-model.md authoring flows** — those are
  bigger surfaces and need their own design pass.
- **Model-manifest initialization MCP tool** — model manifests are lower
  traffic than harness manifests; CLI-only path is acceptable. Add later if
  demand shows up.
- **Procedure-variant scaffolding** (SDD/TDD/BDD). The current seed table is
  a flat `Record<string, string>`; a variant is just another key. No
  data-model change now.

## Design

### Shared core (in existing block modules)

Extend `src/blocks/procedures.ts`:

```ts
export interface AdoptResult {
  key: string;
  path: string;
  action: 'created' | 'skipped-exists' | 'overwritten';
}

export async function adoptProcedures(
  contextDir: string,
  keys: string[],
  opts?: { overwrite?: boolean },
): Promise<AdoptResult[]>;

export interface ProcedureSummary {
  key: string;
  adopted: boolean;
  path: string;
}

export async function listProcedures(contextDir: string): Promise<{
  available: ProcedureSummary[];
}>;

export interface ProcedureDetail {
  key: string;
  template: string;
  adopted: boolean;
  path: string;
  body?: string;
}

export async function showProcedure(
  contextDir: string,
  key: string,
): Promise<ProcedureDetail>;
```

Extend `src/blocks/harness.ts`:

```ts
export interface InitResult {
  name: string;
  path: string;
  action: 'created' | 'skipped-exists' | 'overwritten';
}

export async function initHarness(
  contextDir: string,
  name: string,
  opts?: { overwrite?: boolean },
): Promise<InitResult>;
```

- `adoptProcedures` iterates keys, validates against `SEED_PROCEDURES`
  (unknown key → throws `UnknownProcedureError`), writes `procedures/<key>.md`
  from the seed template, respects `overwrite`. Creates the directory if
  missing. Does **not** strip the ⚠ ownership ritual — the seed template
  ships with it intact per §4.9.
- `initHarness` writes `harnesses/<name>.md` from `harness.template(name)`.
  Same overwrite semantics. No name validation beyond path-component safety
  (no `/`, no empty).
- All three functions throw on I/O errors; consumers translate to exit codes.

### CLI surface

`loom procedures` — new subcommand with list / show / adopt.

```
Usage: loom procedures <subcommand> [options]

Subcommands:
  list             Show available seed procedures and adoption state
  show <key>       Print the template (or adopted body) for one procedure
  adopt [<keys...>] Adopt one or more procedures. No keys + TTY → picker.

Options (list):
  --json           Emit ProcedureSummary[] as JSON

Options (show):
  --json           Emit { key, template, adopted, path, body? }

Options (adopt):
  --all            Adopt every un-adopted seed
  --force          Overwrite existing adopted files
  --json           Emit AdoptResult[]

Global: --context-dir, --json
```

Behavior:
- `loom procedures list` → human table with columns `key | adopted | path`
  or `--json` for structured output. Lists the 6 seed keys; adopted = true
  when the file exists.
- `loom procedures show <key>` → prints the current on-disk body if adopted,
  else the seed template. No decorative header — the body speaks for itself,
  and the presence or absence of the ⚠ ownership ritual is itself the
  adopted/not-adopted signal. Unknown key → exit 2. `--json` returns the
  full detail record including both `template` and `body` (when adopted).
- `loom procedures adopt` with no keys on TTY → multi-select picker listing
  only **un-adopted** seeds. Confirming writes them all. Empty selection
  → exit 2 with message "no procedures selected".
- `loom procedures adopt` with no keys on non-TTY → exit 2 with usage
  message (same pattern as `loom inject`).
- `loom procedures adopt <keys...>` or `--all` → non-interactive, writes
  requested seeds. Pre-existing files are reported as `skipped-exists`
  unless `--force` is passed.

`loom harness` — new subcommand.

```
Usage: loom harness <subcommand> [options]

Subcommands:
  init [<name>]   Write a manifest template for <name>

Options (init):
  --force         Overwrite existing manifest
  --json          Emit InitResult

Global: --context-dir, --client, --json
```

Behavior:
- `loom harness init <name>` → writes `harnesses/<name>.md` from template.
- `loom harness init` (no name) → uses `--client` flag or `$LOOM_CLIENT`;
  errors with usage if neither is set (exit 2).
- Pre-existing manifest → `skipped-exists` unless `--force`.

Exit codes across both commands:
- 0 — success (including `skipped-exists` — idempotent, not an error)
- 1 — I/O or runtime error
- 2 — usage / unknown key / missing required arg / non-TTY without args

### MCP tools

Three new tools on `createLoomServer` (`src/server.ts`):

**`procedure_list`** — no arguments. Returns text summary + JSON-like block:

```json
{
  "available": [
    { "key": "verify-before-completion", "adopted": true,  "path": "..." },
    { "key": "cold-testing",              "adopted": false, "path": "..." }
  ]
}
```

**`procedure_show`** — `{ key: string }`. Returns the seed template text,
and if adopted also returns the current on-disk body. Unknown key → tool
error with message listing valid keys.

**`procedure_adopt`** — `{ keys: string[], overwrite?: boolean }`. Returns
a summary naming each result (created/skipped-exists/overwritten) with the
path. Empty `keys` → error. Unknown key → error naming the offender.

**`harness_init`** — `{ name: string, overwrite?: boolean }`. Returns the
result (`created | skipped-exists | overwritten`) with the path.

All MCP tool bodies are thin wrappers over the shared core functions. Text
bodies are formatted for an LLM reader (prose, not raw JSON dumps).

### File structure

```
src/blocks/
  procedures.ts              +adoptProcedures, listProcedures, showProcedure, UnknownProcedureError
  procedures.test.ts         +tests for the new functions
  harness.ts                 +initHarness
  harness.test.ts            +tests for initHarness
src/cli/
  procedures.ts              NEW — loom procedures list|show|adopt
  procedures.test.ts         NEW
  harness.ts                 NEW — loom harness init
  harness.test.ts            NEW
  subcommands.ts             +'procedures', +'harness'
  index.ts                   +dispatch cases + top-help entries
src/tools/
  procedures.ts              NEW — MCP tool handlers (list/show/adopt)
  procedures.test.ts         NEW
  harness.ts                 NEW — MCP tool handler (init)
  harness.test.ts            NEW
src/server.ts                +4 server.tool() registrations
README.md                    +CLI section + MCP tool entries
docs/loom-stack-v1.md        +§11 Adapters: Procedures + Manifests row
CHANGELOG.md                 +[0.4.0-alpha.5] block
package.json                 version → 0.4.0-alpha.5
```

Content authoring (outside repo, on the Art stack):
```
~/.config/loom/art/procedures/
  verify-before-completion.md
  cold-testing.md
  reflection-at-end-of-unit.md
  handoff-to-unpushable-repo.md
  confidence-calibration.md
  RLHF-resistance.md
~/.config/loom/art/harnesses/claude-code.md  — refresh
~/.config/loom/art/models/claude-opus.md     — refresh
```

### Multi-select TUI reuse

`src/cli/tui/multi-select.ts` was built in alpha.4 with the explicit
intent of being reused for procedure adoption (the code comment calls this
out). The adopt picker calls `multiSelect<string>()` with the un-adopted
seed keys as items. `initialSelected` is empty (opt-in, not opt-out —
adoption is a commitment, not a default). Cancel returns exit 130, consistent
with `loom inject`.

### Overwrite semantics

Default behavior: if `procedures/<key>.md` or `harnesses/<name>.md`
already exists, skip with a human-readable "already adopted" / "already
initialized" line and action `skipped-exists`. Exit 0. This makes the
commands safe to re-run.

`--force` / `overwrite: true`: replace the file with the fresh template,
action `overwritten`. This is the hook the future wizard will use when it
synthesizes a customized procedure body and writes over the default.

### Ownership ritual preservation

Seed procedure bodies ship with:
```
> ⚠ This is a seed template. Edit the Why and How to apply sections with
> your own reasons and triggers, then delete this notice to claim the
> procedure.
```

`adoptProcedures` writes this intact. The agent's editing step
(conversationally or via `loom update-identity`-style tool — out of scope
here) is what removes it. `readAll()` in `procedures.ts` doesn't filter or
mutate the body, so the notice stays visible in the identity payload until
the agent chooses to strip it. This is a feature: unedited procedures are
self-announcing.

### Stack spec §11 row

Append to `docs/loom-stack-v1.md`:

```
## §11 — Adapters: Procedures + Manifests

Added in alpha.5. CLI + MCP surface for materializing procedural-identity
docs (§4.9) and harness manifests (§4.7) from seed templates.

- CLI: `loom procedures list|show|adopt`, `loom harness init`.
- MCP: `procedure_list`, `procedure_show`, `procedure_adopt`, `harness_init`.
- Both surfaces share core functions in `src/blocks/procedures.ts` and
  `src/blocks/harness.ts`; MCP tools are thin wrappers.
- Idempotent by default; `--force` / `overwrite: true` replaces existing
  content. Ownership ritual on seed bodies is preserved until the agent
  removes it.
```

## Testing strategy

- **Unit tests** on shared core (`adoptProcedures`, `listProcedures`,
  `showProcedure`, `initHarness`) against `mkdtemp` roots. Cover: first-time
  create, skip-exists, overwrite, unknown-key, empty-keys, nested-directory
  creation.
- **CLI tests** via `runCliCaptured` — each command form (list table, list
  JSON, show template, show adopted, adopt by key, adopt --all,
  adopt --force, adopt TUI-empty-selection, harness init by name,
  harness init via $LOOM_CLIENT). Mock the multi-select primitive with
  `vi.doMock` as the inject wizard tests do.
- **MCP tests** invoke the tool handlers directly with a temp context dir;
  assert text output and idempotency.
- **Integration test** — drive CLI + MCP through a first-boot scenario:
  fresh context dir → `procedure_list` (all un-adopted) → `procedure_adopt`
  with all 6 keys → `identity()` now includes procedures block → re-running
  adopt reports all `skipped-exists`.

Target suite size: ~377 tests (337 existing + ~40 new).

## Open questions (resolved inline above)

- **MCP symmetry**: yes for adopt/list/show/init; skip show/list for
  harness and model since the LLM can just read the files.
- **Plural naming**: `loom procedures` (plural, matches `memory`/`pursuits`).
  Harness stays singular (`loom harness init`) since it's a one-off action,
  not a collection operation.
- **Overwrite default**: skip-exists. `--force` for replace.
- **Procedure adoption via picker**: TUI shows only un-adopted seeds;
  confirming writes all selected.
- **Content authoring scope**: included in this PR to validate UX and ship
  Jonathan a proper procedures block.

## The thing to remember

> **The primitives we ship now are what the future wizard will compose.**

Overwrite semantics, template-read as a separate primitive, and idempotent
by default aren't polish — they're the hooks a conversational onboarding
flow will need to synthesize customized content over defaults without
losing the ability to preview, re-roll, or accept the seed as-is.
