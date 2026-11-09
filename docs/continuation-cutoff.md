# Staged continuation cutoff enforcement

Companion to draft loom-box#148 and loom-clock#24, tracked by t-2004. This
is core enforcement only. No production issuance policy, collector, installation,
or end-to-end cutoff guarantee is enabled by this change.

The runtime-only Comms adapter accepts integer Unix-millisecond `expiresAt`
(positive, safe integer, within the JavaScript Date range) on continuation posts.
The deadline is part of the existing complete-payload HMAC. A changed deadline
conflicts with an existing receipt. Missing deadlines support exact legacy
receipt lookup only; they never authorize a first insertion or renewal.

First insertion encrypts the words, then takes the message database's
`BEGIN IMMEDIATE` writer lock. Inside that transaction it checks the existing
receipt, reads the real core wall clock, observes a persisted highwater, and
checks cutoff before inserting. No asynchronous work separates the clock check
and insertion. A transaction admitted before cutoff may commit after cutoff.
A backwards clock holds new acceptance until wall time recovers. Deadline and
rollback refusals commit their highwater observation before returning an error.

`op: reconcile` on the same runtime-authenticated adapter takes the same full
payload and ref. It cannot append. Deletion wins over any retained receipt and
returns `deleted`, which says nothing about erased historical acceptance.
Otherwise, under the SAME `BEGIN IMMEDIATE` lock as insertion, it returns:

- `delivered` and the original sequence for an exact receipt;
- HTTP 409 for a conflicting commitment;
- `not-accepted` for a missing deadline-bound ref only after core cutoff;
- `unresolved` before cutoff, during clock rollback, for missing legacy refs,
  or when SQLite cannot acquire the fence within its busy timeout.

This waits for earlier acceptance transactions. Writers arriving after a fenced
negative result must independently fail their cutoff check. Plain missing-ref
reads, transport errors and busy failures are never proof of non-acceptance.

Remaining gates: authenticated clock inspection and admission checks, runtime
reconciliation of indeterminate reports, real runtime/core crash crossing cutoff,
legacy upgrade proofs, independent review, and existing core timing failures.
Production issuance remains deliberately held in the runtime draft. All companion
PRs remain drafts; no merges or installation follow from these local proofs.
