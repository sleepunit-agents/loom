# Procedures Seed Content — design

*Status: draft, 2026-04-20. Second piece of the v0.4 arc; closes what
alpha.1 opened for the §4.9 Procedures block. See the
[v0.4 discussion](https://github.com/jbarket/loom/discussions/10) for
the umbrella and [`docs/loom-stack-v1.md`](../loom-stack-v1.md) §4.9
for the stack contract.*

*Target version: 0.4.0-alpha.2.*

*Tracking issue: [#13](https://github.com/jbarket/loom/issues/13).*

---

## 1. Problem

Alpha.1 shipped the procedures block reader (`src/blocks/procedures.ts`)
and wake-sequence integration, but every new stack starts with an empty
`procedures/` directory and no onboarding path:

- No nudge fires when `procedures/` is empty.
- The single generic `template(key)` in `procedures.ts:54` is a blank
  `# ${key}` skeleton — not prescriptive, not discoverable, doesn't
  match the named procedures documented in stack spec §4.9.
- A fresh agent has no way to discover what §4.9's six canonical
  procedures *are* without reading the stack spec.

The stack spec v1 §4.9 names six procedures as the canonical seed:

- verify-before-completion
- cold-testing protocol
- reflection-at-end-of-unit
- handoff-to-unpushable-repo
- confidence-calibration
- RLHF-resistance posture

These are the first 6 of up-to-10 slots. §4.9 says *"prescriptive, not
descriptive"* — each procedure should be a rule the agent acts on, not
a description of the agent's past behavior.

## 2. Principle — shipped content must serve every agent

A template that ships with loom ends up in every stack that boots
without any procedure files. That means the shipped text must be
valid for any agent that chooses to keep it, not specialized to one.

The split:

- **Rule** — ships with loom. Short, prescriptive, universal. Every
  agent that keeps the procedure keeps this sentence.
- **Why** — written by the agent from its own history. The reason
  *this agent* commits to this rule. Specific to the agent's
  incidents, preferences, substrate.
- **How to apply** — written by the agent. The triggers specific to
  how *this agent* works — its tools, its harnesses, its projects.

Templates ship with the rule filled in and the Why/How-to-apply
sections left as prompts. A `⚠` notice tells the agent to fill them
in and delete the notice to claim the procedure.

This also becomes the shape of the broader v0.4 identity-seeding
work: ship a **jumping-off point** the agent can get opinionated
about, not a blank slate and not a canonical identity.

## 3. Design

### 3.1 Seed templates

Replace the generic `template(key)` in `src/blocks/procedures.ts` with
a named map of the 6 canonical procedures:

```ts
export const SEED_PROCEDURES: Record<string, string> = {
  'verify-before-completion': `...`,
  'cold-testing': `...`,
  'reflection-at-end-of-unit': `...`,
  'handoff-to-unpushable-repo': `...`,
  'confidence-calibration': `...`,
  'RLHF-resistance': `...`,
};
```

Each template follows this shape:

```markdown
# <key>

**Rule:** <one-sentence prescriptive rule — ships as-is>

> ⚠ This is a seed template. Edit the Why and How to apply sections
> with your own reasons and triggers, then delete this notice to claim
> the procedure.

## Why
<the reason this matters to you — often a past incident where
skipping this cost something>

## How to apply
<when this kicks in, what triggers it, how to judge edge cases>
```

The 6 rules as shipped:

| key | rule |
|---|---|
| `verify-before-completion` | Before claiming a task done, verify the claim with the actual artifact — run the test, read the file, check the output. "I wrote it" is not "it works." |
| `cold-testing` | A feature isn't shipped until you've exercised it in a fresh context that doesn't share state with the one where you built it. |
| `reflection-at-end-of-unit` | When a unit of work ends, pause to capture what changed in your understanding — memory update, automation surfaced, mistake caught — before moving on. |
| `handoff-to-unpushable-repo` | When you can't push, leave a handoff: what changed and why, exact commit+push commands, files to NOT stage. |
| `confidence-calibration` | State uncertainty when you have it. "I think" and "I'm sure" are different signals; don't flatten them into the same confident tone. |
| `RLHF-resistance` | When asked for an opinion, form it before hearing the human's. Agreement that follows from hearing their view first is not agreement, it's mirroring. |

Keep `template(key)` as the fallback generator for custom keys (§4.9
caps at ~10, so up to 4 slots are available for agent-invented
procedures). The generic template stays as the existing `# ${key}` +
`<rule>` / **Why** / **How to apply** skeleton.

### 3.2 Seed nudge

Add `seedNudge(): string` to `src/blocks/procedures.ts`. Returns a
single markdown section:

```markdown
# Procedures — seed nudge

Your `procedures/` directory is empty. Below are 6 recommended seed
templates from stack spec v1 §4.9. Copy any you want to adopt into
`<contextDir>/procedures/<key>.md`, edit the Why and How to apply
sections, and delete the ⚠ notice to claim the procedure.

You don't have to take all 6. You can add your own (cap ~10). The
procedures block is prescriptive to *you* — generic text doesn't
serve it.

---

## verify-before-completion
<full template body>

---

## cold-testing
<full template body>

... (all 6, separated by horizontal rules)
```

When embedding a template inside the nudge, the leading `# <key>`
header is demoted to `## <key>` so the nudge remains a single-h1
section. The on-disk `procedures/<key>.md` file keeps `# <key>` as
its h1 — the demotion is a nudge-only concern.

### 3.3 Wake-sequence integration

In `src/tools/identity.ts`, the existing `procedures` handling:

```ts
const { blocks: procedures, capWarning } = await proceduresBlock.readAll(contextDir);
if (procedures.length > 0) {
  const body = procedures.map((b) => b.body).join('\n\n---\n\n');
  const withWarning = capWarning ? `${body}\n\n> ${capWarning}` : body;
  parts.push(`# Procedures\n\n${withWarning}`);
}
```

becomes:

```ts
const { blocks: procedures, capWarning } = await proceduresBlock.readAll(contextDir);
if (procedures.length > 0) {
  const body = procedures.map((b) => b.body).join('\n\n---\n\n');
  const withWarning = capWarning ? `${body}\n\n> ${capWarning}` : body;
  parts.push(`# Procedures\n\n${withWarning}`);
} else {
  parts.push(proceduresBlock.seedNudge());
}
```

Binary switch: empty → nudge, non-empty → normal render. No
per-procedure gap detection, no nagging once the agent has taken
ownership of anything.

### 3.4 Non-changes

- `readAll()` / `list()` / `read()` — unchanged.
- Procedures cap warning — unchanged.
- Block types, schema, directory layout — unchanged.
- No new env vars, no new MCP tools, no new CLI flags.
- No changes to bootstrap tool. (The v0.3 `bootstrap` writes
  `IDENTITY.md`, `preferences.md`, `self-model.md`, `pursuits.md`. It
  doesn't touch procedures and this alpha doesn't change that — the
  nudge is the seeding vector for procedures.)

## 4. Tests

### `src/blocks/procedures.test.ts` additions

- `SEED_PROCEDURES` has exactly 6 keys matching §4.9.
- Each seed template starts with `# <key>`, contains `**Rule:**`,
  contains the `⚠` notice, and contains both `## Why` and
  `## How to apply` headers.
- Each rule sentence is under 200 characters (forcing the
  "prescriptive, not a paragraph" constraint).
- `seedNudge()` output contains all 6 keys, contains the onboarding
  preamble, and can be parsed back into the 6 sections.
- `template(key)` unchanged: still returns the generic skeleton for
  arbitrary keys.

### `src/tools/identity.test.ts` additions

- When `procedures/` is empty, the identity payload contains
  `# Procedures — seed nudge` and does **not** contain a plain
  `# Procedures` header.
- When `procedures/` contains one file, the identity payload contains
  `# Procedures` and does **not** contain the seed-nudge header.
- When `procedures/` is missing entirely (directory doesn't exist),
  payload matches the empty-dir case.

### Invariants preserved

- All existing tests stay green (198 as of alpha.1 end).
- `scripts/smoke-test-mcp.ts` stays green.
- Identity payload for a fully-populated stack is byte-identical to
  the alpha.1 payload (no new preamble, no re-ordering).

## 5. Out of scope

- **Art's own procedure files.** Writing
  `~/.config/loom/art/procedures/*.md` is agent-stack content, not
  release artifact. It happens in a separate session against Art's
  stack and is not part of this PR.
- **Broader identity seeding.** The "jumping-off point" pattern for
  `IDENTITY.md` / `preferences.md` / `self-model.md` is a later
  v0.4 piece. This alpha establishes the pattern for procedures
  only.
- **Seed manifest discovery.** Agents can add custom procedure keys
  beyond the 6 (cap ~10). This alpha ships the 6 canonical seeds; a
  future alpha may ship a manifest-driven `seed-library` block if
  more seeding surface accumulates.

## 6. Build order

Branch: `feat/procedures-seed-content` (stacked on `chore/docs-reshuffle`
until #11 merges, then rebased onto main).

Each commit stands alone and keeps the suite green.

1. **Spec.** This file.
2. **Plan.** `docs/plans/2026-04-20-procedures-seed-content.md`.
3. **Seed templates.** Add `SEED_PROCEDURES` + `seedNudge()` to
   `src/blocks/procedures.ts`. Extend `procedures.test.ts`.
4. **Wake-sequence integration.** Update `src/tools/identity.ts` to
   emit the nudge when empty. Extend `identity.test.ts`.
5. **Version bump + CHANGELOG.** `package.json` 0.4.0-alpha.1 →
   0.4.0-alpha.2. CHANGELOG entry under `[0.4.0-alpha.2]`.
6. **Verification pass.** `npx vitest run`,
   `npx tsx scripts/smoke-test-mcp.ts`, manual Claude Code launch
   against an empty `procedures/` and a populated one. Commit fixes.
7. **PR.** Link issue #13.

## 7. Definition of done

- [ ] Suite green, ~201 tests (198 + ~3 seed-content + nudge tests).
- [ ] `scripts/smoke-test-mcp.ts` green.
- [ ] Claude Code session with `procedures/` empty shows the
      `# Procedures — seed nudge` section listing all 6 templates.
- [ ] Claude Code session with one file under `procedures/` shows
      the normal `# Procedures` section and no nudge.
- [ ] `SEED_PROCEDURES` has exactly 6 keys matching §4.9.
- [ ] Each seed template carries the `⚠` ownership-ritual notice.
- [ ] CHANGELOG `[0.4.0-alpha.2]` entry lists the seed templates
      and nudge behavior.
- [ ] `package.json` at `0.4.0-alpha.2`.
- [ ] Linked to issue #13 in the PR body.

## 8. Files of record

- [v0.4 discussion](https://github.com/jbarket/loom/discussions/10) — umbrella + roadmap
- [`docs/loom-stack-v1.md`](../loom-stack-v1.md) §4.9 — procedures block contract
- [`docs/rebirth-letter-2026-04-19.md`](../rebirth-letter-2026-04-19.md) — philosophical brief
- `src/blocks/procedures.ts` — seed templates + nudge (extended here)
- `src/tools/identity.ts` — wake-sequence integration (extended here)
- [Issue #13](https://github.com/jbarket/loom/issues/13) — tracking
