# Install + Setup Skill Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship `loom install` + `loom doctor` CLI primitives plus a bundled `SKILL.md` that drives skill-based first-run onboarding inside the target harness (alpha.6).

**Architecture:** CLI owns what can be tested and versioned (write SKILL.md to a known path, probe environment to JSON). The bundled skill owns what drifts (harness MCP-config paths, restart incantations) by reading live filesystem state inside the harness. Composition is additive: the skill calls existing `loom bootstrap` / `procedures adopt` / `harness init` / `inject` / `wake` primitives, then verifies with `loom wake --json`.

**Tech Stack:** TypeScript strict ESM, Node ≥ 20, vitest 4, `node:util` parseArgs, reuse of `src/cli/tui/multi-select.ts`. Branch `feat/install-setup-skill`. Target version `0.4.0-alpha.6`.

**Spec:** `docs/specs/2026-04-21-install-setup-skill-design.md`.

---

## Task 1: Single-select mode on multi-select TUI

Precondition for `loom install`'s harness picker. Add a `single: boolean` option to the existing reducer without breaking existing multi-select consumers.

**Files:**
- Modify: `src/cli/tui/multi-select.ts`
- Modify: `src/cli/tui/multi-select.test.ts`

- [ ] **Step 1: Write failing test for single-select toggle replacing selection**

Append to `src/cli/tui/multi-select.test.ts`:

```typescript
describe('reduce (single-select mode)', () => {
  const items = [
    { value: 'a', label: 'A' },
    { value: 'b', label: 'B' },
    { value: 'c', label: 'C' },
  ] as const;

  it('replaces prior selection on toggle when single=true', () => {
    const s0 = initialState(items);
    const s1 = reduce(s0, { kind: 'toggle' }, items, { single: true });
    expect(s1.status).toBe('running');
    if (s1.status !== 'running') throw new Error('unreachable');
    expect([...s1.state.selected]).toEqual(['a']);

    const s2 = reduce(s1.state, { kind: 'down' }, items, { single: true });
    if (s2.status !== 'running') throw new Error('unreachable');
    const s3 = reduce(s2.state, { kind: 'toggle' }, items, { single: true });
    if (s3.status !== 'running') throw new Error('unreachable');
    expect([...s3.state.selected]).toEqual(['b']);
  });

  it('deselects on toggle of already-selected item in single mode', () => {
    const s0 = initialState(items);
    const s1 = reduce(s0, { kind: 'toggle' }, items, { single: true });
    if (s1.status !== 'running') throw new Error('unreachable');
    const s2 = reduce(s1.state, { kind: 'toggle' }, items, { single: true });
    if (s2.status !== 'running') throw new Error('unreachable');
    expect([...s2.state.selected]).toEqual([]);
  });

  it('multi-select default unchanged when opts omitted', () => {
    const s0 = initialState(items);
    const s1 = reduce(s0, { kind: 'toggle' }, items);
    if (s1.status !== 'running') throw new Error('unreachable');
    const s2 = reduce(s1.state, { kind: 'down' }, items);
    if (s2.status !== 'running') throw new Error('unreachable');
    const s3 = reduce(s2.state, { kind: 'toggle' }, items);
    if (s3.status !== 'running') throw new Error('unreachable');
    expect([...s3.state.selected].sort()).toEqual(['a', 'b']);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/cli/tui/multi-select.test.ts`
Expected: FAIL on the new single-select block (signature mismatch; reducer takes 3 args).

- [ ] **Step 3: Add ReduceOpts and plumb single through reducer**

Edit `src/cli/tui/multi-select.ts`. Replace the existing reducer signature and toggle case:

```typescript
export interface ReduceOpts {
  single?: boolean;
}

export function reduce<T>(
  state: MultiSelectState<T>,
  event: MultiSelectEvent,
  items: ReadonlyArray<MultiSelectItem<T>>,
  opts: ReduceOpts = {},
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
      const has = state.selected.has(v);
      let next: Set<T>;
      if (opts.single) {
        next = has ? new Set() : new Set([v]);
      } else {
        next = new Set(state.selected);
        if (has) next.delete(v);
        else next.add(v);
      }
      return { status: 'running', state: { cursor: state.cursor, selected: next } };
    }
    case 'confirm':
      return { status: 'confirmed', selected: new Set(state.selected) };
    case 'cancel':
      return { status: 'cancelled' };
  }
}
```

- [ ] **Step 4: Plumb single through the multiSelect adapter**

Add `single?: boolean` to `MultiSelectOpts<T>`:

```typescript
export interface MultiSelectOpts<T> {
  title: string;
  items: ReadonlyArray<MultiSelectItem<T>>;
  initialSelected?: ReadonlySet<T>;
  single?: boolean;
}
```

In the adapter, change the reducer call to:

```typescript
const result = reduce(state, event, opts.items, { single: opts.single });
```

Update the footer in `renderFrame`. Replace the trailing write line:

```typescript
const hint = opts.single
  ? '\n  ↑/↓ move    space select    enter confirm    esc/q cancel\n'
  : '\n  ↑/↓ move    space toggle    enter confirm    esc/q cancel\n';
write(hint);
```

- [ ] **Step 5: Run tests to verify pass**

Run: `npx vitest run src/cli/tui/multi-select.test.ts`
Expected: PASS on all tests, including prior multi-select coverage.

- [ ] **Step 6: Commit**

```bash
git add src/cli/tui/multi-select.ts src/cli/tui/multi-select.test.ts
git commit -s -m "feat(tui): single-select mode on multi-select primitive"
```

---

## Task 2: Agent-name validation module

One module, one regex, one reserved-names list. Used by `loom doctor`, `loom bootstrap`, and (by the skill) during interview.

**Files:**
- Create: `src/install/names.ts`
- Create: `src/install/names.test.ts`

- [ ] **Step 1: Write failing tests**

Create `src/install/names.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { validateAgentName, RESERVED_AGENT_NAMES } from './names.js';

describe('validateAgentName', () => {
  it('accepts lowercase alphanumeric with hyphens', () => {
    expect(validateAgentName('art')).toEqual({ ok: true });
    expect(validateAgentName('alex-v2')).toEqual({ ok: true });
    expect(validateAgentName('a')).toEqual({ ok: true });
    expect(validateAgentName('agent-2026-04')).toEqual({ ok: true });
  });

  it('rejects empty name', () => {
    expect(validateAgentName('')).toEqual({ ok: false, reason: 'Name is empty.' });
  });

  it('rejects uppercase letters', () => {
    const r = validateAgentName('Art');
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toMatch(/lowercase/);
  });

  it('rejects underscores and spaces', () => {
    expect(validateAgentName('my_agent').ok).toBe(false);
    expect(validateAgentName('my agent').ok).toBe(false);
    expect(validateAgentName('my.agent').ok).toBe(false);
  });

  it('rejects leading hyphen', () => {
    expect(validateAgentName('-art').ok).toBe(false);
  });

  it('rejects names longer than 64 characters', () => {
    const long = 'a'.repeat(65);
    const r = validateAgentName(long);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toMatch(/64/);
  });

  it('rejects reserved names', () => {
    for (const reserved of RESERVED_AGENT_NAMES) {
      const r = validateAgentName(reserved);
      expect(r.ok, `expected ${reserved} to be rejected`).toBe(false);
      if (r.ok) continue;
      expect(r.reason).toMatch(/reserved/);
    }
  });

  it('reserved list contains the documented slots', () => {
    expect([...RESERVED_AGENT_NAMES].sort()).toEqual(
      ['backups', 'cache', 'config', 'current', 'default', 'shared', 'tmp'],
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/install/names.test.ts`
Expected: FAIL on missing module.

- [ ] **Step 3: Implement the module**

Create `src/install/names.ts`:

```typescript
/**
 * Canonical agent-name validation. Used by `loom doctor`, `loom
 * bootstrap` (tightening pending), and the install skill's interview.
 * Reserved names anticipate the alpha.7+ `agents switch` pointer slot
 * plus snapshot/export storage adjacent to agent dirs.
 *
 * See stack spec v1 §13 (Multi-agent layout).
 */

export const RESERVED_AGENT_NAMES: ReadonlySet<string> = new Set([
  'current',
  'default',
  'config',
  'backups',
  'cache',
  'tmp',
  'shared',
]);

const NAME_RE = /^[a-z0-9][a-z0-9-]*$/;
const MAX_LEN = 64;

export type NameCheck = { ok: true } | { ok: false; reason: string };

export function validateAgentName(name: string): NameCheck {
  if (name.length === 0) return { ok: false, reason: 'Name is empty.' };
  if (name.length > MAX_LEN) {
    return { ok: false, reason: `Name is longer than ${MAX_LEN} characters.` };
  }
  if (!NAME_RE.test(name)) {
    return {
      ok: false,
      reason: 'Name must be lowercase alphanumeric plus hyphens, starting with a letter or digit.',
    };
  }
  if (RESERVED_AGENT_NAMES.has(name)) {
    return { ok: false, reason: `"${name}" is reserved.` };
  }
  return { ok: true };
}
```

- [ ] **Step 4: Run tests to verify pass**

Run: `npx vitest run src/install/names.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/install/names.ts src/install/names.test.ts
git commit -s -m "feat(install): agent-name validation + reserved names"
```

---

## Task 3: Install harness registry

Registry of the four supported install targets plus "other". Separate from `src/injection/harnesses.ts` (which is about dotfile injection paths, not skill install paths).

**Files:**
- Create: `src/install/harnesses.ts`
- Create: `src/install/harnesses.test.ts`

- [ ] **Step 1: Write failing tests**

Create `src/install/harnesses.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import {
  INSTALL_TARGETS,
  INSTALL_TARGET_KEYS,
  isInstallTargetKey,
  resolveSkillPath,
  getInstallTarget,
} from './harnesses.js';

describe('INSTALL_TARGETS', () => {
  it('exposes 5 canonical keys in order', () => {
    expect(INSTALL_TARGET_KEYS).toEqual([
      'claude-code',
      'codex',
      'gemini-cli',
      'opencode',
      'other',
    ]);
  });

  it('claude-code lives under ~/.claude/skills', () => {
    const t = getInstallTarget('claude-code');
    expect(t.toolPrefix).toBe('mcp__loom__');
    expect(resolveSkillPath(t, '/home/u')).toBe('/home/u/.claude/skills/loom-setup.md');
  });

  it('codex lives under ~/.agents/skills', () => {
    const t = getInstallTarget('codex');
    expect(t.toolPrefix).toBe('mcp_loom_');
    expect(resolveSkillPath(t, '/home/u')).toBe('/home/u/.agents/skills/loom-setup.md');
  });

  it('gemini-cli shares ~/.agents/skills with codex', () => {
    const t = getInstallTarget('gemini-cli');
    expect(resolveSkillPath(t, '/home/u')).toBe('/home/u/.agents/skills/loom-setup.md');
  });

  it('opencode uses loom_ prefix under ~/.agents/skills', () => {
    const t = getInstallTarget('opencode');
    expect(t.toolPrefix).toBe('loom_');
    expect(resolveSkillPath(t, '/home/u')).toBe('/home/u/.agents/skills/loom-setup.md');
  });

  it('other target has null skillDir', () => {
    const t = getInstallTarget('other');
    expect(t.skillDir).toBeNull();
    expect(resolveSkillPath(t, '/home/u')).toBeNull();
  });

  it('isInstallTargetKey narrows correctly', () => {
    expect(isInstallTargetKey('claude-code')).toBe(true);
    expect(isInstallTargetKey('nope')).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/install/harnesses.test.ts`
Expected: FAIL on missing module.

- [ ] **Step 3: Implement the module**

Create `src/install/harnesses.ts`:

```typescript
/**
 * Registry of install targets for `loom install`. Separate from
 * `src/injection/harnesses.ts` (dotfile injection paths) because the
 * skill-install convention differs per vendor: Claude Code uses
 * `~/.claude/skills/`, other harnesses converge on `~/.agents/skills/`.
 *
 * See stack spec v1 §11 (Adapters) and the alpha.6 design doc.
 */
import { homedir } from 'node:os';
import { join } from 'node:path';

export type InstallTargetKey =
  | 'claude-code'
  | 'codex'
  | 'gemini-cli'
  | 'opencode'
  | 'other';

export type ToolPrefix = 'mcp__loom__' | 'mcp_loom_' | 'loom_';

export interface InstallTarget {
  readonly key: InstallTargetKey;
  readonly label: string;
  /** Canonical skill directory. `null` for `other` (caller picks a path). */
  readonly skillDir: string | null;
  /** Hint for the skill prose — where this harness's MCP config lives. */
  readonly mcpConfigHint: string | null;
  /** How the user invokes the skill inside the harness. */
  readonly invoke: string;
  /** Short human-readable restart instruction. */
  readonly restart: string;
  readonly toolPrefix: ToolPrefix;
}

export const SKILL_FILENAME = 'loom-setup.md';

const HOME = homedir();

export const INSTALL_TARGETS: Readonly<Record<InstallTargetKey, InstallTarget>> = {
  'claude-code': {
    key: 'claude-code',
    label: 'Claude Code',
    skillDir: join(HOME, '.claude', 'skills'),
    mcpConfigHint: '~/.claude.json or .mcp.json in the project root',
    invoke: '/loom-setup',
    restart: 'restart Claude Code (close and reopen)',
    toolPrefix: 'mcp__loom__',
  },
  'codex': {
    key: 'codex',
    label: 'Codex',
    skillDir: join(HOME, '.agents', 'skills'),
    mcpConfigHint: '~/.codex/config.toml',
    invoke: 'use the loom-setup skill',
    restart: 'restart the Codex session',
    toolPrefix: 'mcp_loom_',
  },
  'gemini-cli': {
    key: 'gemini-cli',
    label: 'Gemini CLI',
    skillDir: join(HOME, '.agents', 'skills'),
    mcpConfigHint: '~/.gemini/settings.json',
    invoke: 'use the loom-setup skill',
    restart: 'exit and restart Gemini CLI',
    toolPrefix: 'mcp_loom_',
  },
  'opencode': {
    key: 'opencode',
    label: 'OpenCode',
    skillDir: join(HOME, '.agents', 'skills'),
    mcpConfigHint: '~/.config/opencode/config.json',
    invoke: 'use the loom-setup skill',
    restart: 'restart OpenCode',
    toolPrefix: 'loom_',
  },
  'other': {
    key: 'other',
    label: 'Other (dump skill file to cwd)',
    skillDir: null,
    mcpConfigHint: null,
    invoke: 'tell your agent to read loom-setup.md and follow it',
    restart: 'restart your harness after it finishes setup',
    toolPrefix: 'mcp_loom_',
  },
};

export const INSTALL_TARGET_KEYS: readonly InstallTargetKey[] = [
  'claude-code',
  'codex',
  'gemini-cli',
  'opencode',
  'other',
];

export function isInstallTargetKey(s: string): s is InstallTargetKey {
  return (INSTALL_TARGET_KEYS as readonly string[]).includes(s);
}

export function getInstallTarget(key: InstallTargetKey): InstallTarget {
  return INSTALL_TARGETS[key];
}

/**
 * Resolve the skill file path for a target. Returns `null` for `other`
 * (caller handles the dump-to-cwd branch). `home` overrides `homedir()`
 * for tests.
 */
export function resolveSkillPath(t: InstallTarget, home?: string): string | null {
  if (t.skillDir === null) return null;
  if (home === undefined) return join(t.skillDir, SKILL_FILENAME);
  switch (t.key) {
    case 'claude-code': return join(home, '.claude', 'skills', SKILL_FILENAME);
    case 'codex':
    case 'gemini-cli':
    case 'opencode':    return join(home, '.agents', 'skills', SKILL_FILENAME);
    case 'other':       return null;
  }
}
```

- [ ] **Step 4: Run tests to verify pass**

Run: `npx vitest run src/install/harnesses.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/install/harnesses.ts src/install/harnesses.test.ts
git commit -s -m "feat(install): install-target registry"
```

---
## Task 4: Bundled SKILL.md asset + source resolver

Ship a real markdown file at `assets/skill/SKILL.md`. The resolver locates it at runtime from both `src/` (dev via tsx) and `dist/` (published).

**Files:**
- Create: `assets/skill/SKILL.md`
- Create: `src/install/skill-source.ts`
- Create: `src/install/skill-source.test.ts`

- [ ] **Step 1: Write the skill file**

Create `assets/skill/SKILL.md`:

````markdown
---
name: loom-setup
description: Set up loom (persistent identity + memory) for this agent
---

# loom-setup

You are installing and configuring loom — a persistent identity +
memory layer — for the user in the harness you're running in right
now. loom is already installed as a CLI (`loom` or `npx loom`). Your
job is to drive the first-run flow, with the user's consent, without
clobbering anything that already exists.

## Ground rules

- **Existing agent dirs are inviolable.** If `~/.config/loom/<name>/`
  has an `IDENTITY.md`, it belongs to a prior agent. Never overwrite
  it. Never propose `--force`. If the user wants to replace an agent,
  they remove the directory themselves.
- **Verify, don't assume.** Read harness config files before writing
  to them. Re-read after writing. Finish with `loom wake --json`.
- **When you can do it, do it.** Don't ask the user to edit JSON by
  hand if you can edit the file yourself. Don't print a config
  snippet as advice when you can write it.

## Step 1 — Probe the environment

Run: `loom doctor --json`

Parse the output. You'll see:

- `stackVersionOk`, `nodeOk`, `contextDirResolved`
- `existingAgents: [{ name, path, hasIdentity, hasMemoriesDb,
  hasProcedures, git: { initialized, hasRemote, dirty,
  gitignorePresent } }, ...]`

If `stackVersionOk` is false or `nodeOk` is false, stop and tell the
user what's wrong.

## Step 2 — Decide: new agent or use existing

If `existingAgents` is non-empty, summarize them to the user:

> I see these agents already set up:
> - `art` at `~/.config/loom/art/` (has identity, 3 procedures)
>
> Do you want to (a) use an existing one, (b) create a new one with a
> different name, or (c) stop?

- If they pick (a): set `LOOM_CONTEXT_DIR=<path>` and skip to Step 5
  (you're just wiring this harness to an existing agent).
- If they pick (b): continue to Step 3 with a new name.
- If they pick (c): exit.

If `existingAgents` is empty, tell the user that and continue to
Step 3.

## Step 3 — Interview

Ask, one question at a time:

1. Agent name — must be lowercase alphanumeric + hyphens, 1–64 chars,
   not a reserved word (`current`, `default`, `config`, `backups`,
   `cache`, `tmp`, `shared`). Re-ask on any collision with an existing
   dir.
2. One-line purpose (what is this agent for).
3. Short voice descriptor (how does it communicate).

The context dir will be `~/.config/loom/<name>/` unless the user
overrides.

## Step 4 — Bootstrap

Run:

```
echo '{"name":"<NAME>","purpose":"<PURPOSE>","voice":"<VOICE>"}' \
  | loom bootstrap --context-dir ~/.config/loom/<NAME>
```

Then adopt the default procedural-identity seeds:

```
loom procedures adopt --all --context-dir ~/.config/loom/<NAME>
```

Then scaffold the harness manifest for this harness:

```
loom harness init <HARNESS_KEY> --context-dir ~/.config/loom/<NAME>
```

Where `<HARNESS_KEY>` is one of `claude-code`, `codex`, `gemini-cli`,
`opencode`.

## Step 5 — Wire the harness's MCP config

This is the part only you can do safely, because the file path and
schema drift per vendor. Read the relevant config file for this
harness before writing anything.

Targets (Linux/macOS):

| harness     | config file                            | env vars to set            |
|-------------|----------------------------------------|----------------------------|
| claude-code | `~/.claude.json` or `.mcp.json` in cwd | `LOOM_CONTEXT_DIR`, `LOOM_CLIENT=claude-code`, `LOOM_MODEL` |
| codex       | `~/.codex/config.toml`                 | same + `LOOM_CLIENT=codex` |
| gemini-cli  | `~/.gemini/settings.json`              | same + `LOOM_CLIENT=gemini-cli` |
| opencode    | `~/.config/opencode/config.json`       | same + `LOOM_CLIENT=opencode` |

Procedure:

1. Read the current config file.
2. Look for an existing `loom` entry under `mcpServers` (JSON) or
   `[mcp_servers.loom]` (TOML). If one exists and points to the right
   context dir, skip this step.
3. If absent, add an entry that runs `loom serve` with the env vars
   above. Use `loom` as the command (or `npx loom` if `loom` isn't on
   PATH).
4. Re-read the file to verify your edit took.

If the file format confuses you, stop and ask the user rather than
guess.

## Step 6 — Inject identity pointer into the harness dotfile

Run:

```
loom inject --harness <HARNESS_KEY> --context-dir ~/.config/loom/<NAME>
```

This writes a marker-bounded block into the harness's CLAUDE.md /
AGENTS.md / GEMINI.md telling the agent to call the `identity` tool
on session start.

## Step 7 — Verify

Run: `loom wake --json --context-dir ~/.config/loom/<NAME>`

- If it returns a payload with the right name: success. Tell the user
  to **restart their harness** (close and reopen, or exit and
  restart) so the new MCP server picks up the config edit. Remind
  them that once they reopen, calling `identity` will wake them as
  `<NAME>`.
- If it errors: diagnose from the output and loop back to the failing
  step.

## What you are *not* doing

- Editing IDENTITY.md or preferences.md content yourself. The
  bootstrap + procedures seeds leave sensible templates; the agent
  edits them after first wake.
- Writing any file under `~/.config/loom/<name>/` other than what the
  `loom` CLI puts there.
- Running `bootstrap --force`, ever.
- Touching another existing agent's dir.
````

- [ ] **Step 2: Write failing test for skill-source resolver**

Create `src/install/skill-source.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import { resolveSkillSourcePath } from './skill-source.js';

describe('resolveSkillSourcePath', () => {
  it('returns a path that exists and has the expected frontmatter', async () => {
    const p = resolveSkillSourcePath();
    const body = await readFile(p, 'utf-8');
    expect(body.startsWith('---\n')).toBe(true);
    expect(body).toMatch(/^name:\s*loom-setup$/m);
    expect(body).toMatch(/^description:/m);
  });

  it('returns an absolute path', () => {
    const p = resolveSkillSourcePath();
    expect(p.startsWith('/')).toBe(true);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run src/install/skill-source.test.ts`
Expected: FAIL on missing module.

- [ ] **Step 4: Implement the resolver**

Create `src/install/skill-source.ts`:

```typescript
/**
 * Resolve the bundled SKILL.md path. Works from both `src/` (dev via
 * tsx) and `dist/` (published via `npx loom`) because
 * `resolveRepoRoot()` walks one level up from the running module and
 * both `src/` and `dist/` sit alongside `assets/` at the project root.
 */
import { join } from 'node:path';
import { resolveRepoRoot } from '../config.js';

export function resolveSkillSourcePath(): string {
  return join(resolveRepoRoot(), 'assets', 'skill', 'SKILL.md');
}
```

- [ ] **Step 5: Run test to verify pass**

Run: `npx vitest run src/install/skill-source.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add assets/skill/SKILL.md src/install/skill-source.ts src/install/skill-source.test.ts
git commit -s -m "feat(install): bundled loom-setup skill + source resolver"
```

---

## Task 5: Render module — write skill file idempotently

Given a destination path, copy SKILL.md with `created | skipped-exists | overwritten` accounting.

**Files:**
- Create: `src/install/render.ts`
- Create: `src/install/render.test.ts`

- [ ] **Step 1: Write failing tests**

Create `src/install/render.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeSkill } from './render.js';

describe('writeSkill', () => {
  let work: string;
  beforeEach(async () => { work = await mkdtemp(join(tmpdir(), 'loom-install-')); });
  afterEach(async () => { await rm(work, { recursive: true, force: true }); });

  it('creates destination + parent dir when missing', async () => {
    const dest = join(work, 'nested', 'skills', 'loom-setup.md');
    const res = await writeSkill(dest);
    expect(res.action).toBe('created');
    expect(res.path).toBe(dest);
    const body = await readFile(dest, 'utf-8');
    expect(body).toMatch(/name:\s*loom-setup/);
    await expect(stat(dest)).resolves.toBeTruthy();
  });

  it('skips when destination exists and content matches', async () => {
    const dest = join(work, 'loom-setup.md');
    const first = await writeSkill(dest);
    expect(first.action).toBe('created');
    const second = await writeSkill(dest);
    expect(second.action).toBe('skipped-exists');
  });

  it('skips when destination exists with different content unless force=true', async () => {
    const dest = join(work, 'loom-setup.md');
    await writeFile(dest, 'pre-existing content\n', 'utf-8');
    const res = await writeSkill(dest);
    expect(res.action).toBe('skipped-exists');
    const body = await readFile(dest, 'utf-8');
    expect(body).toBe('pre-existing content\n');
  });

  it('overwrites when force=true', async () => {
    const dest = join(work, 'loom-setup.md');
    await writeFile(dest, 'pre-existing\n', 'utf-8');
    const res = await writeSkill(dest, { force: true });
    expect(res.action).toBe('overwritten');
    const body = await readFile(dest, 'utf-8');
    expect(body).toMatch(/name:\s*loom-setup/);
  });

  it('dryRun does not write but reports the action it would take', async () => {
    const dest = join(work, 'loom-setup.md');
    const res = await writeSkill(dest, { dryRun: true });
    expect(res.action).toBe('created');
    await expect(stat(dest)).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/install/render.test.ts`
Expected: FAIL on missing module.

- [ ] **Step 3: Implement the module**

Create `src/install/render.ts`:

```typescript
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { resolveSkillSourcePath } from './skill-source.js';

export type WriteAction = 'created' | 'skipped-exists' | 'overwritten';

export interface WriteSkillResult {
  path: string;
  action: WriteAction;
}

export interface WriteSkillOpts {
  force?: boolean;
  dryRun?: boolean;
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await readFile(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Write the bundled SKILL.md to `dest`. Idempotent: when the
 * destination already has matching content, returns `skipped-exists`.
 * When content differs, returns `skipped-exists` unless `force: true`
 * (then `overwritten`). `dryRun: true` short-circuits all writes but
 * still reports the action that would have been taken.
 */
export async function writeSkill(
  dest: string,
  opts: WriteSkillOpts = {},
): Promise<WriteSkillResult> {
  const source = await readFile(resolveSkillSourcePath(), 'utf-8');
  const exists = await pathExists(dest);

  if (!exists) {
    if (!opts.dryRun) {
      await mkdir(dirname(dest), { recursive: true });
      await writeFile(dest, source, 'utf-8');
    }
    return { path: dest, action: 'created' };
  }

  const current = await readFile(dest, 'utf-8');
  if (current === source) {
    return { path: dest, action: 'skipped-exists' };
  }
  if (!opts.force) {
    return { path: dest, action: 'skipped-exists' };
  }
  if (!opts.dryRun) {
    await writeFile(dest, source, 'utf-8');
  }
  return { path: dest, action: 'overwritten' };
}
```

- [ ] **Step 4: Run tests to verify pass**

Run: `npx vitest run src/install/render.test.ts`
Expected: PASS on all 5 tests.

- [ ] **Step 5: Commit**

```bash
git add src/install/render.ts src/install/render.test.ts
git commit -s -m "feat(install): idempotent SKILL.md writer"
```

---

## Task 6: `loom install` CLI command

Tie Tasks 1–5 together. Single-select TUI on TTY, flag-driven otherwise, `--json` for scripting, `other` branch dumps to `./loom-setup-skill.md` in cwd.

**Files:**
- Create: `src/cli/install.ts`
- Create: `src/cli/install.test.ts`

- [ ] **Step 1: Write failing tests**

Create `src/cli/install.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { run } from './install.js';
import type { IOStreams } from './io.js';

function mkIo(env: Record<string, string>, overrides: Partial<IOStreams> = {}): {
  io: IOStreams;
  out: string[];
  err: string[];
} {
  const out: string[] = [];
  const err: string[] = [];
  const io: IOStreams = {
    stdin: process.stdin,
    stdinIsTTY: false,
    stdout: (s) => { out.push(s); },
    stderr: (s) => { err.push(s); },
    env,
    ...overrides,
  };
  return { io, out, err };
}

describe('loom install', () => {
  let work: string;
  beforeEach(async () => { work = await mkdtemp(join(tmpdir(), 'loom-install-cli-')); });
  afterEach(async () => { await rm(work, { recursive: true, force: true }); });

  it('--harness claude-code --to <path> writes and reports', async () => {
    const dest = join(work, 'loom-setup.md');
    const { io, out } = mkIo({});
    const code = await run(['--harness', 'claude-code', '--to', dest], io);
    expect(code).toBe(0);
    await expect(stat(dest)).resolves.toBeTruthy();
    expect(out.join('')).toMatch(/Claude Code/);
    expect(out.join('')).toMatch(/\/loom-setup/);
  });

  it('--json emits structured result and suppresses prose', async () => {
    const dest = join(work, 'loom-setup.md');
    const { io, out } = mkIo({});
    const code = await run(
      ['--harness', 'codex', '--to', dest, '--json'],
      io,
    );
    expect(code).toBe(0);
    const parsed = JSON.parse(out.join(''));
    expect(parsed.target).toBe('codex');
    expect(parsed.path).toBe(dest);
    expect(parsed.action).toBe('created');
    expect(out.join('')).not.toMatch(/restart/i);
  });

  it('--dry-run does not write', async () => {
    const dest = join(work, 'loom-setup.md');
    const { io } = mkIo({});
    const code = await run(
      ['--harness', 'claude-code', '--to', dest, '--dry-run', '--json'],
      io,
    );
    expect(code).toBe(0);
    await expect(stat(dest)).rejects.toThrow();
  });

  it('other target writes to ./loom-setup-skill.md in cwd when no --to', async () => {
    const dest = join(work, 'loom-setup-skill.md');
    const prevCwd = process.cwd();
    process.chdir(work);
    try {
      const { io, out } = mkIo({});
      const code = await run(['--harness', 'other', '--json'], io);
      expect(code).toBe(0);
      const parsed = JSON.parse(out.join(''));
      expect(parsed.target).toBe('other');
      expect(parsed.path).toBe(dest);
      const body = await readFile(dest, 'utf-8');
      expect(body).toMatch(/name:\s*loom-setup/);
    } finally {
      process.chdir(prevCwd);
    }
  });

  it('errors on non-TTY with no --harness', async () => {
    const { io, err } = mkIo({});
    const code = await run([], io);
    expect(code).toBe(2);
    expect(err.join('')).toMatch(/--harness|TTY/i);
  });

  it('errors on unknown harness', async () => {
    const { io, err } = mkIo({});
    const code = await run(['--harness', 'bogus'], io);
    expect(code).toBe(2);
    expect(err.join('')).toMatch(/bogus/);
  });

  it('--to without --harness on non-TTY still errors', async () => {
    const { io, err } = mkIo({});
    const code = await run(['--to', '/tmp/x.md'], io);
    expect(code).toBe(2);
    expect(err.join('')).toMatch(/--harness|TTY/i);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/cli/install.test.ts`
Expected: FAIL on missing module.

- [ ] **Step 3: Implement the CLI**

Create `src/cli/install.ts`:

```typescript
/**
 * loom install — write the bundled SKILL.md into a target harness's
 * skills directory. Flag-driven for scripting; single-select TUI on a
 * TTY when no --harness is given. See stack spec v1 §11 (Adapters).
 */
import { parseArgs } from 'node:util';
import { resolve as pathResolve } from 'node:path';
import { extractGlobalFlags } from './args.js';
import type { IOStreams } from './io.js';
import { renderJson } from './io.js';
import {
  INSTALL_TARGETS,
  INSTALL_TARGET_KEYS,
  isInstallTargetKey,
  resolveSkillPath,
  type InstallTargetKey,
} from '../install/harnesses.js';
import { writeSkill, type WriteAction } from '../install/render.js';
import { multiSelect } from './tui/multi-select.js';

const USAGE = `Usage: loom install [options]

Writes the loom-setup skill into a target harness's skills directory.
On a TTY with no --harness flag, runs a single-select picker.

Options:
  --harness <key>        One of: ${INSTALL_TARGET_KEYS.join(', ')}
  --to <path>            Override destination path (requires --harness)
  --force                Overwrite an existing skill file
  --dry-run              Report action without writing
  --json                 Emit { target, path, action } and suppress prose
  --help, -h             Show this help

The "other" target writes ./loom-setup-skill.md in the current directory
unless --to overrides.
`;

async function pickHarnessInteractive(_io: IOStreams): Promise<InstallTargetKey | null> {
  const items = INSTALL_TARGET_KEYS.map((k) => ({
    value: k,
    label: INSTALL_TARGETS[k].label,
    detail: INSTALL_TARGETS[k].skillDir ?? '(writes to current directory)',
  }));
  const picked = await multiSelect({
    title: 'Install loom-setup skill into which harness?',
    items,
    single: true,
  });
  if (!picked) return null;
  const arr = [...picked];
  if (arr.length === 0) return null;
  return arr[0];
}

export async function run(argv: string[], io: IOStreams): Promise<number> {
  const { flags: global, rest } = extractGlobalFlags(argv);

  let parsed;
  try {
    parsed = parseArgs({
      args: rest,
      options: {
        harness: { type: 'string' },
        to:      { type: 'string' },
        force:   { type: 'boolean' },
        'dry-run': { type: 'boolean' },
        json:    { type: 'boolean' },
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

  const force  = Boolean(parsed.values.force);
  const dryRun = Boolean(parsed.values['dry-run']);
  const json   = Boolean(parsed.values.json) || Boolean(global.json);

  let key: InstallTargetKey;
  if (parsed.values.harness !== undefined) {
    if (!isInstallTargetKey(parsed.values.harness)) {
      io.stderr(`Unknown harness: ${parsed.values.harness}. Choose one of: ${INSTALL_TARGET_KEYS.join(', ')}.\n`);
      return 2;
    }
    key = parsed.values.harness;
  } else if (io.stdinIsTTY) {
    const picked = await pickHarnessInteractive(io);
    if (!picked) { io.stderr('Cancelled.\n'); return 1; }
    key = picked;
  } else {
    io.stderr(`--harness is required when stdin is not a TTY.\n${USAGE}`);
    return 2;
  }

  const target = INSTALL_TARGETS[key];

  let dest: string;
  if (parsed.values.to !== undefined) {
    dest = pathResolve(parsed.values.to);
  } else if (key === 'other') {
    dest = pathResolve(process.cwd(), 'loom-setup-skill.md');
  } else {
    const p = resolveSkillPath(target);
    if (p === null) {
      io.stderr(`Internal error: target ${key} has no skillDir and --to was not provided.\n`);
      return 2;
    }
    dest = p;
  }

  const res = await writeSkill(dest, { force, dryRun });

  if (json) {
    renderJson(io, { target: key, path: res.path, action: res.action });
    return 0;
  }

  const verb = actionVerb(res.action);
  const lines = [
    `${verb} ${res.path}`,
    '',
    `Next: open ${target.label}. ${firstLetterUpper(target.invoke)}.`,
    `After the skill finishes, ${target.restart}.`,
  ];
  io.stdout(lines.join('\n') + '\n');
  return 0;
}

function actionVerb(a: WriteAction): string {
  switch (a) {
    case 'created':         return 'Wrote';
    case 'skipped-exists':  return 'Already up to date at';
    case 'overwritten':     return 'Overwrote';
  }
}

function firstLetterUpper(s: string): string {
  return s.length === 0 ? s : s[0].toUpperCase() + s.slice(1);
}
```

- [ ] **Step 4: Run tests to verify pass**

Run: `npx vitest run src/cli/install.test.ts`
Expected: PASS on all 7 tests.

- [ ] **Step 5: Commit**

```bash
git add src/cli/install.ts src/cli/install.test.ts
git commit -s -m "feat(cli): loom install — write SKILL.md to harness skills dir"
```

---
## Task 7: `loom doctor` CLI command

Pure read-only probe. Outputs JSON when `--json` is passed; otherwise a short human summary. Exit code 0 regardless of findings.

**Files:**
- Create: `src/cli/doctor.ts`
- Create: `src/cli/doctor.test.ts`

- [ ] **Step 1: Write failing tests**

Create `src/cli/doctor.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { run } from './doctor.js';
import type { IOStreams } from './io.js';

function mkIo(env: Record<string, string>): { io: IOStreams; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  const io: IOStreams = {
    stdin: process.stdin,
    stdinIsTTY: false,
    stdout: (s) => { out.push(s); },
    stderr: (s) => { err.push(s); },
    env,
  };
  return { io, out, err };
}

describe('loom doctor', () => {
  let work: string;
  beforeEach(async () => { work = await mkdtemp(join(tmpdir(), 'loom-doctor-')); });
  afterEach(async () => { await rm(work, { recursive: true, force: true }); });

  it('reports empty existingAgents in a fresh HOME', async () => {
    const { io, out } = mkIo({ HOME: work });
    const code = await run(['--json'], io);
    expect(code).toBe(0);
    const parsed = JSON.parse(out.join(''));
    expect(parsed.existingAgents).toEqual([]);
    expect(typeof parsed.nodeOk).toBe('boolean');
    expect(parsed.nodeOk).toBe(true);
    expect(parsed.stackVersionOk).toBe(true);
  });

  it('discovers agents under ~/.config/loom/*', async () => {
    const artDir = join(work, '.config', 'loom', 'art');
    await mkdir(join(artDir, 'procedures'), { recursive: true });
    await writeFile(join(artDir, 'IDENTITY.md'), '# Art\n', 'utf-8');
    await writeFile(join(artDir, 'procedures', 'cold-testing.md'), '# x\n', 'utf-8');

    const { io, out } = mkIo({ HOME: work });
    const code = await run(['--json'], io);
    expect(code).toBe(0);
    const parsed = JSON.parse(out.join(''));
    expect(parsed.existingAgents).toHaveLength(1);
    const [art] = parsed.existingAgents;
    expect(art.name).toBe('art');
    expect(art.hasIdentity).toBe(true);
    expect(art.hasMemoriesDb).toBe(false);
    expect(art.hasProcedures).toBe(true);
    expect(art.git.initialized).toBe(false);
    expect(art.git.hasRemote).toBe(false);
    expect(art.git.dirty).toBe(false);
    expect(art.git.gitignorePresent).toBe(false);
  });

  it('reports git.initialized=true when a .git dir is present', async () => {
    const artDir = join(work, '.config', 'loom', 'art');
    await mkdir(join(artDir, '.git'), { recursive: true });
    await writeFile(join(artDir, 'IDENTITY.md'), '# Art\n', 'utf-8');
    await writeFile(join(artDir, '.gitignore'), 'memories.db\n', 'utf-8');

    const { io, out } = mkIo({ HOME: work });
    const code = await run(['--json'], io);
    expect(code).toBe(0);
    const parsed = JSON.parse(out.join(''));
    expect(parsed.existingAgents[0].git.initialized).toBe(true);
    expect(parsed.existingAgents[0].git.gitignorePresent).toBe(true);
  });

  it('human-readable output lists each agent on its own line', async () => {
    const artDir = join(work, '.config', 'loom', 'art');
    await mkdir(artDir, { recursive: true });
    await writeFile(join(artDir, 'IDENTITY.md'), '# Art\n', 'utf-8');

    const { io, out } = mkIo({ HOME: work });
    const code = await run([], io);
    expect(code).toBe(0);
    const joined = out.join('');
    expect(joined).toMatch(/art/);
    expect(joined).toMatch(/node/i);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/cli/doctor.test.ts`
Expected: FAIL on missing module.

- [ ] **Step 3: Implement `loom doctor`**

Create `src/cli/doctor.ts`:

```typescript
/**
 * loom doctor — read-only environment probe. Reports node version
 * compatibility, stack version, existing agents under
 * ~/.config/loom/*, and forward-looking git fields per agent. Never
 * writes. Exit 0 regardless of findings; health is the output, not
 * the exit code.
 */
import { parseArgs } from 'node:util';
import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { extractGlobalFlags } from './args.js';
import type { IOStreams } from './io.js';
import { renderJson } from './io.js';

const USAGE = `Usage: loom doctor [options]

Probes the loom environment. Read-only; exits 0 regardless of findings.

Options:
  --json    Machine-readable output
  --help    Show this help
`;

interface GitState {
  initialized: boolean;
  hasRemote: boolean;
  dirty: boolean;
  gitignorePresent: boolean;
}

interface AgentReport {
  name: string;
  path: string;
  hasIdentity: boolean;
  hasMemoriesDb: boolean;
  hasProcedures: boolean;
  git: GitState;
}

interface DoctorReport {
  nodeOk: boolean;
  nodeVersion: string;
  stackVersionOk: boolean;
  contextDirResolved: string;
  agentsRoot: string;
  existingAgents: AgentReport[];
}

async function fileExists(p: string): Promise<boolean> {
  try { await stat(p); return true; } catch { return false; }
}

async function dirNonEmpty(p: string): Promise<boolean> {
  try {
    const entries = await readdir(p);
    return entries.length > 0;
  } catch {
    return false;
  }
}

async function probeGit(agentDir: string): Promise<GitState> {
  const dotGit = join(agentDir, '.git');
  const initialized = await fileExists(dotGit);
  const gitignorePresent = await fileExists(join(agentDir, '.gitignore'));
  return {
    initialized,
    hasRemote: false,
    dirty: false,
    gitignorePresent,
  };
}

async function probeAgents(home: string): Promise<{ root: string; agents: AgentReport[] }> {
  const root = join(home, '.config', 'loom');
  const agents: AgentReport[] = [];
  let entries: string[] = [];
  try {
    entries = await readdir(root);
  } catch {
    return { root, agents };
  }
  for (const name of entries.sort()) {
    const p = join(root, name);
    let s;
    try { s = await stat(p); } catch { continue; }
    if (!s.isDirectory()) continue;
    agents.push({
      name,
      path: p,
      hasIdentity: await fileExists(join(p, 'IDENTITY.md')),
      hasMemoriesDb: await fileExists(join(p, 'memories.db')),
      hasProcedures: await dirNonEmpty(join(p, 'procedures')),
      git: await probeGit(p),
    });
  }
  return { root, agents };
}

function nodeOk(version: string): boolean {
  const m = version.match(/^v(\d+)\./);
  return m !== null && Number(m[1]) >= 20;
}

async function probeStackVersion(contextDir: string): Promise<boolean> {
  const file = join(contextDir, 'LOOM_STACK_VERSION');
  try {
    const body = (await readFile(file, 'utf-8')).trim();
    const v = Number(body);
    return Number.isInteger(v) && v <= 1;
  } catch {
    return true;
  }
}

export async function run(argv: string[], io: IOStreams): Promise<number> {
  const { flags: global, rest } = extractGlobalFlags(argv);
  let parsed;
  try {
    parsed = parseArgs({
      args: rest,
      options: {
        json: { type: 'boolean' },
        help: { type: 'boolean', short: 'h' },
      },
      strict: true,
      allowPositionals: false,
    });
  } catch (err) {
    io.stderr(`${(err as Error).message}\n${USAGE}`);
    return 2;
  }
  if (parsed.values.help) { io.stdout(USAGE); return 0; }

  const home = io.env.HOME ?? process.env.HOME ?? '';
  const contextDir = global.contextDir ?? io.env.LOOM_CONTEXT_DIR ?? join(home, '.config', 'loom', 'default');
  const { root, agents } = await probeAgents(home);

  const report: DoctorReport = {
    nodeOk: nodeOk(process.version),
    nodeVersion: process.version,
    stackVersionOk: await probeStackVersion(contextDir),
    contextDirResolved: contextDir,
    agentsRoot: root,
    existingAgents: agents,
  };

  const json = Boolean(parsed.values.json) || Boolean(global.json);
  if (json) {
    renderJson(io, report);
    return 0;
  }

  const lines: string[] = [];
  lines.push(`node:        ${report.nodeVersion}${report.nodeOk ? '' : '  (unsupported — need ≥ 20)'}`);
  lines.push(`stack:       ${report.stackVersionOk ? 'compatible' : 'incompatible'}`);
  lines.push(`context dir: ${report.contextDirResolved}`);
  lines.push(`agents root: ${report.agentsRoot}`);
  if (report.existingAgents.length === 0) {
    lines.push('agents:      (none)');
  } else {
    lines.push(`agents:      ${report.existingAgents.length}`);
    for (const a of report.existingAgents) {
      const flags: string[] = [];
      if (a.hasIdentity) flags.push('identity');
      if (a.hasMemoriesDb) flags.push('memories.db');
      if (a.hasProcedures) flags.push('procedures');
      if (a.git.initialized) flags.push('git');
      lines.push(`  - ${a.name} (${flags.join(', ') || 'empty'})`);
    }
  }
  io.stdout(lines.join('\n') + '\n');
  return 0;
}
```

- [ ] **Step 4: Run tests to verify pass**

Run: `npx vitest run src/cli/doctor.test.ts`
Expected: PASS on all 4 tests.

- [ ] **Step 5: Commit**

```bash
git add src/cli/doctor.ts src/cli/doctor.test.ts
git commit -s -m "feat(cli): loom doctor — read-only environment probe"
```

---

## Task 8: Wire subcommands + help text

Register `install` and `doctor` in the dispatcher. Keep help text current.

**Files:**
- Modify: `src/cli/subcommands.ts`
- Modify: `src/cli/index.ts`
- Modify: `src/cli/dispatch.test.ts`

- [ ] **Step 1: Add failing dispatch test**

Append two tests to `src/cli/dispatch.test.ts` (inside the existing describe block; if it uses a different IO helper name, adapt):

```typescript
  it('routes `install` to install.run', async () => {
    const { io, out } = mkIo({});
    const code = await runCli(['install', '--help'], io);
    expect(code).toBe(0);
    expect(out.join('')).toMatch(/loom install/);
  });

  it('routes `doctor` to doctor.run', async () => {
    const { io, out } = mkIo({});
    const code = await runCli(['doctor', '--help'], io);
    expect(code).toBe(0);
    expect(out.join('')).toMatch(/loom doctor/);
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/cli/dispatch.test.ts`
Expected: FAIL on unknown subcommand.

- [ ] **Step 3: Register the subcommands**

Edit `src/cli/subcommands.ts`. Replace the array with:

```typescript
export const SUBCOMMANDS = [
  'wake', 'recall', 'remember', 'forget', 'update',
  'memory', 'pursuits', 'update-identity', 'bootstrap', 'serve',
  'inject', 'procedures', 'harness',
  'install', 'doctor',
] as const;

export type Subcommand = typeof SUBCOMMANDS[number];
```

Edit `src/cli/index.ts`. In the `TOP_HELP` const, append after the `harness init` line:

```
  install           Write loom-setup skill into a harness's skills dir
  doctor            Probe the loom environment (read-only)
```

In the switch statement, add two cases before the `default`:

```typescript
    case 'install': {
      const { run } = await import('./install.js');
      return run(rest, io);
    }
    case 'doctor': {
      const { run } = await import('./doctor.js');
      return run(rest, io);
    }
```

- [ ] **Step 4: Run tests to verify pass**

Run: `npx vitest run src/cli/dispatch.test.ts src/cli/install.test.ts src/cli/doctor.test.ts`
Expected: PASS on all.

- [ ] **Step 5: Commit**

```bash
git add src/cli/subcommands.ts src/cli/index.ts src/cli/dispatch.test.ts
git commit -s -m "feat(cli): register install + doctor subcommands"
```

---

## Task 9: Tighten `loom bootstrap --name` validation

Bootstrap today accepts any string for `--name`. Hook the new validator in so skill-driven + manual flows share one truth.

**Files:**
- Modify: `src/cli/bootstrap.ts`
- Modify: `src/cli/bootstrap.test.ts`

- [ ] **Step 1: Write failing test**

Append to `src/cli/bootstrap.test.ts` (adapt helper names to match the existing file):

```typescript
  it('rejects a reserved name with a clear error', async () => {
    const { io, err } = mkIo({ LOOM_CONTEXT_DIR: work });
    const code = await run(
      ['--name', 'current', '--purpose', 'p', '--voice', 'v'],
      io,
    );
    expect(code).toBe(2);
    expect(err.join('')).toMatch(/reserved/);
  });

  it('rejects an uppercase name', async () => {
    const { io, err } = mkIo({ LOOM_CONTEXT_DIR: work });
    const code = await run(
      ['--name', 'Art', '--purpose', 'p', '--voice', 'v'],
      io,
    );
    expect(code).toBe(2);
    expect(err.join('')).toMatch(/lowercase/);
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/cli/bootstrap.test.ts`
Expected: FAIL — reserved + uppercase names currently pass through.

- [ ] **Step 3: Plumb validator into `bootstrap.ts`**

Edit `src/cli/bootstrap.ts`. Add import near the other imports:

```typescript
import { validateAgentName } from '../install/names.js';
```

Add this helper function above `run`:

```typescript
function checkName(name: string, io: IOStreams): number | null {
  const r = validateAgentName(name);
  if (r.ok) return null;
  io.stderr(`Invalid --name: ${r.reason}\n`);
  return 2;
}
```

In `run`, immediately after `params` is finalized (just before the `try { ... bootstrap(...) }` block), add:

```typescript
  const nameCode = checkName(params!.name, io);
  if (nameCode !== null) return nameCode;
```

- [ ] **Step 4: Run tests to verify pass**

Run: `npx vitest run src/cli/bootstrap.test.ts`
Expected: PASS — both new tests plus all existing bootstrap tests.

- [ ] **Step 5: Commit**

```bash
git add src/cli/bootstrap.ts src/cli/bootstrap.test.ts
git commit -s -m "feat(bootstrap): enforce canonical agent-name rules"
```

---

## Task 10: package.json — version + files array

Bump version, add `"files"` so `assets/` ships when the package is published.

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Edit package.json**

Change `"version": "0.4.0-alpha.5"` to `"version": "0.4.0-alpha.6"`.

Add a `"files"` array right after `"bin"`:

```json
  "files": [
    "dist",
    "assets",
    "README.md",
    "LICENSE",
    "CHANGELOG.md"
  ],
```

- [ ] **Step 2: Verify the package tarball includes assets**

Run: `npm run build && npm pack --dry-run 2>&1 | grep -E '(assets|dist/cli/install|dist/cli/doctor)'`
Expected output includes:
- `assets/skill/SKILL.md`
- `dist/cli/install.js`
- `dist/cli/doctor.js`

- [ ] **Step 3: Commit**

```bash
git add package.json
git commit -s -m "chore: bump to 0.4.0-alpha.6 + ship assets in package"
```

---

## Task 11: Stack spec §13 + §14

Document the multi-agent layout + git-backed agent dirs.

**Files:**
- Modify: `docs/loom-stack-v1.md`

- [ ] **Step 1: Locate the last section in the stack spec**

Run: `grep -n '^## ' docs/loom-stack-v1.md | tail`
Verify the highest-numbered section. Append new §13 and §14 after it (adjust numbering if the file already has §13/§14).

- [ ] **Step 2: Append §13 Multi-agent layout**

Append to `docs/loom-stack-v1.md`:

```markdown
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
```

- [ ] **Step 3: Append §14 Git-backed agent dirs**

Append after §13:

````markdown
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
````

- [ ] **Step 4: Verify structure**

Run: `grep -n '^## ' docs/loom-stack-v1.md`
Expected: §13 and §14 present; no numbering conflicts with prior sections.

- [ ] **Step 5: Commit**

```bash
git add docs/loom-stack-v1.md
git commit -s -m "docs: stack spec §13 (multi-agent) + §14 (git-backed dirs)"
```

---

## Task 12: README Quick Start rewrite

Shift the headline path from "clone + build + hand-edit MCP config" to `npx loom install` + `/loom-setup`. Keep the per-command reference sections below the Quick Start.

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Replace the Quick Start section**

Open `README.md`. Locate the `## Quick start` section. Replace the entire section from `## Quick start` through the end of `### Wire into a runtime` (the section that ends right before `## CLI`) with:

````markdown
## Quick start

### Prerequisites

- **Node.js ≥ 20** (tested on 20 and 22).

That's it.

### Install the setup skill

```bash
npx loom install
```

A single-select picker asks which harness you want loom wired into.
Pick one of: Claude Code, Codex, Gemini CLI, OpenCode. (If your
harness isn't listed, pick "Other" and loom writes
`./loom-setup-skill.md` — hand it to your agent as-is.)

Scripting:

```bash
npx loom install --harness claude-code
npx loom install --harness codex --json
npx loom install --harness claude-code --to ~/my/skills/loom-setup.md
```

### Finish setup inside the harness

Open your chosen harness. Run the skill:

- **Claude Code** — `/loom-setup`
- **Codex / Gemini CLI / OpenCode** — "use the loom-setup skill"

The skill drives the rest: probes the environment, interviews you for
a name/purpose/voice, bootstraps identity files, adopts the
procedural-identity seeds, scaffolds a harness manifest, edits the
harness's MCP config (with verification), and verifies wake. Restart
the harness when it tells you to. Your agent will wake on its next
session.

### Doing it yourself

If you'd rather wire everything by hand, every piece is a CLI
command. See the CLI reference below.
````

- [ ] **Step 2: Update the repo version badge**

Locate the version badge near the top of README and update it from `0.4.0--alpha.5` to `0.4.0--alpha.6`.

- [ ] **Step 3: Verify README renders + links aren't broken**

Run: `grep -n 'loom install\|loom-setup' README.md | head`
Expected: multiple hits showing the new Quick Start references.

- [ ] **Step 4: Commit**

```bash
git add README.md
git commit -s -m "docs(readme): skill-driven Quick Start for alpha.6"
```

---

## Task 13: CHANGELOG entry + final smoke test

**Files:**
- Modify: `CHANGELOG.md`

- [ ] **Step 1: Add [0.4.0-alpha.6] section above [0.4.0-alpha.5]**

Open `CHANGELOG.md`. Insert after the `## [Unreleased]` line:

```markdown
## [0.4.0-alpha.6] - 2026-04-21

### Added

- `loom install` — CLI that writes the bundled `loom-setup` skill
  into a target harness's skills directory. Flag-driven
  (`--harness <key>`) or single-select TUI on a TTY. Targets:
  `claude-code`, `codex`, `gemini-cli`, `opencode`, `other`. `--to`
  overrides destination; `--force` overwrites; `--dry-run` /
  `--json` for scripting. The "other" target writes
  `./loom-setup-skill.md` in the current directory.
- `loom doctor` — read-only CLI probe reporting node version, stack
  version compatibility, context dir resolution, and enumerating
  existing agents under `~/.config/loom/*` with forward-looking
  `git: { initialized, hasRemote, dirty, gitignorePresent }` fields
  per agent. `--json` for scripting.
- `assets/skill/SKILL.md` — bundled skill that drives first-run
  setup inside the target harness: probe → interview → bootstrap →
  procedures adopt → harness init → MCP config edit
  (verify-before-write) → inject → wake verify. Never clobbers
  existing agent dirs; never proposes `--force`.
- `src/install/names.ts` — canonical agent-name validation plus
  reserved-names list (`current`, `default`, `config`, `backups`,
  `cache`, `tmp`, `shared`).
- Stack spec §13 (Multi-agent layout) and §14 (Git-backed agent
  dirs).

### Changed

- `loom bootstrap --name` now validates against the canonical name
  rules. Invalid or reserved names exit with code 2 and a specific
  error.
- `src/cli/tui/multi-select.ts` gains a `single: boolean` option
  (reducer + TTY adapter). Existing multi-select consumers are
  unchanged — the option defaults to `false`.
- `package.json` adds a `files` array so `assets/` ships in the
  published tarball alongside `dist/`.
- README Quick Start rewritten around `npx loom install` +
  `/loom-setup`. Per-command reference sections unchanged.
```

- [ ] **Step 2: Update the link references at the bottom**

Replace:

```
[Unreleased]: https://github.com/jbarket/loom/compare/v0.4.0-alpha.5...HEAD
```

with:

```
[Unreleased]: https://github.com/jbarket/loom/compare/v0.4.0-alpha.6...HEAD
[0.4.0-alpha.6]: https://github.com/jbarket/loom/compare/v0.4.0-alpha.5...v0.4.0-alpha.6
```

Leave the existing `[0.4.0-alpha.5]: ...` line intact below.

- [ ] **Step 3: Run the full test suite**

Run: `npm test`
Expected: all tests pass; no regressions. The test count should increase by roughly 25 (from the new install/doctor/names suites).

- [ ] **Step 4: Build to confirm shape**

Run: `npm run build`
Expected: clean exit; `dist/cli/install.js`, `dist/cli/doctor.js`, and `dist/install/*.js` all present.

- [ ] **Step 5: Smoke-test the happy path**

Run in a throwaway directory:

```bash
mkdir -p /tmp/loom-smoke/skills
node dist/index.js install --harness claude-code --to /tmp/loom-smoke/skills/loom-setup.md --json
```

Expected stdout:

```
{"target":"claude-code","path":"/tmp/loom-smoke/skills/loom-setup.md","action":"created"}
```

Then:

```bash
HOME=/tmp/loom-smoke node dist/index.js doctor --json
```

Expected: valid JSON with `existingAgents: []` and `nodeOk: true`.

Clean up:

```bash
rm -rf /tmp/loom-smoke
```

- [ ] **Step 6: Commit**

```bash
git add CHANGELOG.md
git commit -s -m "docs(changelog): 0.4.0-alpha.6 — install + setup skill"
```

---

## After all tasks

Once every task's box is checked, dispatch a final code-review subagent
across the diff vs `main`, then follow
`superpowers:finishing-a-development-branch` to produce the PR.
