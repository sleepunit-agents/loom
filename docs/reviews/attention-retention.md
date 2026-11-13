# Attention retention and findings cold review

ASSESS high: data yes (schema4 + held-turn deletion); security yes (central inherited scope); contract yes (operation API); concurrency yes (retry/outer transaction); environment no (no rollout); uncaught no (targeted fixtures and CI).

CLAIM: Whole-day metadata aggregates and checked findings retain the old counts and privacy in shared records.
WHY IT MATTERS: Folding must neither discard aggregate counts nor expose a private conversation.

Review uses runtime oneshot, frozen git archives plus the complete unit diff, code template and old behavior contract. At most three rounds under the standing 2026-11-12 ruling. No completed earlier unit is re-reviewed.

## Round 1

Source 496b2eec324a2d3f3e58ba225952c259da10a36b; TREE sha256:36fef47ad58f1b24507d69354a8a7fde5ffd18918bfe37538c6d600385bb9d3e. Frozen `/home/art/scratch/attention-retention-review/round-1/tree`; reply in `retry.md` beside it.

Initial invocation: NONE, runtime usage reporting failed with no verdict. One retry of the same tree/contract completed BLOCKING (one MAJOR, two NIT).

- MAJOR findings retrieval tests: actionable, folded. Added distinct conversations and agents, increasing write timestamps, valid limit, both filters and their intersection, explicit newest-first order, and visibility-before-limit assertion.
- NIT same-day cap only repeated one turn: actionable, folded. Added two different own turns on the same UTC day and a second-finding conflict assertion.
- NIT duplicated five-line record reader: valid trade-off, retained as local helpers in the two independent modules. Both interpolate only closed table names supplied by the module; extracting a shared abstraction adds API surface for a trivial SQL/JSON idiom. This is a maintenance choice, no behavior gap.

Also added an injected later nested-fold refusal proving earlier fold deletions, day inserts, receipts and notifications all roll back with the sweep.
