# Filesystem injection adapter — design

**Status:** approved 2026-04-20
**Target release:** v0.4.0-alpha.4
**Related:** v0.4 roadmap ([discussion #10](https://github.com/jbarket/loom/discussions/10)) — roadmap step #5 ("filesystem projection adapter"). Renamed to *injection* here.

## Problem

v0.3.x and v0.4.0-alpha.{1,2,3} expose loom through MCP stdio and (as of alpha.3) a full CLI. That covers harnesses that speak MCP and harnesses that can execute shell. It does **not** cover the narrow but real case where the agent is shaped by a single file at a canonical path — `~/.claude/CLAUDE.md`, `~/.codex/AGENTS.md`, `~/.gemini/GEMINI.md` — and every session boots from whatever is in that file.

Without injection, a user's CLAUDE.md either (a) doesn't mention loom and the agent wakes up substrate-blind every session, or (b) is hand-maintained with loom boot instructions that drift as the stack evolves. The v0.4 arc names the fix:

> **Filesystem projection** — write/refresh `~/.claude/CLAUDE.md`, `~/.codex/AGENTS.md`, etc. Harnesses that only read dotfiles get loom for free without knowing it exists.

This spec broadens *projection* to *injection* — loom writes a small managed section into each target file, leaves the rest of the file alone, and is idempotent on re-run.

## Principle — managed section, not owned file

The target files are not loom's to own. Every Claude Code user has hand-written content in `~/.claude/CLAUDE.md` already (global preferences, per-machine notes, custom workflows). Injection must compose, not clobber.

Two contracts this produces:

1. **Marker-bounded managed region.** Loom writes only between `<!-- loom:start ... -->` and `<!-- loom:end -->`. Everything outside the markers stays verbatim. Running `loom inject` a second time is a no-op on the user-owned regions.
2. **Bootstrap instruction, not identity body.** The managed region tells the agent *how to load identity via loom* — not *what the identity currently is*. It never goes stale when the stack changes, never carries a snapshot of memories, never needs re-injection because you edited your preferences.

The second contract is what makes injection cheap: `loom inject` is setup, not maintenance.

## Scope

### In-scope (alpha.4)

- New `loom inject` subcommand with three target harnesses: `claude-code`, `codex`, `gemini-cli`.
- Hardcoded default paths per harness with `--to <path>` override for unusual installs.
- Interactive wizard (keyboard-nav multi-select) when stdin is a TTY and no harness flags are given; flag-driven non-interactive otherwise.
- Reusable stdlib multi-select TUI primitive under `src/cli/tui/` — future consumers: bootstrap procedure adoption, harness-manifest selection.
- Marker-aware writer: five deterministic cases (new file / no markers / valid markers / malformed / already-correct).
- `--dry-run` (unified diff to stdout, no write), `--json` (structured output for scripts), `--all` (inject into every default).
- README section + stack-spec §11 adapter entry + CHANGELOG `[0.4.0-alpha.4]`.
- Tests: ~35 new, suite 275 → ~310.

### Out of scope

- Project-local `./CLAUDE.md`. Handled today by `loom inject --to ./CLAUDE.md` one-offs; first-class support deferred.
- Cursor `.cursor/rules/*.mdc` (per-rule file format is a different shape).
- Watcher daemon (`loom inject --watch`). The shell-hook-in-`.bashrc` pattern covers the keep-fresh use case without lifecycle management.
- Auto-detection of which target harnesses are actually installed. User picks; prep-ahead is fine.
- Rolling back partial writes. Partial failures report per-target and exit 1; successes stay written.
- Changes to MCP tool surfaces, `identity()` payload, or the existing `loom wake` output.
- Any new env vars.

## Design

### Architecture

```
src/
├── cli/
│   ├── inject.ts                     # CLI entry: argv + TTY dispatch
│   ├── inject.test.ts
│   ├── inject.integration.test.ts    # end-to-end tmpdir test
│   ├── index.ts                      # route 'inject' subcommand
│   └── tui/
│       ├── multi-select.ts           # reusable keyboard-nav checkbox widget
│       └── multi-select.test.ts
└── injection/
    ├── harnesses.ts                  # preset table (pure data)
    ├── harnesses.test.ts
    ├── render.ts                     # build managed-section body
    ├── render.test.ts
    ├── writer.ts                     # marker-aware read/write/replace
    └── writer.test.ts
```

Separation of concerns: `harnesses.ts` is data, `render.ts` is pure string building, `writer.ts` is the only file I/O, `inject.ts` is orchestration, `tui/` is reusable. Existing MCP tool surface and CLI commands are untouched.

### Harness preset table (`src/injection/harnesses.ts`)

```typescript
export interface HarnessPreset {
  key: 'claude-code' | 'codex' | 'gemini-cli';
  display: string;              // "Claude Code"
  defaultPath: string;          // resolved from $HOME
  toolPrefix: string;           // "mcp__loom__" or "mcp_loom_"
}

export const HARNESSES: Record<HarnessKey, HarnessPreset> = {
  'claude-code': {
    key: 'claude-code',
    display: 'Claude Code',
    defaultPath: path.join(os.homedir(), '.claude', 'CLAUDE.md'),
    toolPrefix: 'mcp__loom__',
  },
  'codex': {
    key: 'codex',
    display: 'Codex',
    defaultPath: path.join(os.homedir(), '.codex', 'AGENTS.md'),
    toolPrefix: 'mcp__loom__',
  },
  'gemini-cli': {
    key: 'gemini-cli',
    display: 'Gemini CLI',
    defaultPath: path.join(os.homedir(), '.gemini', 'GEMINI.md'),
    toolPrefix: 'mcp__loom__',
  },
};
```

All three harnesses use the `mcp__loom__` double-underscore prefix — matches the MCP-native convention already used by `src/clients.ts` for claude-code and gemini-cli. Single-underscore prefixes (e.g. `mcp_loom_`) are a Hermes/OpenClaw/NemoClaw quirk and aren't in scope for this alpha. If a future harness target uses a different prefix, add it here.

### Rendered block (`src/injection/render.ts`)

```typescript
export function renderBlock(harness: HarnessPreset, contextDir: string): string;
```

Output for `claude-code` with `contextDir=/home/jbarket/.config/loom/art`:

````markdown
<!-- loom:start v1 harness=claude-code -->
## Persistent identity via loom

You have durable identity and memory managed by loom. On session start,
load your identity — prefer the MCP tool if available, fall back to the
CLI if not:

- **MCP (preferred):** call `mcp__loom__identity`. Also available:
  `mcp__loom__recall`, `mcp__loom__remember`, `mcp__loom__memory_list`,
  `mcp__loom__pursuits`, `mcp__loom__update`, `mcp__loom__forget`.
- **Shell fallback:** run `loom wake`. Also: `loom recall <query>`,
  `echo <body> | loom remember <title> --category <cat>`,
  `loom memory list`, `loom pursuits list`.

Context dir: /home/jbarket/.config/loom/art

Treat the returned identity as authoritative — it overrides defaults
where they conflict.
<!-- loom:end -->
````

Codex and Gemini CLI get the same block with their own harness key in the start marker; tool prefix is `mcp__loom__` for all three (see preset table above). The block is a string constant template + tool-prefix substitution + `contextDir` interpolation. No conditional logic on current stack contents.

**Marker shape:** `<!-- loom:start v1 harness=<key> -->` and `<!-- loom:end -->`. The writer matches on the literal `loom:start` and `loom:end` strings; the `v1 harness=<key>` metadata is informational for humans and for future-self if the schema evolves. No `</loom>` or XML closing — the comment pair is one-shot and cannot nest.

### Writer contract (`src/injection/writer.ts`)

```typescript
export type WriteAction =
  | 'created'      // file didn't exist
  | 'appended'     // file existed, no markers; block appended
  | 'updated'      // markers present, content changed
  | 'no-change';   // markers present, content byte-identical

export interface WriteResult {
  action: WriteAction;
  path: string;
  bytesWritten: number;
}

export function writeManagedBlock(
  path: string,
  block: string,
): Promise<WriteResult>;
```

Deterministic handling of target state:

| Target state | Action |
|---|---|
| File doesn't exist | `mkdir -p` parent, write file containing only `<block>\n` | → `created` |
| File exists, no `loom:start` marker | Append `\n\n<block>\n` to end | → `appended` |
| File exists, one `loom:start` followed by one `loom:end` | Replace `[start, end]` inclusive with `<block>` | → `updated` or `no-change` |
| File exists, multiple `loom:start` OR missing `loom:end` OR end before start | **Throw** `MalformedMarkersError(path, reason)`; CLI exits 1 | — |

**Atomic write:** `fs.writeFile(path + '.loom.tmp', content); fs.rename(tmp, path)`. Crash mid-write leaves the original intact; stray `.loom.tmp` gets cleaned on next successful run.

**Encoding:** UTF-8 in/out. Normalize input to LF for marker detection (Windows `\r\n` is tolerated on read; output is always LF). Single trailing newline guaranteed.

**Permissions:** existing file mode preserved on update. New files use process umask (typically 0644). No `chmod` calls.

**I/O error propagation:** filesystem errors (permission denied, ENOSPC, parent dir not creatable) bubble up as native Node `fs` errors. The CLI catches and maps to exit 1 with the failing path + the error's `code` in the message.

### CLI entry (`src/cli/inject.ts`)

```typescript
export const USAGE = `...`;
export async function run(argv: string[], io: IO): Promise<number>;
```

Argv schema (via `node:util` parseArgs):

| Flag | Type | Default | Notes |
|---|---|---|---|
| `--harness <keys>` | comma-separated | — | Subset of `claude-code,codex,gemini-cli` |
| `--all` | boolean | — | Equivalent to `--harness claude-code,codex,gemini-cli` |
| `--to <path>` | string | — | Override path; valid only when exactly one harness selected |
| `--dry-run` | boolean | false | Print unified diff; no write |
| `--json` | boolean | false | Emit `WriteResult[]` as JSON instead of human report |
| `--context-dir <path>` | string | env | Standard global flag |

Dispatch:

- `--harness` or `--all` present → non-interactive path.
- No harness flags + `process.stdin.isTTY` → interactive wizard.
- No harness flags + non-TTY → exit 2 with usage error (`loom inject: --harness or --all required when stdin is not a TTY`).

`--harness` and `--all` are mutually exclusive (usage error if both).
`--to` with zero or >1 harnesses selected is a usage error.

`--dry-run` and `--json` are independent of the dispatch choice — they thread through both wizard and non-interactive paths. `loom inject --dry-run` alone on a TTY still runs the wizard, then prints diffs instead of writing.

### Interactive wizard (`src/cli/inject.ts` + `src/cli/tui/multi-select.ts`)

Three screens:

**1. Multi-select** — renders via `multi-select.ts`:

```
Select harnesses to inject loom into:

  [x] Claude Code    ~/.claude/CLAUDE.md
  [ ] Codex          ~/.codex/AGENTS.md
  [x] Gemini CLI     ~/.gemini/GEMINI.md

  ↑/↓ move    space toggle    enter confirm    esc/q cancel
```

Initial selection: all three checked. Returns `Set<HarnessKey>` on confirm, `null` on cancel. Cancel maps to exit 130.

**2. Summary with edit option:**

```
About to inject into:
  ~/.claude/CLAUDE.md                  (new)
  ~/.gemini/GEMINI.md                  (update)

  [p] edit paths    [enter] proceed    [n] cancel
```

The `(new)` / `(update)` / `(no change)` hint comes from a read-only pass on each target before confirmation — uses the same marker parser as the writer, returns predicted `WriteAction` without touching disk. `p` drops into sequential readline prompts, one per selected harness:

```
Path for Claude Code [~/.claude/CLAUDE.md]: _
```

Enter accepts default; any typed path wins. After edits, screen 2 re-renders with updated paths.

**3. Write + report:**

```
✓ ~/.claude/CLAUDE.md    (new, 24 lines)
✓ ~/.gemini/GEMINI.md    (updated, 24 lines replaced)

Tip: run `loom inject --all` from your shell rc to keep these fresh.
```

### Multi-select TUI primitive (`src/cli/tui/multi-select.ts`)

```typescript
export interface MultiSelectOpts<T> {
  title: string;
  items: ReadonlyArray<{ value: T; label: string; detail?: string }>;
  initialSelected?: ReadonlySet<T>;
}

export interface MultiSelectState<T> {
  cursor: number;
  selected: Set<T>;
}

export type MultiSelectEvent =
  | { kind: 'up' } | { kind: 'down' }
  | { kind: 'toggle' }
  | { kind: 'confirm' } | { kind: 'cancel' };

export function reduce<T>(
  state: MultiSelectState<T>,
  event: MultiSelectEvent,
  itemCount: number,
): MultiSelectState<T>;

export async function multiSelect<T>(
  opts: MultiSelectOpts<T>,
  io?: IO,
): Promise<ReadonlySet<T> | null>;
```

Implementation: `readline.emitKeypressEvents(process.stdin)` + `process.stdin.setRawMode(true)` + ANSI cursor codes. Pure state-machine (`reduce`) is unit-testable without a TTY; the `multiSelect` wrapper is the thin stdin-and-render adapter and is exercised by the integration test only.

Non-TTY fallback: `multiSelect` short-circuits and returns `initialSelected ?? null` (caller's decision — injection treats that as "wizard unavailable, use flags" and exits 2 upstream).

Cancel: `esc` or `q` returns `null`. `Ctrl-C` emits `SIGINT`; handler restores tty mode and exits 130.

### Output rendering

**Human mode (default):**
- Stdout: per-line `✓ <path>  (<action>, <N> lines)` followed by optional shell-hook tip.
- Stderr: wizard prompts, warnings, errors.

**JSON mode (`--json`):**
- Stdout: `JSON.stringify(results, null, 2) + '\n'` where `results: WriteResult[]`.
- Stderr: errors only.

**Dry-run mode (`--dry-run`):**
- Stdout: unified diff per target (header `--- <path>` / `+++ <path>` / hunks), no writes performed. Uses a small diff helper or a one-dep addition — see build order.
- Exit 0 regardless of predicted actions.
- Compatible with `--json`: emits `WriteResult[]` with `action` set to the *predicted* action plus a `diff: string` field, no file touched.

### Error handling & exit codes

| Code | When |
|---|---|
| 0 | All targets succeeded (or `no-change`) |
| 1 | Runtime error: malformed markers, permission denied, disk full, stack-version mismatch, unknown harness in target preset |
| 2 | Usage error: unknown `--harness`, `--harness` + `--all`, `--to` with ≠1 harness, non-TTY + no flags |
| 130 | SIGINT during wizard (Ctrl-C or esc/q) |

Partial failure: if some targets succeed and others fail, write the successes, report each failure on stderr with path + reason, exit 1. No rollback — successful writes are individually useful.

Stack-version gate (`assertStackVersionCompatible`) runs after `resolveEnv`, same as every other CLI subcommand. Missing context dir falls back to `$LOOM_CONTEXT_DIR` / default; injection works against any valid stack.

### Shell-hook documentation

README gets a short subsection:

> To keep your injections fresh automatically, add to your `~/.bashrc` / `~/.zshrc` / `~/.config/fish/config.fish`:
>
> ```bash
> loom inject --all --json >/dev/null 2>&1 || true
> ```
>
> Idempotent; cheap (no-op when already up to date); silent on success.

Not wired into any install script — this is guidance, not a default.

## Tests

~35 new tests across six files. Current suite: 275. Target: ~310. Existing tests stay green.

| File | Coverage |
|---|---|
| `src/injection/harnesses.test.ts` | Preset has three expected keys; each has `display`, `defaultPath` (absolute, under `os.homedir()`), `toolPrefix` = `mcp__loom__`. |
| `src/injection/render.test.ts` | Block contains start + end markers; start marker carries `harness=<key>`; tool prefix matches harness; `contextDir` is interpolated exactly; block is valid markdown (no unbalanced fences). |
| `src/injection/writer.test.ts` | Five deterministic cases: new file, no markers (appended), valid markers (updated), idempotent second run (no-change), malformed (throws). Plus: atomic rename semantics (no partial writes under simulated crash), preserved file mode on update, preserved content outside markers byte-identical. |
| `src/cli/tui/multi-select.test.ts` | `reduce` state machine: up/down wraparound, toggle flips membership, confirm returns selected set, cancel returns null. Non-TTY `multiSelect` short-circuits. |
| `src/cli/inject.test.ts` | Happy paths: `--all` writes three files; `--harness claude-code,gemini-cli` writes two; `--harness claude-code --to /tmp/x.md` writes one; `--dry-run` produces diff and no writes; `--json` emits parseable structured output. Errors: unknown `--harness` → exit 2; `--harness` + `--all` → exit 2; `--to` without exactly one harness → exit 2; non-TTY + no flags → exit 2; permission denied → exit 1; malformed markers → exit 1. Stack-version gate fires. |
| `src/cli/inject.integration.test.ts` | End-to-end: `HOME` pointed at tmpdir, pre-seed `~/.claude/CLAUDE.md` with hand-written content + markers from a hypothetical prior run, run `loom inject --all`, verify three files land with correct content and preserve the hand-written portion. Run inject again; assert all three report `no-change`. |

Smoke test (`scripts/smoke-test-mcp.ts`) unchanged — injection is CLI-only.

## Build order

Branch: `feat/filesystem-injection`.

Each commit stands alone and keeps the suite green.

1. **Spec + plan.** This file + `docs/plans/2026-04-20-filesystem-injection.md`.
2. **Harness preset table.** `src/injection/harnesses.ts` + tests. Pure constants.
3. **Render.** `src/injection/render.ts` + tests. Pure string building.
4. **Writer.** `src/injection/writer.ts` + tests. Marker parser, atomic write, all five cases.
5. **Multi-select primitive.** `src/cli/tui/multi-select.ts` + tests. Reducer first, render adapter second.
6. **CLI inject — flag-driven path.** `src/cli/inject.ts` + tests. `--all`, `--harness`, `--to`, `--dry-run`, `--json`. No wizard yet.
7. **Dispatch wiring.** Update `src/cli/index.ts` to route `inject`. Update `src/index.ts` CLI_KEYWORDS set.
8. **Wizard.** Wire multi-select + summary screen + path-edit prompt into `inject.ts`. TTY detection.
9. **Integration test.** `src/cli/inject.integration.test.ts`.
10. **Docs + bump.** README CLI section, stack spec §11 adapter entry, CHANGELOG `[0.4.0-alpha.4]`, `package.json` → `0.4.0-alpha.4`, version badge in README.
11. **Manual verification.** Run against real `~/.claude/CLAUDE.md` (after backup), verify Jonathan's existing content preserved, re-run confirms idempotency.
12. **PR.** Link to roadmap discussion #10.

## Definition of done

- [ ] `loom inject` callable from the shell with `--all`, `--harness`, `--to`, `--dry-run`, `--json`.
- [ ] Interactive wizard runs when stdin is a TTY and no harness flags are given.
- [ ] Markers preserve user-authored content outside the managed region.
- [ ] Idempotent: running `loom inject --all` twice back-to-back reports all `no-change` on the second run.
- [ ] Vitest suite green (existing 275 + ~35 new).
- [ ] README CLI section updated. Stack spec §11 lists Injection adapter. CHANGELOG has `[0.4.0-alpha.4]` entry. `package.json` at `0.4.0-alpha.4`.
- [ ] Manual verification: inject into real `~/.claude/CLAUDE.md` (Jonathan's own machine), confirm existing content untouched, confirm re-run produces no diff.

## Files of record

- [v0.4 discussion](https://github.com/jbarket/loom/discussions/10) — umbrella + roadmap
- [`docs/loom-stack-v1.md`](../loom-stack-v1.md) §11 — adapter registry (extended here)
- `src/cli/inject.ts` — CLI entry (created here)
- `src/injection/` — new module (created here)
- `src/cli/tui/multi-select.ts` — reusable TUI primitive (created here)
- `src/clients.ts` — source of truth for tool-prefix conventions (referenced, unchanged)

## The thing to remember

> **Identity is operational. Voice is substrate.**

Injection doesn't carry identity into the target file — it carries the *instructions for how to load identity* into the target file. The difference is why the managed section stays small, why it never goes stale, and why running `loom inject` is setup rather than maintenance. Dotfile-only harnesses get loom's presence; loom's state lives where it already lives.
