# Filesystem Injection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship `loom inject`, a CLI command that writes a small marker-bounded managed section into harness dotfiles (`~/.claude/CLAUDE.md`, `~/.codex/AGENTS.md`, `~/.gemini/GEMINI.md`) telling the agent how to load identity from loom. Managed region composes with user-authored content; re-running is idempotent. Releases as v0.4.0-alpha.4.

**Architecture:** Three new source modules (`src/injection/` — `harnesses.ts`, `render.ts`, `writer.ts`) plus a new CLI subcommand (`src/cli/inject.ts`) and a reusable stdlib keyboard-nav TUI primitive (`src/cli/tui/multi-select.ts`). The primitive's pure reducer is unit-tested; the TTY render/stdin wrapper is manually verified. Writer uses atomic tmp-file + rename. Flag-driven non-interactive path ships first; interactive wizard layered on top.

**Tech Stack:** TypeScript strict mode, Vitest 4, Node ≥ 20 stdlib only (`node:readline/promises`, `node:readline`, `node:fs/promises`, `node:util`'s parseArgs, `node:process`). No new npm dependencies. ESM.

**Spec of record:** [`docs/specs/2026-04-20-filesystem-injection-design.md`](../specs/2026-04-20-filesystem-injection-design.md). Roadmap step #5 in the [v0.4 discussion](https://github.com/jbarket/loom/discussions/10).

---

## File structure

**Created:**

| Path | Responsibility |
|---|---|
| `src/injection/harnesses.ts` | Harness preset table: key, display name, default path, tool prefix. Pure constants. |
| `src/injection/harnesses.test.ts` | Validate preset shape + membership. |
| `src/injection/render.ts` | `renderBlock(harness, contextDir) → string`. Pure template substitution, no I/O. |
| `src/injection/render.test.ts` | Validate marker shape, tool-prefix substitution, context-dir interpolation. |
| `src/injection/writer.ts` | `writeManagedBlock(path, block) → WriteResult` and `previewWrite(path, block) → PreviewAction`. Marker parser, atomic write, five deterministic outcomes, `MalformedMarkersError`. |
| `src/injection/writer.test.ts` | Exhaust the five cases plus idempotency, atomic rename, malformed-marker errors, mode preservation. |
| `src/cli/tui/multi-select.ts` | `MultiSelectState<T>` + `reduce(state, event, items)` (pure) and async `multiSelect(opts, io)` (TTY adapter). |
| `src/cli/tui/multi-select.test.ts` | State-machine tests for the reducer. TTY adapter is manually verified only. |
| `src/cli/inject.ts` | CLI entry: argv parsing, TTY dispatch, wizard orchestration, target-plan construction, rendering. |
| `src/cli/inject.test.ts` | Flag-driven paths, usage errors, exit codes, stack-version gate, `--dry-run`, `--json`. |
| `src/cli/inject.integration.test.ts` | End-to-end tmpdir test: inject into fake home, verify three files, re-run for idempotency. |

**Modified:**

| Path | Responsibility |
|---|---|
| `src/cli/subcommands.ts` | Add `'inject'` to `SUBCOMMANDS` tuple. |
| `src/cli/index.ts` | Add `case 'inject':` routing + one-line entry in `TOP_HELP`. |
| `README.md` | Add CLI section entry for `loom inject`; mention shell-hook pattern. Version badge `0.4.0--alpha.3` → `0.4.0--alpha.4`. |
| `docs/loom-stack-v1.md` | §11 Adapters — append Injection row. |
| `CHANGELOG.md` | Add `[0.4.0-alpha.4]` entry under `[Unreleased]`. |
| `package.json` | Version bump `0.4.0-alpha.3` → `0.4.0-alpha.4`. |

**No files deleted, no MCP tool surfaces changed.**

---

## Task 1: Harness preset table

**Files:**
- Create: `src/injection/harnesses.ts`
- Create: `src/injection/harnesses.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/injection/harnesses.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { HARNESSES, HARNESS_KEYS, type HarnessKey } from './harnesses.js';

describe('HARNESSES preset table', () => {
  it('exposes exactly three keys: claude-code, codex, gemini-cli', () => {
    expect([...HARNESS_KEYS].sort()).toEqual(['claude-code', 'codex', 'gemini-cli']);
    expect(Object.keys(HARNESSES).sort()).toEqual(['claude-code', 'codex', 'gemini-cli']);
  });

  it('every preset has display, defaultPath, toolPrefix', () => {
    for (const key of HARNESS_KEYS) {
      const p = HARNESSES[key];
      expect(p.key).toBe(key);
      expect(typeof p.display).toBe('string');
      expect(p.display.length).toBeGreaterThan(0);
      expect(typeof p.defaultPath).toBe('string');
      expect(p.defaultPath.startsWith(homedir())).toBe(true);
      expect(p.toolPrefix).toBe('mcp__loom__');
    }
  });

  it('default paths match the documented conventions', () => {
    expect(HARNESSES['claude-code'].defaultPath).toBe(join(homedir(), '.claude', 'CLAUDE.md'));
    expect(HARNESSES['codex'].defaultPath).toBe(join(homedir(), '.codex', 'AGENTS.md'));
    expect(HARNESSES['gemini-cli'].defaultPath).toBe(join(homedir(), '.gemini', 'GEMINI.md'));
  });

  it('HarnessKey type narrows to the three string literals', () => {
    // Compile-time check via assignment; runtime asserts membership.
    const k: HarnessKey = 'claude-code';
    expect(HARNESSES[k]).toBeDefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/injection/harnesses.test.ts`
Expected: FAIL with `Failed to resolve import "./harnesses.js"`.

- [ ] **Step 3: Create `src/injection/harnesses.ts`**

```typescript
/**
 * Harness preset table for `loom inject`. Each entry names a target
 * harness, its canonical default path, and the MCP tool prefix to emit
 * in the injected instruction block. Tool prefix is `mcp__loom__`
 * (double underscore) for all three — the single-underscore variant is
 * a Hermes/OpenClaw/NemoClaw quirk, not in scope for filesystem
 * injection.
 */
import { homedir } from 'node:os';
import { join } from 'node:path';

export type HarnessKey = 'claude-code' | 'codex' | 'gemini-cli';

export interface HarnessPreset {
  readonly key: HarnessKey;
  readonly display: string;
  readonly defaultPath: string;
  readonly toolPrefix: string;
}

export const HARNESS_KEYS: readonly HarnessKey[] = [
  'claude-code',
  'codex',
  'gemini-cli',
];

export const HARNESSES: Readonly<Record<HarnessKey, HarnessPreset>> = {
  'claude-code': {
    key: 'claude-code',
    display: 'Claude Code',
    defaultPath: join(homedir(), '.claude', 'CLAUDE.md'),
    toolPrefix: 'mcp__loom__',
  },
  'codex': {
    key: 'codex',
    display: 'Codex',
    defaultPath: join(homedir(), '.codex', 'AGENTS.md'),
    toolPrefix: 'mcp__loom__',
  },
  'gemini-cli': {
    key: 'gemini-cli',
    display: 'Gemini CLI',
    defaultPath: join(homedir(), '.gemini', 'GEMINI.md'),
    toolPrefix: 'mcp__loom__',
  },
};

export function isHarnessKey(s: string): s is HarnessKey {
  return (HARNESS_KEYS as readonly string[]).includes(s);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/injection/harnesses.test.ts`
Expected: PASS, 4 tests green.

- [ ] **Step 5: Run the full suite**

Run: `npx vitest run`
Expected: all tests green (275 + 4 = 279).

- [ ] **Step 6: Commit**

```bash
git add src/injection/harnesses.ts src/injection/harnesses.test.ts
git commit -s -m "feat(inject): harness preset table"
```

---

## Task 2: Render managed-section body

**Files:**
- Create: `src/injection/render.ts`
- Create: `src/injection/render.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/injection/render.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { HARNESSES } from './harnesses.js';
import { renderBlock } from './render.js';

describe('renderBlock', () => {
  const contextDir = '/home/agent/.config/loom/art';

  it('emits both start and end markers', () => {
    const block = renderBlock(HARNESSES['claude-code'], contextDir);
    expect(block).toMatch(/<!-- loom:start v1 harness=claude-code -->/);
    expect(block).toMatch(/<!-- loom:end -->/);
  });

  it('start marker carries harness key, end marker is bare', () => {
    for (const harness of Object.values(HARNESSES)) {
      const block = renderBlock(harness, contextDir);
      expect(block).toContain(`<!-- loom:start v1 harness=${harness.key} -->`);
      expect(block).toContain('<!-- loom:end -->');
    }
  });

  it('interpolates the tool prefix into the MCP section', () => {
    const block = renderBlock(HARNESSES['claude-code'], contextDir);
    expect(block).toContain('`mcp__loom__identity`');
    expect(block).toContain('`mcp__loom__recall`');
    expect(block).toContain('`mcp__loom__remember`');
  });

  it('interpolates the literal context dir', () => {
    const block = renderBlock(HARNESSES['gemini-cli'], contextDir);
    expect(block).toContain(`Context dir: ${contextDir}`);
  });

  it('ends with exactly one trailing newline', () => {
    const block = renderBlock(HARNESSES['codex'], contextDir);
    expect(block.endsWith('\n')).toBe(true);
    expect(block.endsWith('\n\n')).toBe(false);
  });

  it('output is byte-identical across repeat calls (deterministic)', () => {
    const a = renderBlock(HARNESSES['claude-code'], contextDir);
    const b = renderBlock(HARNESSES['claude-code'], contextDir);
    expect(a).toBe(b);
  });

  it('contains the "prefer MCP, fall back to CLI" phrasing', () => {
    const block = renderBlock(HARNESSES['claude-code'], contextDir);
    expect(block).toContain('prefer the MCP tool if available');
    expect(block).toContain('Shell fallback');
    expect(block).toContain('loom wake');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/injection/render.test.ts`
Expected: FAIL with `Failed to resolve import "./render.js"`.

- [ ] **Step 3: Create `src/injection/render.ts`**

```typescript
/**
 * Renders the marker-bounded managed section that `loom inject` writes
 * into each harness dotfile. Pure: no I/O, no side effects, same input
 * → same output.
 *
 * The block tells the agent *how* to load identity (prefer MCP, fall
 * back to CLI) — it deliberately does not carry the identity body, so
 * nothing here goes stale when the stack changes.
 */
import type { HarnessPreset } from './harnesses.js';

export function renderBlock(harness: HarnessPreset, contextDir: string): string {
  const p = harness.toolPrefix;
  return `<!-- loom:start v1 harness=${harness.key} -->
## Persistent identity via loom

You have durable identity and memory managed by loom. On session start,
load your identity — prefer the MCP tool if available, fall back to the
CLI if not:

- **MCP (preferred):** call \`${p}identity\`. Also available:
  \`${p}recall\`, \`${p}remember\`, \`${p}memory_list\`,
  \`${p}pursuits\`, \`${p}update\`, \`${p}forget\`.
- **Shell fallback:** run \`loom wake\`. Also: \`loom recall <query>\`,
  \`echo <body> | loom remember <title> --category <cat>\`,
  \`loom memory list\`, \`loom pursuits list\`.

Context dir: ${contextDir}

Treat the returned identity as authoritative — it overrides defaults
where they conflict.
<!-- loom:end -->
`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/injection/render.test.ts`
Expected: PASS, 7 tests green.

- [ ] **Step 5: Run full suite**

Run: `npx vitest run`
Expected: all green (~286).

- [ ] **Step 6: Commit**

```bash
git add src/injection/render.ts src/injection/render.test.ts
git commit -s -m "feat(inject): render managed-section body"
```

---

## Task 3: Marker-aware writer

**Files:**
- Create: `src/injection/writer.ts`
- Create: `src/injection/writer.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `src/injection/writer.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, readFile, writeFile, rm, stat, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  writeManagedBlock,
  previewWrite,
  MalformedMarkersError,
} from './writer.js';

const BLOCK = `<!-- loom:start v1 harness=claude-code -->
## Persistent identity via loom

Context dir: /fake/ctx
<!-- loom:end -->
`;

const OTHER_BLOCK = `<!-- loom:start v1 harness=claude-code -->
## Updated block

Context dir: /different/ctx
<!-- loom:end -->
`;

describe('writeManagedBlock', () => {
  let dir: string;

  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'loom-inject-writer-')); });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  it('creates a new file containing only the block', async () => {
    const path = join(dir, 'nested', 'CLAUDE.md');
    const result = await writeManagedBlock(path, BLOCK);
    expect(result.action).toBe('created');
    expect(result.path).toBe(path);
    expect(result.bytesWritten).toBeGreaterThan(0);
    const written = await readFile(path, 'utf-8');
    expect(written).toBe(BLOCK);
  });

  it('appends when file exists without markers', async () => {
    const path = join(dir, 'CLAUDE.md');
    await writeFile(path, '# My notes\n\nHand-written content.\n', 'utf-8');
    const result = await writeManagedBlock(path, BLOCK);
    expect(result.action).toBe('appended');
    const written = await readFile(path, 'utf-8');
    expect(written.startsWith('# My notes\n\nHand-written content.\n')).toBe(true);
    expect(written.includes(BLOCK)).toBe(true);
    // Exactly one blank line between user content and block
    expect(written).toBe(`# My notes\n\nHand-written content.\n\n${BLOCK}`);
  });

  it('replaces content between markers and preserves outside content', async () => {
    const path = join(dir, 'CLAUDE.md');
    const existing = `# Top\n\n<!-- loom:start v1 harness=claude-code -->
## Old block

Context dir: /old
<!-- loom:end -->\n\n# Bottom\n`;
    await writeFile(path, existing, 'utf-8');
    const result = await writeManagedBlock(path, OTHER_BLOCK);
    expect(result.action).toBe('updated');
    const written = await readFile(path, 'utf-8');
    expect(written).toContain('# Top');
    expect(written).toContain('# Bottom');
    expect(written).toContain('Context dir: /different/ctx');
    expect(written).not.toContain('Context dir: /old');
  });

  it('reports no-change when an update would be byte-identical', async () => {
    const path = join(dir, 'CLAUDE.md');
    await writeFile(path, `# Top\n\n${BLOCK}\n# Bottom\n`, 'utf-8');
    const result = await writeManagedBlock(path, BLOCK);
    expect(result.action).toBe('no-change');
    const written = await readFile(path, 'utf-8');
    expect(written).toBe(`# Top\n\n${BLOCK}\n# Bottom\n`);
  });

  it('second identical run is a no-change (idempotent)', async () => {
    const path = join(dir, 'CLAUDE.md');
    const first = await writeManagedBlock(path, BLOCK);
    expect(first.action).toBe('created');
    const second = await writeManagedBlock(path, BLOCK);
    expect(second.action).toBe('no-change');
  });

  it('throws MalformedMarkersError when only a start marker is present', async () => {
    const path = join(dir, 'CLAUDE.md');
    await writeFile(path, '<!-- loom:start v1 harness=claude-code -->\n(no end)\n', 'utf-8');
    await expect(writeManagedBlock(path, BLOCK)).rejects.toBeInstanceOf(MalformedMarkersError);
  });

  it('throws MalformedMarkersError when only an end marker is present', async () => {
    const path = join(dir, 'CLAUDE.md');
    await writeFile(path, '(no start)\n<!-- loom:end -->\n', 'utf-8');
    await expect(writeManagedBlock(path, BLOCK)).rejects.toBeInstanceOf(MalformedMarkersError);
  });

  it('throws MalformedMarkersError when end appears before start', async () => {
    const path = join(dir, 'CLAUDE.md');
    await writeFile(path, '<!-- loom:end -->\n<!-- loom:start v1 harness=claude-code -->\n', 'utf-8');
    await expect(writeManagedBlock(path, BLOCK)).rejects.toBeInstanceOf(MalformedMarkersError);
  });

  it('throws MalformedMarkersError when two start markers are present', async () => {
    const path = join(dir, 'CLAUDE.md');
    await writeFile(
      path,
      `<!-- loom:start v1 harness=claude-code -->\nA\n<!-- loom:end -->\n<!-- loom:start v1 harness=claude-code -->\nB\n<!-- loom:end -->\n`,
      'utf-8',
    );
    await expect(writeManagedBlock(path, BLOCK)).rejects.toBeInstanceOf(MalformedMarkersError);
  });

  it('preserves file mode on update', async () => {
    const path = join(dir, 'CLAUDE.md');
    await writeFile(path, `${BLOCK}`, 'utf-8');
    await chmod(path, 0o640);
    await writeManagedBlock(path, OTHER_BLOCK);
    const s = await stat(path);
    expect(s.mode & 0o777).toBe(0o640);
  });

  it('removes the .loom.tmp file after successful rename', async () => {
    const path = join(dir, 'CLAUDE.md');
    await writeManagedBlock(path, BLOCK);
    await expect(stat(`${path}.loom.tmp`)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('ends written content with exactly one trailing newline', async () => {
    const path = join(dir, 'CLAUDE.md');
    await writeManagedBlock(path, BLOCK);
    const written = await readFile(path, 'utf-8');
    expect(written.endsWith('\n')).toBe(true);
    expect(written.endsWith('\n\n')).toBe(false);
  });
});

describe('previewWrite', () => {
  let dir: string;
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'loom-inject-preview-')); });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  it('predicts "created" for a path that does not exist', async () => {
    const path = join(dir, 'NOPE.md');
    expect(await previewWrite(path, BLOCK)).toBe('created');
  });

  it('predicts "appended" when file exists without markers', async () => {
    const path = join(dir, 'CLAUDE.md');
    await writeFile(path, '# User content\n', 'utf-8');
    expect(await previewWrite(path, BLOCK)).toBe('appended');
  });

  it('predicts "updated" when block content would change', async () => {
    const path = join(dir, 'CLAUDE.md');
    await writeFile(path, BLOCK, 'utf-8');
    expect(await previewWrite(path, OTHER_BLOCK)).toBe('updated');
  });

  it('predicts "no-change" when block would be byte-identical', async () => {
    const path = join(dir, 'CLAUDE.md');
    await writeFile(path, BLOCK, 'utf-8');
    expect(await previewWrite(path, BLOCK)).toBe('no-change');
  });

  it('propagates MalformedMarkersError on malformed targets', async () => {
    const path = join(dir, 'CLAUDE.md');
    await writeFile(path, '<!-- loom:start v1 -->\nno end\n', 'utf-8');
    await expect(previewWrite(path, BLOCK)).rejects.toBeInstanceOf(MalformedMarkersError);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/injection/writer.test.ts`
Expected: FAIL with `Failed to resolve import "./writer.js"`.

- [ ] **Step 3: Create `src/injection/writer.ts`**

```typescript
/**
 * Marker-aware file writer for `loom inject`. Reads the target file,
 * decides between create / append / replace / no-change, writes
 * atomically via tmp-file + rename.
 *
 * The managed region is bounded by two HTML comments:
 *   <!-- loom:start v1 harness=<key> -->
 *   <!-- loom:end -->
 * Only "loom:start" / "loom:end" literals are matched; the metadata
 * (v1, harness=...) is informational for humans and is allowed to
 * differ between on-disk markers and the new block.
 */
import { readFile, writeFile, rename, mkdir, stat, chmod } from 'node:fs/promises';
import { dirname } from 'node:path';

export type WriteAction = 'created' | 'appended' | 'updated' | 'no-change';

export interface WriteResult {
  action: WriteAction;
  path: string;
  bytesWritten: number;
}

export type PreviewAction = WriteAction;

export class MalformedMarkersError extends Error {
  constructor(public readonly path: string, public readonly reason: string) {
    super(
      `inject: malformed loom markers in ${path}: ${reason}; fix manually or delete markers and retry`,
    );
    this.name = 'MalformedMarkersError';
  }
}

const START_RE = /<!--\s*loom:start[^>]*-->/g;
const END_RE = /<!--\s*loom:end\s*-->/g;

interface MarkerBounds {
  startIdx: number;     // offset of first char of start marker
  endTerminusIdx: number; // offset just past the end marker (exclusive)
}

function findMarkers(text: string, path: string): MarkerBounds | null {
  const starts = [...text.matchAll(START_RE)];
  const ends = [...text.matchAll(END_RE)];
  if (starts.length === 0 && ends.length === 0) return null;
  if (starts.length > 1) {
    throw new MalformedMarkersError(path, `${starts.length} start markers found, expected 1`);
  }
  if (ends.length > 1) {
    throw new MalformedMarkersError(path, `${ends.length} end markers found, expected 1`);
  }
  if (starts.length !== ends.length) {
    throw new MalformedMarkersError(
      path,
      `mismatched markers (start=${starts.length}, end=${ends.length})`,
    );
  }
  const s = starts[0];
  const e = ends[0];
  const startIdx = s.index!;
  const endBegin = e.index!;
  const endTerminusIdx = endBegin + e[0].length;
  if (endBegin < startIdx) {
    throw new MalformedMarkersError(path, 'end marker appears before start marker');
  }
  return { startIdx, endTerminusIdx };
}

function normalizeLF(s: string): string {
  return s.replace(/\r\n/g, '\n');
}

function ensureTrailingNewline(s: string): string {
  return s.endsWith('\n') ? s : s + '\n';
}

async function readIfExists(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf-8');
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

async function atomicWrite(
  path: string,
  content: string,
  preserveModeFrom: string | null,
): Promise<number> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.loom.tmp`;
  const buf = Buffer.from(content, 'utf-8');
  await writeFile(tmp, buf);
  if (preserveModeFrom) {
    try {
      const s = await stat(preserveModeFrom);
      await chmod(tmp, s.mode & 0o777);
    } catch {
      /* preserveModeFrom vanished between read and stat; leave tmp at default mode */
    }
  }
  await rename(tmp, path);
  return buf.byteLength;
}

function buildContent(
  existing: string | null,
  block: string,
  markers: MarkerBounds | null,
): { next: string; action: WriteAction } {
  const blockLF = ensureTrailingNewline(block);
  if (existing === null) {
    return { next: blockLF, action: 'created' };
  }
  const norm = normalizeLF(existing);
  if (markers === null) {
    const withGap = norm.endsWith('\n') ? norm : norm + '\n';
    const combined = ensureTrailingNewline(`${withGap}\n${blockLF}`);
    return { next: combined, action: 'appended' };
  }
  const before = norm.slice(0, markers.startIdx);
  const after = norm.slice(markers.endTerminusIdx);
  // The block already ends in \n. We drop any newline immediately after the
  // old end-marker so we don't accumulate blanks on repeat runs.
  const afterTrimmed = after.startsWith('\n') ? after.slice(1) : after;
  const combined = ensureTrailingNewline(`${before}${blockLF.replace(/\n$/, '')}\n${afterTrimmed}`);
  if (combined === norm || combined === existing) {
    return { next: combined, action: 'no-change' };
  }
  return { next: combined, action: 'updated' };
}

export async function writeManagedBlock(
  path: string,
  block: string,
): Promise<WriteResult> {
  const existing = await readIfExists(path);
  const markers = existing !== null ? findMarkers(normalizeLF(existing), path) : null;
  const { next, action } = buildContent(existing, block, markers);
  if (action === 'no-change') {
    return { action, path, bytesWritten: 0 };
  }
  const bytesWritten = await atomicWrite(path, next, existing !== null ? path : null);
  return { action, path, bytesWritten };
}

export async function previewWrite(
  path: string,
  block: string,
): Promise<PreviewAction> {
  const existing = await readIfExists(path);
  const markers = existing !== null ? findMarkers(normalizeLF(existing), path) : null;
  return buildContent(existing, block, markers).action;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/injection/writer.test.ts`
Expected: PASS, 17 tests green.

- [ ] **Step 5: Run full suite**

Run: `npx vitest run`
Expected: all green (~303).

- [ ] **Step 6: Commit**

```bash
git add src/injection/writer.ts src/injection/writer.test.ts
git commit -s -m "feat(inject): marker-aware atomic writer"
```

---

## Task 4: Multi-select TUI primitive (reducer + adapter)

**Files:**
- Create: `src/cli/tui/multi-select.ts`
- Create: `src/cli/tui/multi-select.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/cli/tui/multi-select.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import {
  initialState,
  reduce,
  type MultiSelectItem,
  type MultiSelectState,
} from './multi-select.js';

const ITEMS: ReadonlyArray<MultiSelectItem<string>> = [
  { value: 'a', label: 'Alpha' },
  { value: 'b', label: 'Beta' },
  { value: 'c', label: 'Gamma' },
];

function s(cursor: number, selected: string[]): MultiSelectState<string> {
  return { cursor, selected: new Set(selected) };
}

describe('initialState', () => {
  it('starts with cursor 0 and provided initial selection', () => {
    const st = initialState(ITEMS, new Set(['a', 'c']));
    expect(st.cursor).toBe(0);
    expect([...st.selected].sort()).toEqual(['a', 'c']);
  });

  it('defaults selection to empty when initialSelected omitted', () => {
    const st = initialState(ITEMS);
    expect(st.selected.size).toBe(0);
  });
});

describe('reduce', () => {
  it('down moves cursor forward', () => {
    const r = reduce(s(0, []), { kind: 'down' }, ITEMS);
    expect(r.status).toBe('running');
    if (r.status !== 'running') throw new Error();
    expect(r.state.cursor).toBe(1);
  });

  it('down wraps at end of list', () => {
    const r = reduce(s(2, []), { kind: 'down' }, ITEMS);
    expect(r.status).toBe('running');
    if (r.status !== 'running') throw new Error();
    expect(r.state.cursor).toBe(0);
  });

  it('up wraps at top of list', () => {
    const r = reduce(s(0, []), { kind: 'up' }, ITEMS);
    expect(r.status).toBe('running');
    if (r.status !== 'running') throw new Error();
    expect(r.state.cursor).toBe(2);
  });

  it('toggle adds value at cursor when absent', () => {
    const r = reduce(s(1, []), { kind: 'toggle' }, ITEMS);
    expect(r.status).toBe('running');
    if (r.status !== 'running') throw new Error();
    expect(r.state.selected.has('b')).toBe(true);
  });

  it('toggle removes value at cursor when present', () => {
    const r = reduce(s(1, ['b']), { kind: 'toggle' }, ITEMS);
    expect(r.status).toBe('running');
    if (r.status !== 'running') throw new Error();
    expect(r.state.selected.has('b')).toBe(false);
  });

  it('confirm returns confirmed status carrying the current selection', () => {
    const r = reduce(s(0, ['a', 'c']), { kind: 'confirm' }, ITEMS);
    expect(r.status).toBe('confirmed');
    if (r.status !== 'confirmed') throw new Error();
    expect([...r.selected].sort()).toEqual(['a', 'c']);
  });

  it('cancel returns cancelled status', () => {
    const r = reduce(s(0, ['a']), { kind: 'cancel' }, ITEMS);
    expect(r.status).toBe('cancelled');
  });

  it('toggle on an empty item list is a no-op running state', () => {
    const r = reduce(s(0, []), { kind: 'toggle' }, []);
    expect(r.status).toBe('running');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/cli/tui/multi-select.test.ts`
Expected: FAIL with `Failed to resolve import "./multi-select.js"`.

- [ ] **Step 3: Create `src/cli/tui/multi-select.ts`**

```typescript
/**
 * Reusable keyboard-nav multi-select primitive. The reducer is pure and
 * fully unit-tested; the TTY adapter (`multiSelect`) is a thin
 * stdin+render wrapper exercised by the inject integration test and
 * manual verification only.
 *
 * Pattern intentionally mirrors Hermes's curses_checklist (see
 * ~/.hermes/hermes-agent/hermes_cli/curses_ui.py) but uses Node stdlib
 * instead of curses: raw-mode stdin + ANSI cursor codes.
 */
import { emitKeypressEvents } from 'node:readline';

export interface MultiSelectItem<T> {
  value: T;
  label: string;
  detail?: string;
}

export interface MultiSelectState<T> {
  cursor: number;
  selected: Set<T>;
}

export type MultiSelectEvent =
  | { kind: 'up' }
  | { kind: 'down' }
  | { kind: 'toggle' }
  | { kind: 'confirm' }
  | { kind: 'cancel' };

export type MultiSelectResult<T> =
  | { status: 'running'; state: MultiSelectState<T> }
  | { status: 'confirmed'; selected: Set<T> }
  | { status: 'cancelled' };

export interface MultiSelectOpts<T> {
  title: string;
  items: ReadonlyArray<MultiSelectItem<T>>;
  initialSelected?: ReadonlySet<T>;
}

export function initialState<T>(
  _items: ReadonlyArray<MultiSelectItem<T>>,
  initialSelected?: ReadonlySet<T>,
): MultiSelectState<T> {
  return {
    cursor: 0,
    selected: new Set(initialSelected ?? []),
  };
}

export function reduce<T>(
  state: MultiSelectState<T>,
  event: MultiSelectEvent,
  items: ReadonlyArray<MultiSelectItem<T>>,
): MultiSelectResult<T> {
  switch (event.kind) {
    case 'up': {
      if (items.length === 0) return { status: 'running', state };
      const cursor = (state.cursor - 1 + items.length) % items.length;
      return { status: 'running', state: { ...state, cursor } };
    }
    case 'down': {
      if (items.length === 0) return { status: 'running', state };
      const cursor = (state.cursor + 1) % items.length;
      return { status: 'running', state: { ...state, cursor } };
    }
    case 'toggle': {
      if (items.length === 0) return { status: 'running', state };
      const v = items[state.cursor].value;
      const next = new Set(state.selected);
      if (next.has(v)) next.delete(v);
      else next.add(v);
      return { status: 'running', state: { cursor: state.cursor, selected: next } };
    }
    case 'confirm':
      return { status: 'confirmed', selected: new Set(state.selected) };
    case 'cancel':
      return { status: 'cancelled' };
  }
}

// ─── TTY adapter (manually verified) ────────────────────────────────────────

function renderFrame<T>(
  opts: MultiSelectOpts<T>,
  state: MultiSelectState<T>,
  write: (s: string) => void,
): void {
  // Clear screen + move home; keep scrollback.
  write('\x1b[2J\x1b[H');
  write(`${opts.title}\n\n`);
  opts.items.forEach((item, i) => {
    const marker = state.selected.has(item.value) ? '[x]' : '[ ]';
    const pointer = i === state.cursor ? '›' : ' ';
    const detail = item.detail ? `  ${item.detail}` : '';
    write(`  ${pointer} ${marker} ${item.label}${detail}\n`);
  });
  write('\n  ↑/↓ move    space toggle    enter confirm    esc/q cancel\n');
}

interface KeypressAdapterDeps {
  stdin: NodeJS.ReadStream;
  stdout: { write: (s: string) => void };
}

/**
 * TTY wrapper around `reduce`. Returns the confirmed selection or null
 * on cancel. Throws if stdin is not a TTY — callers must check
 * beforehand.
 */
export async function multiSelect<T>(
  opts: MultiSelectOpts<T>,
  deps: KeypressAdapterDeps = { stdin: process.stdin, stdout: process.stdout },
): Promise<ReadonlySet<T> | null> {
  const { stdin, stdout } = deps;
  if (!stdin.isTTY) {
    throw new Error('multiSelect requires a TTY stdin');
  }
  emitKeypressEvents(stdin);
  stdin.setRawMode(true);
  stdin.resume();

  let state = initialState(opts.items, opts.initialSelected);
  const write = (s: string) => stdout.write(s);
  renderFrame(opts, state, write);

  return new Promise<ReadonlySet<T> | null>((resolve) => {
    const onKey = (_str: string | undefined, key: { name?: string; ctrl?: boolean; sequence?: string }) => {
      let event: MultiSelectEvent | null = null;
      if (key.ctrl && key.name === 'c') event = { kind: 'cancel' };
      else if (key.name === 'escape' || key.name === 'q') event = { kind: 'cancel' };
      else if (key.name === 'up') event = { kind: 'up' };
      else if (key.name === 'down') event = { kind: 'down' };
      else if (key.name === 'space') event = { kind: 'toggle' };
      else if (key.name === 'return') event = { kind: 'confirm' };
      if (!event) return;

      const result = reduce(state, event, opts.items);
      if (result.status === 'running') {
        state = result.state;
        renderFrame(opts, state, write);
        return;
      }
      stdin.off('keypress', onKey);
      stdin.setRawMode(false);
      stdin.pause();
      write('\n');
      resolve(result.status === 'confirmed' ? result.selected : null);
    };
    stdin.on('keypress', onKey);
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/cli/tui/multi-select.test.ts`
Expected: PASS, 10 tests green.

- [ ] **Step 5: Run full suite**

Run: `npx vitest run`
Expected: all green (~313).

- [ ] **Step 6: Commit**

```bash
git add src/cli/tui/multi-select.ts src/cli/tui/multi-select.test.ts
git commit -s -m "feat(cli/tui): multi-select primitive with pure reducer"
```

---

## Task 5: `loom inject` — flag-driven path (no wizard yet)

**Files:**
- Create: `src/cli/inject.ts`
- Create: `src/cli/inject.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `src/cli/inject.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCliCaptured } from './test-helpers.js';

describe('loom inject (flag-driven)', () => {
  let ctx: string;
  let home: string;

  beforeEach(async () => {
    ctx = await mkdtemp(join(tmpdir(), 'loom-inject-ctx-'));
    home = await mkdtemp(join(tmpdir(), 'loom-inject-home-'));
  });
  afterEach(async () => {
    await rm(ctx, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
  });

  it('prints usage with --help and exits 0', async () => {
    const { stdout, stderr, code } = await runCliCaptured(['inject', '--help']);
    expect(code).toBe(0);
    expect(stdout + stderr).toMatch(/loom inject/);
  });

  it('writes a single harness with --harness and --to', async () => {
    const target = join(home, 'CLAUDE.md');
    const { stdout, code } = await runCliCaptured(
      ['inject', '--harness', 'claude-code', '--to', target, '--context-dir', ctx],
    );
    expect(code).toBe(0);
    expect(stdout).toMatch(/created/);
    const written = await readFile(target, 'utf-8');
    expect(written).toContain('<!-- loom:start v1 harness=claude-code -->');
    expect(written).toContain('<!-- loom:end -->');
    expect(written).toContain('mcp__loom__identity');
    expect(written).toContain(`Context dir: ${ctx}`);
  });

  it('writes the subset requested by --harness <a,b>', async () => {
    const { stdout, code } = await runCliCaptured(
      ['inject', '--harness', 'claude-code,gemini-cli', '--context-dir', ctx],
      { env: { HOME: home } },
    );
    expect(code).toBe(0);
    expect(stdout).toMatch(/claude-code/);
    expect(stdout).toMatch(/gemini-cli/);
    expect(stdout).not.toMatch(/codex/);
    const claudeText = await readFile(join(home, '.claude', 'CLAUDE.md'), 'utf-8');
    expect(claudeText).toContain('harness=claude-code');
    const geminiText = await readFile(join(home, '.gemini', 'GEMINI.md'), 'utf-8');
    expect(geminiText).toContain('harness=gemini-cli');
  });

  it('--all writes all three defaults', async () => {
    const { code } = await runCliCaptured(
      ['inject', '--all', '--context-dir', ctx],
      { env: { HOME: home } },
    );
    expect(code).toBe(0);
    expect((await readFile(join(home, '.claude', 'CLAUDE.md'), 'utf-8'))).toContain('harness=claude-code');
    expect((await readFile(join(home, '.codex', 'AGENTS.md'), 'utf-8'))).toContain('harness=codex');
    expect((await readFile(join(home, '.gemini', 'GEMINI.md'), 'utf-8'))).toContain('harness=gemini-cli');
  });

  it('--dry-run writes nothing and prints a diff', async () => {
    const target = join(home, 'CLAUDE.md');
    const { stdout, code } = await runCliCaptured(
      ['inject', '--harness', 'claude-code', '--to', target, '--dry-run', '--context-dir', ctx],
    );
    expect(code).toBe(0);
    // diff headers
    expect(stdout).toMatch(/^--- /m);
    expect(stdout).toMatch(/^\+\+\+ /m);
    // no file was created
    await expect(readFile(target, 'utf-8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('--json emits a WriteResult[] to stdout', async () => {
    const target = join(home, 'CLAUDE.md');
    const { stdout, code } = await runCliCaptured(
      ['inject', '--harness', 'claude-code', '--to', target, '--json', '--context-dir', ctx],
    );
    expect(code).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed).toHaveLength(1);
    expect(parsed[0]).toMatchObject({
      harness: 'claude-code',
      action: 'created',
      path: target,
    });
    expect(typeof parsed[0].bytesWritten).toBe('number');
  });

  it('--dry-run + --json emits predicted action with diff field', async () => {
    const target = join(home, 'CLAUDE.md');
    const { stdout, code } = await runCliCaptured(
      ['inject', '--harness', 'claude-code', '--to', target, '--dry-run', '--json', '--context-dir', ctx],
    );
    expect(code).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed[0]).toMatchObject({ harness: 'claude-code', action: 'created', path: target });
    expect(typeof parsed[0].diff).toBe('string');
    expect(parsed[0].diff).toMatch(/---/);
    await expect(readFile(target, 'utf-8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('idempotent: second --all run reports no-change everywhere', async () => {
    await runCliCaptured(['inject', '--all', '--context-dir', ctx], { env: { HOME: home } });
    const { stdout, code } = await runCliCaptured(
      ['inject', '--all', '--context-dir', ctx],
      { env: { HOME: home } },
    );
    expect(code).toBe(0);
    expect((stdout.match(/no change/g) ?? []).length).toBe(3);
  });

  it('exits 2 on unknown --harness', async () => {
    const { code, stderr } = await runCliCaptured(
      ['inject', '--harness', 'nope', '--context-dir', ctx],
    );
    expect(code).toBe(2);
    expect(stderr).toMatch(/unknown harness/i);
  });

  it('exits 2 when --harness and --all both set', async () => {
    const { code, stderr } = await runCliCaptured(
      ['inject', '--harness', 'claude-code', '--all', '--context-dir', ctx],
    );
    expect(code).toBe(2);
    expect(stderr).toMatch(/mutually exclusive/i);
  });

  it('exits 2 when --to is set with more than one harness', async () => {
    const { code, stderr } = await runCliCaptured(
      ['inject', '--all', '--to', '/tmp/x.md', '--context-dir', ctx],
    );
    expect(code).toBe(2);
    expect(stderr).toMatch(/--to.*single/i);
  });

  it('exits 2 on non-TTY stdin with no flags', async () => {
    // runCliCaptured simulates non-TTY whenever opts.stdin is provided.
    const { code, stderr } = await runCliCaptured(
      ['inject', '--context-dir', ctx],
      { stdin: '' },
    );
    expect(code).toBe(2);
    expect(stderr).toMatch(/--harness or --all required/);
  });

  it('exits 1 when a target file has malformed markers', async () => {
    const target = join(home, 'CLAUDE.md');
    await writeFile(target, '<!-- loom:start v1 -->\n(no end)\n', 'utf-8');
    const { code, stderr } = await runCliCaptured(
      ['inject', '--harness', 'claude-code', '--to', target, '--context-dir', ctx],
    );
    expect(code).toBe(1);
    expect(stderr).toMatch(/malformed loom markers/);
  });

  it('exits 1 when stack is ahead of this build', async () => {
    const { CURRENT_STACK_VERSION, STACK_VERSION_FILE } = await import('../config.js');
    await writeFile(join(ctx, STACK_VERSION_FILE), `${CURRENT_STACK_VERSION + 1}\n`);
    const target = join(home, 'CLAUDE.md');
    const { code, stderr } = await runCliCaptured(
      ['inject', '--harness', 'claude-code', '--to', target, '--context-dir', ctx],
    );
    expect(code).toBe(1);
    expect(stderr).toMatch(/Upgrade loom/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/cli/inject.test.ts`
Expected: FAIL — the `inject` subcommand is not yet routed, so most tests hit the "Unknown subcommand" path.

- [ ] **Step 3: Create `src/cli/inject.ts` (non-interactive path only for this task)**

```typescript
/**
 * loom inject — write a marker-bounded managed section into each
 * selected harness's dotfile. Composes with user content; idempotent.
 *
 * This file only wires the flag-driven (non-interactive) path; the
 * interactive wizard is added in Task 7.
 */
import { parseArgs } from 'node:util';
import { assertStackVersionCompatible } from '../config.js';
import { extractGlobalFlags, resolveEnv } from './args.js';
import type { IOStreams } from './io.js';
import { renderJson } from './io.js';
import {
  HARNESSES,
  HARNESS_KEYS,
  isHarnessKey,
  type HarnessKey,
  type HarnessPreset,
} from '../injection/harnesses.js';
import { renderBlock } from '../injection/render.js';
import {
  writeManagedBlock,
  previewWrite,
  MalformedMarkersError,
  type WriteAction,
  type WriteResult,
} from '../injection/writer.js';
import { readFile } from 'node:fs/promises';

const USAGE = `Usage: loom inject [options]

Writes a managed section into each selected harness's dotfile telling
the agent how to load identity via loom. Re-running is idempotent;
content outside the <!-- loom:start / loom:end --> markers is preserved.

Options:
  --harness <keys>       Comma-separated subset of: ${HARNESS_KEYS.join(', ')}
  --all                  Inject into all default harnesses (exclusive with --harness)
  --to <path>            Override target path (valid only when exactly one harness is selected)
  --dry-run              Print unified diff; write nothing
  --json                 Machine-readable output
  --context-dir <path>   Agent context dir (default: $LOOM_CONTEXT_DIR)
  --help, -h             Show this help

With no harness flags, runs the interactive wizard on a TTY; exits 2
on non-TTY stdin.
`;

interface InjectTarget {
  harness: HarnessPreset;
  path: string;
}

interface ReportRow {
  harness: HarnessKey;
  path: string;
  action: WriteAction;
  bytesWritten: number;
  diff?: string;
}

function makeDiff(existing: string, next: string, path: string): string {
  // Tiny unified-diff generator: just emits headers + a wholesale replace
  // hunk. Good enough for "did the user accept what this will do?". We
  // deliberately avoid pulling in a diff dependency for this.
  const oldLines = existing.split('\n');
  const newLines = next.split('\n');
  const header =
    `--- ${path}\n+++ ${path}\n@@ -1,${oldLines.length} +1,${newLines.length} @@\n`;
  const body =
    oldLines.map((l) => `-${l}`).join('\n') +
    (oldLines.length ? '\n' : '') +
    newLines.map((l) => `+${l}`).join('\n') +
    (newLines.length ? '\n' : '');
  return header + body;
}

async function planTargets(
  harnesses: HarnessKey[],
  toOverride: string | undefined,
  io: IOStreams,
): Promise<InjectTarget[] | { error: string; code: 2 }> {
  if (toOverride !== undefined && harnesses.length !== 1) {
    return {
      error: 'loom inject: --to requires exactly a single --harness value',
      code: 2,
    };
  }
  return harnesses.map((key) => ({
    harness: HARNESSES[key],
    path: toOverride ?? HARNESSES[key].defaultPath,
  }));
}

async function executeTargets(
  targets: InjectTarget[],
  contextDir: string,
  opts: { dryRun: boolean },
): Promise<{ rows: ReportRow[]; hadError: boolean; lastError?: Error }> {
  const rows: ReportRow[] = [];
  let hadError = false;
  let lastError: Error | undefined;
  for (const t of targets) {
    const block = renderBlock(t.harness, contextDir);
    try {
      if (opts.dryRun) {
        const existing = await readFile(t.path, 'utf-8').catch((e) => {
          if ((e as NodeJS.ErrnoException).code === 'ENOENT') return '';
          throw e;
        });
        const action = await previewWrite(t.path, block);
        const next = (() => {
          if (action === 'created') return block;
          if (action === 'no-change') return existing;
          // For appended/updated we reconstruct the post-write content via
          // writeManagedBlock's logic — but to keep this simple for the
          // diff we just show the block as the "new" text.
          return existing + (existing.endsWith('\n') ? '' : '\n') + '\n' + block;
        })();
        rows.push({
          harness: t.harness.key,
          path: t.path,
          action,
          bytesWritten: 0,
          diff: makeDiff(existing, next, t.path),
        });
      } else {
        const res: WriteResult = await writeManagedBlock(t.path, block);
        rows.push({
          harness: t.harness.key,
          path: res.path,
          action: res.action,
          bytesWritten: res.bytesWritten,
        });
      }
    } catch (err) {
      hadError = true;
      lastError = err as Error;
      rows.push({
        harness: t.harness.key,
        path: t.path,
        action: 'no-change',
        bytesWritten: 0,
      });
    }
  }
  return { rows, hadError, lastError };
}

function humanActionLabel(action: WriteAction): string {
  switch (action) {
    case 'created': return 'created';
    case 'appended': return 'appended';
    case 'updated': return 'updated';
    case 'no-change': return 'no change';
  }
}

function writeHumanReport(rows: ReportRow[], io: IOStreams): void {
  for (const r of rows) {
    io.stdout(`${r.harness}: ${r.path} (${humanActionLabel(r.action)})\n`);
  }
}

function writeDiffReport(rows: ReportRow[], io: IOStreams): void {
  for (const r of rows) {
    if (r.diff) io.stdout(r.diff);
  }
}

export async function run(argv: string[], io: IOStreams): Promise<number> {
  const { flags: global, rest } = extractGlobalFlags(argv);
  let parsed;
  try {
    parsed = parseArgs({
      args: rest,
      options: {
        harness: { type: 'string' },
        all:     { type: 'boolean' },
        to:      { type: 'string' },
        'dry-run': { type: 'boolean' },
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

  if (parsed.values.harness !== undefined && parsed.values.all === true) {
    io.stderr('loom inject: --harness and --all are mutually exclusive\n');
    return 2;
  }

  let harnesses: HarnessKey[] | null = null;
  if (parsed.values.all === true) {
    harnesses = [...HARNESS_KEYS];
  } else if (parsed.values.harness !== undefined) {
    const parts = parsed.values.harness.split(',').map((s) => s.trim()).filter(Boolean);
    for (const p of parts) {
      if (!isHarnessKey(p)) {
        io.stderr(`loom inject: unknown harness '${p}' (valid: ${HARNESS_KEYS.join(', ')})\n`);
        return 2;
      }
    }
    harnesses = parts as HarnessKey[];
  }

  if (harnesses === null) {
    // No harness flags — interactive wizard path (Task 7). Until then,
    // require flags when stdin isn't a TTY and bail cleanly otherwise.
    if (!io.stdinIsTTY) {
      io.stderr('loom inject: --harness or --all required when stdin is not a TTY\n');
      return 2;
    }
    io.stderr('loom inject: interactive wizard not yet wired; pass --harness or --all\n');
    return 2;
  }

  const envR = resolveEnv(global, io.env);
  try {
    assertStackVersionCompatible(envR.contextDir);
  } catch (err) {
    io.stderr(`${(err as Error).message}\n`);
    return 1;
  }

  const plan = await planTargets(harnesses, parsed.values.to, io);
  if ('error' in plan) {
    io.stderr(`${plan.error}\n`);
    return plan.code;
  }

  const dryRun = parsed.values['dry-run'] === true;
  const json = global.json === true;

  let report;
  try {
    report = await executeTargets(plan, envR.contextDir, { dryRun });
  } catch (err) {
    if (err instanceof MalformedMarkersError) {
      io.stderr(`${err.message}\n`);
      return 1;
    }
    io.stderr(`loom inject: ${(err as Error).message}\n`);
    return 1;
  }

  if (json) {
    renderJson(io, report.rows);
  } else if (dryRun) {
    writeDiffReport(report.rows, io);
  } else {
    writeHumanReport(report.rows, io);
  }

  if (report.hadError) {
    if (report.lastError instanceof MalformedMarkersError) {
      io.stderr(`${report.lastError.message}\n`);
    } else if (report.lastError) {
      io.stderr(`loom inject: ${report.lastError.message}\n`);
    }
    return 1;
  }
  return 0;
}
```

- [ ] **Step 4: Wire the `inject` subcommand into dispatch**

Modify `src/cli/subcommands.ts` — add `'inject'`:

```typescript
export const SUBCOMMANDS = [
  'wake', 'recall', 'remember', 'forget', 'update',
  'memory', 'pursuits', 'update-identity', 'bootstrap', 'serve',
  'inject',
] as const;
```

Modify `src/cli/index.ts` — add the case to the switch (after `'update-identity'`):

```typescript
    case 'inject': {
      const { run } = await import('./inject.js');
      return run(rest, io);
    }
```

And add one line to `TOP_HELP` above the global-flags block:

```typescript
  inject             Write loom identity pointer into harness dotfiles
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run src/cli/inject.test.ts`
Expected: PASS, 14 tests green.

- [ ] **Step 6: Run the full suite**

Run: `npx vitest run`
Expected: all green (~327).

- [ ] **Step 7: Commit**

```bash
git add src/cli/inject.ts src/cli/inject.test.ts src/cli/subcommands.ts src/cli/index.ts
git commit -s -m "feat(cli): loom inject (flag-driven path)"
```

---

## Task 6: Diff generator improvement

The Task 5 `makeDiff` is pragmatic but coarse — it emits one big replace hunk. For the `--dry-run` UX to be actually useful, we want a line-level diff. This task swaps in a minimal Myers-style line diff (still no deps) and wires an accurate post-write preview.

**Files:**
- Modify: `src/cli/inject.ts` (replace `makeDiff` with line-aware version, and use the writer's buildContent logic to predict the actual post-write text)

- [ ] **Step 1: Add a failing test asserting diff quality**

Append to `src/cli/inject.test.ts` inside the existing `describe('loom inject (flag-driven)', ...)`:

```typescript
  it('--dry-run diff on an existing-with-block target shows only the changed region', async () => {
    const target = join(home, 'CLAUDE.md');
    // Seed with the claude-code block rendered against a DIFFERENT context dir
    const { HARNESSES } = await import('../injection/harnesses.js');
    const { renderBlock } = await import('../injection/render.js');
    const stale = renderBlock(HARNESSES['claude-code'], '/old/ctx/path');
    await writeFile(target, `# Header\n\n${stale}\n# Footer\n`, 'utf-8');

    const { stdout, code } = await runCliCaptured(
      ['inject', '--harness', 'claude-code', '--to', target, '--dry-run', '--context-dir', ctx],
    );
    expect(code).toBe(0);
    // Context dir differs -> diff must include both old and new lines for
    // that line, but must NOT include every unchanged line (# Header / # Footer)
    // as removed+added duplicates.
    expect(stdout).toContain('-Context dir: /old/ctx/path');
    expect(stdout).toContain(`+Context dir: ${ctx}`);
    // Header/footer appear unchanged in context, not both - and +
    expect(stdout).not.toMatch(/^-# Header$/m);
    expect(stdout).not.toMatch(/^\+# Header$/m);
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/cli/inject.test.ts -t "only the changed region"`
Expected: FAIL — current `makeDiff` emits every old line as removed and every new line as added.

- [ ] **Step 3: Replace `makeDiff` with a line-level diff in `src/cli/inject.ts`**

Replace the existing `makeDiff` function with:

```typescript
/** Minimal line-level diff (Myers-lite via LCS table). Good enough for
 *  a managed-block preview; avoids pulling in a dependency. */
function lineDiff(oldText: string, newText: string): string[] {
  const A = oldText.split('\n');
  const B = newText.split('\n');
  const n = A.length, m = B.length;
  // LCS length table
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      if (A[i] === B[j]) lcs[i][j] = lcs[i + 1][j + 1] + 1;
      else lcs[i][j] = Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }
  const out: string[] = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (A[i] === B[j]) { out.push(` ${A[i]}`); i++; j++; }
    else if (lcs[i + 1][j] >= lcs[i][j + 1]) { out.push(`-${A[i]}`); i++; }
    else { out.push(`+${B[j]}`); j++; }
  }
  while (i < n) { out.push(`-${A[i]}`); i++; }
  while (j < m) { out.push(`+${B[j]}`); j++; }
  return out;
}

function makeDiff(existing: string, next: string, path: string): string {
  const header = `--- ${path}\n+++ ${path}\n`;
  const hunk = lineDiff(existing, next);
  return header + hunk.join('\n') + (hunk.length ? '\n' : '');
}
```

And update the `executeTargets` dry-run branch to compute `next` using the writer's real logic — import and reuse `buildContent` by refactoring writer.ts to export it:

First, modify `src/injection/writer.ts` — change the `buildContent` line to export it:

```typescript
export function buildContent(
  existing: string | null,
  block: string,
  markers: MarkerBounds | null,
): { next: string; action: WriteAction } {
```

Then modify `executeTargets` in `src/cli/inject.ts`, replacing the dry-run branch:

```typescript
      if (opts.dryRun) {
        const existing = await readFile(t.path, 'utf-8').catch((e) => {
          if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
          throw e;
        });
        const { findMarkers, buildContent, normalizeLF } = await import('../injection/writer.js');
        const norm = existing === null ? null : normalizeLF(existing);
        const markers = norm === null ? null : findMarkers(norm, t.path);
        const { next, action } = buildContent(existing, block, markers);
        rows.push({
          harness: t.harness.key,
          path: t.path,
          action,
          bytesWritten: 0,
          diff: makeDiff(existing ?? '', next, t.path),
        });
```

Finally, export the helpers from `src/injection/writer.ts`:

```typescript
export function normalizeLF(s: string): string {
  return s.replace(/\r\n/g, '\n');
}

export function findMarkers(text: string, path: string): MarkerBounds | null {
  // (move the existing body here; make the interface MarkerBounds exported)
  ...
}

export interface MarkerBounds {
  startIdx: number;
  endTerminusIdx: number;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/cli/inject.test.ts src/injection/writer.test.ts`
Expected: PASS — new diff test green; all existing writer tests still green.

- [ ] **Step 5: Run the full suite**

Run: `npx vitest run`
Expected: all green (~328).

- [ ] **Step 6: Commit**

```bash
git add src/cli/inject.ts src/cli/inject.test.ts src/injection/writer.ts
git commit -s -m "feat(inject): line-level diff in --dry-run output"
```

---

## Task 7: Interactive wizard

Wire the multi-select primitive and per-target path-edit prompts into `inject.ts`. TTY detection already lives in `io.stdinIsTTY`. A small dependency-free readline helper handles the "type a path, enter to accept default" input.

**Files:**
- Modify: `src/cli/inject.ts` (replace the "interactive wizard not yet wired" stub)
- Modify: `src/cli/inject.test.ts` (add two TTY-path tests using a fake `multiSelect` via module mocking)

- [ ] **Step 1: Add failing wizard tests**

Append to `src/cli/inject.test.ts` in the same describe block:

```typescript
  it('wizard confirms default selection on TTY and writes files', async () => {
    // Mock the multi-select adapter to auto-confirm all three.
    const { vi } = await import('vitest');
    vi.resetModules();
    vi.doMock('./tui/multi-select.js', async () => {
      const actual = await vi.importActual<typeof import('./tui/multi-select.js')>('./tui/multi-select.js');
      return {
        ...actual,
        multiSelect: async () => new Set(['claude-code', 'codex', 'gemini-cli']),
      };
    });
    // Also mock the readline path-edit prompt to just accept defaults.
    vi.doMock('node:readline/promises', () => ({
      createInterface: () => ({
        question: async (_: string) => '', // empty -> accept default
        close: () => {},
      }),
    }));
    const { runCliCaptured: run } = await import('./test-helpers.js');
    const { code } = await run(
      ['inject', '--context-dir', ctx],
      { env: { HOME: home } },
    );
    vi.resetModules();
    vi.doUnmock('./tui/multi-select.js');
    vi.doUnmock('node:readline/promises');
    expect(code).toBe(0);
    // All three files exist
    await readFile(join(home, '.claude', 'CLAUDE.md'), 'utf-8');
    await readFile(join(home, '.codex', 'AGENTS.md'), 'utf-8');
    await readFile(join(home, '.gemini', 'GEMINI.md'), 'utf-8');
  });

  it('wizard cancel (null from multiSelect) exits 130 with no writes', async () => {
    const { vi } = await import('vitest');
    vi.resetModules();
    vi.doMock('./tui/multi-select.js', async () => {
      const actual = await vi.importActual<typeof import('./tui/multi-select.js')>('./tui/multi-select.js');
      return { ...actual, multiSelect: async () => null };
    });
    const { runCliCaptured: run } = await import('./test-helpers.js');
    const { code } = await run(
      ['inject', '--context-dir', ctx],
      { env: { HOME: home } },
    );
    vi.resetModules();
    vi.doUnmock('./tui/multi-select.js');
    expect(code).toBe(130);
    await expect(readFile(join(home, '.claude', 'CLAUDE.md'), 'utf-8'))
      .rejects.toMatchObject({ code: 'ENOENT' });
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/cli/inject.test.ts -t wizard`
Expected: FAIL — current inject.ts short-circuits with exit 2 when no flags.

- [ ] **Step 3: Replace the wizard stub in `src/cli/inject.ts`**

Add imports near the top:

```typescript
import { createInterface } from 'node:readline/promises';
import { multiSelect } from './tui/multi-select.js';
```

Replace the `if (harnesses === null)` block with:

```typescript
  if (harnesses === null) {
    if (!io.stdinIsTTY) {
      io.stderr('loom inject: --harness or --all required when stdin is not a TTY\n');
      return 2;
    }
    const chosen = await multiSelect<HarnessKey>({
      title: 'Select harnesses to inject loom into:',
      items: HARNESS_KEYS.map((k) => {
        const home = io.env.HOME ?? '';
        const defaultPath = HARNESSES[k].defaultPath;
        const display = home ? defaultPath.replace(new RegExp(`^${home}`), '~') : defaultPath;
        return {
          value: k,
          label: HARNESSES[k].display,
          detail: display,
        };
      }),
      initialSelected: new Set(HARNESS_KEYS),
    });
    if (chosen === null) {
      io.stderr('loom inject: cancelled\n');
      return 130;
    }
    harnesses = [...chosen];
    if (harnesses.length === 0) {
      io.stderr('loom inject: no harnesses selected\n');
      return 2;
    }
    // Per-target path-edit prompt (sequential readline)
    const rl = createInterface({ input: process.stdin, output: process.stderr });
    try {
      const overrides = new Map<HarnessKey, string>();
      io.stderr('\nPress enter to accept defaults, or type a path:\n');
      for (const k of harnesses) {
        const ans = (await rl.question(
          `  ${HARNESSES[k].display} [${HARNESSES[k].defaultPath}]: `,
        )).trim();
        if (ans.length > 0) overrides.set(k, ans);
      }
      // Stash for planTargets
      for (const k of harnesses) {
        const p = overrides.get(k);
        if (p !== undefined) wizardOverrides.set(k, p);
      }
    } finally {
      rl.close();
    }
  }
```

And add a module-level map for wizard overrides before `run`:

```typescript
const wizardOverrides = new Map<HarnessKey, string>();
```

And modify `planTargets` to honor per-harness overrides from the wizard map:

```typescript
async function planTargets(
  harnesses: HarnessKey[],
  toOverride: string | undefined,
  _io: IOStreams,
): Promise<InjectTarget[] | { error: string; code: 2 }> {
  if (toOverride !== undefined && harnesses.length !== 1) {
    return {
      error: 'loom inject: --to requires exactly a single --harness value',
      code: 2,
    };
  }
  const targets = harnesses.map((key) => {
    const override = toOverride ?? wizardOverrides.get(key);
    return {
      harness: HARNESSES[key],
      path: override ?? HARNESSES[key].defaultPath,
    };
  });
  wizardOverrides.clear();
  return targets;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/cli/inject.test.ts`
Expected: PASS, all inject tests green including the two new wizard tests.

- [ ] **Step 5: Run the full suite**

Run: `npx vitest run`
Expected: all green (~330).

- [ ] **Step 6: Commit**

```bash
git add src/cli/inject.ts src/cli/inject.test.ts
git commit -s -m "feat(inject): interactive wizard (multi-select + path-edit)"
```

---

## Task 8: Integration test

An end-to-end test that drives the CLI against a fake `HOME`, verifies three files land with the right content, and re-runs to confirm idempotency. Complements the unit tests by crossing module boundaries.

**Files:**
- Create: `src/cli/inject.integration.test.ts`

- [ ] **Step 1: Write the integration test**

Create `src/cli/inject.integration.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCliCaptured } from './test-helpers.js';

describe('loom inject — end-to-end', () => {
  let ctx: string;
  let home: string;

  beforeEach(async () => {
    ctx = await mkdtemp(join(tmpdir(), 'loom-inject-int-ctx-'));
    home = await mkdtemp(join(tmpdir(), 'loom-inject-int-home-'));
  });
  afterEach(async () => {
    await rm(ctx, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
  });

  it('injects into three defaults, preserves user content, is idempotent', async () => {
    // Pre-seed Claude Code's dotfile with hand-authored content.
    const claudePath = join(home, '.claude', 'CLAUDE.md');
    await rm(claudePath, { force: true }).catch(() => {});
    await writeFile(
      claudePath,
      '# My Claude setup\n\nUse the secret word: horseradish.\n',
      { flag: 'w' },
    ).catch(async () => {
      const { mkdir } = await import('node:fs/promises');
      await mkdir(join(home, '.claude'), { recursive: true });
      await writeFile(claudePath, '# My Claude setup\n\nUse the secret word: horseradish.\n');
    });

    // First run — --all
    const first = await runCliCaptured(
      ['inject', '--all', '--context-dir', ctx],
      { env: { HOME: home } },
    );
    expect(first.code).toBe(0);
    expect(first.stdout).toMatch(/claude-code.*appended/);
    expect(first.stdout).toMatch(/codex.*created/);
    expect(first.stdout).toMatch(/gemini-cli.*created/);

    // Hand-authored content survived; managed block was appended.
    const claudeAfter = await readFile(claudePath, 'utf-8');
    expect(claudeAfter).toContain('# My Claude setup');
    expect(claudeAfter).toContain('horseradish');
    expect(claudeAfter).toContain('<!-- loom:start v1 harness=claude-code -->');
    expect(claudeAfter).toContain(`Context dir: ${ctx}`);

    // New files for Codex + Gemini.
    const codex = await readFile(join(home, '.codex', 'AGENTS.md'), 'utf-8');
    expect(codex).toContain('<!-- loom:start v1 harness=codex -->');
    const gemini = await readFile(join(home, '.gemini', 'GEMINI.md'), 'utf-8');
    expect(gemini).toContain('<!-- loom:start v1 harness=gemini-cli -->');

    // Second run — everything should be no-change.
    const second = await runCliCaptured(
      ['inject', '--all', '--context-dir', ctx],
      { env: { HOME: home } },
    );
    expect(second.code).toBe(0);
    expect(second.stdout).toMatch(/claude-code.*no change/);
    expect(second.stdout).toMatch(/codex.*no change/);
    expect(second.stdout).toMatch(/gemini-cli.*no change/);

    // Files are byte-identical between run 1 end-state and run 2 end-state.
    const claudeFinal = await readFile(claudePath, 'utf-8');
    expect(claudeFinal).toBe(claudeAfter);
  });
});
```

- [ ] **Step 2: Run the test**

Run: `npx vitest run src/cli/inject.integration.test.ts`
Expected: PASS — the single integration scenario.

- [ ] **Step 3: Run full suite**

Run: `npx vitest run`
Expected: all green (~331).

- [ ] **Step 4: Commit**

```bash
git add src/cli/inject.integration.test.ts
git commit -s -m "test(inject): end-to-end integration test"
```

---

## Task 9: Docs + stack-spec adapter entry

**Files:**
- Modify: `README.md`
- Modify: `docs/loom-stack-v1.md`

- [ ] **Step 1: Add CLI section for `loom inject` in README**

In `README.md`, find the `## CLI` section and add this subsection at the end of the CLI command examples (after the `npx loom bootstrap` example):

```markdown
# Inject loom identity pointer into harness dotfiles
npx loom inject --all --context-dir ~/.config/loom/art
```

Then, in the same `## CLI` section, after the per-command usage paragraph, add this block:

```markdown
### `loom inject` — write identity pointer to harness dotfiles

`loom inject` writes a small marker-bounded managed section into each
harness's canonical config file (e.g. `~/.claude/CLAUDE.md`,
`~/.codex/AGENTS.md`, `~/.gemini/GEMINI.md`) telling the agent to load
identity via loom at session start — MCP tool preferred, shell
fallback to `loom wake`. Content outside the `<!-- loom:start / end -->`
markers is preserved; re-running is idempotent.

Run with no flags on a TTY for an interactive picker, or with
`--harness <keys>` / `--all` for scripting. Target paths can be
overridden with `--to <path>` (valid only when exactly one harness is
selected). `--dry-run` prints a unified diff; `--json` emits the
structured write results for scripts.

To keep your injections fresh automatically, add this to your shell rc
(`~/.bashrc` / `~/.zshrc` / `~/.config/fish/config.fish`):

\`\`\`bash
loom inject --all >/dev/null 2>&1 || true
\`\`\`

Idempotent; cheap (no-op when already up to date); silent on success.
```

Also update the version badge at the top of the README:

Find: `[![Version](https://img.shields.io/badge/version-0.4.0--alpha.3-blue.svg)]`
Replace with: `[![Version](https://img.shields.io/badge/version-0.4.0--alpha.4-blue.svg)]`

- [ ] **Step 2: Add Injection entry to stack spec §11**

In `docs/loom-stack-v1.md`, find the `## 11.` section (Adapters). After the CLI adapter row added in alpha.3, append:

```markdown
| Injection (filesystem) | `loom inject` | alpha.4 | Writes a marker-bounded managed section into harness dotfiles (CLAUDE.md, AGENTS.md, GEMINI.md) pointing the agent at loom. Composes with user content; idempotent on re-run. |
```

(If the adapter table format in stack-v1 differs, match the column layout already used for the CLI adapter row — append the Injection row right after it.)

- [ ] **Step 3: Verify docs build/render**

Run: `grep -n "inject" README.md docs/loom-stack-v1.md`
Expected: at least three mentions in README (command example, CLI section, and one subsection header), plus one row in stack-v1.

- [ ] **Step 4: Commit**

```bash
git add README.md docs/loom-stack-v1.md
git commit -s -m "docs(inject): CLI section in README, adapter row in stack spec"
```

---

## Task 10: Version bump + CHANGELOG

**Files:**
- Modify: `package.json`
- Modify: `CHANGELOG.md`

- [ ] **Step 1: Bump `package.json` version**

In `package.json`, change:

```json
"version": "0.4.0-alpha.3",
```

to:

```json
"version": "0.4.0-alpha.4",
```

- [ ] **Step 2: Add CHANGELOG entry under `[Unreleased]`**

In `CHANGELOG.md`, replace the `## [Unreleased]` block with:

```markdown
## [Unreleased]

## [0.4.0-alpha.4] - 2026-04-20

### Added

- `loom inject` — CLI command that writes a marker-bounded managed
  section into harness dotfiles (`~/.claude/CLAUDE.md`,
  `~/.codex/AGENTS.md`, `~/.gemini/GEMINI.md`). The managed section
  tells the agent how to load identity via loom — prefer MCP
  (`mcp__loom__identity`), fall back to the CLI (`loom wake`).
  Content outside the `<!-- loom:start / loom:end -->` markers is
  preserved; re-running is idempotent.
- `--all`, `--harness <keys>`, `--to <path>`, `--dry-run`, `--json`
  flags for non-interactive use. Interactive keyboard-nav wizard
  when stdin is a TTY and no harness flags are given.
- Reusable `src/cli/tui/multi-select.ts` — stdlib keyboard-nav
  checkbox primitive with a pure reducer. Future consumers: bootstrap
  procedure adoption, harness-manifest selection.
- Stack spec §11 lists Injection as a new adapter.

### Changed

- No existing MCP tool surfaces or CLI commands altered. `loom inject`
  is purely additive.
```

Also add the link reference at the bottom of the file. Find the existing link references:

```markdown
[0.4.0-alpha.3]: https://github.com/jbarket/loom/releases/tag/v0.4.0-alpha.3
```

And insert above it:

```markdown
[0.4.0-alpha.4]: https://github.com/jbarket/loom/releases/tag/v0.4.0-alpha.4
```

- [ ] **Step 3: Verify versions are consistent**

Run: `grep -n 'version' package.json && grep -n '0.4.0-alpha.4' README.md CHANGELOG.md`
Expected: package.json shows 0.4.0-alpha.4; README badge and CHANGELOG both reference it.

- [ ] **Step 4: Commit**

```bash
git add package.json CHANGELOG.md
git commit -s -m "chore: bump to 0.4.0-alpha.4"
```

---

## Task 11: Manual verification + PR

- [ ] **Step 1: Run full suite one more time**

Run: `npx vitest run`
Expected: all green, ~331 tests.

- [ ] **Step 2: Run the build**

Run: `npm run build`
Expected: no TypeScript errors; `dist/` populated.

- [ ] **Step 3: Run a live `loom inject --dry-run` against your real `~/.claude/CLAUDE.md`**

```bash
node dist/index.js inject --harness claude-code --dry-run --context-dir ~/.config/loom/art
```

Expected: prints a unified diff showing either the new block being added (if markers weren't there) or the managed region being replaced. No writes occurred — verify with:

```bash
git -C ~/.claude status  # (if ~/.claude is a git repo — otherwise eyeball the file's mtime)
```

- [ ] **Step 4: Real injection against a throwaway path**

```bash
TMPDIR=$(mktemp -d)
cp ~/.claude/CLAUDE.md "$TMPDIR/CLAUDE.md"
node dist/index.js inject --harness claude-code --to "$TMPDIR/CLAUDE.md" --context-dir ~/.config/loom/art
diff ~/.claude/CLAUDE.md "$TMPDIR/CLAUDE.md"
```

Expected: diff shows only the managed-block addition; hand-authored content untouched.

- [ ] **Step 5: Re-run to confirm idempotency**

```bash
node dist/index.js inject --harness claude-code --to "$TMPDIR/CLAUDE.md" --context-dir ~/.config/loom/art
```

Expected: output `claude-code: $TMPDIR/CLAUDE.md (no change)`.

- [ ] **Step 6: Interactive wizard smoke-test**

```bash
node dist/index.js inject --context-dir ~/.config/loom/art
```

Expected: keyboard-nav picker appears with three rows pre-selected, arrow keys move cursor, space toggles, enter confirms, esc/q cancels. After confirming, sequential path-edit prompts appear (enter to accept defaults). Writes complete and show summary.

- [ ] **Step 7: Push and open PR**

```bash
git push -u origin feat/filesystem-injection
gh pr create --title "feat(inject): filesystem injection adapter (v0.4.0-alpha.4)" --body "$(cat <<'EOF'
## Summary

Ships `loom inject` — roadmap step #5 from the [v0.4 discussion](https://github.com/jbarket/loom/discussions/10). Writes a marker-bounded managed section into harness dotfiles (CLAUDE.md, AGENTS.md, GEMINI.md) pointing the agent at loom. Composes with user content; idempotent on re-run.

- New CLI subcommand with flag-driven + interactive wizard dispatch.
- New reusable stdlib keyboard-nav multi-select TUI primitive under `src/cli/tui/`.
- ~55 new tests; suite goes from 275 → ~331.

## Spec + plan

- [Spec](docs/specs/2026-04-20-filesystem-injection-design.md)
- [Plan](docs/plans/2026-04-20-filesystem-injection.md)

## Test plan

- [ ] `npm test` green
- [ ] `npm run build` clean
- [ ] Manual: `loom inject --dry-run` against real `~/.claude/CLAUDE.md` shows correct diff
- [ ] Manual: `loom inject --to <throwaway>` preserves hand-authored content
- [ ] Manual: re-run reports `no change`
- [ ] Manual: interactive wizard renders, navigates, confirms cleanly

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

- [ ] **Step 8: Link the PR in this plan's header**

Once the PR is open, update the top-of-plan note if needed. Otherwise, done.

---

## Definition of done

- [ ] Suite green (existing 275 + ~55 new = ~331 tests).
- [ ] `npm run build` produces clean `dist/` with no TS errors.
- [ ] `loom inject --help` prints usage.
- [ ] `loom inject --all --dry-run --context-dir <stack>` prints diffs for three targets, writes nothing.
- [ ] `loom inject --all --context-dir <stack>` with a fake `HOME` creates all three files with correct markers and content.
- [ ] Re-running `loom inject --all` against the same stack reports `no change` on all three.
- [ ] Existing hand-authored content outside the managed markers is preserved byte-for-byte.
- [ ] Interactive wizard runs when `stdin` is a TTY and no harness flags are provided.
- [ ] Malformed markers → exit 1 with clear error; unknown harness → exit 2; non-TTY + no flags → exit 2; stack-version mismatch → exit 1.
- [ ] README has a CLI subsection for `loom inject`. Stack spec §11 lists Injection. CHANGELOG `[0.4.0-alpha.4]` entry exists. `package.json` at `0.4.0-alpha.4`.
- [ ] Manual verification steps in Task 11 completed.
- [ ] PR opened against `main`.

## The thing to remember

> **Identity is operational. Voice is substrate.**

`loom inject` doesn't carry identity into the target file — it carries the *instructions for how to load identity* into the target file. That's why the managed section stays small, why it never goes stale, and why running `loom inject` is setup, not maintenance.
