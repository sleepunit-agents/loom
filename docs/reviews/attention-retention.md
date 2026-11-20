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

## Round 2

Source e9541dee319bbe16a938198ba08dd1863bdf6d5a; TREE sha256:79d9270155ace2598c36fd5fe371d243c79d4210513d7b48fa9206e664c18d46. Frozen `/home/art/scratch/attention-retention-review/round-2/tree`; reply `reply.md`. BLOCKING, one MAJOR and one NIT.

- MAJOR mixed-audience sweep coverage: actionable, folded. One sweep fixture now contains an authorized conversation, a member-private conversation and another agent's conversation; asserts only authorized turns fold. It then asserts a service with retain but no fold grant touches nothing, and a fully granted service folds the remaining non-private conversation while private turns remain held.
- NIT duplicated reader: same valid maintenance trade-off recorded in round 1; no new abstraction.

No implementation defect was reported; this round adds the discriminating authorization fixture without changing central rules or production composition.

## Round 3 — final

Source 9e03004e4579dfe09d978f0209d49a4e8cfbfea1; TREE sha256:093605ff96db86faf8467d91b439911170bfdebd8662e166ab570382c109df41. Frozen `/home/art/scratch/attention-retention-review/round-3/tree`; reply `reply.md`. BLOCKING, one MAJOR and one NIT; both actionable and folded.

- MAJOR no-default-startup timing test: advance the fake clock a full day after installation and before starting the hook; assert all 101 eligible turns remain held and no days exist. This catches an install-time scheduled job, not just synchronous work.
- NIT missing agent-without-project finding denial: added a restricted project conversation that Alice can create and Art cannot access, then assert Art cannot create its finding. This complements Carol's project-without-agent denial.

Review COMPLETE at the standing three-round bound. Final tagged verdict BLOCKING (missing tests, now folded); no fourth round. No implementation changes since 496b2eec324a2d3f3e58ba225952c259da10a36b; no known hole remains. Implementer judgment: ship on final-head green CI. The non-clear verdict is explicitly reported in PR/task/evidence note. Final targeted validation recorded in the PR.
