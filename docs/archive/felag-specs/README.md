# felag specs — archived, non-normative

These six directories used to live at `spec/`:
`loom`, `loom-identity`, `loom-knowledge`, `loom-memory`, `loom-strictness`, `loom-transport`.

They were written in June 2026 as felag ceremony artifacts (`spec.jsonl` criteria plus
`fixtures.jsonl`) and were checked by felag's tooling. felag was shelved on 2026-08-26, and
nothing has run these fixtures since. They were moved here unchanged on 2026-09-17.

**They are not loom's contract.** loom's contract is its vitest suite (`npm test`). Where a
file here disagrees with `src/`, `src/` and its tests are right.

## Known drift

A cold review of `loom-memory` on 2026-09-15 found it disagrees with `src/` in ways a reader
would act on. The review returned REWORK with 5 CRITICAL findings. Examples:

- It lists six memory categories. `src/categories.ts` has seven (`episode` was added).
- It says `prune` deletes expired memories. `prune` archives them, and they can be restored.
- It says `recall` returns results in distance order. `recall` re-ranks for diversity (MMR)
  when there are more candidates than the limit, so `fx-loom-recall-limit` can fail.
- One fixture (`fx-loom-ratify-lifecycle` case 2) stages an empty proposal, which `propose()`
  rejects before the fixture's first check.

The other five directories were not reviewed. Assume they have drifted too.

The full review is in Art's ops repo at `notes/cold-review/2026-09-15-loom-memory-spec-r1.md`.
The decision to archive instead of re-syncing is taskstore row t-716 (2026-09-15).

## Reversing this

To make a spec normative again, move its directory back to `spec/`, re-sync it to `src/`, and
make its fixtures run in vitest. Until a test runs a fixture, that fixture proves nothing.
