# Secrets and grants on the new side

## Remote command client

`loom-secrets-client` requires explicit `LOOM_URL` and `LOOM_TOKEN_FILE`. It
interprets shared `secretCommands` metadata and calls registry operations; it
never opens loom.db, an old Secrets directory, a key, or a piece executable.
The small legacy syntax/acknowledgement transformations stay in the transport
boundary; command metadata owns binding names and flags, and the daemon owns
policy and state rendering. This keeps the existing typed mutation operations
unchanged instead of adding a second daemon write API solely for CLI rendering.
This separate executable leaves existing `loom secrets` dispatch unchanged until
the final move. Tokens supply the actual authenticated principal; environment variables
cannot assert an owner, service or house. The owner commands below require a current
household owner, including metadata reads. A host's old same-user access is not
remote authentication.

| Old command | Remote command / operation | Behavior |
| --- | --- | --- |
| `list [--json]` | same / `secrets.command` | Sorted names only; compact JSON or one name per line, exit 0. |
| `may AGENT NAME [--json]` | same / `secrets.command` | Startup policy only; allowed exits 0, ask/denied exit 1, old text preserved. |
| `state q-ID` | same / `secrets.command` | Pending/granted/expired/denied/revoked; missing exits 3. New cancelled requests explicitly return cancelled. Current authority is determined from the surviving request-linked grant, so moved/replaced grants cannot claim access. |
| `policy houses NAME AGENT [--off]` | same / `secrets.startup` | Atomic chosen-agent edit, old stderr acknowledgement, existing startup operation's registered-agent/known-name validation. |
| `add NAME` | same / `secrets.set` | Nonempty bounded UTF-8 from stdin only; trims one final newline, never argv. |
| `add NAME --force` | `replace NAME` / `secrets.set` | Force/upsert is dropped: explicit replacement requires the existing name; no list-then-write race. |
| `rm NAME` | same / `secrets.remove` | Old stderr acknowledgement. |
| Terminal no-echo value prompt | Settings password form | Dropped from this client; stdin or Settings avoids terminal-mode mutation. |
| `init`, `bundle export/import` | Separate holder lifecycle/final move | Dropped from the remote client: no crypto keys or plaintext export on its registry path. Lifecycle work remains required below. |
| `get --reveal`, `podman`, `issue` | Trusted runtime sink / service `withValue` | Dropped from the remote client; it has no value-read operation, host environment bypass or local injection subprocess. Production runtime sink wiring remains required. |
| `policy houses-import` | Offline metadata importer | Bulk legacy source transfer stays offline, not a series of partial remote policy writes. |
| `ui`, `ui page/act`, `api --json` | Settings and typed registry operations | Old manifest/page/envelope protocol retired. |
| House `request`, `status` through old API | `request NAME --job UUID --why TEXT [--minutes N]` / `secrets.houseRequest`; `status q-ID` / `secrets.houseStatus` | Compact metadata JSON only; current central body authentication, described below. |
| House granted `get` | Trusted Runtime sink | Remains required; no plaintext command or value-read operation is introduced. |

Mutations use the same complete registry id, member-bound writeId and input on
every transport retry. Add/remove stay unavailable in normal next mode until
production holder mutations are installed; fixture holders prove the command
path without activation. Malformed bindings exit 2, denial 4, missing records 3,
and conflict/unavailability 1; provider messages and response bodies never become
errors. A malformed acknowledgement is never printed as success. UTF-8 values
are limited to 64 KiB; owned input buffers are erased. JavaScript strings and the
serialized retry request remain in this process for the call and cannot be
securely erased. The client retains no cross-process retry file; after uncertain
failure it does not claim rollback. Durable production holder reconciliation
remains required before activation.

The checked-in oracle records real output from
`sleepunit-agents/loom-secrets@bc8d2117b8ac35a33ff54ab8fb33ab59b0d8ed39`
on synthetic metadata. The in-process next/staging HTTP test replays the same
cases and compares stdout, stderr and exit codes. It never launches an old
program. This completes these owner command bindings, not the authenticated
house API, holder lifecycle, exact runtime grants transition or full t-2208.

This piece is under construction for t-2208. Next mode installs metadata and
grant operations independently of holder configuration. `installSecrets` owns
names, requests, policy and core grants in loom.db; `installSecretValues` still
needs an injected mutation holder. No public value read operation is exposed.
Authenticated holder reads are explicitly configured for Changes; runtime sinks
and authenticated write/remove/rotation composition remain required.

## Daemon retry fingerprints

`installSecretValues` requires an explicit independent 32-byte random daemon
fingerprint key as its fifth argument (Attention, when used, is sixth). Both
value operations use domain-separated HMAC-SHA-256 of core's full canonical
input for their retry receipts. The input and key never enter retry storage;
the public result remains a fixed acknowledgement. The installer snapshots
caller-owned key bytes; composition must erase its input and load the same key
on restart, from private storage outside loom.db and its backups. This daemon
key is separate from the holder's receipt key and age identity. Missing or
incorrectly sized keys refuse before either value operation is registered.
Fixed keys in fixture installers are synthetic test data only.

No key is generated or discovered here. The explicit persistent async loader
and binding are described below; the older synchronous fixture seam still
requires the same caller-provided key across restarts. Do not use a fresh
random key at every startup. Existing unkeyed receipts are not rewritten by
this change and remain guessable until removed under a separately verified
migration or expired. Production value operations are still uninstalled;
authenticated async holder composition, persistent key loading and safe key
rotation remain required before enabling them. No real database is changed.

## Holder storage prerequisite

`openHolderStore(directory, identityFile, fingerprintKeyFile)` is holder-process
storage, currently unconnected to the executable, socket and registry. It opens
only its own `holder.db`, containing age ciphertext and durable mutation receipts.
Its explicit directory, identity and independent 32-byte random fingerprint key
must be private, owned by the process user; database files must not be symlinks or
hardlinks. Keep the fingerprint key separately from ciphertext database backups.
Changing either key or identity without explicit retained material is refused; see holder key rotation below.

The trusted authenticated caller supplies the **actual member ID** and UUID
writeId after checking current household permission. This storage API does not
authenticate or authorize a supplied member string. Never expose it directly as
an HTTP/registry endpoint. Names, add/replace mode, action, member, writeId and
every value byte enter a keyed full-input fingerprint. Reuse of a member's writeId
with different input fails; identical retries succeed across restarts without
reapplying the mutation, including after a later replacement or re-addition.
Different members have independent writeId namespaces. Receipts are retained.

Ciphertext and receipt commit in one SQLite transaction with FULL synchronous
durability; encryption finishes before that transaction and replay/mode checks
repeat inside it. Failed receipt writes roll back the value change. Concurrent
writers may fail busy and retry. The store copies input before awaiting encryption,
erases its copy on every completion, and returns only fixed errors. Reads return
owned bytes for a trusted caller to erase; no public value read is added.

This asynchronous API must be awaited outside the synchronous `KeyHolder` registry
seam. Authenticated transport, current permission checks, metadata reconciliation
after holder-success/loom-DB rollback, runtime sinks, rotation, importer and final
composition remain required. Existing read-only directory sources are unchanged.

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
The reader accepts raw age envelopes with headers below 16 KiB and one payload
chunk: it bounds encrypted payload length before invoking decryption, so oversized
plaintext is never materialized. The age library still authenticates the whole file.
The TLS implementation and JavaScript may retain internal/string copies; trusted
callbacks still must not retain, return or log credential strings.

Holder arguments are paths only: `--socket`, `--ca`, `--cert`, `--key`,
`--identity` (age identity file), and `--values` (ciphertext directory). All paths
are explicit absolute paths; no old home, file or program is searched. The
socket parent and ciphertext directory must be owned by the current OS user and
private (0700). The socket is 0600; key, certificate, CA, identity, ciphertext
and config files must be private regular files owned by that user, with no final
symlink or hardlink. Use one dedicated PEM CA certificate for this holder/daemon pair with serverAuth
and clientAuth certificates. Server DNS identity is verified even over the socket.
The holder refuses an occupied socket path rather than unlinking it. Normal close
removes the socket; after a crash an operator must verify the old holder is gone
before removing its stale socket. No installation or certificate provisioning is
performed here.

`loom serve --next --secret-holder /absolute/private/config.json` explicitly
composes the real source into `NextChangesOptions`. Config fields are `socket`,
`ca`, `cert`, `key` (daemon TLS identity), `servername` (holder certificate DNS
name) and `github` (public forge owner to secret-name map). No configuration means
no value source. Invalid configuration refuses startup with a fixed error; CA material is parsed
independently because Node TLS can silently ignore a malformed CA.
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

## Next-mode household grant asks

The normal next composition root binds `secretGrantAttention` to the installed
Attention source registry before installing Secrets, even without a Changes
credential source. Requests raise managed household asks; the source capability
never crosses a registry door. Only a current household owner may answer. Yes
grants the exact requested temporary scope and duration; No, Done and Dismiss
deny. None of these Attention answers enables Always. The actual answering
member is retained in the ask, request and grant. Direct `secrets.answer` also
resolves its managed ask in the same transaction.

On restart the root registers the source again, so persisted managed obligations
can be answered. If applying the grant fails, the ask, request, grant and nested
operation receipts roll back together, with no Live notification; retrying the
same answer can then succeed. An intentionally preinstalled Secrets instance
keeps its supplied dependencies; custom installers remain responsible for their
Attention connector and retain the existing fail-closed managed-request checks.
This adds no holder mutation, runtime job authentication, automatic grant or
real-data import. Those obligations remain on t-2208.

## Synchronous holder acknowledgement

The existing `KeyHolder` write and runtime-handoff seam requires completed,
synchronous acknowledgement. Set, remove and handoff reject both native Promises
and thenables, consume rejected asynchronous output, and discard synchronous
output. A rejected save/removal commits no metadata, operation receipt or Live
notification; a rejected handoff records a failed attempt and no confirmed use.
The same operation can retry with a compliant holder.

This check cannot cancel work already started by an invalid asynchronous holder.
The asynchronous read channel must not be connected to the synchronous mutation
seam. Persistent write/remove/rotation, full-input and authenticated-member durable
receipts, and their production composition remain required on t-2208.

`KeyHolder` implementations are trusted in-process code. This check handles
accidentally async adapters with ordinary native Promises (including a shadowed
`then`) and thenables. It does not sandbox adapter code or native Promises whose
`constructor`/`Symbol.species` have been sabotaged: JavaScript consults those
properties before allowing a native rejection handler to attach. Production
adapters must not return such objects or independently log credential material.
The persistent production adapter and its regression tests must satisfy this
constraint when that adapter is composed.

## Async holder mutation transport (not registered)

`holder-mutations.ts` adds a separate mutual-TLS Unix socket with bounded binary
POSTs for add, replace and remove, and empty 204 acknowledgements only after the
holder store completes. The client snapshots input before awaiting, owns and
erases its copy, uses a five-second absolute deadline and never exposes response
bodies or provider errors. The server bounds input at 64 KiB, erases owned bytes
after store settlement, and has no read endpoint. The five-second server bound
starts at connection acceptance, before TLS or HTTP headers complete; clients
use one fresh connection per request and keep-alive cannot extend the bound. It shares only TLS/private-path
helpers with the existing read listener; the read channel and executable stay as
before. No automatic retries or stale-socket cleanup are introduced.

Every listener requires a trusted authority callback. The callback receives the
TLS certificate fingerprint and the daemon's member assertion; it must pin the
permitted daemon, resolve the authenticated actual member, and check current
household write permission. The assertion alone and the daemon's TLS certificate
are not end-member authentication. A pass-through callback is invalid production
composition. Authorization runs before consuming input and again before each
store call, including receipt retries. Changed/denied member resolution fails
closed. The store receives the resolved member, never the asserted member.

A timeout/disconnect can occur after a durable write starts or commits. Callers
must retry with the identical member, writeId and complete input; they must not
infer rollback from transport failure. Storage already started is not cancelled;
its input remains owned until it settles, then is erased. Authorization applies
at admission and immediately before starting storage; it does not cancel an
already started storage mutation.

This module is not wired to the holder executable, normal startup or registry.
Before activation, t-2208 still requires real trusted authority composition,
async registry dispatch with current authenticated member/permission checks,
metadata reconciliation after holder success/loom transaction rollback, rotation,
runtime sinks and the remaining importer/client/Settings/move verification.
It cannot be injected into the synchronous `KeyHolder` seam.

## Settings preview

`/p/settings-preview` is an owner-only kit app. Names, change history, usage,
requests, policy and grants are live records. The `secret.settings` capability
record contains only the agent choices, server time and whether value mutations
are installed. It uses household policy even for a service explicitly listing
that record type. A missing capability shows an owner-only message; a lost feed
removes every editable reader. Empty names never imply permission.

Secrets show who has grants, startup membership, Always request toggles,
confirmed/unconfirmed use, change history, missing policy names, and warnings for
no recorded use or a recorded change older than a year. Unknown change time is
not interpreted as an old value. Grants are grouped by exact agent or service;
revocation carries the displayed scope, including service absence. Requests offer
Allow once, Always and Deny through the existing first-answer operations. Piece
settings link directly to the apps that own sharing, approval rules, schedules
and venue configuration; no raw imported settings object is exposed.

Add and replacement values live in an uncontrolled password input, cleared before
dispatch. They are never put in a component draft, storage or record. The shared
in-memory operation client retains the exact call for uncertain retries, as for
other writes; JavaScript cannot securely erase its strings. No value is rendered
or read back. Removal requires confirmation. An uncertain write can only retry its
original call; it cannot initiate another write while its outcome is unknown.

The production holder mutation installer is still missing, so normal next mode
explicitly disables value forms; this app does not pretend it is connected. This
increment does not complete t-2208 or provide its importer/client/runtime wiring.
The single two-window browser test uses a fixture-only synchronous holder, checks
cross-window updates, exact scoped revocation, restricted-member isolation and
sentinel absence from the DOM and every database table. CI uploads six Settings
screenshots (390, 1280, 1920; Neon Noir and Daylight) in the Settings evidence run.

Settings mutations share one window-only call/lock across readers, navigation,
app remounts and feed loss. An unavailable response keeps that exact call locked;
only its original retry is offered. Value replacement and removal share the lock.
No session draft or second value copy is added. A full browser reload discards
in-memory retry state, matching the common data-client contract.

Request rows start an explicit daemon read when opened. Direct links offer Check
request. Allow/Deny controls appear only after that read confirms the same live
pending record, and each answer repeats the daemon read immediately before the
write. Navigation, feed loss, a changed request or a failed check cancels it.
The backend still decides first-answer and current authorization atomically.

The capability schedules its next refresh with Live's fake-clock-compatible
expiry mechanism at the next grant expiry or year-old change boundary. New grants
and changes invalidate it and reschedule that boundary. No screen timer/poller is
added. Never policy overrides recorded grant labels and startup membership; every
missing policy key is shown, including rules with no startup/request agents.

Inherited default Auto is displayed as checked automatic permission for every
agent, with the default-policy explanation. Those inherited checkboxes are
read-only: the existing Stop operation edits explicit Always membership and cannot
turn off inherited Auto. Explicit per-name membership remains editable. Every
scoped grant displays its exact service, including “No service” when absent.


## Startup policy editing in Settings

The secret reader offers separate “Allow AGENT at startup” checkboxes. These
call household-owner-only `secrets.startup {name, agent, on}`. Each edit reads
the current policy inside the operation transaction and changes only that
agent's startup membership, preserving request level, Always agents, duration,
default and every other name. Concurrent readers therefore cannot replace an
unrelated policy edit with an old browser snapshot. The shared Settings mutation
lock and exact-call uncertain retry apply to these edits too.

Enabling requires an existing name and an agent currently registered in household
membership or a project. Explicit per-name Never refuses enabling; the default
request level remains independent of startup, matching the runtime start rule.
Saved startup members no longer registered are shown so owners can remove them,
including under Never. Removal affects future starts; already running houses may
retain delivered values. Existing temporary grants and request records are not
revoked or rewritten. No runtime value delivery or production holder mutation is
activated by editing this metadata.

## Offline metadata import and verification

`loom migrate secrets --home <stopped-new-home> --from <copied-secret-directory>
--identities <map.json>` imports metadata only. The identity document is
`{"agents":{"old-art":"art"},"members":{"old-owner":"jonathan"}}`;
all referenced identities require exact injective mappings to the imported
household. There is no answering-owner fallback. Import the household first.
The copied source and destination must be separate, including canonical aliases;
overlap and symlink/hardlinked input files refuse before acquiring a write lock. This standalone command accepts an
explicit copied directory, like the other piece import commands; snapshot-manifest
validation belongs to migrate plan/all/verify. The final move must separately migrate ciphertext and provision the holder; this
command never decrypts or installs a credential.

The source files are `store.sops.json` (validated top-level names; encrypted
values and SOPS metadata are discarded), `policy.json`, `requests.json`, and
`audit.jsonl`. Missing files retain legacy empty defaults, but an entirely absent
source refuses. Checksums distinguish absence from an explicit empty file.
Strict JSON decoding rejects duplicate keys, invalid UTF-8 and unexpected metadata
fields. Invalid input errors never include source bytes. Audit events are retained
as value-free legacy metadata and projected into change/use history. Historical
host reads use the explicit `legacy-host` service label; unknown authors use
`legacy:unattributed`, never an invented owner. A restore is displayed as an add
while its original event remains in the retained source metadata. Unknown change
time is zero; Settings uses actual change history for age warnings.

Names, mapped policy, request history, exact scoped grants (including moved
originals for paired revoke), audit history, pending household Attention asks and
source receipts commit in one transaction. Pending asks are managed by the real
Secrets source after next startup and retain their original creation time.
Source-owned ID collisions refuse. A repeated identical source/mapping is a no-op
and preserves subsequent edits; a changed source or mapping refuses. Independent
verification, rather than replay, detects destination edits.

`migrate plan/all/verify` discovers a Secrets directory by the encrypted store or
its policy/request envelope, registers it after household (and after Attention
when present), and compares every physical metadata table plus the Secrets-owned
Attention rows without running the importer or writing the destination. Multiple
sources require an explicit plan. The default plan records same-name identities
from the snapshot household; edit it for renamed principals. The default legacy
source is **outside** the old loom home: `~/.config/loom-secrets`, overridable by
`LOOM_SECRETS_DIR`. The snapshot coordinator must explicitly carry that root;
patterns within the loom home cannot discover an external directory. No real
snapshot/import or holder activation is performed by this implementation.

This completes Secrets metadata persistence/registry verification, not the
runtime grants transition: legacy runtime path-pattern permissions and relay
pairs (`commons/stores/runtime.db`, grants/household) are not equivalent to a
blanket piece grant and must not be broadened by this importer. Their exact
operation/relay mapping remains on t-2208 with the runtime composition. Holder
lifecycle, generated command client, remaining typed Settings and final move/leak
ledger also remain required before that task closes.

## Persistent holder lifecycle and current authority

`loom-secret-holder --config /absolute/private/holder.json` now composes the
persistent age ciphertext store with separate read and mutation sockets. It
loads the existing explicit identity and independent holder receipt key, refuses
an occupied socket or changed key, closes both listeners before the store, and
cleans partially started listeners on failure. It generates no keys and reads no
legacy store. The previous explicit read-only age-directory flags remain
available, and cannot be mixed with `--config`.

The strict private JSON config has these fields (all file/socket/directory paths
absolute):

```json
{
  "read": {"socket":"/private/read.sock","ca":"/private/ca.pem","cert":"/private/holder.pem","key":"/private/holder.key"},
  "mutation": {"socket":"/private/write.sock","ca":"/private/ca.pem","cert":"/private/holder.pem","key":"/private/holder.key"},
  "authority": {"socket":"/private/authority.sock","ca":"/private/ca.pem","cert":"/private/holder.pem","key":"/private/holder.key","servername":"daemon.example"},
  "directory":"/private/store",
  "identity":"/private/age-identity",
  "fingerprintKey":"/private/holder-receipt-key",
  "daemonFingerprint":"UPPERCASE:COLON:SEPARATED:SHA256:FINGERPRINT"
}
```

The fingerprint above is a placeholder: supply the exact 32-byte X509 SHA256
fingerprint in Node's uppercase colon-separated form. Each peer certificate needs
serverAuth and clientAuth when used in both directions, with its own matching DNS
SAN. Different certificates may be supplied for the read and mutation servers;
the daemon certificate used by the mutation client must match the authority
server's pinned fingerprint. Only the holder's read server key can serve reads.

The daemon starts its dedicated authority socket only with
`loom serve --next --secret-authority /absolute/private/authority.json`. This
strict private JSON contains `socket`, `ca`, `cert`, `key` (daemon server identity)
and `holderFingerprint` (the holder authority client's exact certificate SHA256).
It owns that listener's shutdown, including failed next startup. The endpoint is
not a registry operation or public HTTP route. It accepts only an empty POST
from the pinned holder; a member assertion is checked against current household
ownership in the actual daemon database on every call, independently of injected
sharing used elsewhere. Missing members, scoped owners, agents, service names,
missing authority, wrong hostname or a different certificate fail closed. No
permission snapshot is cached. Socket permissions and the absolute five-second
connection deadline apply before TLS/headers finish.

The holder pins the daemon before accepting a mutation assertion, then checks
current authority before consuming value bytes and again before starting the
store mutation, including receipt replay. Work already started may commit after
a disconnect or later permission change; a transport failure never promises
rollback. Stable full-input/member write receipts prevent obsolete retries from
repeating writes. Read access on this persistent lifecycle also pins the daemon,
beyond the dedicated CA. Both read lifecycles now also bound accepted connections
before TLS or incomplete headers; the old read-only lifecycle retains its CA
identity contract. Listener ownership/deadline code stays explicit in the three
protocol modules: the small duplication avoids coupling independently consumed
read, mutation and authority lifecycles to a new generic transport abstraction.

This connects the production holder process and current database authority;
async registry set/remove plus durable metadata reconciliation are still required
before normal Settings value forms are enabled. The synchronous fixture installer
is not used with this async holder. Safe identity/receipt-key rotation, daemon
retry-key loading/rotation, runtime sinks/house API, final ciphertext migration,
and full Changes/Bridges deployment acceptance remain on t-2208. No installed
configuration, credentials, source import or service activation accompanies this
code. Fixture integration exercises actual TLS, encrypted storage, restart,
current-member removal, same-CA peer rejection, failed startup and shutdown.


## Async preparation and receipt ordering

The core registry now checks a prepared write's existing operation receipt and
registered external recovery hooks before calling `prepare`. A committed matching
retry returns its acknowledgement without preparing again, including after permission
loss for an ordinary operation. Operations marked `recheckPolicy` or `windowOnly`
still require current policy before replay. A name or full-input
fingerprint mismatch conflicts before preparation. External recovery can reconcile
metadata and publish changes in that same transaction, preserving its original
receipt deadline. Receipt, recovery and permission checks run again after awaited
preparation, so another write that commits during preparation still wins.

Preparation alone is not a holder write protocol. Without an `admit` hook it
receives no durable reservation: two fresh calls can both prepare, authentication can end
during the await, and the later loom transaction can roll back. Do not put holder
mutations in `prepare` on the strength of the preflight check. The explicitly
composed async installer below adds admission and retry reconciliation; production
startup still needs persistent keys and daemon reconciliation before enabling it.
Settings value forms remain unavailable in normal next mode.

## Committed holder receipt lookup

The private mutation socket also accepts an empty `POST /v1/receipt`, with the
same authenticated member assertion and UUID write ID headers as a mutation.
`localHolderMutations(config).hasReceipt({member, writeId})` returns only a boolean:
empty `204` means that the resolved actual member's write ID has a durable
receipt; empty `404` means no receipt was visible at the lookup. Other statuses,
nonempty/chunked responses, transport errors and invalid provider output fail
with the same fixed private error. The current authority runs before lookup and
again before the answer; wrong peers, missing members and revoked owners receive
no evidence. The persistent executable exposes this through its existing socket,
with the existing private paths, mutual TLS and five-second absolute deadlines.
There is no registry/public route, value read, name listing, fingerprint or
credential output. Lookup does not decrypt, mutate, replay or extend a receipt.

A positive answer is evidence for **that member/write ID only**. It cannot verify
a caller's proposed name, action, mode or value. Before using it for metadata
reconciliation, the daemon must durably reserve the complete registry viewer/id,
operation name and keyed full-input fingerprint, bind the unique holder write ID
to that reservation, and retain the metadata needed to finish in commit order.
A different input or operation ID must not borrow a prior write's receipt. Those
admission/reservation and metadata reconciliation components are still required.

A negative answer is never a cancellation fence: a write encrypting or committing
concurrently can become durable after the lookup, even after its connection has
failed. Keep its reservation and retry the identical full input/member/write ID;
never release it, generate a new write ID or conclude rollback from `false`.
The store's existing atomic ciphertext/receipt transaction makes a failed commit
invisible and a successful receipt survive restarts and later replacement/removal.
Normal Settings value forms and production async registry writes remain disabled
until durable admission and metadata reconciliation are connected. No credential,
installed configuration, real import or host activation accompanies this change.

### Legacy timestamp precision and refusal diagnostics

Offline Secrets import accepts UTC ISO timestamps with no fraction or any number
of fractional digits in audit and request metadata. Projected record times use
integer milliseconds; validated original timestamps stay unchanged. The retained
legacy snapshot includes `auditText`, preserving the complete validated UTF-8
audit input (spacing, line endings and fractional digits), alongside parsed audit
metadata. Unknown fields and invalid dates still refuse before retention.

Source refusals name a fixed check: `copied-source`, `identity-options`,
`source-files`, `encrypted-store`, `policy-request-plan`, `identity-mapping`,
`audit-schema`, or `audit-projection`. Parser messages, keys and values never enter
the error. Destination failures identify `destination-paths`, `destination-state`,
`destination-lock`, or `destination-open`; internal exception messages remain hidden. This is an offline
parser repair only; it performs no live import or holder/Settings activation.

## Durable async mutation admission

`installAsyncSecretValues` registers async set/remove against the production
holder mutation interface; it is explicitly composed and is not enabled by
normal next startup yet. Core's optional synchronous `admit` hook commits its
reservation before `prepare` begins. Admission may store metadata only, cannot
publish changes, and requires its own outer transaction. Preparation receives
that exact core viewer/id, operation and keyed full-input fingerprint.

Secrets retains a non-expiring journal binding that full identity to the member,
caller write UUID, a separately generated unique holder UUID, name, action,
admission sequence, durable commit order and commit timestamp. The always-installed global recovery
guard prevents another operation from borrowing a reserved core id, even when
a restart has no configured holder. A caller's UUID cannot borrow an existing
holder receipt. No value or unkeyed value hash is stored. Pending and committed
writes hold one global durable lock; a later write cannot overtake unreconciled
metadata, even for another name. Other Secrets metadata writes (including
descriptions, grants and policy) wait on the same lock so reconciliation cannot
erase an edit accepted later. This deliberately serializes rare owner writes
so uncertain holder commits cannot be reordered by receipt observation. Identical concurrent calls share preparation within the daemon; holder
idempotency handles overlap across daemon lifetimes.

After a holder acknowledgement (or positive receipt lookup for the admitted
holder UUID), the journal records commit evidence separately from core's final
transaction. Recovery applies metadata/history and completes the reservation
atomically with the core acknowledgement. A failed metadata transaction keeps
the name locked and recovers on the identical retry. Completed retries never
reapply old metadata after later replacement/removal. Missing receipt evidence,
transport failure, expired core result, lost authentication or permission never
free a reservation. Current owner policy gates recovery. No background worker
or timer is installed by this slice.

Normal Settings value forms remain disabled. Persistent daemon key loading and
rotation, holder identity/receipt-key rotation, daemon retry and reconciliation
without caller plaintext, production root composition, trusted runtime sinks and
house APIs, Changes/Bridges composition and the final move remain required on
t-2208. This slice changes no installed configuration or live secret store.

### Public holder generation

The persistent holder exposes `generation()` through `localSecretSource(config)`
and authenticated `GET /v1/generation` on the same private mutual-TLS read
socket. It returns one opaque random UUID, independent of all credential bytes,
and never decrypts a value. Only the pinned daemon can read it in persistent
holder composition. It is metadata, not authority to read a secret.

The marker changes in the same FULL-durability SQLite transaction as each
successful add, replacement (including identical bytes), or removal. Exact
receipt replays, rejected writes and rollbacks leave it unchanged; restart
preserves it. Opening a pre-generation holder initializes the marker without
rewriting values or receipts. One global marker intentionally invalidates every
consumer lifetime on any credential mutation.

Bridges still require the follow-up that polls this role and binds its public
marker to both daemons, composes People names and CLI options, and removes the
old engine credential interface. This PR adds the real prerequisite; it does
not activate a bridge or change an installed holder. The legacy age-file source
has no generation capability and the endpoint refuses it.

## Explicit daemon retry-key loading and binding

`installAsyncSecretValuesFromFile(db, operations, sharing, holder, keyFile,
attention?)` is the explicit async composition entry for a persistent daemon
retry key. Supply an absolute file path in a private owned directory. The file
must contain exactly 32 independently generated random bytes, be owned by the
current user, have no group/world access, and have one hard link. Symlinks,
nonregular files, missing files and malformed lengths refuse with the fixed
`Secret retry key unavailable` diagnostic. Startup neither generates a key nor
replaces an existing file. File bytes are bounded and erased after installation;
the async installer retains its own crypto key copy. A FIFO descriptor is rejected
before reading, and even a file growing after inspection is read only up to
33 bytes (the key plus one excess byte), then refused and erased.

Every async installer, including the in-memory fixture entry, now atomically
pins a domain-separated HMAC of a fixed constant in `secrets_meta` under
`daemon-retry-key-v1` before registering either value operation. No key, value,
or unkeyed value hash enters the database. The binding and write journal have
the same indefinite lifetime: reopening without a previously bound key refuses startup,
even with no unfinished write. Explicit rotation is described below. Keep the daemon key separately from database
backups and retain it for every restored journal. Loading runs outside any
operation/outer transaction so its binding cannot be rolled back underneath
registered operations.

An older journal containing any write intent without a key binding refuses
installation. Its full inputs are deliberately absent, so startup cannot prove
which supplied key made those fingerprints. Do not delete intents or invent a
binding to make it start; adoption of such a journal needs a separate explicit
recovery protocol. This does not affect the normal next instance, which has
never installed async values. No installed home is changed by this work.

For explicit daemon retry-key rotation, the file argument also accepts
`{active: absoluteNewKeyFile, previous: [absoluteOldKeyFile, ...]}`. The in-memory
fixture installer similarly accepts `{active: newBytes, previous: [oldBytes, ...]}`.
Every file has the same privacy, ownership and bounded-read requirements. All read
buffers are erased on success or failure; the installer owns crypto copies of every
key. Startup reads all files before changing the database or registering operations.
There is no key generation, replacement, discovery, registry rotation operation or
host activation. Rotate only while the daemon is stopped, using independently
prepared private files and retaining every historical key separately from backups.

`secrets_meta` also retains a sorted list of all bound key verifiers under
`daemon-retry-keys-v1`. The original v1 binding remains unchanged. The list and any
initial v1 binding commit atomically before operation registration; malformed
manifests, duplicate keys and omission of any historical key refuse startup. A
v1-only database upgrades when its original key is supplied. No journal row or
core receipt is rewritten. Keys cannot be retired because retry identities live
indefinitely; retain the complete key ring for restored backups too. Selecting a
previous key as active is an explicit configuration choice, not a way to omit
any other historical key.

Core supplies the hash hook with authenticated canonical viewer, operation name
and core id. For that exact viewer/id, Secrets compares the supplied full canonical
input against retained keyed hashes and preserves the old hash only on a match.
Otherwise it uses the active key. Fresh identities always use the active key, even
if another viewer's identical input was previously written with an old key. Changed
input still conflicts before holder IO. Holder ids, attribution and commit order
remain unchanged; a lost acknowledgement can reconcile after rotation without
repeating effects. Completed writes remain recoverable after core receipt expiry.

Old-to-new lifecycle: silent key-file replacement stays refused; explicit retained
key-ring startup replaces the former rotation refusal. The synchronous fixture
value installer retains its single-key contract and is not production composition.
Holder identity/receipt-key rotation and daemon receipt reconciliation are described
below; normal-root composition remains. Normal next
mode and Settings value forms stay disabled until those prerequisites are delivered.


### Holder identity and receipt-key rotation

The persistent holder configuration accepts optional `previousIdentities` and
`previousFingerprintKeys`, each an explicit list of absolute private file paths
(at most 31). `identity` and `fingerprintKey` remain the active pair. Stop the
holder, preserve all old files, and restart with the new active files and the old
ones in these lists. Both authenticated listeners bind before storage opens; their request gates refuse
until storage is ready, so listener failures cannot commit a key-history change.
No keys are generated or retired, and no real-home rotation
is performed by this implementation. TLS certificates and their current pinned
peer fingerprints remain separately configured; these lists contain age identities
and receipt HMAC keys only.

New ciphertext uses only the active age recipient. Reads retain every historical
identity. Existing ciphertext, full-input/member receipts, original v1 binding,
and public generation are unchanged at rotation. Old receipt retries compare the
original full input against all retained HMAC keys; fresh receipts use only the
active key. An obsolete add/remove therefore cannot undo a later write, even after
multiple rotations or removal of all current values. Positive receipt lookup does
not need a value or decryption. Historical keys cannot be retired while indefinite
receipts exist.

Startup atomically records the active identity/key pair as a domain-separated
binding in holder-only `holder_key_history`. Every historical pair (including the
original v1 binding) must be derivable from the supplied files, even if no values
or receipts remain. Malformed history, duplicate material, unsafe files or omitted
historical material refuse startup with a fixed error and leave stored data
unchanged. An absent legacy history table is distinct from a missing row in an existing
history table, which is refused. Existing holder tables without their original
v1 binding are also refused, including a damaged legacy store. V1-only stores upgrade in the same transaction; no ciphertext or receipt
rewrite occurs. Explicit reactivation of an old pair is allowed with the complete
ring. Keep every used identity and key separately from the ciphertext backup.
This is retention-based rotation: existing ciphertext is not reencrypted, and old
key compromise is not repaired by selecting a new active pair. Operate one holder
lifetime at a time and restart all holder handles when changing the configuration.

The new holder operations replace no old CLI command; this is explicit configuration
of the separate holder. Normal root mutation
composition (Settings values remain disabled), authenticated house flows/trusted
sinks, Changes/Bridges accounting, remaining Settings parity and the final migration,
leak and staging ledger remain task obligations.


### Daemon receipt reconciliation without caller values

Explicit daemon composition starts `startSecretReconciliation(app, recovery)` with
the controller returned by `installAsyncSecretValues` or its private-file loader.
The foundation owns shutdown. Startup schedules one check immediately; further
checks run every minute, coalescing overlapping runs and large clock advances.
Normal next mode does not install the mutation transport or this job yet, and
Settings values remain disabled. A staging composition must supply a fixture
holder, never a real credential endpoint.

The job reads the oldest unfinished admission and asks the authenticated holder
only for the original member/unique-holder-id receipt. It never reads a value or
resends set/remove. Only boolean true changes pending to committed. False, malformed
results and failures retain the global lock indefinitely: absence cannot fence a
write already in flight. An uncommitted set therefore still requires the original
caller input to retry; the daemon cannot recreate plaintext. Shutdown after a
lookup prevents late database access. Concurrent caller work and completed rows
are not repeated.

Positive evidence records durable observation time and commit order. Core's
in-process `recoverWrite` runs registered global recovery guards with the journal's
original viewer/id/operation/keyed full-input hash, without admission, preparation
or run. The Secrets hook rechecks the original member's actual current household
authority after the last await. A revoked member cannot be replaced by another
owner; the committed row remains locked until authority is restored. Metadata,
removal cleanup, attribution/history, journal completion and the core acknowledgement
commit in one transaction, with live changes published only afterwards. Failed
metadata or core acknowledgement persistence rolls all those effects back and is
retried later. No operation or external door accepts a forged recovery receipt.
Core acknowledgement expiry does not expire the journal's full-input identity.

Old-to-new jobs: daemon receipt checks replace caller-only lost-acknowledgement
recovery for confirmed mutations. Caller retry remains necessary for unconfirmed
writes; no cancellation, timeout release or negative-receipt fence is introduced.
Normal root composition, authenticated house flows/trusted sinks, Changes/Bridges
accounting, full typed Settings parity and final move/staging evidence remain.

### Explicit daemon mutation composition

Normal next startup may opt in with `--secret-writes /absolute/private/writes.json`
paired with `--secret-authority /absolute/private/authority.json`. It does not
start the holder or generate keys. The holder remains a separately managed
process. With no mutation configuration, value forms stay unavailable.
The existing `--secret-holder` config remains the independent read path for
Changes and Bridges.

The private mutation file has exactly `holder` and `retryKeys`. `holder` has
absolute `socket`, `ca`, `cert`, `key` paths and the holder certificate's
`servername`. `retryKeys` has an absolute `active` path and a `previous` array of
absolute paths, retaining every previously bound daemon retry key. These are
references to private files, never literal key or credential values. The holder
pins the daemon certificate and calls the separate authority socket, which
checks the actual current household owner in the database. Missing authority,
unsafe key files or missing historical keys refuse startup.

Root installation loads and binds the retry ring, installs asynchronous set and
remove, and schedules positive receipt recovery on the foundation clock. It uses
the same trusted Attention source for atomic removal cancellation. Only this
explicit configuration makes Settings value forms available.

In staging, every admitted holder id gets a `secret-write` effect before even
its receipt lookup. A due hold makes zero holder calls. After owner release,
exact caller retries can send the originally admitted input; the recovery job
only probes receipts and never resends a mutation. Started or interrupted
(`uncertain`) effects retain that release for the same journal-bound holder id
across restarts. A historical effect can stay uncertain after receipt recovery;
the journal's complete state is the authoritative completion record. A negative
receipt never releases the reservation. Shutdown refuses late holder replies
before touching effects or the database, preserving recovery on restart.

Old-to-new addition: old local value writes are explicit authenticated
`secrets.set`/`secrets.remove` API calls through this composition; daemon
reconciliation is a foundation clock job, with no timer or subprocess. This
ships code only; provisioning files, importing data and activating a holder on
a real machine remain separate owner-present final-move steps.

### Authenticated house request and status

`secrets.houseRequest {job, name, why, minutes?}` accepts a current central
Sign-in body credential. `job` is a required assertion matching that credential,
so retry identity includes the job; it confers no authority. Agent, house and
service are derived from the exact credential and current Runtime job. The
UUID job is the new house grant scope; legacy `h-N` scopes remain distinct.
Copied viewers, agent-only tokens, service/job mismatches, imported or ended
jobs, revoked boxes and Runtime policy-held execution refuse, including replay.
No request can supply an agent, scope, service, sink or path. Existing policy,
carry, deduplication and managed household Attention answer semantics apply.
The public acknowledgement contains only request ID and stored decision state.

`secrets.houseStatus {id}` checks the same current credential/job/service binding
and returns only pending, granted, expired, denied, cancelled or revoked. Another
house's request is indistinguishable from a missing request. Granted requires a
surviving request-linked exact-scope grant. Both operations read only new stores.
They replace the metadata request/status part of the old house API. The typed
`loom-secrets-client` binds them as:

```
loom-secrets-client request API --job UUID --why "needed for this job" --minutes 30
loom-secrets-client status q-ID
```

`--job` is an explicit assertion, never inferred from `HOUSE_ID` or another
environment variable. The token file must contain the actual central body
credential. The daemon derives all authority and refuses stale, unbound or
mismatched credentials. Request retries keep the same complete input and core
operation ID; no writeId, agent, service, scope, sink or path is sent.

Request stdout is compact `{id,state}` JSON plus a newline, with exit 1 for a
stored denied decision and 0 for the other acknowledged states. Status stdout
is compact `{state}` JSON plus a newline, with exit 0 for each known state.
Missing or foreign requests exit 3; refused authentication exits 4; malformed
arguments exit 2; transport failures and malformed acknowledgements exit 1.
Provider error text and arbitrary response fields are never printed. The old
house API's human request sentence (including grant expiry) and status list are
replaced by these exact-request metadata projections; the existing owner `state`
command keeps its legacy text contract. This change is deliberate: the new
public operations expose no expiry, request list or secret value.

Granted-get, trusted Runtime sinks, and typed granted-get remain required on
t-2208. No value-read endpoint or credential delivery is introduced here.

### Holder-side handoff command channel (not activated)

`holder-handoff.ts` provides a separate private mutual-TLS Unix command socket.
The daemon client sends only an opaque UUID ticket to `POST /v1/handoff/:id`;
the response is an empty 204 after the trusted runner transport settles. The
holder process reads its own value and passes its owned bytes directly to that
transport. No value-read callback or plaintext response exists on this channel.
Both peers pin exact dedicated certificate fingerprints; the client checks its
pin during TLS authentication before sending the ticket. Metadata, error bodies
and arbitrary provider diagnostics never become a command result.

The holder's trusted `HolderHandoffAuthority` resolves the ticket to a secret
name and an authenticated runner destination. It must validate the current
central body, exact job and assigned runner, live grant, policy, staging release,
and ticket lifetime. A destination's `current` check runs before source access
and again after it; its `handTo` transport must fence the same assignment at
final runner release. These are trusted process roles, never caller-supplied
URLs, paths, names or callbacks. A daemon-local service value reader is not a
runner destination.

This primitive does not admit tickets, implement one-use receipts, register
`secrets.houseGet`. The later persistent startup composition below can install
a listener in `startPersistentHolder` from explicit private configuration. Runtime's
real authenticated destination transport and the daemon's ticket admission,
revocation and staging protocol must be composed before activation. Those remain
required on t-2208; an in-process fixture destination is not production delivery.
Uncertain handoffs are never automatically retried: destroying the local request
cannot undo a runner transfer that already began. The owning ticket protocol must
prove any retry safe. Holder shutdown fences pending reads, drains started source
and runner work before returning, and erases the borrowed buffer only after the
runner transport has settled. Client shutdown destroys and drains pending requests.

Old-to-new mapping: this adds the local metadata command transport for the old
house granted-get path, without exposing the old plaintext HTTP/CLI response.
The public granted-get command and operation remain unavailable until the complete
trusted runner path and value-free accounting are present. No installed config,
real holder, home, credential or host step changes here.
Private TLS/configuration/key reads use a fixed limit-plus-one scratch buffer,
refuse growth or metadata changes during the read, and erase scratch bytes on
both success and failure. The shared helper preserves the separate 128 KiB
ciphertext limit; it never reads a growing file to EOF without a bound.
The absolute handoff deadline is shared from raw socket acceptance through
Node's TLS wrapper. Its expiry flag and timestamp are checked synchronously
before release, independently of delayed socket-close notification. An unknown
TLS wrapper fails closed rather than starting a fresh per-handler budget.

### Runtime destination metadata (not a credential sink)

`runtimeHouseDestination(app, sharing, viewer)` is Runtime's trusted role for an
actual current body proof. It binds agent/job/service, assigned runner/box and
claim time; copied viewers and ordinary agent tokens have no body proof. It
requires a current eligible box and matching current house configuration, no
imported/ended/reset/written-off job, and no configured execution hold. A changed
assignment or claim cannot become the same retained binding. Each `current()`
call rereads authoritative state and the original central credential.

This role grants no secret and returns no URL, path, certificate, buffer or
transport callback. Its check is necessary for ticket admission and final release;
it does not replace the secret grant, expiry, policy, staging or authenticated
worker sink checks. Public get and holder activation remain unavailable. The real
runner must bind its own pending delivery sink to this exact metadata before
Secrets can connect the complete path.
Destination checks also require current household agent membership, even when a
previously resolved token proof remains retained. Daemon shutdown marks a shared
Foundation admission fence synchronously before awaiting operator/listener drains;
new and retained destination bindings refuse throughout that interval.

### Durable handoff tickets (not activated)

`secretTickets` admits an opaque UUID only for the original central body proof
and Runtime destination. A ticket pins the exact grant record, current policy,
job/service, runner/box and claim, and expires after at most thirty seconds or at
the grant deadline. Grant replacement or deletion, policy edits/removal and name
removal permanently revoke outstanding tickets, including revoke-and-restore.
No public operation accepts or returns tickets, and no holder is started here.

A trusted holder authority may claim once, after the `secret-read` outside-effect
gate releases it. Staging keeps that effect due until an owner explicitly releases
it. The durable claim precedes holder IO; a crash, failed acknowledgement or
missing original proof cannot retry it. Restart preserves ticket rows and loses
the original in-process body proof, so even an unclaimed ticket cannot resume.
A retained claim checks the same current Runtime destination, grant, policy,
expiry and effect before release, and shutdown fails closed. Confirmed worker
acknowledgement may finish the claim; anything else stays uncertain. This is
metadata accounting only, with no credential reader or transport callback.

The authenticated holder-to-worker sink, its final release check, the public
metadata-only get command, usage accounting and complete runner composition
remain required before connecting this role to the holder channel. Neither a
caller-selected endpoint nor daemon-local plaintext is an acceptable substitute.

### Private ticket authority channel (not activated)

`listenTicketAuthority` and `remoteTicketAuthority` connect the separate holder
to the original `secretTickets` role through a dedicated private mutual-TLS Unix
socket. Both peers pin dedicated certificates before sending ticket metadata.
Only the pinned holder can claim an opaque ticket, check the retained claim, or
finish it after worker acknowledgement. Replies contain the exact secret name
and original agent/job/service/runner/box/claim metadata, or an empty acknowledgement.
No value, endpoint, caller-supplied destination or provider diagnostic crosses
this channel. Responses and requests are bounded; a silent peer times out.

Claiming consumes the durable ticket before replying. Lost replies, failed
checks and shutdown cannot recreate it. The server retains original proof
closures only; restarting the server cannot reconstruct claims from stored rows.
It prunes stale claims and marks outstanding claims uncertain when closed.
The client never retries a failed call; a failed current check stays invalid.
Final acknowledgement rechecks original authority in the ticket role.

This channel is not installed in daemon or holder startup. The authenticated
worker pending sink and its final release fence remain required. A remote
`current()` response alone does not authorize value release; the holder-to-worker
transport must authenticate the exact original destination and perform the final
release check. No public get, typed granted-get or holder activation ships here.

### Persistent holder handoff startup

The private `loom-secret-holder --config` composition now accepts an optional
`handoff` object alongside its existing read/mutation configuration. This is
owner-provided process configuration, never an operation argument or endpoint
discovery. `handoff.listen` is a holder TLS listener; `handoff.authority` is a
holder client TLS configuration (including `servername`) for the daemon ticket
listener, pinned by the existing `daemonFingerprint`. Each `handoff.workers`
entry contains an exact `binding` (agent, job, runner, box, claimedAt, optional
service), a client TLS `config` for that worker's input socket, and its server
certificate `fingerprint`. Empty workers deny all handoffs; duplicate bindings,
unknown fields, overlapping socket selections and invalid TLS material fail
startup before storage/key history commits.

Startup composes the original remote ticket claim with managed holder routes
and pinned worker transports. All listeners bind before opening storage, and
requests fail closed until storage is ready. Shutdown retires routes and drains
listeners and their original continuations before closing ticket/worker clients
and storage. Existing configurations without `handoff` keep read/mutation only.
The daemon's existing `secretWorkers` startup resolves the configured token digest
through original Signin/Runtime capabilities; the fixture exercises that real
composition with a persistent holder and a worker input using the original
remote worker proof. Staging still prevents dispatch before the holder reads.
This does not install configuration or enable public/granted get; production
worker orchestration and final owner-present activation remain move work.
