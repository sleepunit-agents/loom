# Conversation metadata migration review

Scope: explicitly installed attention conversation/turn operations, schema 2, tests and minimal registration. Digests, import, retention, findings and apps remain required by docs/attention-piece.md and t-2205. Three-round maximum.

Assessment: high. Data: additive database migration. Security: operation and live scope filtering through central policy. Contracts: metadata operation and record shapes. Concurrency: retry and nested rollback semantics. Delivery: no startup or deployment changes. Mechanism: targeted tests and CI cover the introduced metadata paths. Claim: explicit installation preserves existing asks and provides metadata-only writes and scoped reads without touching the old side.

## Round 1 — BLOCKING, folded

TREE: sha256:4b725b5356b29865b06927791ca4b4063855401167e29e56e31e9e102f9767e2 (9 files).

- MAJOR, independent identity test: actionable. Replaced helper-derived regex check with literal cv-b28ed6ba6479 for agent art, venue relay, place test (SHA-256 of NUL-separated fields).
- MAJOR, latency boundaries: actionable. Added message/reply/message/message/reply sequence proving the previous reply excludes old messages and the oldest pending message wins, then a clock-skewed reply proving the zero clamp.
- MAJOR, project scope coverage: actionable. Added project-scoped creation, persisted operation and live scopes, and rejected project replacement, removal and member addition.
- MAJOR, schema upgrade status preservation: actionable. Seed and verify both existing ask and status rows across installation.

Implementation unchanged; targeted tests now cover these gaps. Round 2 pending.
