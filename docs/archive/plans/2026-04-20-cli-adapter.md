# CLI Adapter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give every MCP tool a CLI equivalent so the shell works as a first-class harness; `node dist/index.js` with no subcommand still launches the MCP server (backward-compat).

**Architecture:** Thin CLI dispatcher in `src/cli/` that parses argv, calls existing pure tool functions in `src/tools/` (and backends where needed for `--json` structured output), and renders to stdout/stderr. `src/index.ts` routes by inspecting `argv[2]`.

**Tech Stack:** TypeScript strict, ESM, Node ≥ 20 (`node:util` `parseArgs`, `node:readline/promises`, `node:child_process` for `$EDITOR`), Vitest 4, DCO sign-off required.

---

## Preflight

**Branch:** `feat/cli-adapter` already created on top of `main` (includes the design spec commit).

**Commit discipline:** every commit ends with a DCO sign-off — use `git commit -s`.

**Working directory:** `/home/jbarket/Code/loom`.

**Reference docs:**
- Design spec: `docs/specs/2026-04-20-cli-adapter-design.md` — the source of truth. If this plan and the spec disagree, the spec wins.
- `docs/loom-stack-v1.md` — stack schema reference.

**Before starting any task, verify:**

```bash
git status                 # tree clean
git branch --show-current  # feat/cli-adapter
npx vitest run             # 208 passing
```

---

## Task 1: Scaffolding + dispatch + stack-version helper

**Files:**
- Create: `src/cli/index.ts`
- Create: `src/cli/args.ts`
- Create: `src/cli/io.ts`
- Create: `src/cli/test-helpers.ts`
- Create: `src/cli/test-helpers.test.ts`
- Create: `src/cli/dispatch.test.ts`
- Modify: `src/config.ts` (add `assertStackVersionCompatible`)
- Modify: `src/server.ts` (replace inline stack-version check with helper)
- Modify: `src/index.ts` (add subcommand dispatch before MCP startup)

The goal is plumbing only: no real subcommand yet. `runCli` handles
`--help` / `--version` at the top level and otherwise returns exit
code `2` (unknown subcommand). Commands land in Tasks 2–10.

- [ ] **Step 1.1: Write the failing stack-version helper test**

Create `src/config.test.ts` if it doesn't exist, or append to it. Check first:

```bash
ls src/config.test.ts 2>&1
```

Append this block (add imports at top as needed):

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertStackVersionCompatible, CURRENT_STACK_VERSION, STACK_VERSION_FILE } from './config.js';

describe('assertStackVersionCompatible', () => {
  let tempDir: string;
  beforeEach(async () => { tempDir = await mkdtemp(join(tmpdir(), 'loom-stack-gate-')); });
  afterEach(async () => { await rm(tempDir, { recursive: true, force: true }); });

  it('stamps current version when missing', async () => {
    assertStackVersionCompatible(tempDir);
    const { readFile } = await import('node:fs/promises');
    const stamp = await readFile(join(tempDir, STACK_VERSION_FILE), 'utf-8');
    expect(stamp.trim()).toBe(String(CURRENT_STACK_VERSION));
  });

  it('accepts a stamp equal to CURRENT_STACK_VERSION', async () => {
    await writeFile(join(tempDir, STACK_VERSION_FILE), `${CURRENT_STACK_VERSION}\n`);
    expect(() => assertStackVersionCompatible(tempDir)).not.toThrow();
  });

  it('refuses a stamp ahead of CURRENT_STACK_VERSION', async () => {
    await writeFile(join(tempDir, STACK_VERSION_FILE), `${CURRENT_STACK_VERSION + 1}\n`);
    expect(() => assertStackVersionCompatible(tempDir)).toThrow(/Upgrade loom/);
  });
});
```

- [ ] **Step 1.2: Run the test to verify it fails**

```bash
npx vitest run src/config.test.ts
```

Expected: FAIL — `assertStackVersionCompatible is not a function` (or similar).

- [ ] **Step 1.3: Implement the helper in `src/config.ts`**

Append to `src/config.ts`:

```typescript
/**
 * Refuse to operate against a stack at a higher version than this build
 * understands; stamp the current version if the file is missing.
 */
export function assertStackVersionCompatible(contextDir: string): void {
  const onDisk = readStackVersion(contextDir);
  if (onDisk !== null && onDisk > CURRENT_STACK_VERSION) {
    throw new Error(
      `Stack at ${contextDir} is version ${onDisk}; ` +
      `this loom build understands up to v${CURRENT_STACK_VERSION}. Upgrade loom.`,
    );
  }
  ensureStackVersion(contextDir);
}
```

- [ ] **Step 1.4: Run the test to verify it passes**

```bash
npx vitest run src/config.test.ts
```

Expected: PASS.

- [ ] **Step 1.5: Replace inline version check in `src/server.ts`**

Find the existing stack-version check in `createLoomServer` and replace with
`assertStackVersionCompatible(contextDir)`. Grep to find it first:

```bash
grep -n "readStackVersion\|STACK_VERSION_FILE\|ensureStackVersion\|understands up to" src/server.ts
```

Swap the inline block for the single helper call. Keep any surrounding
behavior (e.g., the call site that today does both checks + stamp is now
just one line).

- [ ] **Step 1.6: Run the full suite to confirm no regression**

```bash
npx vitest run
```

Expected: all existing tests still pass (208/208).

- [ ] **Step 1.7: Write `src/cli/io.ts`**

```typescript
/**
 * CLI I/O — stream writers, body reader (stdin → $EDITOR fallback),
 * and the --json vs human render dispatcher.
 */
import { readFile, writeFile, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';

export interface IOStreams {
  stdout: (s: string) => void;
  stderr: (s: string) => void;
  stdin: NodeJS.ReadableStream;
  stdinIsTTY: boolean;
  env: NodeJS.ProcessEnv;
}

export function realStreams(): IOStreams {
  return {
    stdout: (s) => { process.stdout.write(s); },
    stderr: (s) => { process.stderr.write(s); },
    stdin: process.stdin,
    stdinIsTTY: Boolean(process.stdin.isTTY),
    env: process.env,
  };
}

export async function readStdin(stdin: NodeJS.ReadableStream): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stdin) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks).toString('utf-8');
}

export interface EditorInput {
  cmd: string;
  tempPath: string;
}

export async function openEditor(
  env: NodeJS.ProcessEnv,
  subcommand: string,
  initial: string = '',
): Promise<string> {
  const editor = env.VISUAL || env.EDITOR;
  if (!editor) {
    throw new Error('no stdin input and $EDITOR not set');
  }
  const randomSuffix = Math.random().toString(36).slice(2, 8);
  const tempPath = join(tmpdir(), `loom-${subcommand}-${process.pid}-${randomSuffix}.md`);
  await writeFile(tempPath, initial, 'utf-8');
  await new Promise<void>((resolve, reject) => {
    const child = spawn(editor, [tempPath], { stdio: 'inherit' });
    child.on('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`editor exited with code ${code}; temp file at ${tempPath}`));
    });
    child.on('error', reject);
  });
  const body = await readFile(tempPath, 'utf-8');
  await unlink(tempPath).catch(() => { /* best effort */ });
  return body;
}

export async function readBody(
  io: IOStreams,
  subcommand: string,
): Promise<string> {
  if (!io.stdinIsTTY) {
    return (await readStdin(io.stdin)).trimEnd();
  }
  const body = await openEditor(io.env, subcommand);
  return body.trimEnd();
}

export function renderJson(io: IOStreams, value: unknown): void {
  io.stdout(JSON.stringify(value, null, 2) + '\n');
}
```

- [ ] **Step 1.8: Write `src/cli/args.ts`**

```typescript
/**
 * Shared argv helpers — global flag resolution + context-dir/env
 * precedence. Individual commands parse their own subcommand flags
 * via node:util parseArgs.
 */
import { resolve } from 'node:path';
import { homedir } from 'node:os';

export interface ResolvedEnv {
  contextDir: string;
  client?: string;
  model?: string;
  json: boolean;
}

export interface RawGlobalFlags {
  contextDir?: string;
  client?: string;
  model?: string;
  json?: boolean;
}

export function resolveEnv(
  flags: RawGlobalFlags,
  processEnv: NodeJS.ProcessEnv,
): ResolvedEnv {
  const contextDir =
    flags.contextDir ??
    processEnv.LOOM_CONTEXT_DIR ??
    resolve(homedir(), '.config', 'loom', 'default');
  return {
    contextDir: resolve(contextDir),
    client: flags.client ?? processEnv.LOOM_CLIENT,
    model: flags.model ?? processEnv.LOOM_MODEL,
    json: Boolean(flags.json),
  };
}

/**
 * Extracts global flags from an argv slice, returning the remaining argv.
 * Recognizes: --context-dir, --client, --model, --json (plus short aliases).
 */
export function extractGlobalFlags(argv: string[]): {
  flags: RawGlobalFlags;
  rest: string[];
} {
  const flags: RawGlobalFlags = {};
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--context-dir') { flags.contextDir = argv[++i]; continue; }
    if (a === '--client')      { flags.client     = argv[++i]; continue; }
    if (a === '--model')       { flags.model      = argv[++i]; continue; }
    if (a === '--json')        { flags.json = true;            continue; }
    rest.push(a);
  }
  return { flags, rest };
}
```

- [ ] **Step 1.9: Write `src/cli/test-helpers.ts`**

```typescript
/**
 * Test helpers — run `runCli` in-process with captured streams.
 */
import type { IOStreams } from './io.js';
import { Readable } from 'node:stream';
import { runCli } from './index.js';

export interface CaptureResult {
  stdout: string;
  stderr: string;
  code: number;
}

export async function runCliCaptured(
  argv: string[],
  opts?: { stdin?: string; env?: Record<string, string> },
): Promise<CaptureResult> {
  let stdout = '';
  let stderr = '';
  const stdin = Readable.from([opts?.stdin ?? '']);
  const io: IOStreams = {
    stdout: (s) => { stdout += s; },
    stderr: (s) => { stderr += s; },
    stdin,
    stdinIsTTY: opts?.stdin === undefined,
    env: opts?.env ?? {},
  };
  const code = await runCli(argv, io);
  return { stdout, stderr, code };
}
```

Note: `runCli` is defined in Step 1.11 and accepts an optional `io` argument.

- [ ] **Step 1.10: Write a failing test for `runCli` top-level dispatch**

Create `src/cli/dispatch.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { runCliCaptured } from './test-helpers.js';

describe('runCli top-level dispatch', () => {
  it('prints top-level help and exits 0 on --help', async () => {
    const { stdout, stderr, code } = await runCliCaptured(['--help']);
    expect(code).toBe(0);
    expect(stderr + stdout).toMatch(/Usage: loom <command>/);
    expect(stderr + stdout).toMatch(/wake/);
  });

  it('prints the loom version and exits 0 on --version', async () => {
    const { stdout, code } = await runCliCaptured(['--version']);
    expect(code).toBe(0);
    expect(stdout).toMatch(/loom v\d+\.\d+\.\d+/);
  });

  it('returns exit code 2 for an unknown subcommand', async () => {
    const { stderr, code } = await runCliCaptured(['nope']);
    expect(code).toBe(2);
    expect(stderr).toMatch(/Unknown subcommand/);
  });
});
```

- [ ] **Step 1.11: Run the test to verify it fails**

```bash
npx vitest run src/cli/dispatch.test.ts
```

Expected: FAIL — `runCli` doesn't exist.

- [ ] **Step 1.12: Implement `src/cli/index.ts`**

```typescript
/**
 * CLI dispatcher — top-level --help / --version plus subcommand routing.
 * Individual subcommand files land in Tasks 2–10.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { resolveRepoRoot } from '../config.js';
import type { IOStreams } from './io.js';
import { realStreams } from './io.js';

const SUBCOMMANDS = [
  'wake', 'recall', 'remember', 'forget', 'update',
  'memory', 'pursuits', 'update-identity', 'bootstrap', 'serve',
] as const;

const TOP_HELP = `Usage: loom <command> [options]

Commands:
  wake               Print agent identity to stdout
  recall <query>     Search memories
  remember <title>   Save a new memory (body via stdin/$EDITOR)
  update <ref>       Modify an existing memory
  forget <ref|scope> Remove memories
  memory list|prune  Browse or clean the memory store
  pursuits <action>  Manage active pursuits
  update-identity    Edit preferences.md / self-model.md sections
  bootstrap          Initialize a fresh agent
  serve              Explicit MCP stdio startup (same as no args)

Global flags:
  --context-dir <path>   Agent context dir (default: $LOOM_CONTEXT_DIR or ~/.config/loom/default)
  --client <name>        Harness adapter hint (default: $LOOM_CLIENT)
  --model <name>         Model manifest hint (default: $LOOM_MODEL)
  --json                 Machine-readable output
  --help, -h             Show help
  --version, -V          Print loom version

Run 'loom <command> --help' for per-command usage.
`;

async function readVersion(): Promise<string> {
  const pkg = JSON.parse(await readFile(join(resolveRepoRoot(), 'package.json'), 'utf-8'));
  return pkg.version;
}

export async function runCli(argv: string[], io: IOStreams = realStreams()): Promise<number> {
  const first = argv[0];

  if (first === '--help' || first === '-h' || first === undefined) {
    io.stdout(TOP_HELP);
    return 0;
  }
  if (first === '--version' || first === '-V') {
    io.stdout(`loom v${await readVersion()}\n`);
    return 0;
  }
  if (!(SUBCOMMANDS as readonly string[]).includes(first)) {
    io.stderr(`Unknown subcommand: ${first}\n`);
    io.stderr(TOP_HELP);
    return 2;
  }

  // Subcommands land in Tasks 2–10.
  io.stderr(`Subcommand not implemented yet: ${first}\n`);
  return 2;
}
```

- [ ] **Step 1.13: Run the test to verify it passes**

```bash
npx vitest run src/cli/dispatch.test.ts
```

Expected: PASS.

- [ ] **Step 1.14: Wire dispatch into `src/index.ts`**

Replace the contents of `src/index.ts` with:

```typescript
/**
 * Loom — CLI + stdio MCP entry point.
 *
 * When argv[2] is a known CLI subcommand or --help/--version, routes to
 * src/cli/index.ts. Otherwise (or if argv is empty / only flags), falls
 * through to the MCP stdio server so existing .mcp.json configs keep
 * working.
 */
import { fileURLToPath } from 'node:url';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createLoomServer } from './server.js';
import { resolveContextDir } from './config.js';

const CLI_KEYWORDS = new Set([
  'wake', 'recall', 'remember', 'forget', 'update',
  'memory', 'pursuits', 'update-identity', 'bootstrap', 'serve',
]);

function isCliInvocation(argv: string[]): boolean {
  const first = argv[2];
  if (first === undefined) return false;
  if (first === '--help' || first === '-h') return true;
  if (first === '--version' || first === '-V') return true;
  return CLI_KEYWORDS.has(first);
}

export { isCliInvocation };

async function main() {
  if (isCliInvocation(process.argv)) {
    const { runCli } = await import('./cli/index.js');
    process.exit(await runCli(process.argv.slice(2)));
  }
  const contextDir = resolveContextDir();
  const { server } = createLoomServer({ contextDir });
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error('Loom failed to start:', err);
    process.exit(1);
  });
}
```

Note: `serve` is in `CLI_KEYWORDS` so `node dist/index.js serve` routes
through the CLI; the `serve` subcommand itself (Task 10) will invoke
the MCP startup.

- [ ] **Step 1.15: Write dispatch test**

Append to `src/cli/dispatch.test.ts`:

```typescript
import { isCliInvocation } from '../index.js';

describe('isCliInvocation (argv[2] routing)', () => {
  it('returns false for no extra args (MCP path)', () => {
    expect(isCliInvocation(['node', 'index.js'])).toBe(false);
  });
  it('returns false for --context-dir path (MCP path)', () => {
    expect(isCliInvocation(['node', 'index.js', '--context-dir', '/foo'])).toBe(false);
  });
  it('returns true for known subcommand', () => {
    expect(isCliInvocation(['node', 'index.js', 'wake'])).toBe(true);
  });
  it('returns true for --help', () => {
    expect(isCliInvocation(['node', 'index.js', '--help'])).toBe(true);
  });
  it('returns false for unknown positional (falls through to MCP)', () => {
    expect(isCliInvocation(['node', 'index.js', 'floop'])).toBe(false);
  });
});
```

- [ ] **Step 1.16: Run full suite**

```bash
npm run build && npx vitest run
```

Expected: build clean, all tests pass (208 existing + new ones).

- [ ] **Step 1.17: Commit**

```bash
git add src/cli/ src/config.ts src/config.test.ts src/server.ts src/index.ts
git commit -s -m "feat(cli): scaffold dispatcher, I/O helpers, stack-version gate

Adds src/cli/{index,args,io,test-helpers}.ts with top-level --help
and --version handling; subcommand slots return exit 2 until Tasks
2–10. src/index.ts routes argv[2] to the CLI only when it names a
known subcommand or a CLI meta-flag, so existing .mcp.json configs
stay on the MCP path.

Consolidates the stack-version check into
assertStackVersionCompatible() and replaces the inline check in
createLoomServer with a single call.

Refs: docs/specs/2026-04-20-cli-adapter-design.md"
```

---

## Task 2: `loom wake`

**Files:**
- Create: `src/cli/wake.ts`
- Create: `src/cli/wake.test.ts`
- Modify: `src/cli/index.ts` (route `wake` subcommand)

- [ ] **Step 2.1: Write failing test**

Create `src/cli/wake.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCliCaptured } from './test-helpers.js';

describe('loom wake', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'loom-cli-wake-'));
    await writeFile(join(tempDir, 'IDENTITY.md'), '# Test creed');
  });
  afterEach(async () => { await rm(tempDir, { recursive: true, force: true }); });

  it('prints identity markdown to stdout and exits 0', async () => {
    const { stdout, code } = await runCliCaptured(
      ['wake', '--context-dir', tempDir],
    );
    expect(code).toBe(0);
    expect(stdout).toMatch(/# Test creed/);
  });

  it('reads LOOM_CONTEXT_DIR from env when flag omitted', async () => {
    const { stdout, code } = await runCliCaptured(
      ['wake'],
      { env: { LOOM_CONTEXT_DIR: tempDir } },
    );
    expect(code).toBe(0);
    expect(stdout).toMatch(/# Test creed/);
  });

  it('flag wins over env', async () => {
    const other = await mkdtemp(join(tmpdir(), 'loom-cli-wake-other-'));
    await writeFile(join(other, 'IDENTITY.md'), '# Other creed');
    try {
      const { stdout } = await runCliCaptured(
        ['wake', '--context-dir', other],
        { env: { LOOM_CONTEXT_DIR: tempDir } },
      );
      expect(stdout).toMatch(/# Other creed/);
    } finally {
      await rm(other, { recursive: true, force: true });
    }
  });

  it('forwards --project to loadIdentity', async () => {
    await mkdir(join(tempDir, 'projects'), { recursive: true });
    await writeFile(join(tempDir, 'projects', 'widget.md'), 'Widget brief');
    const { stdout } = await runCliCaptured(
      ['wake', '--context-dir', tempDir, '--project', 'widget'],
    );
    expect(stdout).toMatch(/Widget brief/);
  });

  it('prints wake usage with --help and exits 0', async () => {
    const { stdout, stderr, code } = await runCliCaptured(['wake', '--help']);
    expect(code).toBe(0);
    expect(stdout + stderr).toMatch(/loom wake/);
  });
});
```

- [ ] **Step 2.2: Run the test to verify it fails**

```bash
npx vitest run src/cli/wake.test.ts
```

Expected: FAIL (subcommand not implemented yet).

- [ ] **Step 2.3: Implement `src/cli/wake.ts`**

```typescript
/**
 * loom wake — prints agent identity markdown to stdout.
 */
import { parseArgs } from 'node:util';
import { loadIdentity } from '../tools/identity.js';
import { assertStackVersionCompatible } from '../config.js';
import { extractGlobalFlags, resolveEnv } from './args.js';
import type { IOStreams } from './io.js';

export const USAGE = `Usage: loom wake [options]

Prints the agent's wake output (identity, preferences, self-model,
harness manifest, model manifest, procedures) to stdout.

Options:
  --project <name>       Load projects/<name>.md as additional context
  --context-dir <path>   Agent context dir
  --client <name>        Harness adapter hint
  --model <name>         Model manifest hint
  --help, -h             Show this help
`;

export async function run(argv: string[], io: IOStreams): Promise<number> {
  const { flags: global, rest } = extractGlobalFlags(argv);
  let parsed;
  try {
    parsed = parseArgs({
      args: rest,
      options: {
        project: { type: 'string' },
        help:    { type: 'boolean', short: 'h' },
      },
      strict: true,
      allowPositionals: false,
    });
  } catch (err) {
    io.stderr(`${(err as Error).message}\n${USAGE}`);
    return 2;
  }
  if (parsed.values.help) { io.stdout(USAGE); return 0; }

  const env = resolveEnv(global, io.env);
  try {
    assertStackVersionCompatible(env.contextDir);
  } catch (err) {
    io.stderr(`${(err as Error).message}\n`);
    return 1;
  }

  const md = await loadIdentity(
    env.contextDir,
    parsed.values.project,
    env.client,
    env.model,
  );
  io.stdout(md.endsWith('\n') ? md : md + '\n');
  return 0;
}
```

- [ ] **Step 2.4: Wire the route in `src/cli/index.ts`**

Replace the placeholder tail of `runCli` (the `Subcommand not implemented yet` block):

```typescript
  const sub = argv[0];
  const rest = argv.slice(1);
  switch (sub) {
    case 'wake': {
      const { run } = await import('./wake.js');
      return run(rest, io);
    }
    default:
      io.stderr(`Subcommand not implemented yet: ${sub}\n`);
      return 2;
  }
```

- [ ] **Step 2.5: Run the test to verify it passes**

```bash
npx vitest run src/cli/wake.test.ts
```

Expected: PASS (all 5).

- [ ] **Step 2.6: Full suite**

```bash
npm run build && npx vitest run
```

Expected: all pass.

- [ ] **Step 2.7: Commit**

```bash
git add src/cli/wake.ts src/cli/wake.test.ts src/cli/index.ts
git commit -s -m "feat(cli): loom wake — print identity markdown to stdout

Reuses loadIdentity(); global flags resolve contextDir/client/model
with env fallback. --project forwards through to projects/<name>.md.

Refs: docs/specs/2026-04-20-cli-adapter-design.md"
```

---

## Task 3: `loom recall`

**Files:**
- Create: `src/cli/recall.ts`
- Create: `src/cli/recall.test.ts`
- Modify: `src/cli/index.ts` (route `recall`)

- [ ] **Step 3.1: Write failing test**

Create `src/cli/recall.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCliCaptured } from './test-helpers.js';
import { remember } from '../tools/remember.js';

describe('loom recall', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'loom-cli-recall-'));
    await writeFile(join(tempDir, 'IDENTITY.md'), '# Creed');
    await remember(tempDir, {
      category: 'reference',
      title: 'blue widget',
      content: 'Specs for the blue widget prototype',
    });
  });
  afterEach(async () => { await rm(tempDir, { recursive: true, force: true }); });

  it('prints matches in human format when found', async () => {
    const { stdout, code } = await runCliCaptured(
      ['recall', 'blue widget', '--context-dir', tempDir],
    );
    expect(code).toBe(0);
    expect(stdout).toMatch(/blue widget/);
  });

  it('emits MemoryMatch[] when --json is set', async () => {
    const { stdout, code } = await runCliCaptured(
      ['recall', 'blue widget', '--context-dir', tempDir, '--json'],
    );
    expect(code).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed[0]).toHaveProperty('title', 'blue widget');
  });

  it('returns exit 2 when query is missing', async () => {
    const { stderr, code } = await runCliCaptured(
      ['recall', '--context-dir', tempDir],
    );
    expect(code).toBe(2);
    expect(stderr).toMatch(/query/i);
  });

  it('respects --category filter', async () => {
    const { stdout } = await runCliCaptured(
      ['recall', 'blue widget', '--context-dir', tempDir, '--category', 'reference', '--json'],
    );
    const parsed = JSON.parse(stdout);
    expect(parsed.every((m: { category: string }) => m.category === 'reference')).toBe(true);
  });
});
```

- [ ] **Step 3.2: Run test to verify it fails**

```bash
npx vitest run src/cli/recall.test.ts
```

Expected: FAIL.

- [ ] **Step 3.3: Implement `src/cli/recall.ts`**

```typescript
/**
 * loom recall — semantic memory search.
 */
import { parseArgs } from 'node:util';
import { recall, formatResults } from '../tools/recall.js';
import { createBackend } from '../backends/index.js';
import { assertStackVersionCompatible } from '../config.js';
import { extractGlobalFlags, resolveEnv } from './args.js';
import { renderJson } from './io.js';
import type { IOStreams } from './io.js';

export const USAGE = `Usage: loom recall <query> [options]

Search memories semantically.

Options:
  --category <name>      Filter by category
  --project <name>       Filter by project
  --limit <n>            Max results (default backend-specific)
  --json                 Emit MemoryMatch[] as JSON
  --context-dir <path>   Agent context dir
  --help, -h             Show this help
`;

export async function run(argv: string[], io: IOStreams): Promise<number> {
  const { flags: global, rest } = extractGlobalFlags(argv);
  let parsed;
  try {
    parsed = parseArgs({
      args: rest,
      options: {
        category: { type: 'string' },
        project:  { type: 'string' },
        limit:    { type: 'string' },
        help:     { type: 'boolean', short: 'h' },
      },
      strict: true,
      allowPositionals: true,
    });
  } catch (err) {
    io.stderr(`${(err as Error).message}\n${USAGE}`);
    return 2;
  }
  if (parsed.values.help) { io.stdout(USAGE); return 0; }

  const query = parsed.positionals[0];
  if (!query) { io.stderr(`Missing query.\n${USAGE}`); return 2; }

  const env = resolveEnv(global, io.env);
  try { assertStackVersionCompatible(env.contextDir); }
  catch (err) { io.stderr(`${(err as Error).message}\n`); return 1; }

  const limit = parsed.values.limit !== undefined
    ? Number.parseInt(parsed.values.limit, 10)
    : undefined;
  if (limit !== undefined && Number.isNaN(limit)) {
    io.stderr(`--limit must be an integer.\n`);
    return 2;
  }

  const input = {
    query,
    category: parsed.values.category,
    project:  parsed.values.project,
    limit,
  };

  if (env.json) {
    const backend = createBackend(env.contextDir);
    const matches = await backend.recall(input);
    renderJson(io, matches);
    return 0;
  }
  const text = await recall(env.contextDir, input);
  io.stdout(text.endsWith('\n') ? text : text + '\n');
  return 0;
}
```

- [ ] **Step 3.4: Route in `src/cli/index.ts`**

Add a case to the switch:

```typescript
    case 'recall': {
      const { run } = await import('./recall.js');
      return run(rest, io);
    }
```

- [ ] **Step 3.5: Run test to verify it passes**

```bash
npx vitest run src/cli/recall.test.ts
```

Expected: PASS.

- [ ] **Step 3.6: Full suite + commit**

```bash
npx vitest run
git add src/cli/recall.ts src/cli/recall.test.ts src/cli/index.ts
git commit -s -m "feat(cli): loom recall — semantic memory search

Human path calls the existing recall() tool; --json path reads
structured MemoryMatch[] directly from the backend. --category /
--project / --limit forward unchanged.

Refs: docs/specs/2026-04-20-cli-adapter-design.md"
```

---

## Task 4: `loom memory list` + `loom memory prune`

**Files:**
- Create: `src/cli/memory.ts`
- Create: `src/cli/memory.test.ts`
- Modify: `src/cli/index.ts` (route `memory`)

- [ ] **Step 4.1: Write failing test**

Create `src/cli/memory.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCliCaptured } from './test-helpers.js';
import { remember } from '../tools/remember.js';

describe('loom memory', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'loom-cli-memory-'));
    await writeFile(join(tempDir, 'IDENTITY.md'), '# Creed');
    await remember(tempDir, { category: 'reference', title: 'alpha', content: 'a' });
    await remember(tempDir, { category: 'reference', title: 'beta',  content: 'b' });
  });
  afterEach(async () => { await rm(tempDir, { recursive: true, force: true }); });

  describe('list', () => {
    it('prints entries in human format', async () => {
      const { stdout, code } = await runCliCaptured(
        ['memory', 'list', '--context-dir', tempDir],
      );
      expect(code).toBe(0);
      expect(stdout).toMatch(/alpha/);
      expect(stdout).toMatch(/beta/);
    });

    it('emits MemoryEntry[] when --json', async () => {
      const { stdout, code } = await runCliCaptured(
        ['memory', 'list', '--context-dir', tempDir, '--json'],
      );
      expect(code).toBe(0);
      const parsed = JSON.parse(stdout);
      expect(Array.isArray(parsed)).toBe(true);
      expect(parsed.length).toBe(2);
    });
  });

  describe('prune', () => {
    it('reports clean store when nothing expired', async () => {
      const { stdout, code } = await runCliCaptured(
        ['memory', 'prune', '--context-dir', tempDir],
      );
      expect(code).toBe(0);
      expect(stdout).toMatch(/healthy|No expired/i);
    });

    it('supports --json', async () => {
      const { stdout, code } = await runCliCaptured(
        ['memory', 'prune', '--context-dir', tempDir, '--json'],
      );
      expect(code).toBe(0);
      const parsed = JSON.parse(stdout);
      expect(parsed).toHaveProperty('expired');
      expect(parsed).toHaveProperty('stale');
    });
  });

  it('returns exit 2 for unknown memory subcommand', async () => {
    const { stderr, code } = await runCliCaptured(
      ['memory', 'bogus', '--context-dir', tempDir],
    );
    expect(code).toBe(2);
    expect(stderr).toMatch(/list|prune/);
  });
});
```

- [ ] **Step 4.2: Run test to verify it fails**

```bash
npx vitest run src/cli/memory.test.ts
```

Expected: FAIL.

- [ ] **Step 4.3: Implement `src/cli/memory.ts`**

```typescript
/**
 * loom memory — list / prune the memory store.
 */
import { parseArgs } from 'node:util';
import { memoryList } from '../tools/memory-list.js';
import { prune } from '../tools/prune.js';
import { createBackend } from '../backends/index.js';
import { assertStackVersionCompatible } from '../config.js';
import { extractGlobalFlags, resolveEnv } from './args.js';
import { renderJson } from './io.js';
import type { IOStreams } from './io.js';

export const USAGE = `Usage: loom memory <subcommand> [options]

Subcommands:
  list    Browse memories (table or --json)
  prune   Report / remove expired and stale memories

Options (list):
  --category <name>    Filter
  --project <name>     Filter
  --limit <n>          Max entries
  --json               Emit MemoryEntry[]

Options (prune):
  --stale-days <n>     Stale threshold in days
  --dry-run            Report what would be pruned, don't delete
  --json               Emit PruneResult

Global: --context-dir, --help/-h
`;

export async function run(argv: string[], io: IOStreams): Promise<number> {
  const { flags: global, rest } = extractGlobalFlags(argv);
  const sub = rest[0];
  const subRest = rest.slice(1);

  if (!sub || sub === '--help' || sub === '-h') {
    io.stdout(USAGE);
    return sub ? 0 : 2;
  }
  if (sub !== 'list' && sub !== 'prune') {
    io.stderr(`Unknown memory subcommand: ${sub}\n${USAGE}`);
    return 2;
  }

  const env = resolveEnv(global, io.env);
  try { assertStackVersionCompatible(env.contextDir); }
  catch (err) { io.stderr(`${(err as Error).message}\n`); return 1; }

  if (sub === 'list') {
    let parsed;
    try {
      parsed = parseArgs({
        args: subRest,
        options: {
          category: { type: 'string' },
          project:  { type: 'string' },
          limit:    { type: 'string' },
        },
        strict: true,
        allowPositionals: false,
      });
    } catch (err) {
      io.stderr(`${(err as Error).message}\n${USAGE}`);
      return 2;
    }
    const limit = parsed.values.limit !== undefined
      ? Number.parseInt(parsed.values.limit, 10)
      : undefined;
    if (limit !== undefined && Number.isNaN(limit)) {
      io.stderr(`--limit must be an integer.\n`);
      return 2;
    }
    const input = {
      category: parsed.values.category,
      project:  parsed.values.project,
      limit,
    };
    if (env.json) {
      const backend = createBackend(env.contextDir);
      renderJson(io, await backend.list(input));
      return 0;
    }
    const text = await memoryList(env.contextDir, input);
    io.stdout(text.endsWith('\n') ? text : text + '\n');
    return 0;
  }

  // prune
  let parsed;
  try {
    parsed = parseArgs({
      args: subRest,
      options: {
        'stale-days': { type: 'string' },
        'dry-run':    { type: 'boolean' },
      },
      strict: true,
      allowPositionals: false,
    });
  } catch (err) {
    io.stderr(`${(err as Error).message}\n${USAGE}`);
    return 2;
  }
  const staleDays = parsed.values['stale-days'] !== undefined
    ? Number.parseInt(parsed.values['stale-days'], 10)
    : undefined;
  const dryRun = Boolean(parsed.values['dry-run']);
  const options = { staleDays, dryRun };

  if (env.json) {
    const backend = createBackend(env.contextDir);
    renderJson(io, await backend.prune(options));
    return 0;
  }
  const text = await prune(env.contextDir, options);
  io.stdout(text.endsWith('\n') ? text : text + '\n');
  return 0;
}
```

- [ ] **Step 4.4: Route in `src/cli/index.ts`**

```typescript
    case 'memory': {
      const { run } = await import('./memory.js');
      return run(rest, io);
    }
```

- [ ] **Step 4.5: Test + full suite + commit**

```bash
npx vitest run src/cli/memory.test.ts && npx vitest run
git add src/cli/memory.ts src/cli/memory.test.ts src/cli/index.ts
git commit -s -m "feat(cli): loom memory list / prune

Two sub-subcommands share dispatch. Human path calls the existing
memoryList() / prune() tools; --json bypasses formatting and serializes
backend output (MemoryEntry[] / PruneResult) directly.

Refs: docs/specs/2026-04-20-cli-adapter-design.md"
```

---

## Task 5: `loom forget`

**Files:**
- Create: `src/cli/forget.ts`
- Create: `src/cli/forget.test.ts`
- Modify: `src/cli/index.ts` (route `forget`)

- [ ] **Step 5.1: Write failing test**

Create `src/cli/forget.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCliCaptured } from './test-helpers.js';
import { remember } from '../tools/remember.js';

describe('loom forget', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'loom-cli-forget-'));
    await writeFile(join(tempDir, 'IDENTITY.md'), '# Creed');
  });
  afterEach(async () => { await rm(tempDir, { recursive: true, force: true }); });

  it('forgets by ref', async () => {
    const ref = await remember(tempDir, { category: 'reference', title: 't1', content: 'c' });
    const { stdout, code } = await runCliCaptured(
      ['forget', ref.ref, '--context-dir', tempDir],
    );
    expect(code).toBe(0);
    expect(stdout).toMatch(/forgotten/i);
  });

  it('emits ForgetResult on --json', async () => {
    const ref = await remember(tempDir, { category: 'reference', title: 't2', content: 'c' });
    const { stdout, code } = await runCliCaptured(
      ['forget', ref.ref, '--context-dir', tempDir, '--json'],
    );
    expect(code).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed.deleted).toEqual([ref.ref]);
  });

  it('refuses title-pattern without a scope guard (exit 2)', async () => {
    const { stderr, code } = await runCliCaptured(
      ['forget', '--title-pattern', 'foo*', '--context-dir', tempDir],
    );
    expect(code).toBe(2);
    expect(stderr).toMatch(/scope|category|project/i);
  });

  it('accepts title-pattern with --category', async () => {
    await remember(tempDir, { category: 'reference', title: 'sweepA', content: 'a' });
    await remember(tempDir, { category: 'reference', title: 'sweepB', content: 'b' });
    const { stdout, code } = await runCliCaptured(
      ['forget', '--title-pattern', 'sweep*', '--category', 'reference', '--context-dir', tempDir],
    );
    expect(code).toBe(0);
    expect(stdout).toMatch(/2/);
  });

  it('exits 3 when ref not found', async () => {
    const { code } = await runCliCaptured(
      ['forget', 'nonexistent/nope.md', '--context-dir', tempDir],
    );
    expect(code).toBe(3);
  });
});
```

- [ ] **Step 5.2: Run failing test**

```bash
npx vitest run src/cli/forget.test.ts
```

Expected: FAIL.

- [ ] **Step 5.3: Implement `src/cli/forget.ts`**

```typescript
/**
 * loom forget — remove memories by ref, category+title, or title pattern.
 */
import { parseArgs } from 'node:util';
import { forget } from '../tools/forget.js';
import { createBackend } from '../backends/index.js';
import { assertStackVersionCompatible } from '../config.js';
import { extractGlobalFlags, resolveEnv } from './args.js';
import { renderJson } from './io.js';
import type { IOStreams } from './io.js';
import type { ForgetInput } from '../backends/types.js';

export const USAGE = `Usage:
  loom forget <ref>
  loom forget --category <cat> --title <exact>
  loom forget --title-pattern <glob> (--category <cat> | --project <name>)

Options:
  --json                 Emit ForgetResult
  --context-dir <path>   Agent context dir
  --help, -h             Show this help
`;

export async function run(argv: string[], io: IOStreams): Promise<number> {
  const { flags: global, rest } = extractGlobalFlags(argv);
  let parsed;
  try {
    parsed = parseArgs({
      args: rest,
      options: {
        category:        { type: 'string' },
        title:           { type: 'string' },
        project:         { type: 'string' },
        'title-pattern': { type: 'string' },
        help:            { type: 'boolean', short: 'h' },
      },
      strict: true,
      allowPositionals: true,
    });
  } catch (err) {
    io.stderr(`${(err as Error).message}\n${USAGE}`);
    return 2;
  }
  if (parsed.values.help) { io.stdout(USAGE); return 0; }

  const input: ForgetInput = {
    ref:           parsed.positionals[0],
    category:      parsed.values.category,
    title:         parsed.values.title,
    project:       parsed.values.project,
    title_pattern: parsed.values['title-pattern'],
  };

  if (input.title_pattern && !input.category && !input.project) {
    io.stderr(`--title-pattern requires --category or --project as a scope guard.\n`);
    return 2;
  }
  const hasAny = input.ref || input.category || input.project || input.title_pattern;
  if (!hasAny) {
    io.stderr(`Nothing to forget.\n${USAGE}`);
    return 2;
  }

  const env = resolveEnv(global, io.env);
  try { assertStackVersionCompatible(env.contextDir); }
  catch (err) { io.stderr(`${(err as Error).message}\n`); return 1; }

  if (env.json) {
    const backend = createBackend(env.contextDir);
    const result = await backend.forget(input);
    renderJson(io, result);
    return result.deleted.length === 0 ? 3 : 0;
  }

  const text = await forget(env.contextDir, input);
  io.stdout(text.endsWith('\n') ? text : text + '\n');
  return /not found|No memories matched/i.test(text) ? 3 : 0;
}
```

- [ ] **Step 5.4: Route in `src/cli/index.ts`**

```typescript
    case 'forget': {
      const { run } = await import('./forget.js');
      return run(rest, io);
    }
```

- [ ] **Step 5.5: Test + full suite + commit**

```bash
npx vitest run src/cli/forget.test.ts && npx vitest run
git add src/cli/forget.ts src/cli/forget.test.ts src/cli/index.ts
git commit -s -m "feat(cli): loom forget — single, scope, and pattern deletion

Single ref → positional. Category+title or scope+title-pattern →
flags. Scope guard enforced at CLI layer (exit 2) and again at tool
layer. Not-found maps to exit 3 so scripts can distinguish empty
result from runtime failure.

Refs: docs/specs/2026-04-20-cli-adapter-design.md"
```

---

## Task 6: `loom remember`

**Files:**
- Create: `src/cli/remember.ts`
- Create: `src/cli/remember.test.ts`
- Modify: `src/cli/index.ts` (route `remember`)

Body content comes from stdin when piped, `$EDITOR` when interactive.
Tests use the `opts.stdin` path (captured TTY = false by default).

- [ ] **Step 6.1: Write failing test**

Create `src/cli/remember.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCliCaptured } from './test-helpers.js';

describe('loom remember', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'loom-cli-remember-'));
    await writeFile(join(tempDir, 'IDENTITY.md'), '# Creed');
  });
  afterEach(async () => { await rm(tempDir, { recursive: true, force: true }); });

  it('writes memory with body from stdin (human output)', async () => {
    const { stdout, code } = await runCliCaptured(
      ['remember', 'my note', '--category', 'reference', '--context-dir', tempDir],
      { stdin: 'body from stdin' },
    );
    expect(code).toBe(0);
    expect(stdout).toMatch(/Remembered/i);
  });

  it('emits MemoryRef on --json', async () => {
    const { stdout, code } = await runCliCaptured(
      ['remember', 'json note', '--category', 'reference', '--context-dir', tempDir, '--json'],
      { stdin: 'body' },
    );
    expect(code).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed).toHaveProperty('ref');
    expect(parsed).toHaveProperty('title', 'json note');
  });

  it('rejects empty body with exit 2', async () => {
    const { stderr, code } = await runCliCaptured(
      ['remember', 'empty', '--category', 'reference', '--context-dir', tempDir],
      { stdin: '' },
    );
    expect(code).toBe(2);
    expect(stderr).toMatch(/body/i);
  });

  it('requires a title (exit 2)', async () => {
    const { stderr, code } = await runCliCaptured(
      ['remember', '--context-dir', tempDir],
      { stdin: 'body' },
    );
    expect(code).toBe(2);
    expect(stderr).toMatch(/title/i);
  });

  it('defaults category to "general" when omitted', async () => {
    const { code } = await runCliCaptured(
      ['remember', 'def', '--context-dir', tempDir, '--json'],
      { stdin: 'body' },
    );
    expect(code).toBe(0);
    const files = await readdir(join(tempDir, 'general')).catch(() => [] as string[]);
    expect(files.length).toBe(1);
  });
});
```

- [ ] **Step 6.2: Run failing test**

```bash
npx vitest run src/cli/remember.test.ts
```

Expected: FAIL.

- [ ] **Step 6.3: Implement `src/cli/remember.ts`**

```typescript
/**
 * loom remember — save a new memory. Body from stdin or $EDITOR.
 */
import { parseArgs } from 'node:util';
import { remember } from '../tools/remember.js';
import { assertStackVersionCompatible } from '../config.js';
import { extractGlobalFlags, resolveEnv } from './args.js';
import { readBody, renderJson } from './io.js';
import type { IOStreams } from './io.js';

export const USAGE = `Usage: loom remember <title> [options]

Body is read from stdin (when piped) or $EDITOR (when interactive).

Options:
  --category <name>      Category (default: general)
  --project <name>       Project tag
  --ttl <dur>            TTL like "7d", "30d", or "permanent"
  --refs <csv>           Comma-separated reference refs stored in metadata
  --json                 Emit MemoryRef
  --context-dir <path>   Agent context dir
  --help, -h             Show this help
`;

export async function run(argv: string[], io: IOStreams): Promise<number> {
  const { flags: global, rest } = extractGlobalFlags(argv);
  let parsed;
  try {
    parsed = parseArgs({
      args: rest,
      options: {
        category: { type: 'string' },
        project:  { type: 'string' },
        ttl:      { type: 'string' },
        refs:     { type: 'string' },
        help:     { type: 'boolean', short: 'h' },
      },
      strict: true,
      allowPositionals: true,
    });
  } catch (err) {
    io.stderr(`${(err as Error).message}\n${USAGE}`);
    return 2;
  }
  if (parsed.values.help) { io.stdout(USAGE); return 0; }

  const title = parsed.positionals[0];
  if (!title) { io.stderr(`Missing title.\n${USAGE}`); return 2; }

  const env = resolveEnv(global, io.env);
  try { assertStackVersionCompatible(env.contextDir); }
  catch (err) { io.stderr(`${(err as Error).message}\n`); return 1; }

  let body: string;
  try {
    body = await readBody(io, 'remember');
  } catch (err) {
    io.stderr(`${(err as Error).message}\n`);
    return 1;
  }
  if (!body) { io.stderr(`body cannot be empty\n`); return 2; }

  const refsList = parsed.values.refs
    ? parsed.values.refs.split(',').map((s) => s.trim()).filter(Boolean)
    : undefined;

  const ref = await remember(env.contextDir, {
    category: parsed.values.category ?? 'general',
    title,
    content: body,
    project:  parsed.values.project,
    ttl:      parsed.values.ttl,
    metadata: refsList ? { refs: refsList } : undefined,
  });

  if (env.json) { renderJson(io, ref); return 0; }
  io.stdout(`Remembered: ${ref.ref} — ${ref.title}\n`);
  return 0;
}
```

- [ ] **Step 6.4: Route in `src/cli/index.ts`**

```typescript
    case 'remember': {
      const { run } = await import('./remember.js');
      return run(rest, io);
    }
```

- [ ] **Step 6.5: Test + full suite + commit**

```bash
npx vitest run src/cli/remember.test.ts && npx vitest run
git add src/cli/remember.ts src/cli/remember.test.ts src/cli/index.ts
git commit -s -m "feat(cli): loom remember — body via stdin / \$EDITOR

Non-TTY stdin feeds body; TTY opens \$VISUAL/\$EDITOR on a temp file.
Empty body → exit 2. Refs list parsed as CSV, stored in metadata so
downstream recall can surface related ids.

Refs: docs/specs/2026-04-20-cli-adapter-design.md"
```

---

## Task 7: `loom update`

**Files:**
- Create: `src/cli/update.ts`
- Create: `src/cli/update.test.ts`
- Modify: `src/cli/index.ts` (route `update`)

Rule: open editor **only** when body is required. If the user only
changes metadata-ish flags (title/refs), don't prompt. If content needs
to change, stdin or editor.

- [ ] **Step 7.1: Write failing test**

Create `src/cli/update.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCliCaptured } from './test-helpers.js';
import { remember } from '../tools/remember.js';

describe('loom update', () => {
  let tempDir: string;
  let ref: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'loom-cli-update-'));
    await writeFile(join(tempDir, 'IDENTITY.md'), '# Creed');
    const res = await remember(tempDir, { category: 'reference', title: 't', content: 'old' });
    ref = res.ref;
  });
  afterEach(async () => { await rm(tempDir, { recursive: true, force: true }); });

  it('updates body via stdin', async () => {
    const { stdout, code } = await runCliCaptured(
      ['update', ref, '--context-dir', tempDir],
      { stdin: 'new body' },
    );
    expect(code).toBe(0);
    expect(stdout).toMatch(/updated/i);
  });

  it('emits UpdateResult on --json', async () => {
    const { stdout, code } = await runCliCaptured(
      ['update', ref, '--context-dir', tempDir, '--json'],
      { stdin: 'new body' },
    );
    expect(code).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed.updated).toBe(true);
    expect(parsed.ref).toBe(ref);
  });

  it('returns exit 3 when ref not found', async () => {
    const { code } = await runCliCaptured(
      ['update', 'nope/missing.md', '--context-dir', tempDir],
      { stdin: 'x' },
    );
    expect(code).toBe(3);
  });

  it('returns exit 2 when no ref given', async () => {
    const { code } = await runCliCaptured(
      ['update', '--context-dir', tempDir],
      { stdin: 'x' },
    );
    expect(code).toBe(2);
  });
});
```

- [ ] **Step 7.2: Run failing test**

```bash
npx vitest run src/cli/update.test.ts
```

Expected: FAIL.

- [ ] **Step 7.3: Implement `src/cli/update.ts`**

```typescript
/**
 * loom update — modify an existing memory.
 */
import { parseArgs } from 'node:util';
import { update } from '../tools/update.js';
import { createBackend } from '../backends/index.js';
import { assertStackVersionCompatible } from '../config.js';
import { extractGlobalFlags, resolveEnv } from './args.js';
import { readBody, renderJson } from './io.js';
import type { IOStreams } from './io.js';
import type { UpdateInput } from '../backends/types.js';

export const USAGE = `Usage: loom update <ref> [options]
       loom update --category <cat> --title <exact> [options]

Updates content (from stdin or \$EDITOR) and/or metadata on an existing
memory.

Options:
  --category <name>      Identify by category (with --title)
  --title <exact>        Identify by title (with --category)
  --json                 Emit UpdateResult
  --context-dir <path>   Agent context dir
  --help, -h             Show this help
`;

export async function run(argv: string[], io: IOStreams): Promise<number> {
  const { flags: global, rest } = extractGlobalFlags(argv);
  let parsed;
  try {
    parsed = parseArgs({
      args: rest,
      options: {
        category: { type: 'string' },
        title:    { type: 'string' },
        help:     { type: 'boolean', short: 'h' },
      },
      strict: true,
      allowPositionals: true,
    });
  } catch (err) {
    io.stderr(`${(err as Error).message}\n${USAGE}`);
    return 2;
  }
  if (parsed.values.help) { io.stdout(USAGE); return 0; }

  const ref = parsed.positionals[0];
  const hasIdentifier = ref || (parsed.values.category && parsed.values.title);
  if (!hasIdentifier) {
    io.stderr(`Provide a <ref> or --category+--title.\n${USAGE}`);
    return 2;
  }

  const env = resolveEnv(global, io.env);
  try { assertStackVersionCompatible(env.contextDir); }
  catch (err) { io.stderr(`${(err as Error).message}\n`); return 1; }

  let body: string;
  try {
    body = await readBody(io, 'update');
  } catch (err) {
    io.stderr(`${(err as Error).message}\n`);
    return 1;
  }
  if (!body) { io.stderr(`body cannot be empty\n`); return 2; }

  const input: UpdateInput = {
    ref,
    category: parsed.values.category,
    title:    parsed.values.title,
    content:  body,
  };

  if (env.json) {
    const backend = createBackend(env.contextDir);
    const result = await backend.update(input);
    renderJson(io, result);
    return result.updated ? 0 : 3;
  }
  const text = await update(env.contextDir, input);
  io.stdout(text.endsWith('\n') ? text : text + '\n');
  return /not found/i.test(text) ? 3 : 0;
}
```

- [ ] **Step 7.4: Route in `src/cli/index.ts`**

```typescript
    case 'update': {
      const { run } = await import('./update.js');
      return run(rest, io);
    }
```

- [ ] **Step 7.5: Test + full suite + commit**

```bash
npx vitest run src/cli/update.test.ts && npx vitest run
git add src/cli/update.ts src/cli/update.test.ts src/cli/index.ts
git commit -s -m "feat(cli): loom update — replace memory body by ref or category+title

New body comes from stdin or \$EDITOR; not-found maps to exit 3.

Refs: docs/specs/2026-04-20-cli-adapter-design.md"
```

---

## Task 8: `loom update-identity`

**Files:**
- Create: `src/cli/update-identity.ts`
- Create: `src/cli/update-identity.test.ts`
- Modify: `src/cli/index.ts` (route `update-identity`)

Three shapes:
- `loom update-identity <file>` → list sections (read-only).
- `loom update-identity <file> <section>` → replace section body (body from stdin/$EDITOR).
- `loom update-identity <file> <section> --append` → add as a new section at EOF.

- [ ] **Step 8.1: Write failing test**

Create `src/cli/update-identity.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCliCaptured } from './test-helpers.js';

describe('loom update-identity', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'loom-cli-upd-ident-'));
    await writeFile(join(tempDir, 'IDENTITY.md'), '# Creed');
    await writeFile(join(tempDir, 'preferences.md'),
      '## Working Style\n\nOld text.\n\n## Tools\n\nOld tools.\n');
  });
  afterEach(async () => { await rm(tempDir, { recursive: true, force: true }); });

  it('lists sections when only file is given', async () => {
    const { stdout, code } = await runCliCaptured(
      ['update-identity', 'preferences', '--context-dir', tempDir],
    );
    expect(code).toBe(0);
    expect(stdout).toMatch(/Working Style/);
    expect(stdout).toMatch(/Tools/);
  });

  it('replaces section body with stdin content', async () => {
    const { code } = await runCliCaptured(
      ['update-identity', 'preferences', 'Working Style', '--context-dir', tempDir],
      { stdin: 'New working style text.' },
    );
    expect(code).toBe(0);
    const updated = await readFile(join(tempDir, 'preferences.md'), 'utf-8');
    expect(updated).toMatch(/New working style text/);
    expect(updated).not.toMatch(/Old text/);
  });

  it('appends a new section with --append', async () => {
    const { code } = await runCliCaptured(
      ['update-identity', 'preferences', 'Brand New', '--append', '--context-dir', tempDir],
      { stdin: 'Fresh content.' },
    );
    expect(code).toBe(0);
    const updated = await readFile(join(tempDir, 'preferences.md'), 'utf-8');
    expect(updated).toMatch(/## Brand New/);
    expect(updated).toMatch(/Fresh content/);
  });

  it('refuses IDENTITY.md as a file argument', async () => {
    const { stderr, code } = await runCliCaptured(
      ['update-identity', 'IDENTITY', 'Any', '--context-dir', tempDir],
      { stdin: 'x' },
    );
    expect(code).toBe(2);
    expect(stderr).toMatch(/preferences|self-model|Unknown/i);
  });

  it('missing file arg → exit 2', async () => {
    const { code } = await runCliCaptured(
      ['update-identity', '--context-dir', tempDir],
      { stdin: 'x' },
    );
    expect(code).toBe(2);
  });
});
```

- [ ] **Step 8.2: Run failing test**

```bash
npx vitest run src/cli/update-identity.test.ts
```

Expected: FAIL.

- [ ] **Step 8.3: Implement `src/cli/update-identity.ts`**

```typescript
/**
 * loom update-identity — list sections or replace/append section body.
 */
import { parseArgs } from 'node:util';
import { listSections, updateIdentity } from '../tools/update-identity.js';
import { assertStackVersionCompatible } from '../config.js';
import { extractGlobalFlags, resolveEnv } from './args.js';
import { readBody, renderJson } from './io.js';
import type { IOStreams } from './io.js';

export const USAGE = `Usage:
  loom update-identity <file>                  # list sections (read-only)
  loom update-identity <file> <section>        # replace section body
  loom update-identity <file> <section> --append  # add as new section

<file> is "preferences" or "self-model". IDENTITY.md is immutable.

Body (for replace/append) is read from stdin or \$EDITOR.

Options:
  --append               Add a new H2 section at end instead of replacing
  --json                 Emit {file, section, mode} on success
  --context-dir <path>   Agent context dir
  --help, -h             Show this help
`;

const EDITABLE = new Set(['preferences', 'self-model']);

export async function run(argv: string[], io: IOStreams): Promise<number> {
  const { flags: global, rest } = extractGlobalFlags(argv);
  let parsed;
  try {
    parsed = parseArgs({
      args: rest,
      options: {
        append: { type: 'boolean' },
        help:   { type: 'boolean', short: 'h' },
      },
      strict: true,
      allowPositionals: true,
    });
  } catch (err) {
    io.stderr(`${(err as Error).message}\n${USAGE}`);
    return 2;
  }
  if (parsed.values.help) { io.stdout(USAGE); return 0; }

  const file = parsed.positionals[0];
  const section = parsed.positionals[1];
  if (!file) { io.stderr(`Missing <file>.\n${USAGE}`); return 2; }
  if (!EDITABLE.has(file)) {
    io.stderr(`Unknown file "${file}". Editable: preferences, self-model.\n`);
    return 2;
  }

  const env = resolveEnv(global, io.env);
  try { assertStackVersionCompatible(env.contextDir); }
  catch (err) { io.stderr(`${(err as Error).message}\n`); return 1; }

  if (!section) {
    const text = await listSections(env.contextDir, file);
    io.stdout(text.endsWith('\n') ? text : text + '\n');
    return 0;
  }

  let body: string;
  try {
    body = await readBody(io, 'update-identity');
  } catch (err) {
    io.stderr(`${(err as Error).message}\n`);
    return 1;
  }
  if (!body) { io.stderr(`body cannot be empty\n`); return 2; }

  const mode = parsed.values.append ? 'append' : 'replace';
  await updateIdentity(env.contextDir, { file, section, content: body, mode });

  if (env.json) { renderJson(io, { file, section, mode }); return 0; }
  io.stdout(`${mode === 'append' ? 'Appended' : 'Replaced'} ${file}:${section}\n`);
  return 0;
}
```

- [ ] **Step 8.4: Route in `src/cli/index.ts`**

```typescript
    case 'update-identity': {
      const { run } = await import('./update-identity.js');
      return run(rest, io);
    }
```

- [ ] **Step 8.5: Test + full suite + commit**

```bash
npx vitest run src/cli/update-identity.test.ts && npx vitest run
git add src/cli/update-identity.ts src/cli/update-identity.test.ts src/cli/index.ts
git commit -s -m "feat(cli): loom update-identity — list / replace / append sections

<file> alone → list sections. <file> <section> → replace (stdin or
\$EDITOR). --append writes a new H2 at end. IDENTITY.md stays
immutable; tool layer + CLI both refuse it.

Refs: docs/specs/2026-04-20-cli-adapter-design.md"
```

---

## Task 9: `loom pursuits`

**Files:**
- Create: `src/cli/pursuits.ts`
- Create: `src/cli/pursuits.test.ts`
- Modify: `src/cli/index.ts` (route `pursuits`)

The existing `pursuits(contextDir, { action, name, ... })` tool already
handles all six actions. CLI maps `loom pursuits <action> [<name>] [flags]`
to that input and prints the string result.

- [ ] **Step 9.1: Write failing test**

Create `src/cli/pursuits.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCliCaptured } from './test-helpers.js';

describe('loom pursuits', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'loom-cli-pursuits-'));
    await writeFile(join(tempDir, 'IDENTITY.md'), '# Creed');
  });
  afterEach(async () => { await rm(tempDir, { recursive: true, force: true }); });

  it('lists pursuits when file is missing', async () => {
    const { stdout, code } = await runCliCaptured(
      ['pursuits', 'list', '--context-dir', tempDir],
    );
    expect(code).toBe(0);
    expect(stdout.length).toBeGreaterThan(0);
  });

  it('adds a pursuit with --goal', async () => {
    const { code } = await runCliCaptured(
      ['pursuits', 'add', 'widget', '--goal', 'Ship the widget', '--context-dir', tempDir],
    );
    expect(code).toBe(0);
    const { stdout } = await runCliCaptured(
      ['pursuits', 'list', '--context-dir', tempDir],
    );
    expect(stdout).toMatch(/widget/);
    expect(stdout).toMatch(/Ship the widget/);
  });

  it('completes a pursuit', async () => {
    await runCliCaptured(
      ['pursuits', 'add', 'ship-it', '--goal', 'Done-ish', '--context-dir', tempDir],
    );
    const { code } = await runCliCaptured(
      ['pursuits', 'complete', 'ship-it', '--context-dir', tempDir],
    );
    expect(code).toBe(0);
  });

  it('exits 2 for unknown action', async () => {
    const { stderr, code } = await runCliCaptured(
      ['pursuits', 'frobnicate', '--context-dir', tempDir],
    );
    expect(code).toBe(2);
    expect(stderr).toMatch(/list|add|update|complete|park|resume/);
  });

  it('exits 2 when add/update/complete lacks a name', async () => {
    const { code } = await runCliCaptured(
      ['pursuits', 'add', '--context-dir', tempDir],
    );
    expect(code).toBe(2);
  });
});
```

- [ ] **Step 9.2: Run failing test**

```bash
npx vitest run src/cli/pursuits.test.ts
```

Expected: FAIL.

- [ ] **Step 9.3: Implement `src/cli/pursuits.ts`**

```typescript
/**
 * loom pursuits — manage active pursuits.
 */
import { parseArgs } from 'node:util';
import { pursuits } from '../tools/pursuits.js';
import { assertStackVersionCompatible } from '../config.js';
import { extractGlobalFlags, resolveEnv } from './args.js';
import { renderJson } from './io.js';
import type { IOStreams } from './io.js';
import type { PursuitAction, PursuitInput } from '../tools/pursuits.js';

export const USAGE = `Usage:
  loom pursuits list
  loom pursuits add <name> --goal <text>
  loom pursuits update <name> --progress <text>
  loom pursuits complete <name>
  loom pursuits park <name> [--reason <text>]
  loom pursuits resume <name>

Options:
  --json                 Emit result payload as JSON
  --context-dir <path>   Agent context dir
  --help, -h             Show this help
`;

const NAME_REQUIRED: Set<PursuitAction> = new Set(
  ['add', 'update', 'complete', 'park', 'resume'],
);
const ALL_ACTIONS: Set<PursuitAction> = new Set(
  ['list', 'add', 'update', 'complete', 'park', 'resume'],
);

export async function run(argv: string[], io: IOStreams): Promise<number> {
  const { flags: global, rest } = extractGlobalFlags(argv);
  const action = rest[0] as PursuitAction | undefined;

  if (!action || action === ('--help' as PursuitAction) || action === ('-h' as PursuitAction)) {
    io.stdout(USAGE);
    return action ? 0 : 2;
  }
  if (!ALL_ACTIONS.has(action)) {
    io.stderr(`Unknown action "${action}".\n${USAGE}`);
    return 2;
  }

  let parsed;
  try {
    parsed = parseArgs({
      args: rest.slice(1),
      options: {
        goal:     { type: 'string' },
        progress: { type: 'string' },
        reason:   { type: 'string' },
        help:     { type: 'boolean', short: 'h' },
      },
      strict: true,
      allowPositionals: true,
    });
  } catch (err) {
    io.stderr(`${(err as Error).message}\n${USAGE}`);
    return 2;
  }
  if (parsed.values.help) { io.stdout(USAGE); return 0; }

  const name = parsed.positionals[0];
  if (NAME_REQUIRED.has(action) && !name) {
    io.stderr(`<name> is required for "${action}".\n${USAGE}`);
    return 2;
  }

  const env = resolveEnv(global, io.env);
  try { assertStackVersionCompatible(env.contextDir); }
  catch (err) { io.stderr(`${(err as Error).message}\n`); return 1; }

  const input: PursuitInput = {
    action,
    name,
    goal:     parsed.values.goal,
    progress: parsed.values.progress,
    reason:   parsed.values.reason,
  };

  const text = await pursuits(env.contextDir, input);
  if (env.json) { renderJson(io, { action, name, message: text }); return 0; }
  io.stdout(text.endsWith('\n') ? text : text + '\n');
  return 0;
}
```

- [ ] **Step 9.4: Route in `src/cli/index.ts`**

```typescript
    case 'pursuits': {
      const { run } = await import('./pursuits.js');
      return run(rest, io);
    }
```

- [ ] **Step 9.5: Test + full suite + commit**

```bash
npx vitest run src/cli/pursuits.test.ts && npx vitest run
git add src/cli/pursuits.ts src/cli/pursuits.test.ts src/cli/index.ts
git commit -s -m "feat(cli): loom pursuits — six action verbs

Dispatches list/add/update/complete/park/resume to the existing
pursuits() tool. --goal/--progress/--reason/--name forward through
the PursuitInput shape.

Refs: docs/specs/2026-04-20-cli-adapter-design.md"
```

---

## Task 10: `loom bootstrap` + `loom serve` + docs/release

This task is larger by necessity — it bundles bootstrap (which has both
flag-driven and interactive paths), the `serve` alias (tiny), and all
docs/release artefacts.

**Files:**
- Create: `src/cli/bootstrap.ts`
- Create: `src/cli/bootstrap.test.ts`
- Create: `src/cli/serve.ts`
- Modify: `src/cli/index.ts` (route `bootstrap`, `serve`)
- Modify: `README.md` (new CLI section)
- Modify: `docs/loom-stack-v1.md` (append §11 Adapters: CLI)
- Modify: `CHANGELOG.md` (add [0.4.0-alpha.3] entry)
- Modify: `package.json` (bump version)
- Modify: `package-lock.json` (npm install --package-lock-only)

### 10A: `loom bootstrap`

- [ ] **Step 10.1: Write failing test**

Create `src/cli/bootstrap.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCliCaptured } from './test-helpers.js';

describe('loom bootstrap', () => {
  let tempDir: string;

  beforeEach(async () => { tempDir = await mkdtemp(join(tmpdir(), 'loom-cli-boot-')); });
  afterEach(async () => { await rm(tempDir, { recursive: true, force: true }); });

  it('runs flag-driven when all required flags are provided', async () => {
    const { stdout, code } = await runCliCaptured([
      'bootstrap',
      '--name', 'Sage',
      '--purpose', 'Help me code',
      '--voice', 'Direct, terse',
      '--context-dir', tempDir,
    ]);
    expect(code).toBe(0);
    await access(join(tempDir, 'IDENTITY.md'));
    await access(join(tempDir, 'preferences.md'));
    await access(join(tempDir, 'self-model.md'));
    expect(stdout.length).toBeGreaterThan(0);
  });

  it('reads params from piped JSON on stdin', async () => {
    const payload = JSON.stringify({
      name: 'Oak', purpose: 'p', voice: 'v', clients: ['claude-code'],
    });
    const { code } = await runCliCaptured(
      ['bootstrap', '--context-dir', tempDir],
      { stdin: payload },
    );
    expect(code).toBe(0);
    await access(join(tempDir, 'IDENTITY.md'));
  });

  it('returns exit 2 when required flags are missing and stdin is empty (TTY simulated)', async () => {
    // runCliCaptured marks stdin as TTY when opts.stdin is undefined
    // but test-helpers sets stdinIsTTY = (opts.stdin === undefined).
    // With no stdin and no flags, the command should refuse (can't prompt
    // in a test harness).
    const { code } = await runCliCaptured(
      ['bootstrap', '--context-dir', tempDir],
    );
    // Either 1 (cannot prompt) or 2 (missing params). Accept 1 or 2 per
    // implementation; the spec demands a clear non-zero exit.
    expect(code).not.toBe(0);
  });

  it('emits structured result on --json', async () => {
    const { stdout, code } = await runCliCaptured([
      'bootstrap',
      '--name', 'Wren', '--purpose', 'p', '--voice', 'v',
      '--context-dir', tempDir, '--json',
    ]);
    expect(code).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed).toHaveProperty('contextDir');
    expect(parsed).toHaveProperty('wrote');
    expect(parsed.wrote).toEqual(expect.arrayContaining([
      expect.stringMatching(/IDENTITY\.md$/),
    ]));
  });
});
```

- [ ] **Step 10.2: Run failing test**

```bash
npx vitest run src/cli/bootstrap.test.ts
```

Expected: FAIL.

- [ ] **Step 10.3: Implement `src/cli/bootstrap.ts`**

```typescript
/**
 * loom bootstrap — initialize a fresh agent.
 *
 * Param sources (precedence):
 *   1. flags (--name, --purpose, --voice, --preferences, --clients)
 *   2. piped JSON on stdin
 *   3. interactive readline prompts (only when stdin is a TTY)
 */
import { parseArgs } from 'node:util';
import { join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { bootstrap } from '../tools/bootstrap.js';
import { extractGlobalFlags, resolveEnv } from './args.js';
import { readStdin, renderJson } from './io.js';
import type { IOStreams } from './io.js';
import type { BootstrapParams } from '../tools/bootstrap.js';

export const USAGE = `Usage: loom bootstrap [options]

Initializes IDENTITY.md, preferences.md, self-model.md, and pursuits.md
in the context directory.

Param sources (first match wins):
  1. Flags (--name / --purpose / --voice)
  2. Piped JSON on stdin: {"name","purpose","voice","clients"?}
  3. Interactive prompts when stdin is a TTY and nothing else is set

Options:
  --name <str>           Agent name (required)
  --purpose <str>        One-line purpose
  --voice <str>          Short voice descriptor
  --preferences <str>    Optional preferences preamble
  --clients <csv>        Comma-separated client adapters (e.g. claude-code)
  --force                Overwrite an existing IDENTITY.md
  --json                 Emit {contextDir, wrote: string[]}
  --context-dir <path>   Agent context dir
  --help, -h             Show this help
`;

async function promptInteractive(io: IOStreams): Promise<BootstrapParams> {
  const rl = createInterface({ input: io.stdin, output: process.stderr });
  const ask = (q: string) => rl.question(q);
  try {
    const name    = (await ask('Agent name: ')).trim();
    const purpose = (await ask('Purpose (one line): ')).trim();
    const voice   = (await ask('Voice (short descriptor): ')).trim();
    const clientsRaw = (await ask('Clients (comma-separated, e.g. claude-code): ')).trim();
    const clients = clientsRaw ? clientsRaw.split(',').map((s) => s.trim()).filter(Boolean) : undefined;
    return { name, purpose, voice, clients };
  } finally {
    rl.close();
  }
}

export async function run(argv: string[], io: IOStreams): Promise<number> {
  const { flags: global, rest } = extractGlobalFlags(argv);
  let parsed;
  try {
    parsed = parseArgs({
      args: rest,
      options: {
        name:        { type: 'string' },
        purpose:     { type: 'string' },
        voice:       { type: 'string' },
        preferences: { type: 'string' },
        clients:     { type: 'string' },
        force:       { type: 'boolean' },
        help:        { type: 'boolean', short: 'h' },
      },
      strict: true,
      allowPositionals: false,
    });
  } catch (err) {
    io.stderr(`${(err as Error).message}\n${USAGE}`);
    return 2;
  }
  if (parsed.values.help) { io.stdout(USAGE); return 0; }

  const env = resolveEnv(global, io.env);

  let params: BootstrapParams | null = null;

  // 1. Flags.
  if (parsed.values.name || parsed.values.purpose || parsed.values.voice) {
    if (!parsed.values.name || !parsed.values.purpose || !parsed.values.voice) {
      io.stderr(`When using flags, --name, --purpose, and --voice are all required.\n`);
      return 2;
    }
    const clientsCsv = parsed.values.clients;
    params = {
      name:        parsed.values.name,
      purpose:     parsed.values.purpose,
      voice:       parsed.values.voice,
      preferences: parsed.values.preferences,
      clients:     clientsCsv ? clientsCsv.split(',').map((s) => s.trim()).filter(Boolean) : undefined,
      force:       Boolean(parsed.values.force),
    };
  } else if (!io.stdinIsTTY) {
    // 2. Piped JSON.
    const raw = await readStdin(io.stdin);
    const trimmed = raw.trim();
    if (!trimmed) {
      io.stderr(`No bootstrap params supplied (no flags, no stdin, no TTY).\n${USAGE}`);
      return 2;
    }
    try {
      const body = JSON.parse(trimmed) as Partial<BootstrapParams>;
      if (!body.name || !body.purpose || !body.voice) {
        io.stderr(`Piped JSON must include name, purpose, and voice.\n`);
        return 2;
      }
      params = {
        name: body.name, purpose: body.purpose, voice: body.voice,
        preferences: body.preferences, clients: body.clients,
        force: Boolean(parsed.values.force),
      };
    } catch (err) {
      io.stderr(`Could not parse stdin as JSON: ${(err as Error).message}\n`);
      return 2;
    }
  } else {
    // 3. Interactive.
    params = await promptInteractive(io);
    if (!params.name || !params.purpose || !params.voice) {
      io.stderr(`name, purpose, and voice are all required.\n`);
      return 2;
    }
    params.force = Boolean(parsed.values.force);
  }

  try {
    const text = await bootstrap(env.contextDir, params);
    if (env.json) {
      renderJson(io, {
        contextDir: env.contextDir,
        wrote: [
          join(env.contextDir, 'IDENTITY.md'),
          join(env.contextDir, 'preferences.md'),
          join(env.contextDir, 'self-model.md'),
          join(env.contextDir, 'pursuits.md'),
        ],
      });
    } else {
      io.stdout(text.endsWith('\n') ? text : text + '\n');
    }
    return 0;
  } catch (err) {
    io.stderr(`${(err as Error).message}\n`);
    return 1;
  }
}
```

### 10B: `loom serve`

- [ ] **Step 10.4: Implement `src/cli/serve.ts`**

```typescript
/**
 * loom serve — explicit alias for stdio MCP startup.
 *
 * This path exists so `loom serve` is discoverable; the default
 * (no-subcommand) invocation of src/index.ts also routes to MCP.
 */
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createLoomServer } from '../server.js';
import { resolveContextDir } from '../config.js';
import type { IOStreams } from './io.js';

export const USAGE = `Usage: loom serve [--context-dir <path>]

Starts the MCP stdio server. Same behavior as invoking 'node dist/index.js'
with no subcommand; provided for explicitness.
`;

export async function run(_argv: string[], _io: IOStreams): Promise<number> {
  // Minimal: reuse the server startup the MCP path runs.
  const contextDir = resolveContextDir();
  const { server } = createLoomServer({ contextDir });
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // server.connect resolves when the stream closes — then the process exits.
  return 0;
}
```

### 10C: Route the remaining subcommands

- [ ] **Step 10.5: Route `bootstrap` and `serve` in `src/cli/index.ts`**

```typescript
    case 'bootstrap': {
      const { run } = await import('./bootstrap.js');
      return run(rest, io);
    }
    case 'serve': {
      const { run } = await import('./serve.js');
      return run(rest, io);
    }
```

- [ ] **Step 10.6: Run bootstrap test + full suite**

```bash
npx vitest run src/cli/bootstrap.test.ts && npx vitest run
```

Expected: all pass.

### 10D: Docs + release

- [ ] **Step 10.7: Add CLI section to `README.md`**

Insert the following block immediately after the "Wire into a runtime"
subsection ends and before "Configuration":

```markdown
## CLI

Every MCP tool has a shell equivalent. Useful for debugging, scripting,
or running without a harness.

```bash
# Dump identity markdown (works even when MCP is dead)
npx loom wake --context-dir ~/.config/loom/art

# Save a memory (body from stdin)
echo "Met Jonathan at a coffee shop" | npx loom remember "first meeting" \
  --category user --context-dir ~/.config/loom/art

# Search
npx loom recall "coffee shop" --context-dir ~/.config/loom/art

# List all memories in a category
npx loom memory list --category feedback --context-dir ~/.config/loom/art

# Initialize a fresh agent
npx loom bootstrap --context-dir ~/.config/loom/new-agent
```

`npx loom --help` lists subcommands; `npx loom <cmd> --help` shows
per-command usage. All global env vars (`LOOM_CONTEXT_DIR`,
`LOOM_CLIENT`, `LOOM_MODEL`) are honored.
\```
```

(Note: in the README the block uses literal triple-backticks around the
shell snippet; the plan above escapes them to avoid nesting.)

- [ ] **Step 10.8: Append §11 to `docs/loom-stack-v1.md`**

Append a new section at the end of the file:

```markdown
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
```

- [ ] **Step 10.9: Bump version**

```bash
# Verify current version:
grep '"version"' package.json
# Should read "0.4.0-alpha.2". If not, stop and investigate.
```

Edit `package.json`: change `"version": "0.4.0-alpha.2"` →
`"version": "0.4.0-alpha.3"`.

Then:

```bash
npm install --package-lock-only
grep '"version"' package-lock.json | head -2
# Should now show 0.4.0-alpha.3 twice.
```

- [ ] **Step 10.10: CHANGELOG entry**

Edit `CHANGELOG.md`. Under `## [Unreleased]` (which is currently empty),
insert a new block above it:

```markdown
## [0.4.0-alpha.3] - 2026-04-20

### Added

- Full CLI surface — every MCP tool has a `loom <subcommand>` shell
  equivalent: `wake`, `recall`, `remember`, `update`, `forget`,
  `memory list`, `memory prune`, `pursuits`, `update-identity`,
  `bootstrap`, plus an explicit `serve` alias. Write commands take
  body text via stdin (when piped) or `$VISUAL`/`$EDITOR` (when
  interactive). `--json` on any command emits the tool's structured
  return value for scripting.
- `assertStackVersionCompatible()` helper consolidates the
  stack-version gate; both MCP startup and every CLI command call it.

### Changed

- `node dist/index.js` with no subcommand still launches MCP (backward
  compatible with every existing `.mcp.json`). A known-subcommand
  argv[2] routes to the CLI instead.
```

And update the link references at the bottom:

```
[Unreleased]: https://github.com/jbarket/loom/compare/v0.4.0-alpha.3...HEAD
[0.4.0-alpha.3]: https://github.com/jbarket/loom/compare/v0.4.0-alpha.2...v0.4.0-alpha.3
[0.4.0-alpha.2]: https://github.com/jbarket/loom/compare/v0.4.0-alpha.1...v0.4.0-alpha.2
[0.4.0-alpha.1]: https://github.com/jbarket/loom/compare/v0.3.1...v0.4.0-alpha.1
[0.3.1]: https://github.com/jbarket/loom/releases/tag/v0.3.1
```

### 10E: Manual verification

- [ ] **Step 10.11: Build and verify**

```bash
npm run build
npx vitest run
```

Expected: build clean, all tests pass.

- [ ] **Step 10.12: Manual smoke test (from a shell, not a test)**

```bash
# 1. Top-level help
node dist/index.js --help | head -30   # should list wake, recall, …

# 2. Version
node dist/index.js --version            # loom v0.4.0-alpha.3

# 3. MCP path still works (no subcommand)
timeout 2 node dist/index.js --context-dir /tmp/loom-smoke-mcp < /dev/null
# Expected: exits cleanly (stdio closes immediately); no stack-version error.

# 4. CLI wake on an existing context dir
mkdir -p /tmp/loom-smoke && echo "# Smoke creed" > /tmp/loom-smoke/IDENTITY.md
node dist/index.js wake --context-dir /tmp/loom-smoke

# 5. Bootstrap a fresh agent via flags
rm -rf /tmp/loom-smoke-boot && mkdir -p /tmp/loom-smoke-boot
node dist/index.js bootstrap \
  --name Sprout --purpose 'smoke test' --voice terse \
  --context-dir /tmp/loom-smoke-boot
ls /tmp/loom-smoke-boot/

# 6. Remember + recall round trip
echo "smoke test body" | node dist/index.js remember 'smoke memory' \
  --category reference --context-dir /tmp/loom-smoke-boot
node dist/index.js recall 'smoke' --context-dir /tmp/loom-smoke-boot

# 7. Cleanup
rm -rf /tmp/loom-smoke /tmp/loom-smoke-boot /tmp/loom-smoke-mcp
```

All seven steps should succeed with the shown behavior.

### 10F: Final commit

- [ ] **Step 10.13: Commit bootstrap + serve + docs + release**

```bash
git add src/cli/bootstrap.ts src/cli/bootstrap.test.ts \
        src/cli/serve.ts src/cli/index.ts \
        README.md docs/loom-stack-v1.md CHANGELOG.md \
        package.json package-lock.json
git commit -s -m "feat(cli): loom bootstrap + loom serve + v0.4.0-alpha.3

bootstrap resolves params from flags, then piped JSON on stdin, then
an interactive readline prompt (TTY only). serve is an explicit alias
for the existing MCP stdio startup.

README gains a CLI section, stack spec gets §11 documenting the
CLI adapter surface, CHANGELOG [0.4.0-alpha.3] entry added.

Refs: docs/specs/2026-04-20-cli-adapter-design.md"
```

---

## Task 11: Push + PR + dependabot disposition follow-through

- [ ] **Step 11.1: Rebase onto main if needed**

```bash
git fetch origin main
git rebase origin/main          # fast-forward if possible; resolve manually if not
```

- [ ] **Step 11.2: Push**

```bash
git push -u origin feat/cli-adapter
```

- [ ] **Step 11.3: Open PR**

```bash
gh pr create --base main --title "v0.4.0-alpha.3: full CLI adapter" --body "$(cat <<'EOF'
## Summary

Every MCP tool now has a shell equivalent. `loom <subcommand>` routes to
the CLI; no-subcommand invocation still launches the MCP server so
existing `.mcp.json` configs keep working.

Ten subcommands plus `serve`:
- `wake`, `recall`, `remember`, `update`, `forget`
- `memory list`, `memory prune`
- `pursuits <action>`, `update-identity <file> [<section>]`
- `bootstrap`, `serve`

Write ops take body via stdin (piped) or \$EDITOR (interactive).
\`--json\` on any command emits the tool's structured return value.

Closes the "CLI adapter" milestone from the v0.4 roadmap
(https://github.com/jbarket/loom/discussions/10).

## Architecture

- \`src/cli/\` holds the adapter; \`src/tools/\` is untouched.
- Subcommand dispatch in \`src/index.ts\` inspects \`argv[2]\`.
- \`assertStackVersionCompatible()\` consolidates the stack-version gate.

Design: \`docs/specs/2026-04-20-cli-adapter-design.md\`.
Plan: \`docs/plans/2026-04-20-cli-adapter.md\`.

## Test plan

- [x] \`npx vitest run\` — all existing + new CLI tests pass
- [x] \`npm run build\` clean
- [x] Manual smoke test (wake / bootstrap / remember / recall / memory list)
- [x] \`.mcp.json\` pointed at \`dist/index.js\` still launches MCP (argv[2] absent path)
- [ ] CI green

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

---

## Definition of done

- [ ] All ten subcommands + `serve` callable from the shell.
- [ ] `npx loom --help` lists subcommands; each `<cmd> --help` prints its own USAGE.
- [ ] `.mcp.json` configs continue to work without edits.
- [ ] `npm run build` clean, full Vitest suite green.
- [ ] README has a CLI section; `docs/loom-stack-v1.md` gains §11.
- [ ] CHANGELOG `[0.4.0-alpha.3]` entry, version bumped in `package.json` + lockfile.
- [ ] Manual smoke test completed.
- [ ] PR opened against `main`, linked to the v0.4 discussion.

---

## Notes for the implementer

- **DCO is non-negotiable** — every commit needs `git commit -s` (Jonathan's branch protection enforces it; unsigned commits are rejected).
- **Imports end in `.js`** — project is strict ESM with `tsc` emitting `.js`. Always write `from '../tools/foo.js'`, never `from '../tools/foo'`.
- **Tests capture via `runCliCaptured`, not subprocesses** — in-process, fast, deterministic. Subprocess tests are off the table (see `src/cli/test-helpers.ts`).
- **`parseArgs` strictness** — the `strict: true` option means unknown flags error out. If a test fails with "Unknown option", check you added the flag to the options object in that command file.
- **Exit code discipline** — 0 success, 1 runtime, 2 usage, 3 not-found, 130 SIGINT. The helper in `src/cli/index.ts::runCli` returns the number and `src/index.ts` does `process.exit(code)`.
- **Stream discipline** — human text + JSON → stdout; errors + help + prompts → stderr. Tests assert on the right stream.
- **No `any`** — project enforces TypeScript strict. Use the exported input/output types from `src/backends/types.ts` and `src/tools/*.ts` directly.
