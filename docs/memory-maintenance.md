# Memory Maintenance — changelog mechanism

Memory-maintenance runs record what they did to a repo-tracked changelog:
[`docs/memory-maintenance-log.md`](./memory-maintenance-log.md).

This is the home for the consolidation digest per blessed decision 3
(SLE-89 / SLE-71): the digest goes to **a file in the repo** — *not* a `reference`
memory, *not* an issue comment. One file holds both maintenance tracks:

- **Tier 2 — Weekly Consolidation** (Art-Consolidate): memory merges, contradictions
  surfaced, stale/expired pruned, duplicate pairs found.
- **Tier 3 — Monthly Identity Review** (Art-Identity-Review): identity-manifest
  sections updated, harness manifests verified, project-brief audit.

## Rules

- **Single file**, chronological, append-only. Entries are never edited or removed.
- **No agent commits.** Agents append to the working file; the maintainer batches
  commits when convenient. (This answers the SLE-91 write/commit HOW: append-only,
  no auto-commit.)
- Each entry is a dated `##` section, separated from the previous one by a `---` break.
- Dates are UTC ISO dates (`YYYY-MM-DD`).

## Entry format

### Tier 2 — Weekly Consolidation

```markdown
## [2026-05-30] Weekly Consolidation (Tier 2)

- **Run:** Art-Consolidate autopilot
- **Memories audited:** 47 (3 stale, 2 duplicates, 0 expired)
- **Operations:**
  - Merges: 1
  - Contradictions: 0
  - Pruned: 1
- **Notes:** <optional free text>
```

### Tier 3 — Monthly Identity Review

```markdown
## [2026-06-30] Monthly Identity Review (Tier 3)

- **Run:** Art-Identity-Review routine
- **Manifest changes:**
  - preferences.md: 3 section(s) updated (communication-style, decision-making, scope-and-access)
  - self-model.md: 2 section(s) updated (strengths, learning)
  - IDENTITY.md: No changes
- **Project briefs:** 8 accessed, 1 stale
- **Harness manifests:** 4/4 present and current
- **Notes:** <optional free text>
```

## How an agent appends an entry

There are two equivalent paths; the format above is the contract either way.

### Option A — append the section directly (default for agents-in-a-mode)

A maintenance agent (Art running in the `consolidate` / `identity` reflection mode)
already has file access. Append a section matching the format above to
`docs/memory-maintenance-log.md`. If the file does not yet exist, start it with the
header block shown at the top of the existing log. Do **not** commit.

### Option B — use the helper (programmatic / CI / future MCP tool)

[`src/tools/append-maintenance-log.ts`](../src/tools/append-maintenance-log.ts) is the
canonical formatter — it is the source of truth for the format above and is covered by
`src/tools/append-maintenance-log.test.ts`. It creates the file with its header on
first write, normalizes separators, and performs **no** git operations.

```typescript
import { appendMaintenanceLog } from '../tools/append-maintenance-log.js';

await appendMaintenanceLog(
  {
    type: 'tier-2',
    tier2: {
      memoriesAudited: 47,
      staleCount: 3,
      duplicateCount: 2,
      expiredCount: 0,
      mergeCount: 1,
      contradictions: 0,
      pruned: 1,
      notes: 'Near-duplicates in the "reference" category flagged for review.',
    },
  },
  'docs/memory-maintenance-log.md',
);
```

Pass an explicit `timestamp: Date` to backdate an entry; it defaults to now.
```
