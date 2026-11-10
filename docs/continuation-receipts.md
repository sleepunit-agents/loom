# Runtime continuation receipts

The runtime-only `/api/loom/comms/adapter` post accepts
`continuation-<64 lowercase hex>` as a stable reply reference. Agent, member and
piece credentials cannot call the adapter. This adds no authority to a wake's
origin conversation or to a body; trusted issuance and exact clock/child binding
remain the runtime's responsibility.

Core binds the reference globally to the normalized payload (agent, destination
thread, text, run and harness label). The hash is an HMAC using the existing
private words key, stored beside the encrypted reply. Exact retries return the
original sequence. Reuse with a different payload returns 409; malformed
continuation references return 400. The writer checks and inserts in the same
SQLite IMMEDIATE transaction, including across listeners. No plaintext report or
new receipt store is introduced. The existing spawn reference behavior is kept.

Acceptance commits before returning. If the runtime dies after core accepts but
before saving its receipt, retrying the same payload/reference returns the
original sequence. Exact retries also work after archiving or text expiry while
the reply row remains. Deleting a thread deletes its receipt rows; the destination
then refuses new posts, so deletion does not recreate a thread. Receipt retention
is the existing reply-row retention, not a new indefinite words archive.

Tests exercise the authenticated HTTP boundary, conflicting payload/destination,
concurrent first requests, and a separate core writer killed with SIGKILL after
commit but before returning a receipt; a different listener reopens the database
and returns the original sequence with one reply row.

This is one layer of runtime PR148's continuation integration. It does not prove
clock wake/delivery/admitted-child binding, runtime outbox restart recovery, CLI,
tick draining or installed delivery. Both changes remain draft until the complete
integration and real negative/end-to-end process-kill proofs exist together.
