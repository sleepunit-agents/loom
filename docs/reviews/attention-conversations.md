# Conversation metadata migration review

Scope: explicitly installed attention conversation/turn operations, schema 2, tests and minimal registration. Digests, import, retention, findings and apps remain required by docs/attention-piece.md and t-2205. Three-round maximum.

Assessment: high. Data: additive database migration. Security: operation and live scope filtering through central policy. Contracts: metadata operation and record shapes. Concurrency: retry and nested rollback semantics. Delivery: no startup or deployment changes. Mechanism: targeted tests and CI cover the introduced metadata paths. Claim: explicit installation preserves existing asks and provides metadata-only writes and scoped reads without touching the old side.

## Round 1 — BLOCKING, folded

TREE: sha256:4b725b5356b29865b06927791ca4b4063855401167e29e56e31e9e102f9767e2 (9 files).

- MAJOR, independent identity test: actionable. Replaced helper-derived regex check with literal cv-b28ed6ba6479 for agent art, venue relay, place test (SHA-256 of NUL-separated fields).
- MAJOR, latency boundaries: actionable. Added message/reply/message/message/reply sequence proving the previous reply excludes old messages and the oldest pending message wins, then a clock-skewed reply proving the zero clamp.
- MAJOR, project scope coverage: actionable. Added project-scoped creation, persisted operation and live scopes, and rejected project replacement, removal and member addition.
- MAJOR, schema upgrade status preservation: actionable. Seed and verify both existing ask and status rows across installation.

Implementation unchanged; targeted tests now cover these gaps. ## Round 2 — BLOCKING, reconciled

TREE: sha256:04c4baf0e1242886b8aa92113f39360e1491b2b71da25145a3f4a148ebe5f020 (9 files).

- CRITICAL, claimed timestamp-order latency: rejected. The governing old backend selects `WHERE ... kind = 'message' AND seq > ? ORDER BY seq LIMIT 1` in recordTurn, lines 348–349; it means first recorded pending message, not minimum timestamp. The new implementation preserves that exact rule. The review contract's ambiguous “oldest message” is clarified to “first recorded pending message (sequence order)”; docs and an out-of-order timestamp test make this behavior explicit. No latency implementation change. The old code remains the contract under the rebuild-house brief; timestamp-order semantics were never authorized.
- MAJOR, incomplete own-turn validation test: actionable. Added otherwise valid reply/action/note cases lacking only run or only outcome, so each requirement discriminates independently.

## Round 3 — BLOCKING, bounded stop and implementer decision

TREE: sha256:76806f235bddf0b1b3c01807d19af6bf3fed2975c71b0d87289848e2ff2dffce (9 files).

- CRITICAL, service collection gate: rejected. The gate calls central mayAct; policy.ts says services require `!!operation && ...operations.includes(operation)`. Existing src/pieces/tasks/index.ts likewise says `Collection reads filter by maySee; services also need an operation grant`. This is a central operation grant, not a piece-specific policy. Removing it would widen access beyond the established collection pattern. Added explicit service tests and documented the distinction between collection operation grants and type-only individual/live reads.
- MAJOR, explicit installation untested: rejected (frozen context omitted an existing test). attention.test.ts already starts with no install, checks `WHERE name LIKE 'attention_%'` returns no tables and filters `operations.offered('direct')` by attention prefix to an empty array, then installs successfully. Both assertions cover the new tables and operations; the full targeted run includes this file.
- MAJOR, no old-store sentinel: actionable. Setup now writes invalid legacy household.json and agents/art/memories.db sentinels; metadata installation and operations succeed, and a test verifies the bytes are untouched.
- NIT, latency absent assertion: actionable. The unsolicited reply now explicitly has no latency_ms property.

Three rounds reached; no fourth round. The last review remains BLOCKING as tagged; all actionable findings are folded. The two final major/critical claims are rejected with the code evidence above. No known implementation hole remains. Original remaining rebuild obligations are carried by docs/attention-piece.md. This bounded review and its non-clear final verdict must be reported with the merge; it is not an owner blocker under the 2026-11-12 review-by-judgment ruling.
