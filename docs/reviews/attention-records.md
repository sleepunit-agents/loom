# Attention records migration review

Scope: the explicitly installed ask/status backend, role, schema and tests. Conversation metadata, import and apps remain obligations of t-2205 and the rebuild-house brief. Three-round maximum applies.

Assessment: high. Data: new migration; security: central policy filtering at operation/live boundaries; contracts: role and stored record shape; concurrency: first-answer and retry semantics. Delivery: no deployment or automatic installation. Mechanisms: targeted tests and CI exist, but needed visibility and rollback checks. Claim: a new home can explicitly install the backend with stable asks and one person answer; existing homes are untouched.

## Round 1 — BLOCKING, folded

TREE: sha256:28588c265ec882d4a9c9fcc99a22318a4cdbf67bca27f70285d83b26132860d7 (5 files).

- NIT, duplicated load/decode: valid trade-off. Three short table-specific reads retain local types; no behavioral change. Revisit if another record type needs them.
- MAJOR, live authorization untested: actionable. Added reads of both registered live types for visible owner, other owner and agent against private records.
- MAJOR, transaction/notification boundary untested: actionable. A test operation nests attention.raise and fails; verifies write rollback and zero notifications. Success verifies notification after the outer transaction commits.
- MAJOR, explicit installation untested: actionable. Starts foundation without installation, checks absent tables/operations, then explicitly installs successfully (including live registrations, which reject duplicates).
- NIT, open/resolved stable identity: actionable. Added repeated raises in both states and verifies original result is retained.
- NIT, status audience preservation: actionable. Added project and agent changes alongside member change; each is refused.

Eight targeted tests and TypeScript pass after the folds. Implementation unchanged in this round; findings addressed by tests of its promised boundaries.

## Round 2 — CLEAR, stop

TREE: sha256:d60edccae324a25140dc3ff6c4669f07bb055b6989f9afe900b8da3f30f93a5c (5 files).

- NIT, duplicated load/decode: same accepted trade-off as round 1; table-specific readers remain small and local. The implementation retains this shape rather than adding a generic storage abstraction.
- NIT, status project/agent cases allegedly fail mayCreate: rejected. The frozen policy says `if (m?.owner) return true`, before project and agent checks. Alice is an owner, and mayCreate checks maySee on those separate scopes, so both inputs pass create authorization. Added direct assertions of that fact to make the discrimination explicit; tests pass.
- NIT, private resolve/re-raise authorization untested: actionable. Added denied calls by the other owner for both operations; tests pass.

No CRITICAL or MAJOR findings in round 2. Review stops under the standing three-round maximum. Final changes since the frozen round are test-only; all eight tests pass. Clear review is evidence, not merge authority. Exact-head rule and green CI are still required.
