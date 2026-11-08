# Install + Setup Skill: Skill-driven Onboarding

**Date:** 2026-04-21
**Target release:** v0.4.0-alpha.6
**Stack spec sections:** v1 §4 (context dir layout), §4.7 (harness manifests),
§4.9 (procedures), §11 (Adapters). Adds §13 (Multi-agent layout) and §14
(Git-backed agent dirs) — see §Stack-spec updates below.

---

## Problem

A first-time user wants to evaluate loom. The shortest honest path today is:

1. `git clone`, `npm ci`, `npm run build`.
2. Hand-write a `.mcp.json` / `config.toml` / `settings.json` stanza for
   their harness, guessing the right path, transport, and env var names.
3. Run `bootstrap` by crafting a JSON payload in the right MCP tool.
4. Run `inject` and `procedures adopt` and `harness init` from memory.
5. Restart the harness. Discover something was wrong. Start over.

Every step is a cliff. The primitives for doing each step are already
shipping (`loom bootstrap`, `loom inject`, `loom procedures adopt`,
`loom harness init`, `loom wake --json`), but there is no cohesive flow
that pulls them together for a new user — and the part the user actually
cares about ("am I set up?") is the part we leave to them.

This spec closes the first-run gap by shipping two small CLI primitives
(`loom install`, `loom doctor`) plus one bundled skill (`SKILL.md`) that
the target harness itself executes. The CLI handles the one thing that
must run outside a harness (getting the skill file into the user's
harness skills dir). The skill handles the one thing that can't be
hard-coded (per-harness MCP-config plumbing) by using the harness's
own file-editing tools with verification.

## Scope (alpha.6)

Ships:

- `loom install` — TTY-only single-select TUI to pick a target harness,
  then writes `SKILL.md` to that harness's skills directory. `--harness
  <key>`, `--to <path>`, `--dry-run`, `--json`, `--force` for scripting.
  "Other" target vomits the skill to `./loom-setup-skill.md` in cwd.
- `loom doctor` — JSON-first environment probe the skill calls. Reports
  node version, stack version compat, `LOOM_CONTEXT_DIR` resolution,
  existing agents under `~/.config/loom/*`, harness config-file
  existence + loom stanza presence, and forward-looking git fields
  (`initialized`, `hasRemote`, `dirty`) on each agent dir. Pure read;
  never writes.
- `assets/skill/SKILL.md` — bundled with the package, shipped verbatim.
  Frontmatter (`name: loom-setup`, `description: …`). Runs a linear
  script: doctor → interview → bootstrap → procedures adopt → harness
  init → MCP-config edit (verify-before-write) → inject → wake verify →
  tell user to restart harness.
- Harness registry (`src/install/harnesses.ts`) covering four targets
  (claude-code, codex, gemini-cli, opencode) + "other". Per-entry:
  canonical skills dir, config file path, tool-prefix convention,
  restart instruction, next-step invocation string.
- `LOOM_STACK_VERSION` knowledge of multi-agent layout and git-backed
  dirs (stack spec v1 §13 + §14) so future `agents` / `snapshot` /
  `memory export` adapters land on a documented footing.
- README rewrite of the Quick Start section: from "clone, build,
  hand-edit MCP config" to "`npx loom install`, open harness, run
  `/loom-setup`".
- CHANGELOG + version bump to `0.4.0-alpha.6`.

## Non-goals

- **`loom agents list|switch|current`** — the canonical-path +
  reserved-names invariants land in this spec, but the CLI surface ships
  in alpha.7+. The skill interview treats `LOOM_CONTEXT_DIR` as the
  only pointer.
- **`loom snapshot` / `loom memory export|import --jsonl`** — the
  memories.db-is-derivable-cache invariant is documented, and doctor
  reports git state on each agent dir, but we don't run `git init` for
  the user in alpha.6. Users who want portability can `git init` their
  agent dir today; the tooling that automates it ships in alpha.7+.
- **GUI / browser onboarding** — TTY only. `npx loom install` without
  a TTY and without `--harness` errors out.
- **Windows harness detection** — the registry encodes Linux/macOS
  canonical paths. Windows users fall through to the "Other" branch
  until a Windows pass in a later alpha.
- **Auto-editing `.mcp.json` from the CLI** — explicitly rejected. The
  skill edits harness configs via the harness's own file tools with
  read-verify-write; the CLI never shells out to edit config files it
  doesn't own.

## Architecture

Two surfaces, split by what drifts:

- **CLI (`loom install`, `loom doctor`)** — owns loom-controlled,
  testable work: writing the skill file to a known path, probing
  environment state, emitting structured JSON. Ships compiled,
  versioned with loom, tested in vitest.
- **Skill (`SKILL.md`)** — owns harness-specific knowledge that rots:
  where `.mcp.json` lives this month, how a harness likes its tool
  prefix spelled, how to get a model to actually restart. Prose + a
  short recipe. The agent executing the skill solves drift by reading
  the current filesystem state before writing. If a path moved, the
  agent notices; we don't have to ship a patch.

The skill composes existing primitives — it calls `loom bootstrap`,
`loom procedures adopt --all`, `loom harness init`, `loom inject`, and
`loom wake --json` — rather than re-implementing their logic. The skill
only does two things the CLI can't: (1) interview the user for a name
+ purpose + voice, and (2) edit the harness's MCP-config file with
verification.

Verification is always `loom wake --json` at the end. If it fails, the
skill diagnoses from its output and loops; it doesn't declare success
on side-effects alone. This mirrors the procedures/verify-before-
completion norm already baked into Art's identity.

## Components & File Structure

**New files:**

- `assets/skill/SKILL.md` — real markdown file with YAML frontmatter,
  bundled via `package.json` `files`. Copied verbatim on install; no
  templating. Frontmatter:
  ```yaml
  ---
  name: loom-setup
  description: Set up loom (persistent identity + memory) for this agent
  ---
  ```
- `src/install/harnesses.ts` — registry:
  ```ts
  export interface InstallTarget {
    key: 'claude-code' | 'codex' | 'gemini-cli' | 'opencode' | 'other';
    label: string;
    skillDir: string | null;        // null = 'other'
    mcpConfigHint: string | null;   // path for skill prose, not CLI use
    invoke: string;                 // e.g. "/loom-setup" or "use the loom-setup skill"
    restart: string;                // human-readable restart instruction
    toolPrefix: 'mcp__loom__' | 'mcp_loom_' | 'loom_';
  }
  export const INSTALL_TARGETS: readonly InstallTarget[];
  ```
  Canonical paths (Linux/macOS):
  | key          | skillDir                   | mcpConfigHint               | toolPrefix   |
  |--------------|----------------------------|-----------------------------|--------------|
  | claude-code  | `~/.claude/skills/`        | `~/.claude.json` or `.mcp.json` in project | `mcp__loom__` |
  | codex        | `~/.agents/skills/`        | `~/.codex/config.toml`      | `mcp_loom_`  |
  | gemini-cli   | `~/.agents/skills/`        | `~/.gemini/settings.json`   | `mcp_loom_`  |
  | opencode     | `~/.agents/skills/`        | `~/.config/opencode/config.json` | `loom_`  |
  | other        | `null`                     | `null`                      | `mcp_loom_`  |
- `src/install/skill-source.ts` — resolves the bundled `SKILL.md` path
  relative to `dist/` at runtime (works in both source dev and
  published `npx` installs).
- `src/install/render.ts` — idempotent writer: given target key +
  destination path, copies `SKILL.md` and returns
  `{ path, action: 'created' | 'skipped-exists' | 'overwritten' }`.
- `src/cli/install.ts` — `loom install` entry point. Loads `harnesses.ts`
  registry, runs single-select TUI (reuses
  `src/cli/tui/multi-select.ts` in single-select mode — see Task 0
  below), resolves destination, calls `render.ts`, prints next-step
  block scaled to the chosen target.
- `src/cli/doctor.ts` — `loom doctor` entry point. Pure probe. Exits
  0 on successful probe regardless of findings (health is the
  *output*, not the exit code).
- `src/cli/doctor.test.ts`, `src/cli/install.test.ts`,
  `src/install/render.test.ts`, `src/install/harnesses.test.ts` —
  vitest coverage. TUI path tested via mocked stdin pattern already
  used in `multi-select.test.ts`.

**Modified files:**

- `src/cli/subcommands.ts` — register `install` and `doctor` subcommand
  dispatch.
- `src/cli/index.ts` — help text lists the two new subcommands.
- `src/cli/tui/multi-select.ts` — add `single: boolean` option to the
  reducer. Existing multi-select consumers pass `single: false`
  explicitly (no behavioral change). (Task 0; precondition for install
  TUI.)
- `package.json` — `"version": "0.4.0-alpha.6"`; `"files"` array gains
  `"assets"`.
- `CHANGELOG.md` — new `[0.4.0-alpha.6]` section; compare link for
  alpha.6 and update Unreleased.
- `README.md` — Quick Start rewrites to `npx loom install` +
  `/loom-setup`. Existing per-command sections (inject, procedures,
  harness init) stay as reference but move below Quick Start.
- `docs/loom-stack-v1.md` — two new sections:
  - §13 (Multi-agent layout) — canonical path, name validation,
    reserved names, self-containment invariant, pointer-slot contract.
  - §14 (Git-backed agent dirs) — rationale (portability + unfuck),
    what should and shouldn't be committed, `memories.db` is
    derivable-cache architectural invariant.

## Data Flow

### Flow 1 — `loom install` (outside any harness)

```
user: npx loom install
  └─► resolve TTY — if not TTY and no --harness: error
  └─► load INSTALL_TARGETS from harnesses.ts
  └─► single-select TUI: "which harness do you want loom setup in?"
  │    claude-code / codex / gemini-cli / opencode / other
  └─► resolve destination path (skillDir + SKILL.md)
  │    override with --to if provided
  │    'other' branch: ./loom-setup-skill.md in cwd
  └─► render.ts: ensure dir, write (or skip-exists, or overwrite with --force)
  └─► print next-step block scaled to target:
       "Open claude-code. Run /loom-setup to finish setup."
       (or equivalent per target.restart + target.invoke)
```

`--json` emits `{ target, path, action }` and suppresses the prose
next-step block.

### Flow 2 — `/loom-setup` skill (inside the harness)

```
agent in harness: /loom-setup  (or equivalent invocation)
  └─► run: loom doctor --json
  └─► parse output. Surface findings:
  │    - existingAgents: [{ name, path, hasIdentity }, …]
  │    - stackVersionOk, nodeOk, contextDirResolved
  │    - harnessConfigExists, loomStanzaPresent
  │    - git: { initialized, hasRemote, dirty, gitignorePresent } per agent
  └─► if existingAgents.length > 0:
  │      acknowledge each, offer to use one (sets LOOM_CONTEXT_DIR),
  │      OR create a new name (validate, refuse collisions)
  │    else:
  │      interview for name (ask; validate regex + reserved list),
  │      purpose, voice, primary harness
  └─► run: loom bootstrap --name <name> --purpose ... --voice ... --context-dir <path>
  │    (skill generates the JSON and pipes via stdin)
  └─► run: loom procedures adopt --all --context-dir <path>
  └─► run: loom harness init <harnessKey> --context-dir <path>
  └─► MCP config edit — the part only the agent can do safely:
  │    - read current harness config file (.mcp.json / config.toml / settings.json)
  │    - if loom stanza already correct: skip
  │    - else: add/replace the loom stanza referencing LOOM_CONTEXT_DIR,
  │           LOOM_CLIENT, LOOM_MODEL
  │    - verify with a re-read of the file
  └─► run: loom inject --harness <harnessKey> --context-dir <path>
  │    (identity pointer in harness dotfiles)
  └─► run: loom wake --json --context-dir <path>
  │    - on success: tell user "all set; restart <harness> and you'll wake as <name>"
  │    - on failure: diagnose from wake error, loop on the failing step
```

The skill never runs `bootstrap --force`. If a name collision
is detected (dir exists, has `IDENTITY.md`), it refuses and re-asks.

## Safety for existing setups

Rule: existing agent dirs are inviolable without an explicit destructive
action the user typed themselves. No skill step, no CLI default, and no
flag combination invented by this spec overrides it.

Mechanics:

- `loom doctor --json` enumerates `~/.config/loom/*` and emits
  `existingAgents: [{ name, path, hasIdentity, hasMemoriesDb,
  hasProcedures, git: {...} }]`. This is read-only; doctor writes
  nothing.
- The skill's first substantive step after doctor is to acknowledge
  every existing agent by name. If any exist, it asks whether the
  user wants to (a) use one of them (just sets `LOOM_CONTEXT_DIR`,
  runs inject + MCP config edit + wake verify — no identity writes),
  (b) create a new agent with a new name, or (c) bail.
- `loom bootstrap` already refuses non-empty dirs without `--force`.
  The skill never proposes `--force`. If a new-name collision somehow
  resolves to an existing dir (user typed the same name), the skill
  re-asks.
- Name validation lives in one place
  (`src/install/names.ts::validateAgentName`): regex
  `^[a-z0-9][a-z0-9-]*$`, length 1–64, and a reserved list:
  `current`, `default`, `config`, `backups`, `cache`, `tmp`, `shared`.
  Reserved names anticipate the alpha.7+ `agents switch` pointer
  (`~/.config/loom/current` symlink or file), snapshot storage, and
  a shared-resources slot.
- Idempotency is the recovery story for mid-flow errors. If the skill
  fails on step 5 of 8, re-running it re-reads doctor state, sees
  steps 1–4 already done, and resumes.

## Multi-agent Architecture + Git-backed Agent Dirs

alpha.6 doesn't ship the multi-agent CLI surface, but it commits the
architecture so alpha.7+ slots in cleanly.

**Canonical path.** `~/.config/loom/<name>/`. `LOOM_CONTEXT_DIR`
overrides for advanced users, but the skill interview defaults to the
canonical path. No other layout is documented or supported.

**Name validation.** One regex, one reserved list, one module:
`src/install/names.ts::validateAgentName(name: string): {ok:true}
| {ok:false, reason:string}`. Used by `loom install` (n/a —
install doesn't take names), `loom doctor` (when parsing dir
names for the `existingAgents` report — invalid-named dirs are
flagged, not filtered), `loom bootstrap` (validates `--name`;
currently bootstrap accepts any string — tightening lands in this
spec), and the skill's interview loop.

**Reserved names.** `current`, `default`, `config`, `backups`, `cache`,
`tmp`, `shared`. Rationale baked into code comments:
- `current` / `default` — pointer slot for `agents switch`.
- `config` — loom-wide config (not agent-scoped) if we ever need it.
- `backups` / `cache` — storage slots adjacent to agents.
- `tmp` — scratch slot used by `memory export` working dir.
- `shared` — shared prompts / templates across agents.

**Self-containment invariant.** Everything needed to resurrect an agent
lives under `~/.config/loom/<name>/`. Nothing outside that dir is
required to make the agent function. `fastembed` model cache
(`~/.cache/loom/fastembed/`) is explicitly excluded from self-
containment: it's a shared, re-downloadable artifact, not agent data.

**Git-backed agent dirs.** Rationale: (1) portability — `git clone`
to a new machine gets the agent back; (2) unfuck — `git reset --hard`
rolls a bad upgrade off an agent you care about.

Architectural commitments in alpha.6, even without CLI surface:

- **Canonical `.gitignore`** at the agent-dir root lists what should
  *not* be committed. `memories.db`, `memories.db-wal`, `memories.db-shm`,
  `*.log`. The skill doesn't write this file in alpha.6 — but the
  stack spec §14 documents it, and `loom doctor --json` reports
  `.gitignore` presence as one of its git fields.
- **memories.db is a derivable cache.** Canonical form of a memory is
  its JSONL representation (emitted today by `loom memory list
  --json`); embeddings are deterministic for a given model +
  backend; `memories.db` is a materialized index. This has two
  consequences that alpha.6 must not break:
  1. `memories.db` in `.gitignore` is not data loss.
  2. `loom memory export --jsonl` (alpha.7+) + `loom memory import
     --jsonl` (alpha.7+) is the canonical export/import pair; the
     DB file itself is not.
  Nothing ships that contradicts this in alpha.6.
- **`loom doctor` reports forward-looking git fields** per agent:
  `git: { initialized: boolean, hasRemote: boolean, dirty: boolean,
  gitignorePresent: boolean }`. In alpha.6 these will typically all
  be `false` / `false` / `false` / `false` for fresh agents; the
  fields exist so alpha.7+ snapshot tooling can light up without a
  doctor schema change. Surfaced in the skill only when one is true
  (don't spam users).

Alpha.7+ roadmap (explicitly not in this spec, but the invariants
above must be consistent with):

- `loom agents list|current|switch <name>`.
- `loom snapshot [--message <m>]` — commits current agent dir state.
- `loom memory export --jsonl > ...`, `loom memory import --jsonl < ...`.
- Optional post-setup `git init` + initial snapshot, offered by the
  install skill once the plumbing exists.

## Stack-spec updates

`docs/loom-stack-v1.md` gains two sections in this release:

- **§13 Multi-agent layout.** Canonical path, name validation rules,
  reserved-names list with rationale per entry, self-containment
  invariant, `LOOM_CONTEXT_DIR` override semantics, pointer-slot
  contract (forward-declared; `agents switch` lands later).
- **§14 Git-backed agent dirs.** Rationale, canonical `.gitignore`,
  `memories.db` as derivable cache, export/import contract
  (forward-declared), snapshot contract (forward-declared), doctor
  reporting contract.

Adapter table (§11) gains a row: **Install + Setup Skill** (alpha.6).

## Testing

Per-file vitest coverage for the new CLI + install modules. Keyboard-
nav TUI tested via the mocked-stdin harness already used in
`src/cli/tui/multi-select.test.ts`. `loom doctor --json` output
shape tested against a fixture context dir with and without an
existing agent. `loom install --json --dry-run` asserts no write
occurred. Skill smoke: `assets/skill/SKILL.md` parses as YAML
frontmatter + markdown body (no render engine; just a shape check
against `gray-matter`-style parsing).

End-to-end manual validation: run `loom install` in a throwaway
`LOOM_CONTEXT_DIR`, pick claude-code, open Claude Code, run
`/loom-setup`, confirm a fresh agent appears under
`~/.config/loom/<name>/`, restart Claude Code, confirm
`mcp__loom__identity` returns the new identity.

## Open questions

None remaining — user approved the design verbally 2026-04-21. Task
decomposition and step-by-step plan will be produced by the writing-
plans skill in the next session step.
