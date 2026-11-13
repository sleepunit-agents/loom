# Conversation metadata migration review

Scope: explicitly installed attention conversation/turn operations, schema 2, tests and minimal registration. Digests, import, retention, findings and apps remain required by docs/attention-piece.md and t-2205. Three-round maximum.

Assessment: high. Data: additive database migration. Security: operation and live scope filtering through central policy. Contracts: metadata operation and record shapes. Concurrency: retry and nested rollback semantics. Delivery: no startup or deployment changes. Mechanism: targeted tests and CI cover the introduced metadata paths. Claim: explicit installation preserves existing asks and provides metadata-only writes and scoped reads without touching the old side.

Round 1 pending, frozen under /home/art/scratch/attention-conversation-review/round-1. The review receives artifact and contract only.
