# Attention digests cold review

ASSESS: high. Data: schema 3. Security: inherited central scopes and nested role grants. Contract: digest operations. Concurrency: retry revisions and nested rollback. Environment: no install/deploy changes. Uncaught: targeted tests and CI cover this implementation.

CLAIM: digest rewrites atomically supersede central asks using revision-specific identity.
WHY: retrying a write must preserve a person's answer; an explicit rewrite may ask again.

Round 1: BLOCKING. Frozen source 5b74f81e150eb393d4300650c8c8030922c94015; TREE sha256:4e386f58790a02db5f7a417d3422789f069f3f118c78ea667986c1f44f559157. /home/art/scratch/attention-digest-review/round-1/reply.md.

- NIT unused legacy helpers: actionable, removed needsOfRow and yesNoText from the copied pure question parser.
- CRITICAL missing service collection operation grant: actionable, added central mayAct for attention.digests; type-only service test now expects denial, separately granted collection service succeeds.
- MAJOR untested collection bounds: actionable, tests now cover default 100, explicit 1 and 500, and reject 0/501/fractional limits.
- MAJOR nested resolve refusal rollback: actionable, two prior asks plus an injected second nested refusal prove all asks, digests, conversation references, receipts and notifications unchanged. Separate raise-refusal-after-resolve test also restores the previous open ask.
- MAJOR authored fields untested: actionable, read-back and replacement assert summary, asks, decisions and tasks.
- MAJOR policy project inheritance untested: actionable, digest/ask/conversation scope checked, shared-project member can read, member of only the referenced project cannot read or see live record.
- NIT hash vector: actionable, pinned literal dg-29237ec06e2f for cv-b28ed6ba6479 + NUL + run-1, independently calculated with SHA-256.

Round 2 pending. No further rounds after three; decide by the standing bounded-review rule.
