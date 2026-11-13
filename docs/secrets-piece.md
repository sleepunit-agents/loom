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

## Offline request source model

`parseLegacySecretRequests(Buffer)` in `request-source.ts` parses stored v1
`requests.json` metadata only. It preserves IDs, original stored states (an
expired grant is still `granted`), exact house/service presence, timestamps,
minutes, policy/owner decision, actual answering member when present, Always,
and both carry links. It neither grants access nor reads a file or clock.
Missing attribution on old owner decisions stays missing; no owner is invented.

Malformed/unsupported sources, unknown fields, mismatched map IDs, self links
and impossible local decision metadata refuse with a fixed value-free error.
Unlike the old runtime's empty-store fallback, migration refuses corruption.
Historical carry partners can have been pruned by the old 200-record retention;
links are retained even when their other row is absent. This source model does
not assert cross-row consistency or authorize a missing partner. The final
importer must validate effective carry/revocation semantics and import matching
scoped grants, names, policy and audit in its enclosing transaction. This slice
has no DB writes, receipt, filesystem discovery, command or daemon registration.

The source model retains any string agent identity, matching legacy `houseOf`;
the final importer must map it to a registered principal without normalizing it
or granting agent-wide access. Unsupported new-side identities must refuse at
that composition boundary. Parsing alone never makes a principal authoritative.


## Strict offline JSON metadata

Policy and request inputs share a fatal UTF-8 decoder and a JSON token walk
that rejects duplicate decoded object keys at every depth, including escaped
aliases. A duplicated `default`, secret rule or `grant` cannot silently discard
an earlier Never rule. Unknown fields cannot be hidden behind a duplicate key.
Both public parsers keep their fixed redacted error messages. This is input
validation only; it adds no command, daemon registration or real import.

## Offline carry-link validation

`parseLegacySecretRequestLinks(Buffer)` layers cross-row validation over the
request source parser. Surviving partners must be reciprocal, keep the same
agent, secret, exact service and expiry, move to a different house, and represent
a plain owner Allow moved only once. Paired revocations must agree in state and
revocation time. Multiple rows cannot claim the same partner, even if retention
pruned that partner. A pruned middle row cannot hide a second carry, and carry
creation must precede the inherited expiry even for a later-revoked row.
Contradictions refuse with a fixed value-free error.

The function returns the original metadata, including expired stored grants and
missing historical partners, without inventing member attribution. It performs
no current-time check, principal mapping, grant creation or DB/file access.
Missing partners are retained for history, never proof of authorization; the
final importer must refuse unsupported effective-grant composition, suppress
claimed originals and map every identity to a registered principal. The complete
transactional importer and daemon registration remain pending on t-2208.

## Offline request authority plan

`planLegacySecretRequests(bytes, principals, snapshotAt)` in `request-plan.ts`
adds explicit principal resolution and effective-grant planning to the validated
source model. It performs no IO, DB writes or current-clock lookup, and is not
registered with the migration CLI or daemon. The caller supplies snapshot time
and exact legacy-string bindings to a set of registered new-side agent IDs.
Any source creation or decision after snapshot time refuses, including pending,
denied and revoked history: the planner cannot rewind a later stored state.
Events exactly at snapshot time are accepted.
There is no same-name fallback or normalization; two distinct source principals
cannot map to the same new principal, including historical/pending rows.

The plan retains every original request field under `source` alongside its
mapped agent. Exact `who` attribution stays on the original row, including
revoked history; it is not copied onto an unattributed carry. Missing owner
attribution stays missing. Its grant proposals are
only the live `granted` rows at snapshot time, scoped to the exact house and
service presence, with the stored expiry. Expired, denied, pending, revoked and
claimed-original rows confer no authority. Always and policy grants remain
house-scoped and temporary; standing policy must be imported separately.
A live carry requires the surviving reciprocal original and cannot predate that
original's decision. A missing original on an expired/revoked carry remains
history; a missing original on a live carry refuses the plan. A claimed original
whose target was pruned is retained as history and never grants access.

Multiple live proposals for one mapped agent/name/exact house/service refuse,
regardless of order or expiry. The new table stores one grant per exact scope;
choosing one or unioning their durations would silently lose request provenance.
Different services, houses and names remain distinct. This conservative refusal
is an explicit unsupported-composition choice for the final offline import.

These are proposals, not complete `Grant` records. The final importer still
owns atomic names/policy/requests/grants/audit persistence, checksum and content
verification, attribution without invention, pending attention composition and
non-authorizing moved-original records needed for paired revocation. It must use
the household registry for `registered`, reconcile the same mappings with policy
membership, and preserve the original metadata for history. No real import is
performed by this increment.

## Combined offline policy/request plan

`planLegacySecretMetadata(policyBytes, requestBytes, principals, snapshotAt)`
resolves the union of request identities and every policy `agents`/`houses`
entry with the same explicit registered bindings. Distinct legacy identities
cannot map to one agent across inputs, separate rules or membership fields,
even for inactive rules or denied history. Repeated identical identities are
preserved; unused bindings do not create membership. Startup and request lists
remain independent, and levels, omissions, empty lists and clamped durations
retain the strict policy parser's meaning. Unsupported legacy policy IDs still
refuse rather than normalize. The strict policy decoder now lives in pure
`policy-source.ts`; `policy-importer.ts` keeps its existing parser export and
persistence behavior.

The result contains validated original policy membership, mapped policy and the
existing request plan. It performs no IO or registration. Names, actual member
attribution mapping, pending attention, moved-original revocation storage, audit,
atomic persistence/receipts and independent content verification remain the final
importer's work. This plan does not activate a runtime permission or import data.

## Offline destination request/grant records

`planLegacySecretRecords` builds on the combined policy/request plan without IO,
DB writes or implicit time. A dedicated entry-point test forbids filesystem and
subprocess calls, database dependencies and implicit clock access. It supplies runtime `GrantRequest` and `Grant` shapes,
retaining the full validated original metadata separately. Grant IDs use the same
pure helper as runtime writes. A live carried grant includes a moved-original
record at the original scope: it never authorizes use, but lets revocation from
either scope revoke the pair. An independent grant colliding with that record
refuses rather than being overwritten. Exact service absence and original expiry
are retained; expired, revoked, denied and pruned claimed originals create no
usable grants. Policy decisions remain policy decisions; Always remains temporary.

All surviving `who` fields require explicit injective bindings to registered
household members, including historical decisions. No same-name or first-owner
fallback exists. An unattributed historical request remains unattributed. A live
owner grant without surviving mapped attribution refuses this composition; a live
carry derives grant attribution from its surviving original while preserving its
own absent `who`. This conservative unsupported-composition refusal avoids naming
an invented answering member. The final importer must supply registered agents,
members and actual stored secret names from its destination, not caller assertions.

Pending requests refuse until the final importer can create trusted household
Attention asks in the same transaction. Unsupported service IDs and active grants
for absent names also refuse. This helper is unregistered and does not persist or
activate anything. Atomic names/policy/requests/grants/audit import, source receipts,
independent destination verification, pending Attention composition and migration
registry/CLI wiring remain required by t-2208.

## Authenticated local holder reads

`loom-secret-holder` is a standalone crypto-only process. It listens exclusively
on an explicit Unix socket, speaks TLS 1.3 with required client certificates,
and reads explicit private age ciphertext files (`NAME.age`) using its own age
identity. No request starts a child process. The age key is loaded only in the
holder; the daemon owns a different TLS client key. No value is supplied in
arguments, environment, errors, logs or plaintext files. Values are decrypted
in memory, bounded to 64 KiB, and owned buffers are erased after sending or use.
The TLS implementation and JavaScript may retain internal/string copies; trusted
callbacks still must not retain, return or log credential strings.

Holder arguments are paths only: `--socket`, `--ca`, `--cert`, `--key`,
`--identity` (age identity file), and `--values` (ciphertext directory). All paths
are explicit absolute paths; no old home, file or program is searched. The
socket parent and ciphertext directory must be owned by the current OS user and
private (0700). The socket is 0600; key, certificate, CA, identity, ciphertext
and config files must be private regular files owned by that user, with no final
symlink or hardlink. Use a dedicated CA for this holder/daemon pair with serverAuth
and clientAuth certificates. Server DNS identity is verified even over the socket.
The holder refuses an occupied socket path rather than unlinking it. Normal close
removes the socket; after a crash an operator must verify the old holder is gone
before removing its stale socket. No installation or certificate provisioning is
performed here.

`loom serve --next --secret-holder /absolute/private/config.json` explicitly
composes the real source into `NextChangesOptions`. Config fields are `socket`,
`ca`, `cert`, `key` (daemon TLS identity), `servername` (holder certificate DNS
name) and `github` (public forge owner to secret-name map). No configuration means
no value source. Invalid configuration refuses startup with a fixed error.
Connections authenticate both peers; reads have an absolute five-second deadline,
64 KiB response bound and generic failure. The existing bound service role checks
current owner-written grants both before and after acquisition. Configuration
creates neither secret names nor service grants. Staging holds scheduled Changes
reads and forge requests before either runs.

In-process next-mode tests use the real protocol with age ciphertext and separate
client/server certificates, restart the holder, exercise `withValue`, revoke and
expiry, verify failed authentication and buffer cleanup, and inspect every DB table,
operation receipt, Live notification and captured log for a sentinel. A separate
scheduled-job fixture proves root Changes composition and staging holds. The CLI
test verifies the configured source is actually delivered to `startLoom`.

This is persistent **read** delivery for Changes and future service consumers.
Authenticated write/remove/rotation with durable full-input/member write receipts,
runtime sinks, bridge composition, remaining importer/CLI/Settings work and final
move verification remain on t-2208. Existing synchronous `KeyHolder` mutation
operations are not connected to this asynchronous read transport. No real secret,
installed home, process, unit or deployment is changed by these tests or this PR.
