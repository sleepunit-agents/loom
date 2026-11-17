# Receiving identity retirement

This contract defines permanent retirement of next-side Discord receiving
checkpoints/raw receipts and Slack raw receipts. It states all lifecycle
acceptance obligations below; no external task or document supplies an unstated
requirement. There is no retirement operation, durable fence or cleanup worker
implemented by this document. Implementation remains open until the fixtures
below pass on actual centrally authorized Bridges and Runtime roles. This
contract authorizes no deletion in a running home, move, activation or deletion
of an old-side snapshot.

The project index [Bridges dispositions](bridges-dispositions.md) and task t-2210
are informational tracking references, not prerequisites to interpret this
contract. Completion evidence belongs in the repository's
`docs/bridges-receiver-lifecycle.md` (this page), with links from
`docs/bridges-dispositions.md` and `docs/bridges-contract-inventory.md`.

## Identity and recoverability

Use the same physical identity as the receiving store, without a new alias:

- Discord: venue, platform, workspace, agent, bot, token-secret reference and
  credential epoch. Encode with JavaScript `JSON.stringify([venueId, platform,
  workspace, agent, bot, tokenSecret, credentialEpoch])`, then lowercase hex
  SHA-256 of its UTF-8 bytes, as `discord-inbox.ts` does.
- Slack: venue, platform, workspace, agent, bot and authenticated app, encoded
  as JavaScript `JSON.stringify([venueId, platform, workspace, agent, bot, app])`
  (the JSON string itself, not its hash), as `slack-inbox.ts` does. All tuple
  fields are strings. Secret rotation alone is not a new identity.

A process stopping, missing credentials, unavailable holder, grant revocation,
setup revision change, disabling/removing a venue, platform failure, expired raw
words or absence from the current setup does **not** prove permanent retirement.
An identity without an explicit committed retirement remains recoverable subject
to current authentication/policy. Slack reconnects to the same identity recover
pending work; a replacement identity cannot read it. Discord reset only removes
the current checkpoint; it retains message tombstones. Existing one-hour raw-word
expiry remains independent and does not retire either platform's identity.

## What is implemented today

The Discord resume cursor is stored (`bridge_resume`) and resumed across a
restart, a pause and a lost socket. Its row records the identity it was made
under: the SHA-256 of `JSON.stringify([connection id, platform, workspace,
agent, bot, token-secret name, the last change to the connection's secrets])`,
computed in `src/pieces/bridges/shared-daemon.ts`. A lifetime is given the
cursor only if its own identity is the stored one, so after a secret is replaced
or the secret name changes the next lifetime identifies afresh, whether or not
the program was running when the change was made. The credential epoch here is
the newest `secret_changes` row for the connection's secrets; the permanent
retirement described below is still open.

Raw event words still expire after one hour. A message that was held (its
connection disabled, or its bot's agent ambiguous) keeps a `bridge_incoming` row
with what admission read, and is tried again from that row for a day after its
raw event is gone. A message that never got a row, because its channel's
metadata could not be read for the whole hour, is lost and counted in the
daemon's report.

## Owning transition

Implement an explicit next-side retirement transition owned jointly by Bridges
and Runtime, with authorization only through central policy: the current
authenticated viewer must be a household-owner member (`mayAct(viewer, {}, sharing,
"household")` from `src/policy.ts`). Here `sharing` is the current central
Sharing value: the predicate requires `viewer.kind === "member"` and an own
entry `sharing.members[viewer.id].owner === true`. No bridge-local policy
copy is allowed. An agent, project member without
household ownership, transport credential or delegated body credential cannot
authorize retirement. Recheck current owner authority for every call, including
receipt replay, inside the committing transaction. A public caller may
identify a candidate but may not supply its own trusted Runtime proof. Bridges
resolves the exact stored identity; Runtime supplies current durable disposition
of all work already handed off from that identity. Until this owning operation
and its authority exist, cleanup must fail closed.

Retirement is permanent for that exact physical identity. Commit an immutable
retirement fence before erasing anything. Reusing the same tuple must be refused,
including after restart or restoring setup. A desired replacement needs a truly
new physical identity, not a new local alias for the fenced tuple. A Slack secret
rotation cannot bypass this fence. The fence and dedup tombstones are not garbage
collected by this lifecycle.

The transition must serialize with raw receipt commit, normalization/handoff,
checkpoint commit/reset and other retirement attempts. In-flight asynchronous
platform or Runtime responses must recheck the fence before their final local
commit. After the fence commits, no receiver for it may save raw words, read or
resume its checkpoint, normalize/deliver a pending receipt or revive the identity.
A stale receiver and a newly constructed receiver must both obey it. Recording a
candidate or preparing a transition has none of these effects.

Runtime must reconcile each accepted handoff durably before retirement can
commit: either retain its accepted normalized delivery and ongoing job under
Runtime ownership, or record an explicit terminal disposition. Running, waiting,
uncertain or temporarily unreachable work cannot be inferred to be delivered,
failed or disposable. Unresolved disposition blocks retirement. Bridges must not
cancel a Runtime job, delete its transcript or recreate an accepted handoff.
The atomic transition must validate that the reconciliation still describes the
handoffs it fences; a proof computed before a new handoff is not sufficient.

Unhanded raw receipts are explicitly discarded by the authorized retirement,
never replayed into the replacement. Their stable dedup identities remain.
The transition records the exact identity, authorizing actor, time and bounded
summary of disposition without raw text, credentials or checkpoint contents.
Do not project raw identity evidence to an audience broader than central policy
allows. No old store, source file, command or installed piece is read at runtime.

## Bounded cleanup and recovery

After a committed fence, an in-process daemon erases raw event words and Discord
checkpoints for that fenced identity. Erasure is logical SQLite erasure; it makes
no secure-erasure claim about WAL, backups or copies already in flight. Consumed
receipt IDs and the retirement fence remain. Normalized inbox/outbox,
conversations, file associations and Runtime records are outside this cleanup.

Each pass performs at most 64 raw-row erasures per platform and 64 checkpoint
removals total, in one transaction. Select deterministically by stable identity
and receipt ID. Schedule once on startup and then with the injected operations clock
`clock.at(clock.now() + 60000, callback)` after each pass; coalesce missed ticks rather than looping to drain a backlog.
Do not scan unbounded unfenced identities to select a batch: the schema/indexes
must support bounded selection. Shutdown cancels future passes. A failed
transaction rolls back the whole pass and retries on the next scheduled pass.
A crash after fencing but before cleanup leaves a fenced, recoverable cleanup
backlog, never a resumable receiver. Repeating retirement returns its original
receipt; changed-input replay conflicts. No worker consumes an uncommitted fence.

The public operation is `bridges.retireReceiver`. Its complete strict input is
`{id: string, platform: "discord" | "slack", identity: string}`. `id` is the
caller-chosen durable operation ID (1–200 characters), distinct from the outer
transport retry ID; identity is the exact stored encoded key above. No extra
field, caller-supplied disposition or proof is accepted. Scope the durable ID
to this operation and current authenticated member ID; retain it independently
of expiring core transport receipts. Input equivalence compares platform and identity
byte-for-byte, independent of object property order. The permanent receipt holds
operation ID, actor, platform, identity, fence time and two original disposition
counts (terminal and retained-ownership). Receipt JSON is at most 8192 UTF-8
bytes; reject an oversized request before mutation, never truncate. Retain
complete private disposition evidence as separate indexed rows, one per stable
accepted-delivery ID with its terminal or retained-ownership status, atomically
associated with the fence. Counts must equal those rows; no omission is allowed.
Read evidence internally in keyset pages of at most 64 rows, not a growing
receipt array; all rows stay private. Reconciliation may prepare these rows
in bounded staging batches but only a complete, current set can authorize the
atomic fence. Public success returns only `{retired: true}`. A retry after
authority recheck returns that same success without recomputing disposition or
rewriting time. Changed current Runtime evidence is not changed caller input.
An already-fenced identity requested with a new operation ID records a new
authorized receipt against the existing fence without erasing more data or
changing its original disposition. No fence is created on denied, conflicting
or unresolved requests. Public unresolved disposition returns a conflict, not a
success. The generated client must return success/exit 0, denied/exit 1 and
conflict/exit 1 without private evidence in output.

## Required implementation fixtures

Use synthetic local SQLite and fake platform/network/holder IO. Drive scheduling
with the injected clock; no subprocess, browser or live workspace is needed.
These are acceptance obligations, not tests claimed to pass today:

| Case | Required observation |
| --- | --- |
| Same-identity restart | Unretired Discord checkpoint and Slack pending work recover; replacement identity cannot read them. |
| Identity components | Independently vary each tuple component while holding every other field fixed. In particular vary only Discord token-secret reference, only Discord epoch and only Slack app. Replacement cannot read, consume, fence or erase the original identity. Vary only Slack secret reference/epoch and prove same-identity recovery rather than retirement. |
| Temporary absence | Disable/remove/restore setup, unavailable holder, revoked/restored grant and secret rotation do not create fences or retirement cleanup. Independent age expiry still applies. |
| Permanent retirement | Actual centrally authorized owning transition fences exactly the selected physical identity; household owner succeeds after real reconciliation; non-owner member, agent and caller-supplied fake Runtime proof refuse without mutation. Revoked owner cannot replay a receipt. |
| Outstanding work | Real Runtime accepted handoff with running/waiting/uncertain work blocks unresolved retirement; explicit durable ownership/disposition permits it without deleting or redelivering that work. |
| Handoff race | Hold Runtime response before local commit, prepare retirement, introduce another handoff, then release: stale reconciliation cannot fence unseen work. No accepted delivery is lost or repeated. |
| Receiver race | Hold raw/checkpoint/metadata IO across fence commit; release it and verify no post-fence raw, checkpoint or normalized delivery commit. Exercise old receiver and reconstructed receiver. |
| Cleanup restart | Crash after fence commit and between successful batches; restart drains only fenced raw words/checkpoints and never reconnects that identity. Current unrelated pending work survives. |
| Bounds and rollback | More than 64 rows on each platform plus more than 64 checkpoints; one tick respects each bound. Inject failure after first platform update; all changes roll back, then next tick progresses. |
| Replay fence | Replay a platform event after cleanup, reset a cursor, restore old setup and restart; no raw revival or handoff. Dedup IDs and fence survive. Slack credential rotation cannot evade its identity. |
| Evidence bound | More than 64 accepted handoffs retain complete per-delivery private evidence and matching counts; page bound 64, receipt bound 8192 bytes, no truncation. Incomplete/stale staging cannot authorize a fence; restart preserves staged versus committed distinction. |
| Operation replay | Identical operation retry returns exactly `{retired: true}` publicly; a private database assertion verifies that the original internal receipt, fence time and disposition rows remain unchanged; changed identity/platform under the same actor/operation ID conflicts; injected disposition input refuses. Current evidence changes do not rewrite a successful receipt; a different actor has an independent operation-ID namespace. |
| Scope and shutdown | No raw/checkpoint/credential leaks through public records or client output; current identities and normalized/Runtime/file records untouched; shutdown prevents later scheduled mutations. |

Completion requires migration/indices, actual owner transition and Runtime seam,
receiver guards, daemon registration, public operation/client output and exit
fixtures, restart/race tests above, and a completion-evidence table on this page naming the merged migration, operation/client,
Runtime reconciliation and daemon changes beside every fixture row above,
including any remaining open row. Before those implementations land, every
fixture row above remains open. A helper with
a fake permit or negative tests alone does not complete this contract.
