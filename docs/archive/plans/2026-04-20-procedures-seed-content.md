# Procedures Seed Content Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the §4.9 procedures block gap: ship 6 canonical seed templates (rule-only, agent fills in Why/How-to-apply), a seed nudge in the wake payload that emits when `procedures/` is empty, and an ownership-ritual ⚠ notice the agent deletes to claim each procedure. Releases as 0.4.0-alpha.2.

**Architecture:** Extend `src/blocks/procedures.ts` with a `SEED_PROCEDURES` map (6 named templates) and a `seedNudge()` function. Update `src/tools/identity.ts` to emit the nudge when the on-disk directory is empty/missing; otherwise render the existing `# Procedures` section unchanged. No new files, no new env vars, no new MCP tools.

**Tech Stack:** TypeScript strict mode, `@modelcontextprotocol/sdk`, Zod 4, Vitest 4, Node ≥ 20, ESM. Same as alpha.1.

**Spec of record:** [`docs/specs/2026-04-20-procedures-seed-content-design.md`](../specs/2026-04-20-procedures-seed-content-design.md). Stack schema: [`docs/loom-stack-v1.md`](../loom-stack-v1.md) §4.9. Tracking: [issue #13](https://github.com/jbarket/loom/issues/13).

---

## File structure

**Modified:**

| Path | Responsibility |
|---|---|
| `src/blocks/procedures.ts` | Add `SEED_PROCEDURES` map + `seedNudge()`. Keep existing `read`/`list`/`readAll`/`template` unchanged. |
| `src/blocks/procedures.test.ts` | Add tests for `SEED_PROCEDURES` shape + `seedNudge()` content. |
| `src/tools/identity.ts` | Emit `seedNudge()` when `procedures/` is empty; preserve existing non-empty branch. |
| `src/tools/identity.test.ts` | Update empty-dir test (was "omits # Procedures section") to assert seed nudge; keep non-empty + cap-warning tests unchanged. |
| `package.json` | Version bump `0.4.0-alpha.1` → `0.4.0-alpha.2`. |
| `CHANGELOG.md` | Add `[0.4.0-alpha.2]` entry; move `[Unreleased]` docs-reshuffle note under it. |

**No files created, no files deleted.**

---

## Task 1: Seed templates in `src/blocks/procedures.ts`

**Files:**
- Modify: `src/blocks/procedures.ts:1-65` (add `SEED_PROCEDURES` + related exports after existing `template()`)
- Test: `src/blocks/procedures.test.ts` (add tests after existing `'template contains the key'` test)

- [ ] **Step 1: Write failing tests for `SEED_PROCEDURES`**

Append to `src/blocks/procedures.test.ts` after the existing `template` test (before the closing `});`):

```typescript
  describe('SEED_PROCEDURES', () => {
    const EXPECTED_KEYS = [
      'verify-before-completion',
      'cold-testing',
      'reflection-at-end-of-unit',
      'handoff-to-unpushable-repo',
      'confidence-calibration',
      'RLHF-resistance',
    ];

    it('has exactly the 6 canonical §4.9 keys', () => {
      expect(Object.keys(procedures.SEED_PROCEDURES).sort()).toEqual([...EXPECTED_KEYS].sort());
    });

    it('every seed template starts with "# <key>"', () => {
      for (const key of EXPECTED_KEYS) {
        const body = procedures.SEED_PROCEDURES[key];
        expect(body.startsWith(`# ${key}\n`)).toBe(true);
      }
    });

    it('every seed template contains a Rule line, the ⚠ notice, Why, and How to apply', () => {
      for (const key of EXPECTED_KEYS) {
        const body = procedures.SEED_PROCEDURES[key];
        expect(body).toContain('**Rule:**');
        expect(body).toContain('⚠');
        expect(body).toContain('## Why');
        expect(body).toContain('## How to apply');
      }
    });

    it('every rule sentence is under 200 characters', () => {
      for (const key of EXPECTED_KEYS) {
        const body = procedures.SEED_PROCEDURES[key];
        const match = body.match(/\*\*Rule:\*\* (.+?)(?:\n|$)/);
        expect(match, `missing Rule line in ${key}`).not.toBeNull();
        expect(match![1].length).toBeLessThan(200);
      }
    });
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/blocks/procedures.test.ts`
Expected: FAIL with `procedures.SEED_PROCEDURES is undefined` (or similar `Cannot read properties of undefined`).

- [ ] **Step 3: Add `SEED_PROCEDURES` to `src/blocks/procedures.ts`**

After the existing `template()` function (line 54-65), append:

```typescript
/**
 * Canonical seed templates for the 6 §4.9 procedures. Each template ships with
 * a prescriptive Rule (universal, keep-as-is) and leaves Why + How to apply as
 * agent-authored prompts. The ⚠ notice is the ownership ritual: the agent
 * deletes it to claim the procedure.
 */
export const SEED_PROCEDURES: Record<string, string> = {
  'verify-before-completion': seedBody(
    'verify-before-completion',
    'Before claiming a task done, verify the claim with the actual artifact — run the test, read the file, check the output. "I wrote it" is not "it works."',
  ),
  'cold-testing': seedBody(
    'cold-testing',
    "A feature isn't shipped until you've exercised it in a fresh context that doesn't share state with the one where you built it.",
  ),
  'reflection-at-end-of-unit': seedBody(
    'reflection-at-end-of-unit',
    'When a unit of work ends, pause to capture what changed in your understanding — memory update, automation surfaced, mistake caught — before moving on.',
  ),
  'handoff-to-unpushable-repo': seedBody(
    'handoff-to-unpushable-repo',
    "When you can't push, leave a handoff: what changed and why, exact commit+push commands, files to NOT stage.",
  ),
  'confidence-calibration': seedBody(
    'confidence-calibration',
    'State uncertainty when you have it. "I think" and "I\'m sure" are different signals; don\'t flatten them into the same confident tone.',
  ),
  'RLHF-resistance': seedBody(
    'RLHF-resistance',
    "When asked for an opinion, form it before hearing the human's. Agreement that follows from hearing their view first is not agreement, it's mirroring.",
  ),
};

function seedBody(key: string, rule: string): string {
  return `# ${key}

**Rule:** ${rule}

> ⚠ This is a seed template. Edit the Why and How to apply sections with your
> own reasons and triggers, then delete this notice to claim the procedure.

## Why
<the reason this matters to you — often a past incident where skipping this cost something>

## How to apply
<when this kicks in, what triggers it, how to judge edge cases>
`;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/blocks/procedures.test.ts`
Expected: All tests PASS, including the 4 new `SEED_PROCEDURES` tests.

- [ ] **Step 5: Commit**

```bash
git add src/blocks/procedures.ts src/blocks/procedures.test.ts
git commit -s -m "feat(procedures): seed templates for the 6 §4.9 procedures

Each template ships with a prescriptive Rule and leaves Why + How to
apply as agent-authored prompts. The ⚠ ownership ritual: agent deletes
the notice to claim the procedure.

Refs: #13"
```

---

## Task 2: `seedNudge()` function

**Files:**
- Modify: `src/blocks/procedures.ts` (add `seedNudge` after `SEED_PROCEDURES`)
- Test: `src/blocks/procedures.test.ts` (add tests after the `SEED_PROCEDURES` describe block)

- [ ] **Step 1: Write failing tests for `seedNudge()`**

Append to `src/blocks/procedures.test.ts` before the outer closing `});`:

```typescript
  describe('seedNudge', () => {
    it('opens with the "# Procedures — seed nudge" header', () => {
      const nudge = procedures.seedNudge();
      expect(nudge.startsWith('# Procedures — seed nudge\n')).toBe(true);
    });

    it('mentions the empty directory and the §4.9 reference', () => {
      const nudge = procedures.seedNudge();
      expect(nudge).toContain('`procedures/` directory is empty');
      expect(nudge).toContain('§4.9');
    });

    it('includes every seed procedure with an h2 header', () => {
      const nudge = procedures.seedNudge();
      for (const key of Object.keys(procedures.SEED_PROCEDURES)) {
        expect(nudge, `nudge missing ## ${key}`).toContain(`## ${key}`);
      }
    });

    it('demotes the embedded templates from h1 to h2 (no secondary h1s)', () => {
      const nudge = procedures.seedNudge();
      const h1Matches = nudge.match(/^# /gm) ?? [];
      expect(h1Matches.length).toBe(1);
    });

    it('preserves each template body (rule, notice, Why, How to apply)', () => {
      const nudge = procedures.seedNudge();
      expect((nudge.match(/\*\*Rule:\*\*/g) ?? []).length).toBe(6);
      expect((nudge.match(/⚠/g) ?? []).length).toBe(6);
      expect((nudge.match(/## Why/g) ?? []).length).toBe(6);
      expect((nudge.match(/## How to apply/g) ?? []).length).toBe(6);
    });
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/blocks/procedures.test.ts`
Expected: FAIL with `procedures.seedNudge is not a function`.

- [ ] **Step 3: Add `seedNudge()` to `src/blocks/procedures.ts`**

Append after the `seedBody` helper:

```typescript
/**
 * Renders the empty-directory onboarding nudge. Includes all 6 seed templates
 * inline with their h1 headers demoted to h2 so the nudge remains a
 * single-h1 section. On-disk `procedures/<key>.md` files keep `# <key>`
 * as their h1 — the demotion is a nudge-only concern.
 */
export function seedNudge(): string {
  const preamble = `# Procedures — seed nudge

Your \`procedures/\` directory is empty. Below are 6 recommended seed templates
from stack spec v1 §4.9. Copy any you want to adopt into
\`<contextDir>/procedures/<key>.md\`, edit the Why and How to apply sections,
and delete the ⚠ notice to claim the procedure.

You don't have to take all 6. You can add your own (cap ~10). The procedures
block is prescriptive to *you* — generic text doesn't serve it.`;

  const sections = Object.entries(SEED_PROCEDURES).map(([, body]) =>
    body.replace(/^# /, '## '),
  );

  return [preamble, ...sections].join('\n\n---\n\n');
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/blocks/procedures.test.ts`
Expected: All procedures tests PASS (original 6 + 4 seed-template + 5 seedNudge = 15).

- [ ] **Step 5: Commit**

```bash
git add src/blocks/procedures.ts src/blocks/procedures.test.ts
git commit -s -m "feat(procedures): seedNudge() renders the empty-directory onboarding

Emits a single-h1 markdown section with all 6 seed templates inline,
each template's h1 demoted to h2 so the nudge stays one section.

Refs: #13"
```

---

## Task 3: Wire seed nudge into the wake sequence

**Files:**
- Modify: `src/tools/identity.ts:97-103` (procedures render block)
- Test: `src/tools/identity.test.ts:246-250` (update existing "omits" test) + add a new test

- [ ] **Step 1: Update the existing empty-dir test + add nudge-specific tests**

In `src/tools/identity.test.ts`, replace the existing test at lines 246-250 and add new tests. Find this existing block:

```typescript
  it('omits the "# Procedures" section when procedures/ is missing', async () => {
    const result = await loadIdentity(tempDir);
    expect(result).not.toContain('# Procedures');
  });
```

Replace it with:

```typescript
  it('emits the seed nudge when procedures/ is missing', async () => {
    const result = await loadIdentity(tempDir);
    expect(result).toContain('# Procedures — seed nudge');
    expect(result).toContain('## verify-before-completion');
    expect(result).toContain('## RLHF-resistance');
    // Non-empty "# Procedures" header must NOT appear alongside the nudge
    const nonNudgeProceduresHeader = /\n# Procedures\n/;
    expect(result).not.toMatch(nonNudgeProceduresHeader);
  });

  it('emits the seed nudge when procedures/ exists but is empty', async () => {
    await mkdir(join(tempDir, 'procedures'), { recursive: true });
    const result = await loadIdentity(tempDir);
    expect(result).toContain('# Procedures — seed nudge');
  });

  it('does NOT emit the seed nudge when any procedure file exists', async () => {
    await mkdir(join(tempDir, 'procedures'), { recursive: true });
    await writeFile(join(tempDir, 'procedures', 'verify.md'), '# Verify\n\nAlways verify.');
    const result = await loadIdentity(tempDir);
    expect(result).not.toContain('# Procedures — seed nudge');
    expect(result).toContain('# Procedures');
    expect(result).toContain('Always verify.');
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/tools/identity.test.ts`
Expected: FAIL — the new nudge assertions will fail because identity.ts still has the `if (procedures.length > 0)` gate with no else branch.

- [ ] **Step 3: Update `src/tools/identity.ts` to emit the nudge**

Find the procedures block (lines 97-103):

```typescript
  // Procedures — procedural-identity docs (stack spec §4.9).
  const { blocks: procedures, capWarning } = await proceduresBlock.readAll(contextDir);
  if (procedures.length > 0) {
    const body = procedures.map((b) => b.body).join('\n\n---\n\n');
    const withWarning = capWarning ? `> ${capWarning}\n\n${body}` : body;
    parts.push(`# Procedures\n\n${withWarning}`);
  }
```

Replace with:

```typescript
  // Procedures — procedural-identity docs (stack spec §4.9).
  // Empty directory → seed nudge. Any content → normal render.
  const { blocks: procedures, capWarning } = await proceduresBlock.readAll(contextDir);
  if (procedures.length > 0) {
    const body = procedures.map((b) => b.body).join('\n\n---\n\n');
    const withWarning = capWarning ? `> ${capWarning}\n\n${body}` : body;
    parts.push(`# Procedures\n\n${withWarning}`);
  } else {
    parts.push(proceduresBlock.seedNudge());
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/tools/identity.test.ts`
Expected: All identity tests PASS, including the 3 new procedures tests.

- [ ] **Step 5: Run the full suite**

Run: `npx vitest run`
Expected: All files PASS. Total count should be ~207 (198 from alpha.1 + 4 seed-template + 5 seedNudge + 2 new identity tests; one existing identity test was rewritten, not added).

- [ ] **Step 6: Commit**

```bash
git add src/tools/identity.ts src/tools/identity.test.ts
git commit -s -m "feat(identity): emit procedures seed nudge on empty directory

Binary switch: procedures/ empty or missing -> seed nudge lists all 6
canonical templates; any procedures/*.md present -> normal render.
No per-procedure gap detection, no nagging after ownership is claimed.

Refs: #13"
```

---

## Task 4: Version bump + CHANGELOG

**Files:**
- Modify: `package.json:3` (version field)
- Modify: `CHANGELOG.md` (add `[0.4.0-alpha.2]` entry; fold the existing docs-reshuffle note under it)

- [ ] **Step 1: Bump `package.json`**

In `package.json`, change the `version` field:

```json
  "version": "0.4.0-alpha.2",
```

- [ ] **Step 2: Update `CHANGELOG.md`**

Find the current `[Unreleased]` block:

```markdown
## [Unreleased]

### Changed

- Documentation reshuffle: v0.4 arc docs moved out of the repo. The
  roadmap now lives in the
  [v0.4 discussion](https://github.com/jbarket/loom/discussions/10) and
  the [project board](https://github.com/users/jbarket/projects/1/views/1).
  Per-feature specs and plans moved from `docs/superpowers/{specs,plans}/`
  to `docs/{specs,plans}/` — tool-neutral paths, same content.
```

Replace with:

```markdown
## [Unreleased]

## [0.4.0-alpha.2] - 2026-04-20

### Added

- Seed templates for the 6 canonical §4.9 procedures
  (`verify-before-completion`, `cold-testing`, `reflection-at-end-of-unit`,
  `handoff-to-unpushable-repo`, `confidence-calibration`, `RLHF-resistance`).
  Each ships with a prescriptive Rule; Why and How-to-apply sections are
  agent-authored prompts. A `⚠` notice serves as the ownership ritual —
  agents delete it to claim the procedure.
- Empty-directory seed nudge in the `identity()` payload. When
  `procedures/` is empty or missing, the wake payload emits a single
  `# Procedures — seed nudge` section listing all 6 seed templates
  inline. Once any `procedures/*.md` exists, the nudge goes silent and
  the normal `# Procedures` section renders. Binary switch, no
  per-procedure nagging.

### Changed

- Documentation reshuffle: v0.4 arc docs moved out of the repo. The
  roadmap now lives in the
  [v0.4 discussion](https://github.com/jbarket/loom/discussions/10) and
  the [project board](https://github.com/users/jbarket/projects/1/views/1).
  Per-feature specs and plans moved from `docs/superpowers/{specs,plans}/`
  to `docs/{specs,plans}/` — tool-neutral paths, same content.
```

Then find the link-reference block at the bottom:

```markdown
[Unreleased]: https://github.com/jbarket/loom/compare/v0.4.0-alpha.1...HEAD
[0.4.0-alpha.1]: https://github.com/jbarket/loom/compare/v0.3.1...v0.4.0-alpha.1
[0.3.1]: https://github.com/jbarket/loom/releases/tag/v0.3.1
```

Replace with:

```markdown
[Unreleased]: https://github.com/jbarket/loom/compare/v0.4.0-alpha.2...HEAD
[0.4.0-alpha.2]: https://github.com/jbarket/loom/compare/v0.4.0-alpha.1...v0.4.0-alpha.2
[0.4.0-alpha.1]: https://github.com/jbarket/loom/compare/v0.3.1...v0.4.0-alpha.1
[0.3.1]: https://github.com/jbarket/loom/releases/tag/v0.3.1
```

- [ ] **Step 3: Run the full suite and smoke test**

Run: `npx vitest run`
Expected: All tests PASS (~207).

Run: `npx tsx scripts/smoke-test-mcp.ts`
Expected: Green. (Smoke test exercises remember/recall/list/forget over stdio — doesn't directly depend on procedures, but regression check.)

- [ ] **Step 4: Commit**

```bash
git add package.json CHANGELOG.md
git commit -s -m "chore: bump to 0.4.0-alpha.2

Refs: #13"
```

---

## Task 5: Manual verification + PR

**Files:** (no code changes)

- [ ] **Step 1: Manual check — empty procedures/ renders the nudge**

In a scratch context directory with no `procedures/` subdir, run loom's `identity()` tool (via the MCP inspector or a quick stdio smoke harness) and confirm the payload contains `# Procedures — seed nudge` and all 6 `## <key>` sub-sections.

One quick way:

```bash
npx tsx -e "
import { loadIdentity } from './src/tools/identity.js';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const dir = mkdtempSync(join(tmpdir(), 'loom-verify-'));
loadIdentity(dir).then((out) => {
  console.log(out);
  console.log('---');
  console.log('nudge present:', out.includes('# Procedures — seed nudge'));
});
"
```

Expected: `nudge present: true` and all 6 seed keys appear.

- [ ] **Step 2: Manual check — populated procedures/ silences the nudge**

```bash
npx tsx -e "
import { loadIdentity } from './src/tools/identity.js';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const dir = mkdtempSync(join(tmpdir(), 'loom-verify-'));
mkdirSync(join(dir, 'procedures'));
writeFileSync(join(dir, 'procedures', 'verify.md'), '# Verify\n\nAlways verify.');
loadIdentity(dir).then((out) => {
  console.log('nudge present:', out.includes('# Procedures — seed nudge'));
  console.log('procedures header present:', out.includes('# Procedures\n'));
  console.log('procedure body present:', out.includes('Always verify.'));
});
"
```

Expected: `nudge present: false`, `procedures header present: true`, `procedure body present: true`.

- [ ] **Step 3: Push the branch**

```bash
git push -u origin feat/procedures-seed-content
```

- [ ] **Step 4: Rebase onto main if #11 has merged**

If PR #11 (`chore/docs-reshuffle`) has merged to `origin/main` by this point:

```bash
git fetch origin main
git rebase origin/main
git push --force-with-lease
```

If #11 has not merged yet, skip this step and open the PR stacked on `chore/docs-reshuffle` — note the dependency in the PR body.

- [ ] **Step 5: Open the PR**

```bash
gh pr create --title "v0.4.0-alpha.2: procedures seed content" --body "$(cat <<'EOF'
## Summary

- Ship 6 canonical §4.9 procedure seed templates with prescriptive Rules; Why and How-to-apply sections are agent-authored prompts.
- Empty-directory seed nudge in the `identity()` payload — binary switch, silences as soon as any `procedures/*.md` exists.
- `⚠` ownership ritual: the agent deletes the notice to claim the procedure.

Closes #13.

## Linked spec / issue

- Spec: [`docs/specs/2026-04-20-procedures-seed-content-design.md`](docs/specs/2026-04-20-procedures-seed-content-design.md)
- Plan: [`docs/plans/2026-04-20-procedures-seed-content.md`](docs/plans/2026-04-20-procedures-seed-content.md)
- Issue: #13

## Test plan

- [x] `npx vitest run` — ~207 tests green
- [x] `npx tsx scripts/smoke-test-mcp.ts` — smoke test green
- [x] Manual: empty `procedures/` renders seed nudge with all 6 templates
- [x] Manual: any `procedures/*.md` silences the nudge, renders normally

## Checklist

- [x] Commits are signed off (`git commit -s`)
- [x] No new external dependencies
- [x] No secrets added
- [x] CHANGELOG updated under `[0.4.0-alpha.2]`
EOF
)"
```

---

## Definition of done

Reproduced here so it's next to the tasks, not just in the spec:

- [ ] Suite green, ~207 tests.
- [ ] `scripts/smoke-test-mcp.ts` green.
- [ ] Manual verification: empty `procedures/` renders seed nudge with all 6 templates.
- [ ] Manual verification: any `procedures/*.md` silences nudge and renders normal `# Procedures` section.
- [ ] `SEED_PROCEDURES` has exactly 6 keys matching §4.9.
- [ ] Each seed template carries `**Rule:**`, the `⚠` notice, `## Why`, and `## How to apply`.
- [ ] `package.json` at `0.4.0-alpha.2`.
- [ ] CHANGELOG lists `[0.4.0-alpha.2]` with Added + Changed sections.
- [ ] PR linked to issue #13 and to the spec.

---

## Files of record

- Spec: [`docs/specs/2026-04-20-procedures-seed-content-design.md`](../specs/2026-04-20-procedures-seed-content-design.md)
- Umbrella + roadmap: [v0.4 discussion](https://github.com/jbarket/loom/discussions/10)
- Stack schema: [`docs/loom-stack-v1.md`](../loom-stack-v1.md) §4.9
- Tracking issue: [#13](https://github.com/jbarket/loom/issues/13)
