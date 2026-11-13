# Secrets and grants on the new side

This piece is under construction for t-2208. It is not installed by next mode.
`installSecrets` owns names, requests, policy and core grants in loom.db;
`installSecretValues` needs an injected key holder. No value read operation is
exposed. The production separate authenticated holder and runtime/attention
composition are still required before activation.

## Removal increment

| Old behavior | New behavior |
| --- | --- |
| `rm NAME`, UI `remove` | Household-only `secrets.remove {name, writeId}` through the value installer. Missing names return `not-found`; the generated CLI will map this to exit 3. |
| Delete encrypted value | `KeyHolder.remove` with stable member-bound write ID; no raw holder result or error reaches the registry. |
| Clear standing auto | Explicit and inherited auto become ask. Start mappings, duration and Never are preserved. |
| Existing temporary requests/grants after removal | All secret grants for the name are deleted, allowed requests revoked, pending requests cancelled. History and carry pairing remain. Re-adding the name cannot revive those grants. |

Removal deliberately strengthens old cleanup: the old implementation could retain
live request grants; these are now revoked. The old removal of an auto rule also
dropped start mappings; this operation preserves them independently, as Stop does.
Existing bodies may retain a value they already received. Removal affects future
uses only. No installed or old-side program is changed.

The holder must durably bind its operation ID to the name and authenticated
member and acknowledge retries after holder success/database rollback. A committed
metadata receipt also prevents a duplicate write ID in a fresh registry operation
from deleting a later re-addition. Reusing that ID for a different name conflicts.
The metadata transaction rolls back all names/grants/requests/policy/receipt writes
and emits no Live changes on failure. Holder errors are fixed, value-free messages.

## Remaining delivery and final move

The full old command/route/job ledger, audit and usage/change metadata, importer,
generated CLI output/exit parity, Settings app, screenshot CI, real holder,
authenticated runtime and Changes adapters, trusted household attention source and
transactional answer hook, fixture/staging composition and end-to-end checks remain
on t-2208. This page is the beginning of that ledger, not completion of the piece.

Only the final owner-present move may import real metadata or activate the piece.
The importer must be offline, one transaction, checksum guarded, repeatable for the
same source and refuse a different source, with ID/count/content comparisons and
interruption tests. It must preserve scopes, expirations, policy and carry/revoke
metadata and import audit metadata without importing value bytes into loom.db.
The old stores remain untouched for rollback. No import or host step is performed
by this increment.

## Service use inside the daemon

`installSecretServices` adds household-only `secrets.grantService` and
`secrets.revokeService` for `{service, name}` (grant optionally has `expiresAt`).
Only installed services and existing names may be granted. These entries live in
the same central grants table with the reserved principal `service:<id>`; `:` is
not a valid agent ID. They are household records, never grants to an agent with
that service's name. Agent grants and service grants do not authorize each other.
Removal already deletes every grant for the secret, including service entries.

`secretUseRole` binds the authenticated service viewer at composition and offers
`withValue(name, use)`. It checks current registration, the exact service grant,
expiry, Never policy and name existence before reading the holder and again
before calling `use` after transport awaits. There is no public value operation,
retry result or Live change. Holder and callback errors become a fixed message.
The injected `SecretValueSource` must deliver a fresh exclusively owned buffer
from the authenticated separate holder; that buffer is erased on every exit.

The callback is trusted built-in code. It must not log, store, return or retain
credential text or any transformed copy. Its result is returned only to its
in-process caller, never automatically to the registry. JavaScript strings cannot
be securely erased; the callback's credential string is dropped when it returns.
Production local transport, provider account lookup (`resolveGitHub`), staging
holds and authenticated composition remain required; this increment installs
nothing in next mode and reads no old files. Agent value delivery remains
`handSecret`/`handTo` to a runtime sink.

## Value change history

| Old behavior | New behavior |
| --- | --- |
| Audit `set` with `how: add/replace` | Value installer commits `secret.change` with action `add` or `replace`. |
| Audit `removed` | Removal commits action `removed`; the history survives removal and re-addition. |
| Page change time | Household-only `secrets.history {name}` and `secret.change` Live records. Description edits do not count as value writes. |

Changes contain only stable ID, name, action, authenticated member and daemon time.
They never include values, descriptions, holder results or raw errors. History is
committed with metadata and the operation receipt: a rollback emits no history or
Live change. Repeating a stable member-bound write does not duplicate its history.
The holder still owns full-input write-ID validation. Unlike the old best-effort
change audit, failure to persist this metadata fails the operation; the holder
must acknowledge retries after its own write succeeded. Additive migration 3
preserves existing metadata and starts empty history; it does not invent old times.

This is change history only. Read/issue/service-use audit, usage summaries and old
audit import remain required on t-2208. The service-use role still writes no
metadata. No new installer is wired into next mode by this increment.

## Offline policy import slice

`importSecretPolicy(db, from)` in `src/pieces/secrets/policy-importer.ts` takes
an explicit old `policy.json` path. It reads that file only, never discovers a
home, decrypts values or invokes an old program. It is not wired to a command or
the daemon. The final offline migration must compose it with the remaining
metadata importers in one enclosing transaction, behind the stopped-daemon gate.

| Old policy field | Imported meaning |
| --- | --- |
| `v: 1` (or absent) | Accepted source version; not a new-side record field. Other versions refuse. |
| `default`, `secrets` absent | Old defaults `ask` and an empty rule map. |
| `grant`, `agents` | Exact request level and auto agent membership, independently of start permission. |
| `houses` | Exact at-start membership, independently of request permission. |
| Positive integer `minutes` | Preserved up to 480; larger durations clamp to 480 as old `decide` does. |

Malformed or unknown fields refuse with a fixed error, including accidental
value-bearing input; no raw parse diagnostics are returned. Unlike the old
runtime reader's silent fallback on malformed JSON, migration requires a valid
source so an invalid Never rule cannot quietly become Ask or Auto. Unsupported
invalid durations refuse rather than being silently repaired. This is an
explicit import validation choice, not a change to the old side.

The source bytes' SHA-256 receipt is committed with schema and policy. Identical
bytes are a no-op even after a later policy edit; different bytes refuse. A
first import refuses an existing destination policy. The importer compares the
complete written policy, including names and array contents, before recording
the receipt; interruption or comparison/receipt failure rolls everything back.
The source file is unchanged. Names, requests, grants, carry/revocation and old
audit import remain required; this slice does not claim the complete secrets
migration or final command, and does not perform a real import.
