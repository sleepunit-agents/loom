# Procedures + Manifests CLI/MCP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship `loom procedures list|show|adopt` + `loom harness init` CLI commands and their MCP counterparts (`procedure_list`, `procedure_show`, `procedure_adopt`, `harness_init`), plus content authoring of the 6 seed procedures into the Art stack.

**Architecture:** Three existing block modules (`src/blocks/procedures.ts`, `harness.ts`, `model.ts`) already own template rendering and reading. Extend procedures.ts + harness.ts with `adoptProcedures`/`listProcedures`/`showProcedure`/`initHarness`. CLI entries in `src/cli/procedures.ts` and `src/cli/harness.ts` mirror the `loom inject` pattern (flag-driven + TTY wizard, reusing `multi-select.ts`). MCP tools in `src/tools/procedures.ts` and `src/tools/harness.ts` are thin wrappers over the same core. Idempotent by default; `--force` / `overwrite: true` replaces. No model-manifest MCP tool this round.

**Tech Stack:** TypeScript strict ESM, Node ≥ 20, vitest 4, MCP SDK, `node:util` parseArgs. Branch `feat/procedures-manifests` (already created). Target version 0.4.0-alpha.5.

---

## Task 1: Shared core — adoptProcedures / listProcedures / showProcedure

Extend `src/blocks/procedures.ts` with three new functions and one error class. Pure I/O over `<contextDir>/procedures/*.md`, nothing CLI-specific.

**Files:**
- Modify: `src/blocks/procedures.ts`
- Modify: `src/blocks/procedures.test.ts`

- [ ] **Step 1: Write failing tests for `adoptProcedures`**

Append to `src/blocks/procedures.test.ts`:

```typescript
import { adoptProcedures, listProcedures, showProcedure, UnknownProcedureError } from './procedures.js';

describe('adoptProcedures', () => {
  let ctx: string;
  beforeEach(async () => { ctx = await mkdtemp(join(tmpdir(), 'loom-proc-adopt-')); });
  afterEach(async () => { await rm(ctx, { recursive: true, force: true }); });

  it('creates procedures/<key>.md from seed template for a new key', async () => {
    const [result] = await adoptProcedures(ctx, ['verify-before-completion']);
    expect(result.action).toBe('created');
    expect(result.key).toBe('verify-before-completion');
    expect(result.path).toBe(resolve(ctx, 'procedures', 'verify-before-completion.md'));
    const body = await readFile(result.path, 'utf-8');
    expect(body).toContain('**Rule:**');
    expect(body).toContain('⚠ This is a seed template');
  });

  it('creates the procedures directory if missing', async () => {
    await adoptProcedures(ctx, ['cold-testing']);
    const entries = await readdir(resolve(ctx, 'procedures'));
    expect(entries).toContain('cold-testing.md');
  });

  it('reports skipped-exists for an already-adopted key', async () => {
    await adoptProcedures(ctx, ['cold-testing']);
    const [second] = await adoptProcedures(ctx, ['cold-testing']);
    expect(second.action).toBe('skipped-exists');
  });

  it('overwrites when opts.overwrite is true', async () => {
    const path = resolve(ctx, 'procedures', 'cold-testing.md');
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, '# customized body', 'utf-8');
    const [result] = await adoptProcedures(ctx, ['cold-testing'], { overwrite: true });
    expect(result.action).toBe('overwritten');
    const body = await readFile(path, 'utf-8');
    expect(body).toContain('⚠ This is a seed template');
  });

  it('throws UnknownProcedureError with the offending key for an invalid seed', async () => {
    await expect(adoptProcedures(ctx, ['does-not-exist']))
      .rejects.toThrow(UnknownProcedureError);
  });

  it('handles multiple keys in one call', async () => {
    const results = await adoptProcedures(ctx, ['cold-testing', 'confidence-calibration']);
    expect(results).toHaveLength(2);
    expect(results.every((r) => r.action === 'created')).toBe(true);
  });
});

describe('listProcedures', () => {
  let ctx: string;
  beforeEach(async () => { ctx = await mkdtemp(join(tmpdir(), 'loom-proc-list-')); });
  afterEach(async () => { await rm(ctx, { recursive: true, force: true }); });

  it('reports all seed keys with adopted=false on a fresh stack', async () => {
    const { available } = await listProcedures(ctx);
    const keys = available.map((a) => a.key);
    expect(keys).toEqual(expect.arrayContaining([
      'verify-before-completion',
      'cold-testing',
      'reflection-at-end-of-unit',
      'handoff-to-unpushable-repo',
      'confidence-calibration',
      'RLHF-resistance',
    ]));
    expect(available.every((a) => a.adopted === false)).toBe(true);
  });

  it('flags adopted=true for keys that have been written', async () => {
    await adoptProcedures(ctx, ['cold-testing']);
    const { available } = await listProcedures(ctx);
    const cold = available.find((a) => a.key === 'cold-testing');
    expect(cold?.adopted).toBe(true);
  });
});

describe('showProcedure', () => {
  let ctx: string;
  beforeEach(async () => { ctx = await mkdtemp(join(tmpdir(), 'loom-proc-show-')); });
  afterEach(async () => { await rm(ctx, { recursive: true, force: true }); });

  it('returns template + adopted=false for an un-adopted key', async () => {
    const detail = await showProcedure(ctx, 'cold-testing');
    expect(detail.adopted).toBe(false);
    expect(detail.template).toContain('⚠ This is a seed template');
    expect(detail.body).toBeUndefined();
  });

  it('returns template + body + adopted=true after adoption', async () => {
    await adoptProcedures(ctx, ['cold-testing']);
    const detail = await showProcedure(ctx, 'cold-testing');
    expect(detail.adopted).toBe(true);
    expect(detail.body).toContain('⚠ This is a seed template');
    expect(detail.template).toContain('⚠ This is a seed template');
  });

  it('throws UnknownProcedureError for an unknown key', async () => {
    await expect(showProcedure(ctx, 'not-a-seed'))
      .rejects.toThrow(UnknownProcedureError);
  });
});
```

Also update the test file's imports at the top to add what's needed:

```typescript
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
```

(Keep existing imports.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/blocks/procedures.test.ts`
Expected: FAIL — `adoptProcedures`, `listProcedures`, `showProcedure`, `UnknownProcedureError` don't exist yet.

- [ ] **Step 3: Implement the functions**

Append to `src/blocks/procedures.ts` (after `seedNudge`):

```typescript
// ─── Adoption / listing / show ──────────────────────────────────────────────

import { mkdir, writeFile } from 'node:fs/promises';

export class UnknownProcedureError extends Error {
  constructor(public readonly key: string, public readonly valid: string[]) {
    super(
      `Unknown procedure key '${key}'. ` +
      `Valid keys: ${valid.join(', ')}`,
    );
    this.name = 'UnknownProcedureError';
  }
}

export interface AdoptResult {
  key: string;
  path: string;
  action: 'created' | 'skipped-exists' | 'overwritten';
}

export async function adoptProcedures(
  contextDir: string,
  keys: string[],
  opts: { overwrite?: boolean } = {},
): Promise<AdoptResult[]> {
  const validKeys = Object.keys(SEED_PROCEDURES);
  for (const key of keys) {
    if (!(key in SEED_PROCEDURES)) {
      throw new UnknownProcedureError(key, validKeys);
    }
  }
  const dir = resolve(contextDir, DIR);
  await mkdir(dir, { recursive: true });
  const results: AdoptResult[] = [];
  for (const key of keys) {
    const path = resolve(dir, `${key}.md`);
    const exists = existsSync(path);
    if (exists && !opts.overwrite) {
      results.push({ key, path, action: 'skipped-exists' });
      continue;
    }
    await writeFile(path, SEED_PROCEDURES[key], 'utf-8');
    results.push({ key, path, action: exists ? 'overwritten' : 'created' });
  }
  return results;
}

export interface ProcedureSummary {
  key: string;
  adopted: boolean;
  path: string;
}

export async function listProcedures(contextDir: string): Promise<{
  available: ProcedureSummary[];
}> {
  const available: ProcedureSummary[] = Object.keys(SEED_PROCEDURES).map((key) => {
    const path = resolve(contextDir, DIR, `${key}.md`);
    return { key, adopted: existsSync(path), path };
  });
  return { available };
}

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
): Promise<ProcedureDetail> {
  if (!(key in SEED_PROCEDURES)) {
    throw new UnknownProcedureError(key, Object.keys(SEED_PROCEDURES));
  }
  const path = resolve(contextDir, DIR, `${key}.md`);
  const template = SEED_PROCEDURES[key];
  if (!existsSync(path)) {
    return { key, template, adopted: false, path };
  }
  const body = await readFile(path, 'utf-8');
  return { key, template, adopted: true, path, body };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/blocks/procedures.test.ts`
Expected: PASS — all new `adoptProcedures`, `listProcedures`, `showProcedure` tests green alongside the existing ones.

- [ ] **Step 5: Commit**

```bash
git add src/blocks/procedures.ts src/blocks/procedures.test.ts
git commit -s -m "feat(procedures): adopt/list/show helpers for seed templates"
```

---

## Task 2: Shared core — initHarness

Extend `src/blocks/harness.ts` with `initHarness`. Mirrors adopt semantics.

**Files:**
- Modify: `src/blocks/harness.ts`
- Modify: `src/blocks/harness.test.ts`

- [ ] **Step 1: Write failing tests**

Append to `src/blocks/harness.test.ts`:

```typescript
import { initHarness } from './harness.js';

describe('initHarness', () => {
  let ctx: string;
  beforeEach(async () => { ctx = await mkdtemp(join(tmpdir(), 'loom-harness-init-')); });
  afterEach(async () => { await rm(ctx, { recursive: true, force: true }); });

  it('creates harnesses/<name>.md from the template on a fresh stack', async () => {
    const result = await initHarness(ctx, 'claude-code');
    expect(result.action).toBe('created');
    expect(result.name).toBe('claude-code');
    expect(result.path).toBe(resolve(ctx, 'harnesses', 'claude-code.md'));
    const body = await readFile(result.path, 'utf-8');
    expect(body).toContain('harness: claude-code');
    expect(body).toContain('Tool prefixes');
  });

  it('creates the harnesses directory if missing', async () => {
    await initHarness(ctx, 'codex');
    const entries = await readdir(resolve(ctx, 'harnesses'));
    expect(entries).toContain('codex.md');
  });

  it('reports skipped-exists for an already-initialized harness', async () => {
    await initHarness(ctx, 'codex');
    const result = await initHarness(ctx, 'codex');
    expect(result.action).toBe('skipped-exists');
  });

  it('overwrites when opts.overwrite is true', async () => {
    const path = resolve(ctx, 'harnesses', 'codex.md');
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, '# customized manifest body', 'utf-8');
    const result = await initHarness(ctx, 'codex', { overwrite: true });
    expect(result.action).toBe('overwritten');
    const body = await readFile(path, 'utf-8');
    expect(body).toContain('harness: codex');
  });

  it('rejects names containing path separators', async () => {
    await expect(initHarness(ctx, 'foo/bar')).rejects.toThrow(/name/);
  });

  it('rejects an empty name', async () => {
    await expect(initHarness(ctx, '')).rejects.toThrow(/name/);
  });
});
```

Also ensure the test file imports include:

```typescript
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
```

(Keep existing imports.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/blocks/harness.test.ts`
Expected: FAIL — `initHarness` is undefined.

- [ ] **Step 3: Implement `initHarness`**

Append to `src/blocks/harness.ts`:

```typescript
// ─── Initialization ─────────────────────────────────────────────────────────

import { mkdir, writeFile } from 'node:fs/promises';

export interface InitResult {
  name: string;
  path: string;
  action: 'created' | 'skipped-exists' | 'overwritten';
}

export async function initHarness(
  contextDir: string,
  name: string,
  opts: { overwrite?: boolean } = {},
): Promise<InitResult> {
  if (!name || name.includes('/') || name.includes('\\')) {
    throw new Error(
      `Invalid harness name '${name}': must be non-empty and contain no path separators.`,
    );
  }
  const dir = resolve(contextDir, DIR);
  await mkdir(dir, { recursive: true });
  const path = resolve(dir, `${name}.md`);
  const exists = existsSync(path);
  if (exists && !opts.overwrite) {
    return { name, path, action: 'skipped-exists' };
  }
  await writeFile(path, template(name), 'utf-8');
  return { name, path, action: exists ? 'overwritten' : 'created' };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/blocks/harness.test.ts`
Expected: PASS — all new + existing harness tests green.

- [ ] **Step 5: Commit**

```bash
git add src/blocks/harness.ts src/blocks/harness.test.ts
git commit -s -m "feat(harness): initHarness writes manifest from template"
```

---

## Task 3: CLI — `loom procedures list` and `loom procedures show`

Read-only commands first; adopt comes in Task 4/5.

**Files:**
- Create: `src/cli/procedures.ts`
- Create: `src/cli/procedures.test.ts`

- [ ] **Step 1: Write failing tests**

Create `src/cli/procedures.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { runCliCaptured } from './test-helpers.js';

describe('loom procedures list', () => {
  let ctx: string;
  beforeEach(async () => { ctx = await mkdtemp(join(tmpdir(), 'loom-proc-cli-list-')); });
  afterEach(async () => { await rm(ctx, { recursive: true, force: true }); });

  it('prints a human table with all seed keys and adoption state', async () => {
    const { stdout, code } = await runCliCaptured(
      ['procedures', 'list', '--context-dir', ctx],
    );
    expect(code).toBe(0);
    expect(stdout).toMatch(/verify-before-completion/);
    expect(stdout).toMatch(/cold-testing/);
    expect(stdout).toMatch(/RLHF-resistance/);
    // adopted column header or markers
    expect(stdout.toLowerCase()).toMatch(/adopted/);
  });

  it('marks adopted keys differently from un-adopted keys', async () => {
    await mkdir(resolve(ctx, 'procedures'), { recursive: true });
    await writeFile(resolve(ctx, 'procedures', 'cold-testing.md'), '# custom', 'utf-8');
    const { stdout } = await runCliCaptured(
      ['procedures', 'list', '--context-dir', ctx],
    );
    // Representation detail: adopted = yes, un-adopted = no (or equivalent)
    const coldLine = stdout.split('\n').find((l) => l.includes('cold-testing')) ?? '';
    const verifyLine = stdout.split('\n').find((l) => l.includes('verify-before-completion')) ?? '';
    expect(coldLine).not.toEqual(verifyLine);
  });

  it('--json emits a ProcedureSummary[] array', async () => {
    const { stdout, code } = await runCliCaptured(
      ['procedures', 'list', '--json', '--context-dir', ctx],
    );
    expect(code).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed).toHaveProperty('available');
    expect(Array.isArray(parsed.available)).toBe(true);
    expect(parsed.available.length).toBe(6);
    expect(parsed.available[0]).toMatchObject({
      key: expect.any(String),
      adopted: expect.any(Boolean),
      path: expect.any(String),
    });
  });
});

describe('loom procedures show', () => {
  let ctx: string;
  beforeEach(async () => { ctx = await mkdtemp(join(tmpdir(), 'loom-proc-cli-show-')); });
  afterEach(async () => { await rm(ctx, { recursive: true, force: true }); });

  it('prints the seed template for an un-adopted key', async () => {
    const { stdout, code } = await runCliCaptured(
      ['procedures', 'show', 'cold-testing', '--context-dir', ctx],
    );
    expect(code).toBe(0);
    expect(stdout).toContain('⚠ This is a seed template');
    expect(stdout).toContain('**Rule:**');
  });

  it('prints the on-disk body for an adopted key', async () => {
    await mkdir(resolve(ctx, 'procedures'), { recursive: true });
    await writeFile(
      resolve(ctx, 'procedures', 'cold-testing.md'),
      '# cold-testing\n\n**Rule:** my customized rule\n',
      'utf-8',
    );
    const { stdout, code } = await runCliCaptured(
      ['procedures', 'show', 'cold-testing', '--context-dir', ctx],
    );
    expect(code).toBe(0);
    expect(stdout).toContain('my customized rule');
    expect(stdout).not.toContain('⚠ This is a seed template');
  });

  it('exits 2 on an unknown key', async () => {
    const { code, stderr } = await runCliCaptured(
      ['procedures', 'show', 'does-not-exist', '--context-dir', ctx],
    );
    expect(code).toBe(2);
    expect(stderr).toMatch(/does-not-exist/);
    expect(stderr).toMatch(/Valid keys/);
  });

  it('--json emits a ProcedureDetail record', async () => {
    const { stdout, code } = await runCliCaptured(
      ['procedures', 'show', 'cold-testing', '--json', '--context-dir', ctx],
    );
    expect(code).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed).toMatchObject({
      key: 'cold-testing',
      adopted: false,
      template: expect.stringContaining('**Rule:**'),
    });
  });

  it('exits 2 with usage when no key is given', async () => {
    const { code, stderr } = await runCliCaptured(
      ['procedures', 'show', '--context-dir', ctx],
    );
    expect(code).toBe(2);
    expect(stderr).toMatch(/show/);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/cli/procedures.test.ts`
Expected: FAIL — no `procedures` subcommand registered (hits the "Unknown subcommand" fallthrough at exit code 2, but assertions on the specific stdout/stderr shape won't match).

- [ ] **Step 3: Implement the list + show CLI**

Create `src/cli/procedures.ts`:

```typescript
/**
 * loom procedures — list, show, adopt.
 *
 * Read-only commands (list, show) and the write command (adopt — flag-driven
 * and TTY-wizard) for procedural-identity seed templates. Shares core logic
 * with the MCP surface via src/blocks/procedures.ts.
 */
import { parseArgs } from 'node:util';
import { assertStackVersionCompatible } from '../config.js';
import { extractGlobalFlags, resolveEnv } from './args.js';
import { renderJson } from './io.js';
import type { IOStreams } from './io.js';
import {
  listProcedures,
  showProcedure,
  UnknownProcedureError,
} from '../blocks/procedures.js';

const USAGE = `Usage: loom procedures <subcommand> [options]

Subcommands:
  list             Show available seed procedures and adoption state
  show <key>       Print template (or adopted body) for one procedure
  adopt [<keys>]   Adopt one or more procedures (TUI picker when no keys)

Options (list):
  --json           Emit { available: ProcedureSummary[] } as JSON

Options (show):
  --json           Emit ProcedureDetail as JSON

Options (adopt):
  --all            Adopt every un-adopted seed
  --force          Overwrite existing adopted files
  --json           Emit AdoptResult[] as JSON

Global: --context-dir, --json, --help
`;

export async function run(argv: string[], io: IOStreams): Promise<number> {
  const { flags: global, rest } = extractGlobalFlags(argv);
  const sub = rest[0];
  const subRest = rest.slice(1);

  if (!sub || sub === '--help' || sub === '-h') {
    io.stdout(USAGE);
    return sub ? 0 : 2;
  }
  if (sub !== 'list' && sub !== 'show' && sub !== 'adopt') {
    io.stderr(`Unknown procedures subcommand: ${sub}\n${USAGE}`);
    return 2;
  }

  const env = resolveEnv(global, io.env);
  try { assertStackVersionCompatible(env.contextDir); }
  catch (err) { io.stderr(`${(err as Error).message}\n`); return 1; }

  if (sub === 'list') return runList(env, subRest, io);
  if (sub === 'show') return runShow(env, subRest, io);
  return runAdopt(env, subRest, io);
}

async function runList(
  env: ReturnType<typeof resolveEnv>,
  subRest: string[],
  io: IOStreams,
): Promise<number> {
  try {
    parseArgs({ args: subRest, options: {}, strict: true, allowPositionals: false });
  } catch (err) {
    io.stderr(`${(err as Error).message}\n${USAGE}`);
    return 2;
  }
  const result = await listProcedures(env.contextDir);
  if (env.json) { renderJson(io, result); return 0; }
  const rows = result.available.map((a) => ({
    key: a.key,
    adopted: a.adopted ? 'yes' : 'no ',
    path: a.path,
  }));
  const keyW = Math.max(3, ...rows.map((r) => r.key.length));
  io.stdout(`${'key'.padEnd(keyW)}  adopted  path\n`);
  for (const r of rows) {
    io.stdout(`${r.key.padEnd(keyW)}  ${r.adopted}      ${r.path}\n`);
  }
  return 0;
}

async function runShow(
  env: ReturnType<typeof resolveEnv>,
  subRest: string[],
  io: IOStreams,
): Promise<number> {
  if (subRest.length === 0 || subRest[0].startsWith('--')) {
    io.stderr(`loom procedures show: requires a <key>\n${USAGE}`);
    return 2;
  }
  const key = subRest[0];
  const rest = subRest.slice(1);
  try {
    parseArgs({ args: rest, options: {}, strict: true, allowPositionals: false });
  } catch (err) {
    io.stderr(`${(err as Error).message}\n${USAGE}`);
    return 2;
  }
  try {
    const detail = await showProcedure(env.contextDir, key);
    if (env.json) { renderJson(io, detail); return 0; }
    io.stdout(detail.body ?? detail.template);
    if (!(detail.body ?? detail.template).endsWith('\n')) io.stdout('\n');
    return 0;
  } catch (err) {
    if (err instanceof UnknownProcedureError) {
      io.stderr(`${err.message}\n`);
      return 2;
    }
    io.stderr(`loom procedures show: ${(err as Error).message}\n`);
    return 1;
  }
}

async function runAdopt(
  _env: ReturnType<typeof resolveEnv>,
  _subRest: string[],
  io: IOStreams,
): Promise<number> {
  // Implemented in Task 4/5.
  io.stderr('loom procedures adopt: not implemented yet\n');
  return 2;
}
```

Also update `src/cli/subcommands.ts` to register the new subcommand (small diff):

```typescript
export const SUBCOMMANDS = [
  'wake', 'recall', 'remember', 'forget', 'update',
  'memory', 'pursuits', 'update-identity', 'bootstrap', 'serve',
  'inject', 'procedures',
] as const;
```

And add a dispatch case in `src/cli/index.ts` (find the `case 'inject':` block and add after it):

```typescript
    case 'procedures': {
      const { run } = await import('./procedures.js');
      return run(rest, io);
    }
```

Add to the top-help block in `src/cli/index.ts`:

```
  procedures        Browse/adopt procedural-identity seed templates
```

(Insert after the `inject` line in the Commands list.)

- [ ] **Step 4: Run tests to verify list + show pass**

Run: `npx vitest run src/cli/procedures.test.ts`
Expected: all list/show tests PASS. `adopt` tests don't exist yet.

- [ ] **Step 5: Commit**

```bash
git add src/blocks/procedures.ts src/cli/procedures.ts src/cli/procedures.test.ts \
        src/cli/subcommands.ts src/cli/index.ts
git commit -s -m "feat(cli): loom procedures list|show (read-only)"
```

(`src/blocks/procedures.ts` is included because the existing import section may need small moves — only include it if it actually changed.)

---

## Task 4: CLI — `loom procedures adopt` (flag-driven)

Non-interactive adoption path: explicit keys or `--all`.

**Files:**
- Modify: `src/cli/procedures.ts`
- Modify: `src/cli/procedures.test.ts`

- [ ] **Step 1: Write failing tests**

Append to `src/cli/procedures.test.ts`:

```typescript
describe('loom procedures adopt (flag-driven)', () => {
  let ctx: string;
  beforeEach(async () => { ctx = await mkdtemp(join(tmpdir(), 'loom-proc-cli-adopt-')); });
  afterEach(async () => { await rm(ctx, { recursive: true, force: true }); });

  it('adopts a single key by positional arg', async () => {
    const { stdout, code } = await runCliCaptured(
      ['procedures', 'adopt', 'cold-testing', '--context-dir', ctx],
    );
    expect(code).toBe(0);
    expect(stdout).toMatch(/cold-testing.*created/);
    const { readFile } = await import('node:fs/promises');
    const body = await readFile(resolve(ctx, 'procedures', 'cold-testing.md'), 'utf-8');
    expect(body).toContain('⚠ This is a seed template');
  });

  it('adopts multiple keys', async () => {
    const { stdout, code } = await runCliCaptured(
      ['procedures', 'adopt', 'cold-testing', 'confidence-calibration', '--context-dir', ctx],
    );
    expect(code).toBe(0);
    expect(stdout).toMatch(/cold-testing.*created/);
    expect(stdout).toMatch(/confidence-calibration.*created/);
  });

  it('--all adopts every seed procedure', async () => {
    const { stdout, code } = await runCliCaptured(
      ['procedures', 'adopt', '--all', '--context-dir', ctx],
    );
    expect(code).toBe(0);
    expect(stdout).toMatch(/verify-before-completion.*created/);
    expect(stdout).toMatch(/RLHF-resistance.*created/);
    // 6 lines, one per seed
    expect(stdout.trim().split('\n')).toHaveLength(6);
  });

  it('skips-exists on re-run without --force', async () => {
    await runCliCaptured(['procedures', 'adopt', 'cold-testing', '--context-dir', ctx]);
    const { stdout, code } = await runCliCaptured(
      ['procedures', 'adopt', 'cold-testing', '--context-dir', ctx],
    );
    expect(code).toBe(0);
    expect(stdout).toMatch(/cold-testing.*skipped-exists/);
  });

  it('--force overwrites existing adopted files', async () => {
    await runCliCaptured(['procedures', 'adopt', 'cold-testing', '--context-dir', ctx]);
    const { readFile, writeFile } = await import('node:fs/promises');
    const path = resolve(ctx, 'procedures', 'cold-testing.md');
    await writeFile(path, '# my edits\n', 'utf-8');
    const { stdout, code } = await runCliCaptured(
      ['procedures', 'adopt', 'cold-testing', '--force', '--context-dir', ctx],
    );
    expect(code).toBe(0);
    expect(stdout).toMatch(/cold-testing.*overwritten/);
    const body = await readFile(path, 'utf-8');
    expect(body).toContain('⚠ This is a seed template');
  });

  it('exits 2 on an unknown key', async () => {
    const { code, stderr } = await runCliCaptured(
      ['procedures', 'adopt', 'not-a-real-key', '--context-dir', ctx],
    );
    expect(code).toBe(2);
    expect(stderr).toMatch(/not-a-real-key/);
  });

  it('exits 2 when --all and positional keys are both given', async () => {
    const { code, stderr } = await runCliCaptured(
      ['procedures', 'adopt', '--all', 'cold-testing', '--context-dir', ctx],
    );
    expect(code).toBe(2);
    expect(stderr).toMatch(/mutually exclusive|--all/);
  });

  it('--json emits an AdoptResult[] array', async () => {
    const { stdout, code } = await runCliCaptured(
      ['procedures', 'adopt', 'cold-testing', '--json', '--context-dir', ctx],
    );
    expect(code).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed[0]).toMatchObject({
      key: 'cold-testing',
      action: 'created',
      path: expect.any(String),
    });
  });

  it('exits 2 with usage when no keys and non-TTY stdin', async () => {
    const { code, stderr } = await runCliCaptured(
      ['procedures', 'adopt', '--context-dir', ctx],
      { stdin: '' }, // forces non-TTY
    );
    expect(code).toBe(2);
    expect(stderr).toMatch(/TTY|keys/);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/cli/procedures.test.ts`
Expected: FAIL — adopt is a stub that returns exit 2 with "not implemented yet".

- [ ] **Step 3: Implement flag-driven adopt**

Replace the stub `runAdopt` in `src/cli/procedures.ts` with:

```typescript
async function runAdopt(
  env: ReturnType<typeof resolveEnv>,
  subRest: string[],
  io: IOStreams,
): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args: subRest,
      options: {
        all:   { type: 'boolean' },
        force: { type: 'boolean' },
        help:  { type: 'boolean', short: 'h' },
      },
      strict: true,
      allowPositionals: true,
    });
  } catch (err) {
    io.stderr(`${(err as Error).message}\n${USAGE}`);
    return 2;
  }

  if (parsed.values.help) { io.stdout(USAGE); return 0; }

  const positionals = parsed.positionals;
  const wantAll = parsed.values.all === true;
  const overwrite = parsed.values.force === true;

  if (wantAll && positionals.length > 0) {
    io.stderr('loom procedures adopt: --all and positional keys are mutually exclusive\n');
    return 2;
  }

  let keys: string[];
  if (wantAll) {
    const { available } = await listProcedures(env.contextDir);
    keys = available.map((a) => a.key);
  } else if (positionals.length > 0) {
    keys = positionals;
  } else {
    // No keys → would be wizard. Wizard lives in Task 5.
    if (!io.stdinIsTTY) {
      io.stderr('loom procedures adopt: <keys> or --all required when stdin is not a TTY\n');
      return 2;
    }
    // TTY path implemented in Task 5 — until then, print usage and exit 2.
    io.stderr(`loom procedures adopt: interactive picker not implemented yet\n${USAGE}`);
    return 2;
  }

  try {
    const results = await adoptProcedures(env.contextDir, keys, { overwrite });
    if (env.json) { renderJson(io, results); return 0; }
    for (const r of results) {
      io.stdout(`${r.key}: ${r.path} (${r.action})\n`);
    }
    return 0;
  } catch (err) {
    if (err instanceof UnknownProcedureError) {
      io.stderr(`${err.message}\n`);
      return 2;
    }
    io.stderr(`loom procedures adopt: ${(err as Error).message}\n`);
    return 1;
  }
}
```

Also update the imports at the top of the file to add:

```typescript
import { adoptProcedures } from '../blocks/procedures.js';
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/cli/procedures.test.ts`
Expected: all adopt flag-driven tests PASS. The "interactive picker not implemented yet" stderr is fine for Task 5's TTY tests to replace in the next task.

- [ ] **Step 5: Commit**

```bash
git add src/cli/procedures.ts src/cli/procedures.test.ts
git commit -s -m "feat(cli): loom procedures adopt (flag-driven)"
```

---

## Task 5: CLI — `loom procedures adopt` (interactive TUI)

Replace the TTY stub with a real multi-select picker.

**Files:**
- Modify: `src/cli/procedures.ts`
- Modify: `src/cli/procedures.test.ts`

- [ ] **Step 1: Write failing tests**

Append to `src/cli/procedures.test.ts`:

```typescript
describe('loom procedures adopt (TUI picker)', () => {
  let ctx: string;
  beforeEach(async () => { ctx = await mkdtemp(join(tmpdir(), 'loom-proc-cli-tui-')); });
  afterEach(async () => { await rm(ctx, { recursive: true, force: true }); });

  it('picker with user selections writes only the selected keys', async () => {
    const { vi } = await import('vitest');
    vi.resetModules();
    vi.doMock('./tui/multi-select.js', async () => {
      const actual = await vi.importActual<typeof import('./tui/multi-select.js')>('./tui/multi-select.js');
      return {
        ...actual,
        multiSelect: async () => new Set(['cold-testing', 'confidence-calibration']),
      };
    });
    const { runCliCaptured: run } = await import('./test-helpers.js');
    const { code } = await run(['procedures', 'adopt', '--context-dir', ctx]);
    vi.resetModules();
    vi.doUnmock('./tui/multi-select.js');
    expect(code).toBe(0);
    const { readFile } = await import('node:fs/promises');
    await readFile(resolve(ctx, 'procedures', 'cold-testing.md'), 'utf-8');
    await readFile(resolve(ctx, 'procedures', 'confidence-calibration.md'), 'utf-8');
    // Non-selected keys should not have been written
    const { access } = await import('node:fs/promises');
    await expect(access(resolve(ctx, 'procedures', 'cold-testing.md'))).resolves.toBeUndefined();
    await expect(access(resolve(ctx, 'procedures', 'RLHF-resistance.md')))
      .rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('picker cancel (null) exits 130', async () => {
    const { vi } = await import('vitest');
    vi.resetModules();
    vi.doMock('./tui/multi-select.js', async () => {
      const actual = await vi.importActual<typeof import('./tui/multi-select.js')>('./tui/multi-select.js');
      return { ...actual, multiSelect: async () => null };
    });
    const { runCliCaptured: run } = await import('./test-helpers.js');
    const { code } = await run(['procedures', 'adopt', '--context-dir', ctx]);
    vi.resetModules();
    vi.doUnmock('./tui/multi-select.js');
    expect(code).toBe(130);
  });

  it('picker empty-selection exits 2 with message', async () => {
    const { vi } = await import('vitest');
    vi.resetModules();
    vi.doMock('./tui/multi-select.js', async () => {
      const actual = await vi.importActual<typeof import('./tui/multi-select.js')>('./tui/multi-select.js');
      return { ...actual, multiSelect: async () => new Set<string>() };
    });
    const { runCliCaptured: run } = await import('./test-helpers.js');
    const { code, stderr } = await run(['procedures', 'adopt', '--context-dir', ctx]);
    vi.resetModules();
    vi.doUnmock('./tui/multi-select.js');
    expect(code).toBe(2);
    expect(stderr).toMatch(/no procedures selected/);
  });

  it('picker only offers un-adopted keys', async () => {
    const { vi } = await import('vitest');
    const { mkdir, writeFile } = await import('node:fs/promises');
    await mkdir(resolve(ctx, 'procedures'), { recursive: true });
    await writeFile(resolve(ctx, 'procedures', 'cold-testing.md'), '# done', 'utf-8');

    vi.resetModules();
    let capturedKeys: string[] = [];
    vi.doMock('./tui/multi-select.js', async () => {
      const actual = await vi.importActual<typeof import('./tui/multi-select.js')>('./tui/multi-select.js');
      return {
        ...actual,
        multiSelect: async (opts: { items: { value: string }[] }) => {
          capturedKeys = opts.items.map((i) => i.value);
          return new Set<string>();
        },
      };
    });
    const { runCliCaptured: run } = await import('./test-helpers.js');
    await run(['procedures', 'adopt', '--context-dir', ctx]);
    vi.resetModules();
    vi.doUnmock('./tui/multi-select.js');

    expect(capturedKeys).not.toContain('cold-testing');
    expect(capturedKeys).toContain('verify-before-completion');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/cli/procedures.test.ts`
Expected: TUI tests FAIL — current stub returns 2 with "not implemented yet".

- [ ] **Step 3: Implement the TUI path**

In `src/cli/procedures.ts`, replace the TTY block inside `runAdopt` (where it currently returns 2 with "interactive picker not implemented yet") with:

```typescript
    // TTY path — multi-select picker, un-adopted keys only
    const { available } = await listProcedures(env.contextDir);
    const unadopted = available.filter((a) => !a.adopted);
    if (unadopted.length === 0) {
      io.stdout('All seed procedures are already adopted. Nothing to do.\n');
      return 0;
    }
    const { multiSelect } = await import('./tui/multi-select.js');
    const chosen = await multiSelect<string>({
      title: 'Select procedures to adopt:',
      items: unadopted.map((a) => ({
        value: a.key,
        label: a.key,
        detail: a.path,
      })),
      initialSelected: new Set<string>(),
    });
    if (chosen === null) {
      io.stderr('loom procedures adopt: cancelled\n');
      return 130;
    }
    if (chosen.size === 0) {
      io.stderr('loom procedures adopt: no procedures selected\n');
      return 2;
    }
    keys = [...chosen];
```

(Keep the adopt-and-report block below untouched — it runs against whatever `keys` was set to.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/cli/procedures.test.ts`
Expected: all procedures CLI tests PASS (list + show + adopt flag-driven + adopt TUI).

- [ ] **Step 5: Commit**

```bash
git add src/cli/procedures.ts src/cli/procedures.test.ts
git commit -s -m "feat(cli): loom procedures adopt TUI picker"
```

---

## Task 6: CLI — `loom harness init`

One-shot manifest initializer.

**Files:**
- Create: `src/cli/harness.ts`
- Create: `src/cli/harness.test.ts`
- Modify: `src/cli/subcommands.ts`
- Modify: `src/cli/index.ts`

- [ ] **Step 1: Write failing tests**

Create `src/cli/harness.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { runCliCaptured } from './test-helpers.js';

describe('loom harness init', () => {
  let ctx: string;
  beforeEach(async () => { ctx = await mkdtemp(join(tmpdir(), 'loom-harness-cli-')); });
  afterEach(async () => { await rm(ctx, { recursive: true, force: true }); });

  it('writes harnesses/<name>.md with the template body', async () => {
    const { stdout, code } = await runCliCaptured(
      ['harness', 'init', 'claude-code', '--context-dir', ctx],
    );
    expect(code).toBe(0);
    expect(stdout).toMatch(/claude-code.*created/);
    const body = await readFile(resolve(ctx, 'harnesses', 'claude-code.md'), 'utf-8');
    expect(body).toContain('harness: claude-code');
  });

  it('infers name from --client when no positional is given', async () => {
    const { stdout, code } = await runCliCaptured(
      ['harness', 'init', '--client', 'codex', '--context-dir', ctx],
    );
    expect(code).toBe(0);
    expect(stdout).toMatch(/codex.*created/);
    await readFile(resolve(ctx, 'harnesses', 'codex.md'), 'utf-8');
  });

  it('infers name from $LOOM_CLIENT when neither positional nor --client', async () => {
    const { stdout, code } = await runCliCaptured(
      ['harness', 'init', '--context-dir', ctx],
      { env: { LOOM_CLIENT: 'gemini-cli' } },
    );
    expect(code).toBe(0);
    expect(stdout).toMatch(/gemini-cli.*created/);
  });

  it('exits 2 when no name can be resolved', async () => {
    const { code, stderr } = await runCliCaptured(
      ['harness', 'init', '--context-dir', ctx],
    );
    expect(code).toBe(2);
    expect(stderr).toMatch(/name|--client|LOOM_CLIENT/);
  });

  it('skips-exists on re-run without --force', async () => {
    await runCliCaptured(['harness', 'init', 'codex', '--context-dir', ctx]);
    const { stdout, code } = await runCliCaptured(
      ['harness', 'init', 'codex', '--context-dir', ctx],
    );
    expect(code).toBe(0);
    expect(stdout).toMatch(/codex.*skipped-exists/);
  });

  it('--force overwrites', async () => {
    await mkdir(resolve(ctx, 'harnesses'), { recursive: true });
    const path = resolve(ctx, 'harnesses', 'codex.md');
    await writeFile(path, '# custom\n', 'utf-8');
    const { stdout, code } = await runCliCaptured(
      ['harness', 'init', 'codex', '--force', '--context-dir', ctx],
    );
    expect(code).toBe(0);
    expect(stdout).toMatch(/codex.*overwritten/);
    const body = await readFile(path, 'utf-8');
    expect(body).toContain('harness: codex');
  });

  it('--json emits an InitResult', async () => {
    const { stdout, code } = await runCliCaptured(
      ['harness', 'init', 'codex', '--json', '--context-dir', ctx],
    );
    expect(code).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed).toMatchObject({
      name: 'codex',
      action: 'created',
      path: expect.any(String),
    });
  });

  it('exits 2 for a name with path separators', async () => {
    const { code, stderr } = await runCliCaptured(
      ['harness', 'init', 'foo/bar', '--context-dir', ctx],
    );
    expect(code).toBe(2);
    expect(stderr).toMatch(/name/);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/cli/harness.test.ts`
Expected: FAIL — `harness` is not in SUBCOMMANDS.

- [ ] **Step 3: Implement the CLI**

Create `src/cli/harness.ts`:

```typescript
/**
 * loom harness — manifest lifecycle for harness adapters.
 *
 * For v0.4.0-alpha.5 the only subcommand is `init`: writes a manifest
 * template to <contextDir>/harnesses/<name>.md. Reading is implicit —
 * identity() already composes the manifest from disk.
 */
import { parseArgs } from 'node:util';
import { assertStackVersionCompatible } from '../config.js';
import { extractGlobalFlags, resolveEnv } from './args.js';
import { renderJson } from './io.js';
import type { IOStreams } from './io.js';
import { initHarness } from '../blocks/harness.js';

const USAGE = `Usage: loom harness <subcommand> [options]

Subcommands:
  init [<name>]    Write a manifest template for <name>

Options (init):
  --force          Overwrite existing manifest
  --json           Emit InitResult as JSON

<name> falls back to --client, then $LOOM_CLIENT.

Global: --context-dir, --client, --json, --help
`;

export async function run(argv: string[], io: IOStreams): Promise<number> {
  const { flags: global, rest } = extractGlobalFlags(argv);
  const sub = rest[0];
  const subRest = rest.slice(1);

  if (!sub || sub === '--help' || sub === '-h') {
    io.stdout(USAGE);
    return sub ? 0 : 2;
  }
  if (sub !== 'init') {
    io.stderr(`Unknown harness subcommand: ${sub}\n${USAGE}`);
    return 2;
  }

  const env = resolveEnv(global, io.env);
  try { assertStackVersionCompatible(env.contextDir); }
  catch (err) { io.stderr(`${(err as Error).message}\n`); return 1; }

  let parsed;
  try {
    parsed = parseArgs({
      args: subRest,
      options: {
        force: { type: 'boolean' },
        help:  { type: 'boolean', short: 'h' },
      },
      strict: true,
      allowPositionals: true,
    });
  } catch (err) {
    io.stderr(`${(err as Error).message}\n${USAGE}`);
    return 2;
  }
  if (parsed.values.help) { io.stdout(USAGE); return 0; }

  const name = parsed.positionals[0] ?? env.client;
  if (!name) {
    io.stderr(
      'loom harness init: <name> required (or pass --client / set $LOOM_CLIENT)\n',
    );
    return 2;
  }

  try {
    const result = await initHarness(env.contextDir, name, {
      overwrite: parsed.values.force === true,
    });
    if (env.json) { renderJson(io, result); return 0; }
    io.stdout(`${result.name}: ${result.path} (${result.action})\n`);
    return 0;
  } catch (err) {
    // initHarness throws on invalid name — usage error.
    if ((err as Error).message.startsWith('Invalid harness name')) {
      io.stderr(`${(err as Error).message}\n`);
      return 2;
    }
    io.stderr(`loom harness init: ${(err as Error).message}\n`);
    return 1;
  }
}
```

Add `'harness'` to SUBCOMMANDS in `src/cli/subcommands.ts`:

```typescript
export const SUBCOMMANDS = [
  'wake', 'recall', 'remember', 'forget', 'update',
  'memory', 'pursuits', 'update-identity', 'bootstrap', 'serve',
  'inject', 'procedures', 'harness',
] as const;
```

Add dispatch case in `src/cli/index.ts` (after the `procedures` case):

```typescript
    case 'harness': {
      const { run } = await import('./harness.js');
      return run(rest, io);
    }
```

Add to top-help in `src/cli/index.ts` (after the `procedures` line):

```
  harness init      Scaffold a harness manifest from template
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/cli/harness.test.ts`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add src/cli/harness.ts src/cli/harness.test.ts \
        src/cli/subcommands.ts src/cli/index.ts
git commit -s -m "feat(cli): loom harness init"
```

---

## Task 7: MCP tools — procedures (list, show, adopt)

Three thin handlers over the shared core.

**Files:**
- Create: `src/tools/procedures.ts`
- Create: `src/tools/procedures.test.ts`

- [ ] **Step 1: Write failing tests**

Create `src/tools/procedures.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { procedureList, procedureShow, procedureAdopt } from './procedures.js';

describe('procedureList (MCP)', () => {
  let ctx: string;
  beforeEach(async () => { ctx = await mkdtemp(join(tmpdir(), 'loom-proc-mcp-list-')); });
  afterEach(async () => { await rm(ctx, { recursive: true, force: true }); });

  it('returns a human-readable summary listing all seeds', async () => {
    const text = await procedureList(ctx);
    expect(text).toMatch(/verify-before-completion/);
    expect(text).toMatch(/RLHF-resistance/);
    expect(text).toMatch(/adopted/i);
  });

  it('marks adopted keys distinctly from un-adopted', async () => {
    await mkdir(resolve(ctx, 'procedures'), { recursive: true });
    await writeFile(resolve(ctx, 'procedures', 'cold-testing.md'), '# x', 'utf-8');
    const text = await procedureList(ctx);
    const coldLine = text.split('\n').find((l) => l.includes('cold-testing')) ?? '';
    const verifyLine = text.split('\n').find((l) => l.includes('verify-before-completion')) ?? '';
    expect(coldLine).not.toEqual(verifyLine);
  });
});

describe('procedureShow (MCP)', () => {
  let ctx: string;
  beforeEach(async () => { ctx = await mkdtemp(join(tmpdir(), 'loom-proc-mcp-show-')); });
  afterEach(async () => { await rm(ctx, { recursive: true, force: true }); });

  it('returns template text for un-adopted key', async () => {
    const text = await procedureShow(ctx, 'cold-testing');
    expect(text).toContain('⚠ This is a seed template');
  });

  it('returns adopted body when adopted', async () => {
    await mkdir(resolve(ctx, 'procedures'), { recursive: true });
    await writeFile(
      resolve(ctx, 'procedures', 'cold-testing.md'),
      '# cold-testing\n**Rule:** my custom\n',
      'utf-8',
    );
    const text = await procedureShow(ctx, 'cold-testing');
    expect(text).toContain('my custom');
  });

  it('throws for unknown key', async () => {
    await expect(procedureShow(ctx, 'bogus')).rejects.toThrow(/bogus/);
  });
});

describe('procedureAdopt (MCP)', () => {
  let ctx: string;
  beforeEach(async () => { ctx = await mkdtemp(join(tmpdir(), 'loom-proc-mcp-adopt-')); });
  afterEach(async () => { await rm(ctx, { recursive: true, force: true }); });

  it('adopts requested keys and returns summary text', async () => {
    const text = await procedureAdopt(ctx, { keys: ['cold-testing', 'confidence-calibration'] });
    expect(text).toMatch(/cold-testing.*created/);
    expect(text).toMatch(/confidence-calibration.*created/);
    const body = await readFile(resolve(ctx, 'procedures', 'cold-testing.md'), 'utf-8');
    expect(body).toContain('⚠ This is a seed template');
  });

  it('reports skipped-exists on re-run', async () => {
    await procedureAdopt(ctx, { keys: ['cold-testing'] });
    const text = await procedureAdopt(ctx, { keys: ['cold-testing'] });
    expect(text).toMatch(/cold-testing.*skipped-exists/);
  });

  it('overwrites when overwrite=true', async () => {
    await procedureAdopt(ctx, { keys: ['cold-testing'] });
    const path = resolve(ctx, 'procedures', 'cold-testing.md');
    await writeFile(path, '# custom edits\n', 'utf-8');
    const text = await procedureAdopt(ctx, { keys: ['cold-testing'], overwrite: true });
    expect(text).toMatch(/cold-testing.*overwritten/);
    const body = await readFile(path, 'utf-8');
    expect(body).toContain('⚠ This is a seed template');
  });

  it('throws on empty keys', async () => {
    await expect(procedureAdopt(ctx, { keys: [] })).rejects.toThrow(/keys/);
  });

  it('throws on unknown key with valid-keys list in message', async () => {
    await expect(procedureAdopt(ctx, { keys: ['bogus'] }))
      .rejects.toThrow(/bogus/);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/tools/procedures.test.ts`
Expected: FAIL — file doesn't exist.

- [ ] **Step 3: Implement the MCP handlers**

Create `src/tools/procedures.ts`:

```typescript
/**
 * MCP tool handlers for procedural-identity seed templates.
 *
 * Thin wrappers over src/blocks/procedures.ts. Return prose text that
 * reads well to an LLM caller — server.ts wraps each in the standard
 * { content: [{ type: 'text', text }] } envelope.
 */
import {
  adoptProcedures,
  listProcedures,
  showProcedure,
  SEED_PROCEDURES,
  UnknownProcedureError,
  type AdoptResult,
} from '../blocks/procedures.js';

export async function procedureList(contextDir: string): Promise<string> {
  const { available } = await listProcedures(contextDir);
  const lines = ['Procedures — available seeds and adoption state:\n'];
  const keyWidth = Math.max(3, ...available.map((a) => a.key.length));
  for (const a of available) {
    const marker = a.adopted ? '✓ adopted' : '  not yet';
    lines.push(`  ${a.key.padEnd(keyWidth)}  ${marker}  ${a.path}`);
  }
  lines.push('');
  lines.push('Call `procedure_show { key }` to preview a template, ');
  lines.push('or `procedure_adopt { keys: [...] }` to materialize.');
  return lines.join('\n');
}

export async function procedureShow(contextDir: string, key: string): Promise<string> {
  const detail = await showProcedure(contextDir, key);
  return detail.body ?? detail.template;
}

export async function procedureAdopt(
  contextDir: string,
  input: { keys: string[]; overwrite?: boolean },
): Promise<string> {
  if (!input.keys || input.keys.length === 0) {
    throw new Error('procedure_adopt: keys array required and must be non-empty');
  }
  const results: AdoptResult[] = await adoptProcedures(
    contextDir,
    input.keys,
    { overwrite: input.overwrite },
  );
  const lines = ['Procedure adoption results:\n'];
  for (const r of results) {
    lines.push(`  ${r.key}: ${r.path} (${r.action})`);
  }
  return lines.join('\n');
}

// Re-export for server.ts validation
export { SEED_PROCEDURES, UnknownProcedureError };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/tools/procedures.test.ts`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add src/tools/procedures.ts src/tools/procedures.test.ts
git commit -s -m "feat(mcp): procedure_list / procedure_show / procedure_adopt tools"
```

---

## Task 8: MCP tool — harness_init + server registration

**Files:**
- Create: `src/tools/harness.ts`
- Create: `src/tools/harness.test.ts`
- Modify: `src/server.ts`

- [ ] **Step 1: Write failing tests**

Create `src/tools/harness.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { harnessInit } from './harness.js';

describe('harnessInit (MCP)', () => {
  let ctx: string;
  beforeEach(async () => { ctx = await mkdtemp(join(tmpdir(), 'loom-harness-mcp-')); });
  afterEach(async () => { await rm(ctx, { recursive: true, force: true }); });

  it('creates a manifest and returns summary text', async () => {
    const text = await harnessInit(ctx, { name: 'claude-code' });
    expect(text).toMatch(/claude-code/);
    expect(text).toMatch(/created/);
    const body = await readFile(resolve(ctx, 'harnesses', 'claude-code.md'), 'utf-8');
    expect(body).toContain('harness: claude-code');
  });

  it('reports skipped-exists on re-init', async () => {
    await harnessInit(ctx, { name: 'codex' });
    const text = await harnessInit(ctx, { name: 'codex' });
    expect(text).toMatch(/skipped-exists/);
  });

  it('overwrites with overwrite=true', async () => {
    await harnessInit(ctx, { name: 'codex' });
    await writeFile(resolve(ctx, 'harnesses', 'codex.md'), '# custom\n', 'utf-8');
    const text = await harnessInit(ctx, { name: 'codex', overwrite: true });
    expect(text).toMatch(/overwritten/);
  });

  it('throws for invalid names', async () => {
    await expect(harnessInit(ctx, { name: '' })).rejects.toThrow(/name/);
    await expect(harnessInit(ctx, { name: 'foo/bar' })).rejects.toThrow(/name/);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/tools/harness.test.ts`
Expected: FAIL — file doesn't exist.

- [ ] **Step 3: Implement the handler**

Create `src/tools/harness.ts`:

```typescript
/**
 * MCP tool handler for harness-manifest initialization.
 * Thin wrapper over src/blocks/harness.initHarness.
 */
import { initHarness } from '../blocks/harness.js';

export async function harnessInit(
  contextDir: string,
  input: { name: string; overwrite?: boolean },
): Promise<string> {
  const result = await initHarness(contextDir, input.name, {
    overwrite: input.overwrite,
  });
  return `Harness manifest ${result.name}: ${result.path} (${result.action})`;
}
```

- [ ] **Step 4: Register the four new tools in server.ts**

In `src/server.ts`, add these imports near the existing tool imports:

```typescript
import { procedureList, procedureShow, procedureAdopt } from './tools/procedures.js';
import { harnessInit } from './tools/harness.js';
```

Then, after the `pursuits` tool registration (near the end of the file, before `return { server };`), add:

```typescript
  // ─── Procedures ─────────────────────────────────────────────────────────────

  server.tool(
    'procedure_list',
    'List available procedural-identity seed templates and their adoption state in this stack. ' +
    'Procedures are prescriptive docs for how this agent acts (verify, cold-test, reflect, handoff). ' +
    'Use this when you want to see which seeds are available or which have already been adopted.',
    {},
    async () => {
      const text = await procedureList(contextDir);
      return { content: [{ type: 'text' as const, text }] };
    },
  );

  server.tool(
    'procedure_show',
    'Preview the body of a procedure — the seed template if not adopted, or the current ' +
    'on-disk body if adopted. Useful before calling procedure_adopt or as a primitive for ' +
    'future customization wizards.',
    {
      key: z.string().describe('Seed procedure key (e.g. "verify-before-completion")'),
    },
    async ({ key }) => {
      const text = await procedureShow(contextDir, key);
      return { content: [{ type: 'text' as const, text }] };
    },
  );

  server.tool(
    'procedure_adopt',
    'Materialize one or more procedural-identity seed templates into ' +
    '<contextDir>/procedures/<key>.md. Idempotent: skip-exists by default. ' +
    'Pass overwrite: true to replace already-adopted files. Call this in response ' +
    'to the procedures seed nudge in the identity payload.',
    {
      keys: z.array(z.string()).describe('Seed procedure keys to adopt'),
      overwrite: z.boolean().optional().describe('Replace already-adopted files (default: false)'),
    },
    async ({ keys, overwrite }) => {
      const text = await procedureAdopt(contextDir, { keys, overwrite });
      return { content: [{ type: 'text' as const, text }] };
    },
  );

  // ─── Harness manifests ──────────────────────────────────────────────────────

  server.tool(
    'harness_init',
    'Scaffold a harness manifest at <contextDir>/harnesses/<name>.md from the template ' +
    '(see stack spec v1 §4.7). Call this when identity() reports a missing manifest for the ' +
    'current harness. Idempotent: skip-exists by default; overwrite: true replaces.',
    {
      name: z.string().describe('Harness name (e.g. "claude-code", "codex", "gemini-cli")'),
      overwrite: z.boolean().optional().describe('Replace existing manifest (default: false)'),
    },
    async ({ name, overwrite }) => {
      const text = await harnessInit(contextDir, { name, overwrite });
      return { content: [{ type: 'text' as const, text }] };
    },
  );
```

- [ ] **Step 5: Run tests to verify all pass**

Run: `npx vitest run`
Expected: full suite green, ~377 tests.

- [ ] **Step 6: Commit**

```bash
git add src/tools/harness.ts src/tools/harness.test.ts src/server.ts
git commit -s -m "feat(mcp): harness_init tool + register procedure_* tools on server"
```

---

## Task 9: Integration test — first-boot flow

End-to-end: fresh stack → list → adopt --all → identity includes procedures → re-adopt reports skipped-exists.

**Files:**
- Create: `src/cli/procedures.integration.test.ts`

- [ ] **Step 1: Write the integration test**

Create `src/cli/procedures.integration.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { runCliCaptured } from './test-helpers.js';
import { loadIdentity } from '../tools/identity.js';

describe('procedures — first-boot integration', () => {
  let ctx: string;
  beforeEach(async () => { ctx = await mkdtemp(join(tmpdir(), 'loom-proc-int-')); });
  afterEach(async () => { await rm(ctx, { recursive: true, force: true }); });

  it('list → adopt --all → identity → re-adopt', async () => {
    // 1. Fresh list — all 6 un-adopted
    const list1 = await runCliCaptured(
      ['procedures', 'list', '--json', '--context-dir', ctx],
    );
    expect(list1.code).toBe(0);
    const listed = JSON.parse(list1.stdout).available;
    expect(listed).toHaveLength(6);
    expect(listed.every((a: { adopted: boolean }) => a.adopted === false)).toBe(true);

    // 2. Adopt --all
    const adopt1 = await runCliCaptured(
      ['procedures', 'adopt', '--all', '--context-dir', ctx],
    );
    expect(adopt1.code).toBe(0);
    expect(adopt1.stdout.trim().split('\n')).toHaveLength(6);

    // 3. identity() now includes the procedures block
    const identity = await loadIdentity(ctx);
    expect(identity).toContain('# Procedures');
    expect(identity).toContain('verify-before-completion');
    expect(identity).toContain('⚠ This is a seed template'); // ownership ritual visible

    // 4. Re-adopt — all should report skipped-exists
    const adopt2 = await runCliCaptured(
      ['procedures', 'adopt', '--all', '--context-dir', ctx],
    );
    expect(adopt2.code).toBe(0);
    expect(adopt2.stdout.match(/skipped-exists/g)).toHaveLength(6);

    // 5. Files are readable
    const bodyA = await readFile(resolve(ctx, 'procedures', 'cold-testing.md'), 'utf-8');
    expect(bodyA).toContain('**Rule:**');
  });
});
```

- [ ] **Step 2: Run the test**

Run: `npx vitest run src/cli/procedures.integration.test.ts`
Expected: PASS.

- [ ] **Step 3: Run full suite**

Run: `npx vitest run`
Expected: all green.

- [ ] **Step 4: Commit**

```bash
git add src/cli/procedures.integration.test.ts
git commit -s -m "test(procedures): first-boot integration"
```

---

## Task 10: Docs — README + stack spec

**Files:**
- Modify: `README.md`
- Modify: `docs/loom-stack-v1.md`

- [ ] **Step 1: README version badge**

Find line 4 of `README.md`:
`[![Version](https://img.shields.io/badge/version-0.4.0--alpha.4-blue.svg)](CHANGELOG.md)`

Replace `0.4.0--alpha.4` with `0.4.0--alpha.5`.

- [ ] **Step 2: README CLI examples**

In the `## CLI` section, inside the `bash` code block that already shows `loom bootstrap` and `loom inject`, append these examples after the `loom inject` line (before the closing triple-backtick):

```
# Adopt procedural-identity seed templates
npx loom procedures list
npx loom procedures adopt --all --context-dir ~/.config/loom/art

# Scaffold a harness manifest
npx loom harness init claude-code --context-dir ~/.config/loom/art
```

- [ ] **Step 3: README subsection**

Immediately after the existing `### \`loom inject\` — write identity pointer to harness dotfiles` subsection (and before `## Configuration`), insert:

````markdown
### `loom procedures` — adopt procedural-identity seed templates

`loom procedures` manages the prescriptive "how this agent acts" docs in
`<context>/procedures/*.md` (stack spec v1 §4.9). Six seed templates ship
with loom: `verify-before-completion`, `cold-testing`,
`reflection-at-end-of-unit`, `handoff-to-unpushable-repo`,
`confidence-calibration`, `RLHF-resistance`.

- `loom procedures list` — table of seeds with adoption state.
- `loom procedures show <key>` — print template or adopted body.
- `loom procedures adopt <keys...>` — write seeds to disk.
- `loom procedures adopt --all` — adopt every un-adopted seed.
- `loom procedures adopt` on a TTY — multi-select picker (un-adopted
  only).
- `--force` overwrites; idempotent by default (re-runs report
  `skipped-exists`). `--json` for scripting.

Adopted procedures ship with a ⚠ ownership ritual the agent deletes when
it customizes the Why and How-to-apply sections. Unedited seeds are
self-announcing in the identity payload.

### `loom harness init` — scaffold a harness manifest

`loom harness init <name>` writes `<context>/harnesses/<name>.md` from
the stack-spec §4.7 template. Name falls back to `--client` then
`$LOOM_CLIENT`. `--force` overwrites; `--json` for scripting.

Typical use: `identity()` reports "manifest missing" for the current
harness — run `loom harness init` (or call `harness_init` via MCP) to
drop a template you can then fill in with the harness's tool prefixes,
delegation primitive, etc.
````

- [ ] **Step 4: Stack spec §11 new section**

In `docs/loom-stack-v1.md`, append after the `## §11 — Adapters: Injection (filesystem)` section:

```markdown

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
```

- [ ] **Step 5: Verify docs build**

Run: `grep -n 'procedures\|harness init' README.md && grep -n 'Procedures + Manifests' docs/loom-stack-v1.md`
Expected: ≥ 4 README mentions, 1 stack-spec section heading.

- [ ] **Step 6: Commit**

```bash
git add README.md docs/loom-stack-v1.md
git commit -s -m "docs(procedures,harness): CLI subsections + stack-spec adapter row"
```

---

## Task 11: Version bump + CHANGELOG

**Files:**
- Modify: `package.json`
- Modify: `CHANGELOG.md`

- [ ] **Step 1: package.json**

Replace:
```json
"version": "0.4.0-alpha.4",
```
with:
```json
"version": "0.4.0-alpha.5",
```

- [ ] **Step 2: CHANGELOG entry**

In `CHANGELOG.md`, replace the `## [Unreleased]` block with:

```markdown
## [Unreleased]

## [0.4.0-alpha.5] - 2026-04-21

### Added

- `loom procedures list|show|adopt` — CLI for procedural-identity seed
  templates (stack spec v1 §4.9). `adopt` supports positional keys,
  `--all`, `--force` overwrite, and an interactive multi-select picker
  (reuses the `src/cli/tui/multi-select.ts` primitive from alpha.4) on
  TTY. Idempotent by default.
- `loom harness init <name>` — CLI that scaffolds a harness manifest
  (stack spec v1 §4.7) from the template. Falls back to `--client` /
  `$LOOM_CLIENT` when no name is given. `--force` overwrites.
- `mcp__loom__procedure_list`, `procedure_show`, `procedure_adopt`,
  `harness_init` — MCP tools mirroring the CLI. Thin wrappers over the
  same shared core; first-class way for an agent to respond to the
  procedures seed nudge or a missing-manifest warning in the identity
  payload without needing harness-native filesystem tools.
- Stack spec §11 lists Procedures + Manifests as a new adapter.

### Changed

- `src/blocks/procedures.ts` gains `adoptProcedures`, `listProcedures`,
  `showProcedure`, and `UnknownProcedureError` (additive — existing
  exports untouched).
- `src/blocks/harness.ts` gains `initHarness` (additive).
```

Also add the link reference. Find:

```
[0.4.0-alpha.4]: https://github.com/jbarket/loom/compare/v0.4.0-alpha.3...v0.4.0-alpha.4
```

And insert above it:

```
[0.4.0-alpha.5]: https://github.com/jbarket/loom/compare/v0.4.0-alpha.4...v0.4.0-alpha.5
```

Also update the `[Unreleased]` link to point from `v0.4.0-alpha.5...HEAD`.

- [ ] **Step 3: Verify**

Run: `grep -n 'version' package.json && grep -nE '0\.4\.0-alpha\.5' CHANGELOG.md`
Expected: package.json `0.4.0-alpha.5`; CHANGELOG has heading + link ref.

- [ ] **Step 4: Commit**

```bash
git add package.json CHANGELOG.md
git commit -s -m "chore: bump to 0.4.0-alpha.5"
```

---

## Task 12: Content authoring + manual verification + PR

Use the new tooling against the real Art stack to both (a) validate the UX and (b) ship a proper procedures block.

- [ ] **Step 1: Build**

Run: `npm run build`
Expected: clean, no TS errors.

- [ ] **Step 2: Adopt procedures on the Art stack**

```bash
node dist/index.js procedures list --context-dir ~/.config/loom/art
node dist/index.js procedures adopt --all --context-dir ~/.config/loom/art
```

Expected: list shows all 6 un-adopted; adopt creates 6 files. Re-running adopt reports all 6 `skipped-exists`.

At this point the files ship with the ⚠ ownership ritual intact. **Open each file and edit the Why and How to apply sections** to reflect Art's actual reasons (past incidents, specific triggers), then delete the ⚠ notice line per §4.9. These edits are out of repo — they live in `~/.config/loom/art/procedures/`.

If Jonathan wants to defer the personal authoring and just ship the seed bodies, that's fine too — the seeds are self-announcing so `identity()` will keep surfacing the ownership ritual until the agent picks them up.

- [ ] **Step 3: Verify manifests**

```bash
node dist/index.js harness init claude-code --context-dir ~/.config/loom/art
```

Expected: `claude-code: .../harnesses/claude-code.md (skipped-exists)` — Art already has this manifest from before. If it didn't, it would have been created.

Also eyeball `~/.config/loom/art/harnesses/claude-code.md` and `~/.config/loom/art/models/claude-opus.md` for alignment with current stack spec §4.7/§4.8. Touch-ups are out of repo.

- [ ] **Step 4: MCP smoke test**

From a Claude Code session with loom MCP connected, call `mcp__loom__procedure_list`. Expected: the six seeds, all marked adopted.

Then `mcp__loom__procedure_show` with `{ key: 'cold-testing' }`. Expected: the (edited or seed) body of the procedure.

(If the MCP server was running before this PR, restart the session so it picks up the new tools.)

- [ ] **Step 5: Full suite + build**

Run: `npx vitest run && npm run build`
Expected: all green, clean build.

- [ ] **Step 6: Push + PR**

```bash
git push -u origin feat/procedures-manifests
gh pr create --title "feat(procedures,harness): CLI + MCP surface (v0.4.0-alpha.5)" --body "$(cat <<'EOF'
## Summary

Ships roadmap steps 7 + 8 from [v0.4 discussion](https://github.com/jbarket/loom/discussions/10). CLI + MCP surface for adopting procedural-identity seed templates (§4.9) and scaffolding harness manifests (§4.7). Reuses the multi-select TUI primitive from alpha.4.

- `loom procedures list|show|adopt` + `mcp__loom__procedure_*` tools
- `loom harness init` + `mcp__loom__harness_init`
- Shared core in `src/blocks/procedures.ts` and `src/blocks/harness.ts`; MCP = thin wrappers
- Idempotent by default; `--force` / `overwrite: true` for replace
- ~40 new tests; suite 337 → ~377

Primitives deliberately chosen to compose into a future conversational first-boot wizard (v0.5+): overwrite semantics, template-read as a separate tool, and skip-exists idempotence are the hooks a wizard will use when synthesizing customized content over defaults.

## Spec + plan

- [Spec](docs/specs/2026-04-21-procedures-manifests-cli-mcp-design.md)
- [Plan](docs/plans/2026-04-21-procedures-manifests-cli-mcp.md)

## Test plan

- [x] `npm test` green
- [x] `npm run build` clean
- [x] Manual: adopted 6 procedures against real Art stack
- [x] Manual: re-run reports `skipped-exists`
- [x] Manual: MCP tools callable from Claude Code session

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

- [ ] **Step 7: Link PR back in this plan (optional)**

If you want a pointer, add the PR URL at the top of this plan. Otherwise done.

---

## Definition of done

- [ ] Suite green (~337 + ~40 new = ~377 tests).
- [ ] `npm run build` produces clean `dist/`.
- [ ] `loom procedures --help` / `loom harness --help` print usage.
- [ ] `loom procedures list` shows all 6 seeds with adoption state.
- [ ] `loom procedures adopt --all` writes all 6 files; re-run reports `skipped-exists`.
- [ ] `loom procedures adopt --force <key>` overwrites.
- [ ] `loom harness init <name>` writes a template; re-run reports `skipped-exists`.
- [ ] `mcp__loom__procedure_list` / `procedure_show` / `procedure_adopt` / `harness_init` callable from a Claude Code session and return expected text.
- [ ] `identity()` continues to include the procedures block once adopted, with ownership ritual visible until the agent removes it.
- [ ] README has CLI subsections for procedures + harness; stack spec §11 lists Procedures + Manifests; CHANGELOG `[0.4.0-alpha.5]` entry exists; `package.json` at `0.4.0-alpha.5`.
- [ ] Manual verification in Task 12 completed.
- [ ] PR opened against `main`.

## The thing to remember

> **The primitives we ship now are what the future wizard will compose.**

Overwrite semantics aren't polish. Template-read as a separate tool isn't overkill. Skip-exists idempotence isn't defensive. These are the hooks a conversational onboarding flow will need to synthesize customized content over defaults without losing the ability to preview, re-roll, or accept the seed as-is.
