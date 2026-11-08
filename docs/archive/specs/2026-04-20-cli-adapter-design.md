# CLI adapter — design

**Status:** approved 2026-04-20
**Target release:** v0.4.0-alpha.3
**Related:** v0.4 roadmap ([discussion #10](https://github.com/jbarket/loom/discussions/10))

## Problem

v0.3.x and v0.4.0-alpha.{1,2} expose loom only over MCP stdio. When a
harness can't speak MCP — because it was never wired up, because the
server is down, because the user is debugging from a plain shell — the
stack is mute. The v0.4 arc calls out the fix:

> CLI adapter — `loom wake --client=X` dumps identity to stdout. The
> universal escape hatch. If everything else dies, piping markdown into
> context still works.

This spec broadens that scope: **every MCP tool gets a CLI equivalent**.
The shell becomes a first-class harness.

## Principle

The CLI is a transport wrapper, not a parallel implementation. Existing
tool functions in `src/tools/` already have the shape
`(contextDir, input) → result` — pure business logic that MCP and CLI
can both call. CLI adds argv parsing, stdio handling, and output
rendering. No existing tool function changes semantics.

## Scope

### In-scope (alpha.3)

Ten subcommands mirroring the ten MCP tools, plus `serve` for
explicitness:

| Subcommand | MCP tool | Notes |
|---|---|---|
| `loom wake` | `identity` | markdown-only; `--json` ignored (content, not metadata) |
| `loom recall` | `recall` | human + `--json` |
| `loom remember` | `remember` | body via stdin / `$EDITOR` |
| `loom update` | `update` | body via stdin / `$EDITOR` (optional) |
| `loom forget` | `forget` | scope-guard preserved |
| `loom memory list` | `memory_list` | table / `--json` |
| `loom memory prune` | `memory_prune` | confirmation / `--json` |
| `loom pursuits <action>` | `pursuits` | `list`/`add`/`update`/`complete`/`park`/`resume` |
| `loom update-identity <file> [<section>]` | `update_identity` | IDENTITY.md still immutable |
| `loom bootstrap` | `bootstrap` | interactive readline if TTY |
| `loom serve` | — | explicit alias for current MCP startup |

Existing behavior preserved: `node dist/index.js` with no subcommand
still launches the MCP server. All existing `.mcp.json` files keep
working without edits.

### Out of scope

- HTTP/SSE MCP transport (v0.5+).
- Shell completion scripts (a later chore; the help text will seed it).
- ANSI color in output.
- A structured JSON error envelope (errors stay plain-text on stderr;
  scripts use exit codes).
- Any changes to MCP tool signatures or server wiring.

## Design

### Architecture

```
src/
├── index.ts              # dispatcher (MCP default, CLI on subcommand)
├── cli/
│   ├── index.ts          # runCli(argv) → exit code; handles --help/--version
│   ├── args.ts           # shared parseArgs helpers, global flag resolution
│   ├── io.ts             # stdin/$EDITOR reader, stdout/stderr writers, --json dispatch
│   ├── test-helpers.ts   # runCliCaptured(argv, opts) for tests
│   ├── wake.ts
│   ├── recall.ts
│   ├── remember.ts
│   ├── forget.ts
│   ├── update.ts
│   ├── memory.ts
│   ├── pursuits.ts
│   ├── update-identity.ts
│   ├── bootstrap.ts
│   └── serve.ts
└── tools/                # unchanged — called by both MCP and CLI
```

Each `src/cli/<cmd>.ts` file exports:
- `USAGE` — help text constant (stderr output, testable).
- `async function run(argv: string[], env: Env): Promise<number>` —
  parses argv, calls the tool function, renders output, returns exit
  code.

`src/cli/index.ts::runCli` handles top-level `--help`/`--version`,
pops the subcommand, dispatches to `<cmd>.run()`, and catches uncaught
errors into stderr + exit 1.

### Dispatch (src/index.ts)

```typescript
const CLI_KEYWORDS = new Set([
  'wake','recall','remember','forget','update',
  'memory','pursuits','update-identity','bootstrap','serve',
]);

const first = process.argv[2];
const isCli =
  first === '--help' || first === '-h' ||
  first === '--version' || first === '-V' ||
  (first !== undefined && CLI_KEYWORDS.has(first));

if (isCli) {
  const { runCli } = await import('./cli/index.js');
  process.exit(await runCli(process.argv.slice(2)));
}
// existing MCP startup below, unchanged
```

Any first arg that isn't in `CLI_KEYWORDS` and isn't a CLI flag falls
through to MCP mode. This preserves every current `.mcp.json`
invocation, including those that pass `--context-dir <path>` positionally
after the script name.

### Argument parsing

Native `node:util` `parseArgs` — stable on Node ≥ 20 (already required).
No new dependency. Each subcommand file declares its own option schema.
`src/cli/args.ts` provides a `resolveEnv()` helper that reads global
flags (`--context-dir`, `--client`, `--model`, `--json`) with env
fallback.

### Flag / env precedence

Applies to `contextDir`, `client`, `model`:
1. Explicit flag on the subcommand.
2. Environment variable (`LOOM_CONTEXT_DIR` / `LOOM_CLIENT` / `LOOM_MODEL`).
3. Default (only applies to `contextDir` → `~/.config/loom/default`).

### Body input for write commands

`remember`, `update`, `update-identity`, `bootstrap` accept body text
that can't fit on a flag.

- **Non-TTY stdin** (piped): read body from stdin.
- **TTY stdin, body required, no body yet**: open `$VISUAL ?? $EDITOR ?? 'vi'`
  on a temp file under `tmpdir()/loom-<cmd>-<pid>-<random>.md`. On save,
  read file contents as body. Non-zero editor exit aborts with exit 1
  and leaves the temp file as a breadcrumb (path on stderr).
- **TTY stdin, body optional, no flag needs it** (`update` with only
  `--new-title`): don't open editor.
- **Empty body** after all routes: exit 2 with usage error
  "body cannot be empty".

### Output

**Stream discipline.** `stdout` is the primary artifact (pipe-target):
markdown for `wake`, formatted text for reads, single confirmation
lines for writes, raw JSON when `--json`. `stderr` holds errors,
warnings, interactive prompts, editor-opens notices, and `--help`.

**Human rendering per command.**
- `wake` — markdown from `loadIdentity()`, no decoration.
- `recall` — `formatResults()` from `src/tools/recall.ts` (existing).
- `memory list` — fixed-width table `CATEGORY  TITLE  CREATED  REF`;
  title truncated to `process.stdout.columns` (fallback 80).
- `memory prune` — `Pruned N memor(y|ies):` followed by one ref/line.
- `pursuits list` — prose returned by existing `pursuits()` tool.
- Write confirmations — `Remembered: <category>/<filename> — <title>`.
- `bootstrap` — existing bootstrap()'s prose output.

**`--json` rendering.** `JSON.stringify(value, null, 2) + "\n"` where
`value` is the tool function's structured return. Tools that today
return human strings (`recall`, `pursuits`, `bootstrap`) grow a
sibling that returns structured data; the existing string-returning
function calls the structured one and formats. No MCP-surface change.

**No ANSI color** in alpha.3. Keeps output parse-safe for scripts.

**`--help`.** Each subcommand prints `USAGE` to stderr and exits 0.
Top-level `loom --help` lists all subcommands with one-line summaries.

### Stack-version gate

New helper in `src/config.ts`:

```typescript
export function assertStackVersionCompatible(contextDir: string): void {
  const onDisk = readStackVersion(contextDir);
  if (onDisk !== null && onDisk > CURRENT_STACK_VERSION) {
    throw new Error(
      `Stack at ${contextDir} is version ${onDisk}; ` +
      `this loom build understands up to v${CURRENT_STACK_VERSION}. ` +
      `Upgrade loom.`
    );
  }
  ensureStackVersion(contextDir);
}
```

Both `createLoomServer` (replacing its inline check) and every CLI
command (right after `resolveEnv()`) call it. One canonical place.

### Exit codes

| Code | When |
|---|---|
| 0 | Success |
| 1 | Runtime error (missing context dir, stack-version mismatch, backend failure, editor aborted) |
| 2 | Usage error (bad flag, unknown subcommand, missing required arg, empty body) |
| 3 | Not-found (e.g., `forget <ref>` / `update <ref>` with no match) |
| 130 | Ctrl-C during interactive bootstrap (SIGINT convention) |

## Tests

Each `src/cli/<cmd>.ts` has a sibling `<cmd>.test.ts`. Tests run
**in-process** (not via subprocess): a shared helper captures
stdout/stderr/exit-code by swapping `process.stdout.write` /
`process.stderr.write` / `process.stdin` for the duration of the call.

**`src/cli/test-helpers.ts`:**

```typescript
export async function runCliCaptured(
  argv: string[],
  opts?: { stdin?: string; env?: Record<string,string>; contextDir?: string },
): Promise<{ stdout: string; stderr: string; code: number }>;
```

**Minimum coverage per command:**
1. Happy path — human output (assert key substrings).
2. Happy path — `--json` (parse, assert structure).
3. Missing required arg → exit 2 + usage on stderr.
4. Missing context dir → exit 1 + hint.
5. Write commands: stdin-body path, EDITOR-body path (mock `$EDITOR`
   with a sentinel script), empty-body rejection.
6. Flag/env precedence: flag wins over env.

**Integration test** `src/cli/integration.test.ts`: bootstrap → wake →
remember → recall → update → forget, asserting on each step's stdout
and the cumulative on-disk state.

**Dispatch test** (extend `src/index.test.ts` or create new):
- `argv=[]` → MCP path (assert decision, don't actually start server).
- `argv=['--context-dir','/foo']` → MCP path.
- `argv=['wake']` → CLI path.
- `argv=['unknown']` → MCP path (falls through).

## Out-of-scope (not in this PR)

- HTTP/SSE transport.
- Shell completion scripts.
- ANSI color.
- JSON error envelope.
- Changes to MCP tool surfaces.

## Build order (rough)

1. Scaffold `src/cli/` (runCli, args, io, test-helpers) + `index.ts`
   dispatch + stack-version helper extraction.
2. `loom wake` — smallest command; exercises the pattern.
3. `loom recall` + `loom memory list` — reads with structured output.
4. `loom memory prune` + `loom forget`.
5. `loom remember` — stdin + `$EDITOR` path.
6. `loom update`.
7. `loom update-identity`.
8. `loom pursuits` — sub-subcommand dispatch.
9. `loom bootstrap` — interactive prompts + `--force`.
10. `loom serve` + docs (README CLI section, stack spec §11 adapters,
    CHANGELOG `[0.4.0-alpha.3]`, `package.json` bump) + manual verify
    + PR.

## Definition of done

- All ten subcommands plus `serve` callable from the shell.
- `npx loom --help` lists subcommands; each `<cmd> --help` prints usage.
- Existing `.mcp.json` configs unchanged and still work.
- Vitest suite green (existing + new CLI tests).
- README has a CLI section. Stack spec §11 names the adapter. CHANGELOG
  has an alpha.3 entry. `package.json` bumped.
- Manual verification checklist completed.

## The thing to remember

> **Identity is operational. Voice is substrate.**

The CLI adapter doesn't change who the agent is — it changes how a
harness can reach what the agent already carries. MCP is down? Pipe
`loom wake` into context and keep going.
