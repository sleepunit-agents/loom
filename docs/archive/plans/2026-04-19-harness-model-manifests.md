# Harness + Model Manifests Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Land the first piece of the v0.4 arc — harness and model manifests as first-class stack blocks, integrated into the wake sequence, with `LOOM_STACK_VERSION` plumbing. Ships as 0.4.0-alpha.1.

**Architecture:** A new `src/blocks/` module exposes three plain-function readers (harness, model, procedures) that load `<context>/harnesses/*.md`, `<context>/models/*.md`, and `<context>/procedures/*.md`. `src/tools/identity.ts` composes their output into the wake payload, emits nudges when a manifest is expected but missing, and accepts a new `model` param (falling back to `LOOM_MODEL` env). `src/server.ts` stamps `LOOM_STACK_VERSION=1` on boot and short-circuits every tool handler with an error if the on-disk version is ahead of what this loom understands. No new MCP tools. No backend changes.

**Tech Stack:** TypeScript strict mode, `@modelcontextprotocol/sdk`, Zod 4, Vitest 4, Node ≥ 20, ESM. Matches what v0.3.1 already ships.

**Spec of record:** [`docs/specs/2026-04-19-harness-model-manifests-design.md`](../specs/2026-04-19-harness-model-manifests-design.md). Umbrella: [v0.4 discussion](https://github.com/jbarket/loom/discussions/10). Stack schema: [`docs/loom-stack-v1.md`](../loom-stack-v1.md).

---

## File structure

**Created:**

| Path | Responsibility |
|---|---|
| `src/blocks/types.ts` | `Block` interface, `parseFrontmatter` helper, `BlockReader` interface |
| `src/blocks/harness.ts` | `read / list / template` for `harnesses/*.md` |
| `src/blocks/model.ts` | `read / list / template` for `models/*.md` |
| `src/blocks/procedures.ts` | `read / list / readAll / template` for `procedures/*.md` (cap-aware) |
| `src/blocks/types.test.ts` | frontmatter parser tests |
| `src/blocks/harness.test.ts` | harness reader tests |
| `src/blocks/model.test.ts` | model reader tests |
| `src/blocks/procedures.test.ts` | procedures reader tests, cap warning |

**Modified:**

| Path | What changes |
|---|---|
| `src/config.ts` | add `STACK_VERSION_FILE`, `CURRENT_STACK_VERSION`, `readStackVersion`, `ensureStackVersion` |
| `src/config.test.ts` | tests for the four new exports |
| `src/server.ts` | boot-time version check; identity tool gets `model` param; version bump in McpServer ctor |
| `src/server.test.ts` | boot stamps `LOOM_STACK_VERSION`, refuses unknown versions |
| `src/tools/identity.ts` | signature gains `model?: string`; new harness / model / procedures / nudge sections; ordering per stack spec §5 |
| `src/tools/identity.test.ts` | new harness/model/procedures/nudge cases, model env + override |
| `package.json` | 0.3.1 → 0.4.0-alpha.1 |
| `README.md` | `LOOM_MODEL` row + MCP-config example, new block types in layout diagram |
| `.env.example` | add `LOOM_MODEL` |
| `CHANGELOG.md` | `[Unreleased]` entry listing this ship |

**Written outside the repo (Art's context dir):**

- `~/.config/loom/art/harnesses/claude-code.md` — seed harness manifest
- `~/.config/loom/art/models/claude-opus.md` — seed model manifest
- `~/.config/loom/art/LOOM_STACK_VERSION` — auto-stamped on first server boot, but we can write `1` up front

---

## Task 1: Create feature branch

**Files:** none (git branch only)

- [ ] **Step 1: Start from a clean main**

```bash
cd /home/jbarket/Code/loom
git status
```

Expected: `On branch main`, `nothing to commit, working tree clean`. If dirty, stash or commit before proceeding.

- [ ] **Step 2: Create and check out the feature branch**

```bash
git checkout -b feat/harness-model-manifests
```

Expected: `Switched to a new branch 'feat/harness-model-manifests'`.

---

## Task 2: Stack version plumbing in config

**Files:**
- Modify: `src/config.ts`
- Test: `src/config.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `src/config.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  CURRENT_STACK_VERSION,
  STACK_VERSION_FILE,
  readStackVersion,
  ensureStackVersion,
} from './config.js';

describe('stack version', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'loom-stack-version-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('exposes CURRENT_STACK_VERSION = 1', () => {
    expect(CURRENT_STACK_VERSION).toBe(1);
  });

  it('exposes STACK_VERSION_FILE = "LOOM_STACK_VERSION"', () => {
    expect(STACK_VERSION_FILE).toBe('LOOM_STACK_VERSION');
  });

  it('readStackVersion returns null when the file is missing', () => {
    expect(readStackVersion(dir)).toBeNull();
  });

  it('readStackVersion parses a numeric version', () => {
    writeFileSync(join(dir, 'LOOM_STACK_VERSION'), '1\n');
    expect(readStackVersion(dir)).toBe(1);
  });

  it('readStackVersion returns NaN for unparseable content', () => {
    writeFileSync(join(dir, 'LOOM_STACK_VERSION'), 'banana');
    expect(Number.isNaN(readStackVersion(dir))).toBe(true);
  });

  it('ensureStackVersion writes 1 when the file is missing', () => {
    ensureStackVersion(dir);
    expect(existsSync(join(dir, 'LOOM_STACK_VERSION'))).toBe(true);
    expect(readFileSync(join(dir, 'LOOM_STACK_VERSION'), 'utf-8')).toBe('1\n');
  });

  it('ensureStackVersion leaves an existing file untouched', () => {
    writeFileSync(join(dir, 'LOOM_STACK_VERSION'), '1\n');
    ensureStackVersion(dir);
    expect(readFileSync(join(dir, 'LOOM_STACK_VERSION'), 'utf-8')).toBe('1\n');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd /home/jbarket/Code/loom
npx vitest run src/config.test.ts
```

Expected: FAIL with "CURRENT_STACK_VERSION is not exported" / similar import errors.

- [ ] **Step 3: Implement the new exports in `src/config.ts`**

Append to `src/config.ts` (after the existing exports):

```ts
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

// ─── Stack version ────────────────────────────────────────────────────────────

/** The stack schema version this loom build understands. */
export const CURRENT_STACK_VERSION = 1;

/** The filename at the stack root that records the on-disk schema version. */
export const STACK_VERSION_FILE = 'LOOM_STACK_VERSION';

/**
 * Read the stack version stamp at `<contextDir>/LOOM_STACK_VERSION`.
 * Returns null if the file is missing, or NaN if the content doesn't parse.
 */
export function readStackVersion(contextDir: string): number | null {
  const path = resolve(contextDir, STACK_VERSION_FILE);
  if (!existsSync(path)) return null;
  return Number.parseInt(readFileSync(path, 'utf-8').trim(), 10);
}

/**
 * Lazy-write the current stack version if the stamp is missing. Does not
 * overwrite an existing file; the caller is responsible for validating
 * (and refusing) versions ahead of CURRENT_STACK_VERSION.
 */
export function ensureStackVersion(contextDir: string): void {
  const path = resolve(contextDir, STACK_VERSION_FILE);
  if (existsSync(path)) return;
  writeFileSync(path, `${CURRENT_STACK_VERSION}\n`, 'utf-8');
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npx vitest run src/config.test.ts
```

Expected: PASS (existing + 7 new tests).

- [ ] **Step 5: Commit**

```bash
git add src/config.ts src/config.test.ts
git commit -m "feat(config): add LOOM_STACK_VERSION plumbing

Introduces CURRENT_STACK_VERSION, STACK_VERSION_FILE, readStackVersion,
and ensureStackVersion. First piece of the v0.4 arc — the stack version
stamp unlocks adapter-level compatibility checks and future migrations."
```

---

## Task 3: Server factory stamps version on boot and refuses unknown versions

**Files:**
- Modify: `src/server.ts`
- Test: `src/server.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `src/server.test.ts`:

```ts
import { writeFileSync, readFileSync, existsSync } from 'node:fs';

describe('createLoomServer — stack version', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'server-version-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('writes LOOM_STACK_VERSION=1 on boot for a fresh context dir', () => {
    const contextDir = makeContextDir(tmpDir);
    const stampPath = join(contextDir, 'LOOM_STACK_VERSION');
    expect(existsSync(stampPath)).toBe(false);

    createLoomServer({ contextDir });

    expect(existsSync(stampPath)).toBe(true);
    expect(readFileSync(stampPath, 'utf-8')).toBe('1\n');
  });

  it('leaves an existing LOOM_STACK_VERSION=1 alone', () => {
    const contextDir = makeContextDir(tmpDir);
    writeFileSync(join(contextDir, 'LOOM_STACK_VERSION'), '1\n');

    createLoomServer({ contextDir });

    expect(readFileSync(join(contextDir, 'LOOM_STACK_VERSION'), 'utf-8')).toBe('1\n');
  });

  it('throws on boot when on-disk version is ahead of what loom understands', () => {
    const contextDir = makeContextDir(tmpDir);
    writeFileSync(join(contextDir, 'LOOM_STACK_VERSION'), '2\n');

    expect(() => createLoomServer({ contextDir })).toThrow(/stack version 2/i);
  });

  it('throws on boot when LOOM_STACK_VERSION is unparseable', () => {
    const contextDir = makeContextDir(tmpDir);
    writeFileSync(join(contextDir, 'LOOM_STACK_VERSION'), 'banana');

    expect(() => createLoomServer({ contextDir })).toThrow(/unparseable/i);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npx vitest run src/server.test.ts
```

Expected: FAIL — the new tests will either throw "file not written" or not throw when expected.

- [ ] **Step 3: Wire the version check into `src/server.ts`**

At the top of `src/server.ts`, add the import and version constant:

```ts
import { CURRENT_STACK_VERSION, ensureStackVersion, readStackVersion, STACK_VERSION_FILE } from './config.js';
```

At the top of `createLoomServer`, before the `new McpServer(...)` call, add:

```ts
export function createLoomServer(config: LoomServerConfig): LoomServerInstance {
  const { contextDir } = config;

  // Refuse to boot against a stack this loom build doesn't understand.
  const onDisk = readStackVersion(contextDir);
  if (onDisk !== null) {
    if (Number.isNaN(onDisk)) {
      throw new Error(
        `LOOM_STACK_VERSION unparseable at ${contextDir}/${STACK_VERSION_FILE}. ` +
        `Expected an integer; got raw content.`,
      );
    }
    if (onDisk > CURRENT_STACK_VERSION) {
      throw new Error(
        `loom understands stack version ${CURRENT_STACK_VERSION} but ` +
        `${contextDir}/${STACK_VERSION_FILE} is ${onDisk}. ` +
        `Upgrade loom or pin LOOM_CONTEXT_DIR to an older stack.`,
      );
    }
  }
  ensureStackVersion(contextDir);

  // … existing body unchanged …
```

Bump the version string in the `McpServer` ctor from `0.3.1` to `0.4.0-alpha.1` while you're in this file (it's easier to do now than in a separate commit):

```ts
  const server = new McpServer({
    name: 'loom',
    version: '0.4.0-alpha.1', // Keep in sync with package.json
  });
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npx vitest run src/server.test.ts src/config.test.ts
```

Expected: PASS. Also run the full suite:

```bash
npx vitest run
```

Expected: all 149 previous tests still pass plus the 4 new server tests.

- [ ] **Step 5: Commit**

```bash
git add src/server.ts src/server.test.ts
git commit -m "feat(server): stamp LOOM_STACK_VERSION on boot, refuse unknown versions

Server factory now writes LOOM_STACK_VERSION=1 into fresh context dirs on
boot and throws when the stamp is ahead of the version this loom build
understands. Also bumps the advertised MCP server version to
0.4.0-alpha.1 (package.json will follow)."
```

---

## Task 4: Block types + frontmatter parser

**Files:**
- Create: `src/blocks/types.ts`
- Test: `src/blocks/types.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `src/blocks/types.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { parseFrontmatter } from './types.js';

describe('parseFrontmatter', () => {
  it('returns empty frontmatter and body verbatim when no fences are present', () => {
    const text = '# Heading\n\nPlain body.';
    const { frontmatter, body } = parseFrontmatter(text);
    expect(frontmatter).toEqual({});
    expect(body).toBe(text);
  });

  it('parses simple key:value pairs between --- fences', () => {
    const text = '---\nharness: claude-code\nversion: 0.4\n---\n\n## Section\nhello';
    const { frontmatter, body } = parseFrontmatter(text);
    expect(frontmatter).toEqual({ harness: 'claude-code', version: '0.4' });
    expect(body).toBe('\n## Section\nhello');
  });

  it('trims whitespace around keys and values', () => {
    const text = '---\n  harness :   claude-code  \n---\nbody';
    const { frontmatter } = parseFrontmatter(text);
    expect(frontmatter.harness).toBe('claude-code');
  });

  it('ignores malformed frontmatter lines silently', () => {
    const text = '---\nharness: claude-code\nno-colon-here\nversion: 0.4\n---\nbody';
    const { frontmatter } = parseFrontmatter(text);
    expect(frontmatter).toEqual({ harness: 'claude-code', version: '0.4' });
  });

  it('leaves frontmatter empty and body intact when the closing fence is missing', () => {
    const text = '---\nharness: claude-code\nbody without closing fence';
    const { frontmatter, body } = parseFrontmatter(text);
    expect(frontmatter).toEqual({});
    expect(body).toBe(text);
  });

  it('supports values containing colons after the first one', () => {
    const text = '---\nnote: time is 08:30 CT\n---\nbody';
    const { frontmatter } = parseFrontmatter(text);
    expect(frontmatter.note).toBe('time is 08:30 CT');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npx vitest run src/blocks/types.test.ts
```

Expected: FAIL — no such module.

- [ ] **Step 3: Implement `src/blocks/types.ts`**

Create `src/blocks/types.ts`:

```ts
/**
 * Shared block types for loom stack blocks.
 *
 * A "block" is a markdown file in the stack that an adapter loads during
 * the wake sequence — a harness manifest, a model manifest, a procedure.
 * This module defines the common shape and a tiny frontmatter parser.
 * We intentionally avoid a YAML dep: frontmatter here is key: value lines,
 * small and strict.
 */

/** A single block read from disk. */
export interface Block {
  /** Filename without `.md`. Also the harness / model / procedure name. */
  key: string;
  /** Parsed frontmatter as flat key→value. Empty object when absent or malformed. */
  frontmatter: Record<string, string>;
  /** Markdown body after the frontmatter fences, trimmed. */
  body: string;
  /** Absolute path this block was read from. */
  path: string;
}

/** The common reader surface harness and model both implement. */
export interface BlockReader {
  /** Read a single block by key. Returns null when the file is missing or empty. */
  read(contextDir: string, key: string): Promise<Block | null>;
  /** Sorted list of keys present in this block's directory. */
  list(contextDir: string): Promise<string[]>;
  /** A blank template for this block type, parameterized by key. */
  template(key: string): string;
}

/**
 * Split `---` frontmatter from the markdown body. Missing or malformed
 * fences yield `{}` frontmatter + the original text as body. Individual
 * lines that aren't `key: value` are ignored.
 */
export function parseFrontmatter(text: string): {
  frontmatter: Record<string, string>;
  body: string;
} {
  const match = text.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!match) return { frontmatter: {}, body: text };

  const frontmatter: Record<string, string> = {};
  for (const line of match[1].split('\n')) {
    const colon = line.indexOf(':');
    if (colon === -1) continue;
    const key = line.slice(0, colon).trim();
    const value = line.slice(colon + 1).trim();
    if (key) frontmatter[key] = value;
  }
  return { frontmatter, body: match[2] };
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npx vitest run src/blocks/types.test.ts
```

Expected: PASS (6 new tests).

- [ ] **Step 5: Commit**

```bash
git add src/blocks/types.ts src/blocks/types.test.ts
git commit -m "feat(blocks): add Block type and frontmatter parser

New src/blocks/ module with the shared types every stack block reader
will use. Minimal line-by-line frontmatter parser — no YAML dep since
the frontmatter schema is tiny and strict."
```

---

## Task 5: Harness reader

**Files:**
- Create: `src/blocks/harness.ts`
- Test: `src/blocks/harness.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `src/blocks/harness.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import * as harness from './harness.js';

describe('blocks/harness', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'loom-harness-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  describe('read', () => {
    it('returns null when harnesses/ directory does not exist', async () => {
      expect(await harness.read(dir, 'claude-code')).toBeNull();
    });

    it('returns null when the specific manifest is missing', async () => {
      await mkdir(join(dir, 'harnesses'), { recursive: true });
      expect(await harness.read(dir, 'claude-code')).toBeNull();
    });

    it('returns null when the manifest file is empty', async () => {
      await mkdir(join(dir, 'harnesses'), { recursive: true });
      await writeFile(join(dir, 'harnesses', 'claude-code.md'), '');
      expect(await harness.read(dir, 'claude-code')).toBeNull();
    });

    it('returns a Block with parsed frontmatter and trimmed body', async () => {
      await mkdir(join(dir, 'harnesses'), { recursive: true });
      await writeFile(
        join(dir, 'harnesses', 'claude-code.md'),
        '---\nharness: claude-code\nversion: 0.4\n---\n\n## Tool prefixes\nmcp__loom__*\n',
      );
      const block = await harness.read(dir, 'claude-code');
      expect(block).not.toBeNull();
      expect(block?.key).toBe('claude-code');
      expect(block?.frontmatter).toEqual({ harness: 'claude-code', version: '0.4' });
      expect(block?.body).toContain('## Tool prefixes');
      expect(block?.path).toBe(join(dir, 'harnesses', 'claude-code.md'));
    });

    it('returns a Block with empty frontmatter when file has none', async () => {
      await mkdir(join(dir, 'harnesses'), { recursive: true });
      await writeFile(join(dir, 'harnesses', 'claude-code.md'), '## Tool prefixes\nmcp__loom__*\n');
      const block = await harness.read(dir, 'claude-code');
      expect(block?.frontmatter).toEqual({});
      expect(block?.body).toContain('## Tool prefixes');
    });
  });

  describe('list', () => {
    it('returns [] when harnesses/ is missing', async () => {
      expect(await harness.list(dir)).toEqual([]);
    });

    it('returns sorted keys for present manifests', async () => {
      await mkdir(join(dir, 'harnesses'), { recursive: true });
      await writeFile(join(dir, 'harnesses', 'hermes.md'), '# hermes');
      await writeFile(join(dir, 'harnesses', 'claude-code.md'), '# claude-code');
      await writeFile(join(dir, 'harnesses', 'not-a-manifest.txt'), 'skip me');
      expect(await harness.list(dir)).toEqual(['claude-code', 'hermes']);
    });
  });

  describe('template', () => {
    it('returns a template string containing the supplied key in the frontmatter', () => {
      const tpl = harness.template('claude-code');
      expect(tpl).toContain('harness: claude-code');
      expect(tpl).toContain('## Tool prefixes');
      expect(tpl).toContain('## Delegation primitive');
      expect(tpl).toContain('## Cron / scheduling');
      expect(tpl).toContain('## Session search');
      expect(tpl).toContain('## Gotchas');
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npx vitest run src/blocks/harness.test.ts
```

Expected: FAIL — no such module.

- [ ] **Step 3: Implement `src/blocks/harness.ts`**

Create `src/blocks/harness.ts`:

```ts
/**
 * Harness manifest reader.
 *
 * Each harness an agent has ever sleeved into gets one manifest at
 * `<contextDir>/harnesses/<client>.md`. The manifest describes the
 * harness independently of the model running inside it — tool prefixes,
 * delegation primitive, scheduling, session search, known gotchas.
 *
 * Contract: stack spec v1 §4.7.
 */
import { readFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseFrontmatter, type Block } from './types.js';

const DIR = 'harnesses';

export async function read(contextDir: string, key: string): Promise<Block | null> {
  const path = resolve(contextDir, DIR, `${key}.md`);
  if (!existsSync(path)) return null;
  const raw = await readFile(path, 'utf-8');
  if (raw.trim() === '') return null;
  const { frontmatter, body } = parseFrontmatter(raw);
  return { key, frontmatter, body: body.trim(), path };
}

export async function list(contextDir: string): Promise<string[]> {
  const path = resolve(contextDir, DIR);
  if (!existsSync(path)) return [];
  const entries = await readdir(path);
  return entries
    .filter((name) => name.endsWith('.md'))
    .map((name) => name.slice(0, -'.md'.length))
    .sort();
}

export function template(key: string): string {
  return `---
harness: ${key}
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
`;
}
```

(Eliminate the unused `join` import; Node's `resolve` handles path composition here.)

- [ ] **Step 4: Run tests to verify they pass**

```bash
npx vitest run src/blocks/harness.test.ts
```

Expected: PASS (9 new tests).

- [ ] **Step 5: Commit**

```bash
git add src/blocks/harness.ts src/blocks/harness.test.ts
git commit -m "feat(blocks): add harness manifest reader

Reads harnesses/<key>.md. Provides read / list / template. Matches
stack spec v1 §4.7. Pure functions, no class, no side effects."
```

---

## Task 6: Model reader

**Files:**
- Create: `src/blocks/model.ts`
- Test: `src/blocks/model.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `src/blocks/model.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import * as model from './model.js';

describe('blocks/model', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'loom-model-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  describe('read', () => {
    it('returns null when models/ directory does not exist', async () => {
      expect(await model.read(dir, 'claude-opus')).toBeNull();
    });

    it('returns null when the specific manifest is missing', async () => {
      await mkdir(join(dir, 'models'), { recursive: true });
      expect(await model.read(dir, 'claude-opus')).toBeNull();
    });

    it('returns null when the manifest file is empty', async () => {
      await mkdir(join(dir, 'models'), { recursive: true });
      await writeFile(join(dir, 'models', 'claude-opus.md'), '');
      expect(await model.read(dir, 'claude-opus')).toBeNull();
    });

    it('returns a Block with parsed frontmatter and trimmed body', async () => {
      await mkdir(join(dir, 'models'), { recursive: true });
      await writeFile(
        join(dir, 'models', 'claude-opus.md'),
        '---\nmodel: claude-opus\nfamily: claude\n---\n\n## Capability notes\nStrong tool use.\n',
      );
      const block = await model.read(dir, 'claude-opus');
      expect(block?.key).toBe('claude-opus');
      expect(block?.frontmatter).toEqual({ model: 'claude-opus', family: 'claude' });
      expect(block?.body).toContain('## Capability notes');
    });
  });

  describe('list', () => {
    it('returns [] when models/ is missing', async () => {
      expect(await model.list(dir)).toEqual([]);
    });

    it('returns sorted keys for present manifests', async () => {
      await mkdir(join(dir, 'models'), { recursive: true });
      await writeFile(join(dir, 'models', 'gemma4.md'), '# gemma4');
      await writeFile(join(dir, 'models', 'claude-opus.md'), '# opus');
      expect(await model.list(dir)).toEqual(['claude-opus', 'gemma4']);
    });
  });

  describe('template', () => {
    it('returns a template containing the supplied key', () => {
      const tpl = model.template('claude-opus');
      expect(tpl).toContain('model: claude-opus');
      expect(tpl).toContain('## Capability notes');
      expect(tpl).toContain('## Workarounds');
      expect(tpl).toContain('## When to use');
      expect(tpl).toContain('## When not to use');
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npx vitest run src/blocks/model.test.ts
```

Expected: FAIL — no such module.

- [ ] **Step 3: Implement `src/blocks/model.ts`**

Create `src/blocks/model.ts`:

```ts
/**
 * Model manifest reader.
 *
 * Each model family the agent has ever sleeved into gets one manifest at
 * `<contextDir>/models/<key>.md`. Describes capability notes, workarounds,
 * and when-to-use / when-not-to-use guidance — independent of harness.
 *
 * Contract: stack spec v1 §4.8.
 */
import { readFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseFrontmatter, type Block } from './types.js';

const DIR = 'models';

export async function read(contextDir: string, key: string): Promise<Block | null> {
  const path = resolve(contextDir, DIR, `${key}.md`);
  if (!existsSync(path)) return null;
  const raw = await readFile(path, 'utf-8');
  if (raw.trim() === '') return null;
  const { frontmatter, body } = parseFrontmatter(raw);
  return { key, frontmatter, body: body.trim(), path };
}

export async function list(contextDir: string): Promise<string[]> {
  const path = resolve(contextDir, DIR);
  if (!existsSync(path)) return [];
  const entries = await readdir(path);
  return entries
    .filter((name) => name.endsWith('.md'))
    .map((name) => name.slice(0, -'.md'.length))
    .sort();
}

export function template(key: string): string {
  return `---
model: ${key}
family: <family name>
size: <size hint if meaningful>
---

## Capability notes
<strengths and weaknesses that matter operationally>

## Workarounds
<known-good compensation patterns — or "None required.">

## When to use
<concrete situations this model is the right choice>

## When not to use
<concrete situations where a different model is better>
`;
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npx vitest run src/blocks/model.test.ts
```

Expected: PASS (8 new tests).

- [ ] **Step 5: Commit**

```bash
git add src/blocks/model.ts src/blocks/model.test.ts
git commit -m "feat(blocks): add model manifest reader

Reads models/<key>.md. Provides read / list / template. Matches
stack spec v1 §4.8. Parallel structure to the harness reader."
```

---

## Task 7: Procedures reader (cap-aware)

**Files:**
- Create: `src/blocks/procedures.ts`
- Test: `src/blocks/procedures.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `src/blocks/procedures.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import * as procedures from './procedures.js';

describe('blocks/procedures', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'loom-procedures-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('list returns [] and readAll returns empty blocks when procedures/ is missing', async () => {
    expect(await procedures.list(dir)).toEqual([]);
    const all = await procedures.readAll(dir);
    expect(all.blocks).toEqual([]);
    expect(all.capWarning).toBeNull();
  });

  it('readAll returns blocks sorted alphabetically by key', async () => {
    await mkdir(join(dir, 'procedures'), { recursive: true });
    await writeFile(join(dir, 'procedures', 'reflection-at-end-of-unit.md'), '# Reflection');
    await writeFile(join(dir, 'procedures', 'cold-testing.md'), '# Cold testing');
    const all = await procedures.readAll(dir);
    expect(all.blocks.map((b) => b.key)).toEqual(['cold-testing', 'reflection-at-end-of-unit']);
    expect(all.capWarning).toBeNull();
  });

  it('readAll emits a cap warning when >10 procedures are present', async () => {
    await mkdir(join(dir, 'procedures'), { recursive: true });
    for (let i = 0; i < 11; i++) {
      await writeFile(join(dir, 'procedures', `proc-${i.toString().padStart(2, '0')}.md`), `# ${i}`);
    }
    const all = await procedures.readAll(dir);
    expect(all.blocks.length).toBe(11);
    expect(all.capWarning).not.toBeNull();
    expect(all.capWarning).toMatch(/11/);
    expect(all.capWarning).toMatch(/cap/i);
  });

  it('readAll skips empty files', async () => {
    await mkdir(join(dir, 'procedures'), { recursive: true });
    await writeFile(join(dir, 'procedures', 'empty.md'), '');
    await writeFile(join(dir, 'procedures', 'ok.md'), '# OK');
    const all = await procedures.readAll(dir);
    expect(all.blocks.map((b) => b.key)).toEqual(['ok']);
  });

  it('read returns a single procedure by key', async () => {
    await mkdir(join(dir, 'procedures'), { recursive: true });
    await writeFile(
      join(dir, 'procedures', 'verify-before-completion.md'),
      '---\ntitle: Verify\n---\n\n## Rule\nAlways verify.\n',
    );
    const block = await procedures.read(dir, 'verify-before-completion');
    expect(block?.key).toBe('verify-before-completion');
    expect(block?.frontmatter.title).toBe('Verify');
    expect(block?.body).toContain('## Rule');
  });

  it('template contains the key in the first header', () => {
    const tpl = procedures.template('verify-before-completion');
    expect(tpl).toContain('verify-before-completion');
    expect(tpl.toLowerCase()).toContain('why');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npx vitest run src/blocks/procedures.test.ts
```

Expected: FAIL — no such module.

- [ ] **Step 3: Implement `src/blocks/procedures.ts`**

Create `src/blocks/procedures.ts`:

```ts
/**
 * Procedures block reader.
 *
 * Procedural-identity docs live at `<contextDir>/procedures/*.md` —
 * short prescriptive rules for how this agent acts (verify, cold-test,
 * reflect, handoff). Hard cap at ~10 per stack spec v1 §4.9; `readAll`
 * emits a warning when the cap is exceeded so the wake sequence can
 * surface it in the identity payload.
 */
import { readFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseFrontmatter, type Block } from './types.js';

const DIR = 'procedures';
const CAP = 10;

export async function read(contextDir: string, key: string): Promise<Block | null> {
  const path = resolve(contextDir, DIR, `${key}.md`);
  if (!existsSync(path)) return null;
  const raw = await readFile(path, 'utf-8');
  if (raw.trim() === '') return null;
  const { frontmatter, body } = parseFrontmatter(raw);
  return { key, frontmatter, body: body.trim(), path };
}

export async function list(contextDir: string): Promise<string[]> {
  const path = resolve(contextDir, DIR);
  if (!existsSync(path)) return [];
  const entries = await readdir(path);
  return entries
    .filter((name) => name.endsWith('.md'))
    .map((name) => name.slice(0, -'.md'.length))
    .sort();
}

export async function readAll(contextDir: string): Promise<{
  blocks: Block[];
  capWarning: string | null;
}> {
  const keys = await list(contextDir);
  const blocks: Block[] = [];
  for (const key of keys) {
    const block = await read(contextDir, key);
    if (block) blocks.push(block);
  }
  const capWarning = blocks.length > CAP
    ? `Procedures cap exceeded: ${blocks.length} files present, cap is ${CAP}. ` +
      `Prune — this block has regressed toward agentskills. See stack spec v1 §4.9.`
    : null;
  return { blocks, capWarning };
}

export function template(key: string): string {
  return `# ${key}

<one-sentence rule>

## Why
<the reason — often a past incident or strong preference>

## How to apply
<when this kicks in, how to judge edge cases>
`;
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npx vitest run src/blocks/procedures.test.ts
```

Expected: PASS (6 new tests).

- [ ] **Step 5: Commit**

```bash
git add src/blocks/procedures.ts src/blocks/procedures.test.ts
git commit -m "feat(blocks): add procedures reader with cap warning

Procedures block is capped at ~10 files per stack spec v1 §4.9.
readAll returns blocks + capWarning so the wake sequence can surface
overflow without crashing. Pure functions, no class."
```

---

## Task 8: Wake-sequence integration — harness section

**Files:**
- Modify: `src/tools/identity.ts`
- Test: `src/tools/identity.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `src/tools/identity.test.ts`:

```ts
describe('loadIdentity — harness manifest', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'loom-harness-wake-'));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('omits the "# Harness:" section when no client is specified', async () => {
    await writeFile(join(tempDir, 'IDENTITY.md'), 'Creed');
    const result = await loadIdentity(tempDir);
    expect(result).not.toContain('# Harness:');
  });

  it('emits a nudge section when client is set but no manifest exists', async () => {
    await writeFile(join(tempDir, 'IDENTITY.md'), 'Creed');
    const result = await loadIdentity(tempDir, undefined, 'claude-code');
    expect(result).toContain('# Harness: claude-code (manifest missing)');
    expect(result).toContain('harness: claude-code');
    expect(result).toContain('## Tool prefixes');
  });

  it('emits the harness manifest body when present', async () => {
    await writeFile(join(tempDir, 'IDENTITY.md'), 'Creed');
    await mkdir(join(tempDir, 'harnesses'), { recursive: true });
    await writeFile(
      join(tempDir, 'harnesses', 'claude-code.md'),
      '---\nharness: claude-code\nversion: 0.4\n---\n\n## Tool prefixes\nmcp__loom__*\n',
    );
    const result = await loadIdentity(tempDir, undefined, 'claude-code');
    expect(result).toContain('# Harness: claude-code');
    expect(result).not.toContain('manifest missing');
    expect(result).toContain('mcp__loom__*');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npx vitest run src/tools/identity.test.ts
```

Expected: FAIL — new tests fail because the "# Harness:" section isn't emitted yet.

- [ ] **Step 3: Integrate harness reading into `loadIdentity`**

In `src/tools/identity.ts`, add imports at the top:

```ts
import * as harnessBlock from '../blocks/harness.js';
```

Inside `loadIdentity`, after the project section and before the legacy memories/INDEX.md block, add the harness section:

```ts
  // Harness manifest — the shape of the current runtime (stack spec §4.7).
  const effectiveClient = client ?? process.env.LOOM_CLIENT;
  if (effectiveClient) {
    const block = await harnessBlock.read(contextDir, effectiveClient);
    if (block) {
      parts.push(`# Harness: ${effectiveClient}\n\n${block.body}`);
    } else {
      parts.push(
        `# Harness: ${effectiveClient} (manifest missing)\n\n` +
        `No manifest found at ${contextDir}/harnesses/${effectiveClient}.md. ` +
        `Write one — here's the template:\n\n` +
        harnessBlock.template(effectiveClient),
      );
    }
  }
```

Leave the existing `effectiveClient` / `loadClientAdapter` logic at the bottom of the function alone — the `## Runtime:` block still appears and keeps existing tests green. (You'll see there's now a duplicate `effectiveClient` const; rename the earlier one to avoid the collision, or reuse a single const at the top of the function body and pass it to both paths.)

To clean that up: move the `effectiveClient` resolution to the top of `loadIdentity`, above the `parts` assembly, and reuse it in both places:

```ts
export async function loadIdentity(
  contextDir: string,
  project?: string,
  client?: string,
): Promise<string> {
  const parts: string[] = [];
  const effectiveClient = client ?? process.env.LOOM_CLIENT;

  // …existing identity / preferences / self-model / project sections unchanged…

  // Harness manifest block, as above.

  // …existing memories/INDEX.md block unchanged…

  // Runtime client adapter (legacy; continues to emit `## Runtime: …`)
  if (effectiveClient) {
    const adapter = await loadClientAdapter(contextDir, effectiveClient);
    if (adapter) parts.push(adapter);
  }

  return parts.join('\n\n---\n\n');
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npx vitest run src/tools/identity.test.ts
```

Expected: PASS — existing tests (including the `## Runtime:` adapter tests) stay green, three new harness tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/tools/identity.ts src/tools/identity.test.ts
git commit -m "feat(identity): integrate harness manifest into wake sequence

loadIdentity now reads harnesses/<client>.md and emits a '# Harness:'
section in the identity payload when LOOM_CLIENT resolves. Missing
manifest produces a template-filled nudge instead of an error."
```

---

## Task 9: Wake-sequence integration — model section

**Files:**
- Modify: `src/tools/identity.ts`
- Modify: `src/server.ts`
- Test: `src/tools/identity.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `src/tools/identity.test.ts`:

```ts
describe('loadIdentity — model manifest', () => {
  let tempDir: string;
  const originalModelEnv = process.env.LOOM_MODEL;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'loom-model-wake-'));
    delete process.env.LOOM_MODEL;
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
    if (originalModelEnv === undefined) {
      delete process.env.LOOM_MODEL;
    } else {
      process.env.LOOM_MODEL = originalModelEnv;
    }
  });

  it('omits the "# Model:" section when neither env nor param is set', async () => {
    await writeFile(join(tempDir, 'IDENTITY.md'), 'Creed');
    const result = await loadIdentity(tempDir);
    expect(result).not.toContain('# Model:');
  });

  it('emits a nudge when LOOM_MODEL is set but no manifest exists', async () => {
    await writeFile(join(tempDir, 'IDENTITY.md'), 'Creed');
    process.env.LOOM_MODEL = 'claude-opus';
    const result = await loadIdentity(tempDir);
    expect(result).toContain('# Model: claude-opus (manifest missing)');
    expect(result).toContain('model: claude-opus');
    expect(result).toContain('## Capability notes');
  });

  it('emits manifest body when the file is present', async () => {
    await writeFile(join(tempDir, 'IDENTITY.md'), 'Creed');
    await mkdir(join(tempDir, 'models'), { recursive: true });
    await writeFile(
      join(tempDir, 'models', 'claude-opus.md'),
      '---\nmodel: claude-opus\n---\n\n## Capability notes\nStrong tool use.\n',
    );
    process.env.LOOM_MODEL = 'claude-opus';
    const result = await loadIdentity(tempDir);
    expect(result).toContain('# Model: claude-opus');
    expect(result).not.toContain('manifest missing');
    expect(result).toContain('Strong tool use');
  });

  it('accepts a model param that overrides LOOM_MODEL', async () => {
    await writeFile(join(tempDir, 'IDENTITY.md'), 'Creed');
    process.env.LOOM_MODEL = 'claude-opus';
    const result = await loadIdentity(tempDir, undefined, undefined, 'claude-haiku');
    expect(result).toContain('# Model: claude-haiku (manifest missing)');
    expect(result).not.toContain('# Model: claude-opus');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npx vitest run src/tools/identity.test.ts
```

Expected: FAIL — no model section emitted, and the fourth positional arg isn't accepted.

- [ ] **Step 3: Extend `loadIdentity` signature and add model section**

In `src/tools/identity.ts`:

1. Add an import:

```ts
import * as modelBlock from '../blocks/model.js';
```

2. Extend the signature:

```ts
export async function loadIdentity(
  contextDir: string,
  project?: string,
  client?: string,
  model?: string,
): Promise<string>
```

3. Just after the harness section you added in Task 8, add the model section:

```ts
  // Model manifest — model-family-specific capability notes (stack spec §4.8).
  const effectiveModel = model ?? process.env.LOOM_MODEL;
  if (effectiveModel) {
    const block = await modelBlock.read(contextDir, effectiveModel);
    if (block) {
      parts.push(`# Model: ${effectiveModel}\n\n${block.body}`);
    } else {
      parts.push(
        `# Model: ${effectiveModel} (manifest missing)\n\n` +
        `No manifest found at ${contextDir}/models/${effectiveModel}.md. ` +
        `Write one — here's the template:\n\n` +
        modelBlock.template(effectiveModel),
      );
    }
  }
```

- [ ] **Step 4: Wire the new param into `src/server.ts`**

In `src/server.ts`, inside the identity tool registration, add the `model` input field and pass it through:

```ts
  server.tool(
    'identity',
    'Load the persistent identity for this agent. Returns the terminal creed ' +
    '(who you are), relevant memories, preferences, and self-model. ' +
    'IMPORTANT: Call this tool FIRST before doing any other work. ' +
    'The identity defines who you are and how you should behave.',
    {
      project: z.string().optional().describe('Project context to load (loads project-specific memories)'),
      client: z.string().optional().describe(
        'Runtime client name for tool-prefix context: "claude-code", "gemini-cli", "hermes", "openclaw", "nemoclaw". ' +
        'Overrides the LOOM_CLIENT environment variable.',
      ),
      model: z.string().optional().describe(
        'Model identifier for model-manifest context (e.g. "claude-opus", "gemma4"). ' +
        'Overrides the LOOM_MODEL environment variable.',
      ),
    },
    async ({ project, client, model }) => {
      const result = await loadIdentity(contextDir, project, client, model);
      return { content: [{ type: 'text' as const, text: result }] };
    },
  );
```

- [ ] **Step 5: Run tests to verify they pass**

```bash
npx vitest run
```

Expected: all prior tests still green, four new model tests pass.

- [ ] **Step 6: Commit**

```bash
git add src/tools/identity.ts src/tools/identity.test.ts src/server.ts
git commit -m "feat(identity): integrate model manifest + LOOM_MODEL into wake

loadIdentity accepts an optional model param (fallback: LOOM_MODEL env)
and emits a '# Model:' section sourced from models/<key>.md. Missing
manifest produces a template nudge. identity() MCP tool exposes the
new param in its input schema."
```

---

## Task 10: Wake-sequence integration — procedures section

**Files:**
- Modify: `src/tools/identity.ts`
- Test: `src/tools/identity.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `src/tools/identity.test.ts`:

```ts
describe('loadIdentity — procedures', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'loom-proc-wake-'));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('omits the "# Procedures" section when procedures/ is missing', async () => {
    await writeFile(join(tempDir, 'IDENTITY.md'), 'Creed');
    const result = await loadIdentity(tempDir);
    expect(result).not.toContain('# Procedures');
  });

  it('emits procedures joined with --- when present', async () => {
    await writeFile(join(tempDir, 'IDENTITY.md'), 'Creed');
    await mkdir(join(tempDir, 'procedures'), { recursive: true });
    await writeFile(join(tempDir, 'procedures', 'verify.md'), '# Verify\n\nAlways verify.');
    await writeFile(join(tempDir, 'procedures', 'reflect.md'), '# Reflect\n\nAlways reflect.');
    const result = await loadIdentity(tempDir);
    expect(result).toContain('# Procedures');
    expect(result).toContain('Always verify');
    expect(result).toContain('Always reflect');
  });

  it('prepends a cap warning when >10 procedures are present', async () => {
    await writeFile(join(tempDir, 'IDENTITY.md'), 'Creed');
    await mkdir(join(tempDir, 'procedures'), { recursive: true });
    for (let i = 0; i < 11; i++) {
      await writeFile(
        join(tempDir, 'procedures', `proc-${i.toString().padStart(2, '0')}.md`),
        `# ${i}\nbody`,
      );
    }
    const result = await loadIdentity(tempDir);
    expect(result).toContain('# Procedures');
    expect(result.toLowerCase()).toContain('cap exceeded');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npx vitest run src/tools/identity.test.ts
```

Expected: FAIL — no procedures section emitted.

- [ ] **Step 3: Add the procedures section to `loadIdentity`**

In `src/tools/identity.ts`:

1. Add an import:

```ts
import * as proceduresBlock from '../blocks/procedures.js';
```

2. After the model section you added in Task 9, and before the legacy memory-index block, add:

```ts
  // Procedures — procedural-identity docs (stack spec §4.9).
  const { blocks: procedures, capWarning } = await proceduresBlock.readAll(contextDir);
  if (procedures.length > 0) {
    const body = procedures.map((b) => b.body).join('\n\n---\n\n');
    const withWarning = capWarning ? `> ${capWarning}\n\n${body}` : body;
    parts.push(`# Procedures\n\n${withWarning}`);
  }
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npx vitest run
```

Expected: all tests green including three new procedure tests.

- [ ] **Step 5: Commit**

```bash
git add src/tools/identity.ts src/tools/identity.test.ts
git commit -m "feat(identity): integrate procedures block into wake

loadIdentity now concatenates procedures/*.md into a '# Procedures'
section, joined with --- separators. Cap warning (>10 files)
surfaces as a blockquote prepended to the section."
```

---

## Task 11: Seed manifests in Art's context directory

**Files (outside the repo):**
- Create: `~/.config/loom/art/harnesses/claude-code.md`
- Create: `~/.config/loom/art/models/claude-opus.md`
- Optionally ensure: `~/.config/loom/art/LOOM_STACK_VERSION` contains `1`

- [ ] **Step 1: Confirm Art's context dir and verify it contains the expected stack files**

```bash
ls -la ~/.config/loom/art/
```

Expected: IDENTITY.md, preferences.md, self-model.md, pursuits.md, memories.db, and likely `projects/`. `harnesses/` and `models/` may not exist yet.

- [ ] **Step 2: Create `harnesses/` and write the seed claude-code manifest**

```bash
mkdir -p ~/.config/loom/art/harnesses
cat > ~/.config/loom/art/harnesses/claude-code.md <<'EOF'
---
harness: claude-code
version: 0.4
---

## Tool prefixes
`mcp__loom__*` for loom tools. Built-in tools use bare names:
Bash, Read, Edit, Write, Glob, Grep, Agent, ToolSearch, TaskCreate/TaskUpdate,
ScheduleWakeup.

## Delegation primitive
Agent tool with a `subagent_type` selector. Sub-agents start with zero
context — briefs must be self-contained. Parallel sub-agents: dispatch
multiple Agent calls in a single assistant message.

## Cron / scheduling
Deferred tool `ScheduleWakeup` schedules a wake inside the current loop.
Claude Code itself has no cron; cross-session scheduling lives in the
hermes harness (if applicable) or in external systems.

## Session search
`/resume` dialog in the TUI. Transcripts on disk under
`~/.claude/projects/<cwd-encoded>/<session-id>.jsonl`. Fine-grained
semantic search is not built in — grep the transcripts or use
loom's own memory store.

## Gotchas
- Many tools are **deferred** (surfaced by name only). Call `ToolSearch`
  first with a `select:<name>` query to load the schema before invoking.
- The `TodoWrite` tool name you may see in older prompts has been
  replaced by `TaskCreate` / `TaskUpdate` / `TaskList` / `TaskGet`.
- When calling multiple tools with no dependencies, batch them in one
  assistant message — parallel by default.
- The skill system (`Skill` tool) is how user-invocable slash commands
  dispatch into specialized subroutines.
EOF
```

- [ ] **Step 3: Create `models/` and write the seed claude-opus manifest**

```bash
mkdir -p ~/.config/loom/art/models
cat > ~/.config/loom/art/models/claude-opus.md <<'EOF'
---
model: claude-opus
family: claude
size: opus
---

## Capability notes
- Strong tool-chain reliability; handles long multi-step tool sequences
  without losing the thread.
- Strong architectural reasoning and code review.
- Creative writing: capable, tends toward a conservative/considered tone
  over a playful one.
- Long-context comprehension is a strength; willing to read broadly
  before answering.

## Workarounds
None required. Opus's main failure mode is cost; reach for Sonnet or
Haiku for mechanical work rather than trying to compensate here.

## When to use
- Deep architectural design and multi-system reasoning.
- Code review where systemic consequences matter.
- Brainstorming that benefits from considered pushback, not reflex.
- Any task where "adaptive reasoning over faithful execution" is the
  value prop.

## When not to use
- Mechanical boilerplate: Sonnet suffices at a fraction of the cost.
- High-volume scripted work: prefer Haiku / Sonnet based on difficulty.
- Any task where speed matters more than depth.
EOF
```

- [ ] **Step 4: Optionally write the stack-version stamp up front**

The server factory will lazy-write it on next boot, but having it present avoids a first-boot write:

```bash
echo '1' > ~/.config/loom/art/LOOM_STACK_VERSION
```

- [ ] **Step 5: Verify files exist**

```bash
ls -la ~/.config/loom/art/harnesses/ ~/.config/loom/art/models/
cat ~/.config/loom/art/LOOM_STACK_VERSION
```

Expected: both manifest files present, stack-version file reads `1`.

(No commit — these files live outside the repo. They will be picked up by Art's next Claude Code session.)

---

## Task 12: README + .env.example + CHANGELOG

**Files:**
- Modify: `README.md`
- Modify: `.env.example`
- Modify: `CHANGELOG.md`

- [ ] **Step 1: Add the `LOOM_MODEL` row to the README config table**

In `README.md`, find the Configuration table (currently five rows starting with `LOOM_CONTEXT_DIR`). Add a row between `LOOM_FASTEMBED_CACHE_DIR` and `LOOM_CLIENT`:

```markdown
| `LOOM_MODEL` | *(unset)* | Model identifier for model-manifest context: `claude-opus`, `gemma4`, etc. |
```

- [ ] **Step 2: Add `LOOM_MODEL` to the MCP config example**

In the Claude Code MCP config example in `README.md`, add the env var alongside the existing ones:

```json
{
  "mcpServers": {
    "loom": {
      "command": "node",
      "args": ["/absolute/path/to/loom/dist/index.js"],
      "env": {
        "LOOM_CONTEXT_DIR": "/absolute/path/to/your/agent/context",
        "LOOM_CLIENT": "claude-code",
        "LOOM_MODEL": "claude-opus"
      }
    }
  }
}
```

- [ ] **Step 3: Update the context directory layout to include the new block types**

In the "Context directory layout" section of `README.md`, replace the existing tree with:

```
$LOOM_CONTEXT_DIR/
├── LOOM_STACK_VERSION      # schema-version stamp (auto-written)
├── IDENTITY.md             # the terminal creed (immutable via tools)
├── preferences.md          # user working style; agent-editable
├── self-model.md           # agent's self-knowledge; agent-editable
├── pursuits.md             # active cross-session goals
├── memories.db             # sqlite-vec store of record
├── projects/               # optional per-project briefs
│   └── <project>.md
├── harnesses/              # optional per-harness manifests
│   └── <client>.md
├── models/                 # optional per-model manifests
│   └── <model>.md
└── procedures/             # optional procedural-identity docs (cap ~10)
    └── <procedure>.md
```

- [ ] **Step 4: Update `.env.example`**

Append to `.env.example`:

```bash

# Optional: model-family identifier for model-manifest context.
# Read from <LOOM_CONTEXT_DIR>/models/<LOOM_MODEL>.md on wake.
# Common values: claude-opus, claude-sonnet, claude-haiku, gemma4
# LOOM_MODEL=claude-opus
```

- [ ] **Step 5: Update `CHANGELOG.md`**

Replace the existing `[Unreleased]` block with:

```markdown
## [Unreleased]

Work toward v0.4 — see [docs/v0.4-architecture.md](docs/v0.4-architecture.md)
for the full arc. This alpha is the first piece.

## [0.4.0-alpha.1] - 2026-04-19

### Added

- Harness manifest block (`harnesses/<client>.md`) — per-harness
  descriptor (tool prefixes, delegation primitive, scheduling,
  session search, gotchas). Loaded by `identity()` when
  `LOOM_CLIENT` resolves. Matches stack spec v1 §4.7.
- Model manifest block (`models/<model>.md`) — per-model-family
  descriptor (capability notes, workarounds, when-to-use /
  when-not-to-use). Loaded by `identity()` when `LOOM_MODEL`
  resolves. Matches stack spec v1 §4.8.
- Procedures block (`procedures/*.md`) — procedural-identity docs
  with a hard cap of ~10 files. Reader ships; populated content
  lands in a later alpha. Matches stack spec v1 §4.9.
- `LOOM_MODEL` environment variable + optional `model` param on the
  `identity` tool.
- `LOOM_STACK_VERSION` file at the context-dir root, auto-stamped
  with `1` on server boot. `createLoomServer` refuses to start
  against a stack version ahead of what this loom understands.
- Missing-manifest nudges: when `LOOM_CLIENT` or `LOOM_MODEL` is set
  but no corresponding manifest exists, `identity()` emits a
  template-filled section telling the agent exactly what to write.
```

Also add at the bottom:

```markdown
[0.4.0-alpha.1]: https://github.com/jbarket/loom/compare/v0.3.1...v0.4.0-alpha.1
```

- [ ] **Step 6: Commit**

```bash
git add README.md .env.example CHANGELOG.md
git commit -m "docs: document LOOM_MODEL, new block types, and CHANGELOG entry

README now shows LOOM_MODEL in the env-var table and MCP config example
and the context-directory layout includes harnesses/, models/, and
procedures/. CHANGELOG [Unreleased] → [0.4.0-alpha.1]."
```

---

## Task 13: Version bump

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Bump the version**

Edit `package.json`:

```json
{
  "name": "loom",
  "version": "0.4.0-alpha.1",
  …
}
```

- [ ] **Step 2: Run the full test suite**

```bash
npx vitest run
```

Expected: all ~174 tests green.

- [ ] **Step 3: Rebuild**

```bash
npm run build
```

Expected: clean build, no TypeScript errors. Output goes to `dist/`.

- [ ] **Step 4: Commit**

```bash
git add package.json
git commit -m "chore: bump version to 0.4.0-alpha.1"
```

---

## Task 14: Verification pass

**Files:** none (runs only)

- [ ] **Step 1: Full suite green from a clean state**

```bash
cd /home/jbarket/Code/loom
npx vitest run
```

Expected: ~174 tests pass, zero failures.

- [ ] **Step 2: MCP smoke test**

```bash
npx tsx scripts/smoke-test-mcp.ts
```

Expected: existing smoke flow passes (remember / recall / list / forget). The smoke script doesn't exercise the new manifest features but must not regress.

- [ ] **Step 3: Manual end-to-end verification**

Document in the PR description that Jonathan should:

1. Update `.mcp.json` for the loom entry to add `"LOOM_MODEL": "claude-opus"` alongside the existing `LOOM_CLIENT`.
2. Restart Claude Code.
3. Call `mcp__loom__identity`.
4. Verify the returned payload contains both:
   - `# Harness: claude-code` with the tool-prefixes / delegation / cron / session-search / gotchas sections from the seed manifest.
   - `# Model: claude-opus` with the capability notes / workarounds / when-to-use sections.
5. Delete `~/.config/loom/art/harnesses/claude-code.md` temporarily, re-run `identity`, confirm the nudge appears with the correct template; then restore the file.

This step is manual because the stdio server's output is consumed by the MCP client; automated E2E would require a stdio client harness we haven't built.

- [ ] **Step 4: Push the branch and open the PR**

```bash
git push -u origin feat/harness-model-manifests
gh pr create --title "v0.4.0-alpha.1: harness + model manifests" --body "$(cat <<'EOF'
## Summary
- First piece of the v0.4 arc (see `docs/v0.4-architecture.md`).
- Adds harness, model, and procedures block readers (`src/blocks/`).
- `identity()` wake sequence now emits `# Harness:`, `# Model:`, and
  `# Procedures` sections, with template-filled nudges when a manifest
  is expected but missing.
- `LOOM_MODEL` env var + `identity({model})` param override.
- `LOOM_STACK_VERSION=1` stamped on server boot; boot refuses unknown versions.
- Seed manifests (claude-code + claude-opus) written to Art's context dir.
- Version 0.3.1 → 0.4.0-alpha.1.

## Spec
Design: `docs/superpowers/specs/2026-04-19-harness-model-manifests-design.md`.
Plan: `docs/superpowers/plans/2026-04-19-harness-model-manifests.md`.

## Test plan
- [ ] `npx vitest run` — ~174 tests green
- [ ] `npx tsx scripts/smoke-test-mcp.ts` — smoke test green
- [ ] Restart Claude Code with `LOOM_MODEL=claude-opus` in `.mcp.json`,
      call `identity()`, verify new sections render
- [ ] Temporarily remove a manifest, confirm nudge renders, restore

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

(Do NOT run the push / gh commands until Jonathan gives the go-ahead; they're listed here so the flow is documented and the PR can be opened the moment the verification pass completes.)

---

## Definition of done

Reproduced here so it's next to the tasks, not just in the spec:

- [ ] Suite green, ~174 tests.
- [ ] `scripts/smoke-test-mcp.ts` green.
- [ ] Claude Code with `LOOM_MODEL=claude-opus` in `.mcp.json` renders `# Harness:` and `# Model:` sections sourced from the seed manifests.
- [ ] `~/.config/loom/art/harnesses/claude-code.md` and `~/.config/loom/art/models/claude-opus.md` exist and match the stack spec §4.7 / §4.8 shape.
- [ ] `LOOM_STACK_VERSION` file stamped `1` in Art's context dir.
- [ ] README documents `LOOM_MODEL` in the env-var table and MCP config example; context-directory layout lists harnesses/, models/, procedures/.
- [ ] CHANGELOG has a `[0.4.0-alpha.1]` entry.
- [ ] `package.json` at `0.4.0-alpha.1`.

---

## Files of record

- Spec: [`docs/specs/2026-04-19-harness-model-manifests-design.md`](../specs/2026-04-19-harness-model-manifests-design.md)
- Umbrella + roadmap: [v0.4 discussion](https://github.com/jbarket/loom/discussions/10)
- Stack schema: [`docs/loom-stack-v1.md`](../loom-stack-v1.md)
- Rebirth letter: [`docs/rebirth-letter-2026-04-19.md`](../rebirth-letter-2026-04-19.md)
