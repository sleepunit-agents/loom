# Worker credential input primitive

`src/runtime-runner/secret-input.ts` owns an in-memory pending request for one
original worker input stream. The worker registers the exact agent, job, service,
runner, box and claim timestamp, its original synchronous local proof, an async
authority check, and a deadline of at most 30 seconds. A random pending id names
that request. The owning worker must cancel it when replacing the request; a new
request has a new id even for the same assignment. Local proof failure is sticky.
The async check must retain original central ticket authority; metadata equality
alone never establishes that authority.

An authenticated holder delivery consumes the pending id before awaiting bytes
or authority. After authority settles, the worker checks the connection and its
original local proof, then writes to the original stream without another await.
It never looks up a replacement stream. The dedicated input must consume its
borrowed write before invoking the write callback and must not retain the buffer
afterwards. The worker erases it after settlement. A failed write, shutdown or
missing acknowledgement is uncertain and never licenses a retry. Shutdown fences
pending work and drains an already-started stream write; the input owner must
settle write callbacks on cancellation as well as success.

`secret-transport.ts` carries this through pinned mutual TLS over a private Unix
socket. Both endpoint and expected certificate come from owning configuration,
never operation input. It bounds each connection from acceptance to five seconds
and each body to 64 KiB. Only the holder and original worker input see values;
responses are empty and diagnostics are generic. It does not serialize pending
proofs, reconstruct them on restart, or expose a daemon operation.

This is an unactivated component. No installed standalone worker composes
this transport with `secretTickets`,
`remoteTicketAuthority` and `listenHolderHandoff`. That composition must preserve
both the original central claim and the original worker request, bind the pending
id to its ticket, select configured transport from owning assignment, finish
central claims as uncertain on any failure, and pass staging/value-free accounting
checks before public get or typed-command access can activate.

## Retained central proof for a pending request

Trusted admission can pass the original worker handle's `{id, binding}` to
`secretTickets.admit`. It compares all assignment fields to Runtime's original
body proof before inserting the ticket. The pending id is immutable in the
original claim and its pinned holder metadata. It is never loaded from a durable
row. A pending id can be admitted once per role lifetime, including after failed
acknowledgement. The unactivated role keeps at most 1024 such tombstones and then
fails closed; production lifecycle/capacity handling is still required before
activation. Failed admission does not consume the pending id.

`listenTicketAuthority` accepts owner-configured worker certificate pins paired
with exact assignments. These peers can only check the original retained claim
for its bound pending id, through an empty `worker-current` response. They cannot
claim or finish a ticket, supply an assignment, or choose an endpoint. Holder and
worker pins must differ. `remoteWorkerTicketProof` retains a sticky check closure
for the original ticket/pending pair. That closure can be the async authority
check in `workerSecretInputs`; the synchronous local proof still fences the final
write after the network await. A true remote result alone grants no input access.

Tests compose actual ticket admission, retained holder claim, worker central
check and pinned holder-to-worker delivery into an original private stream.
The following sections describe the additive startup and admission composition.
No public operation or installed startup is activated.

## Owner-configured holder routing and early failure retirement

`routedHolderAuthority(remoteTicketAuthority(...), routes)` snapshots exact
assignment-to-transport capabilities supplied by the owner. Each route contains
an already pinned `workerSecretTransport`, never a caller endpoint. Duplicate
assignments are rejected. Every assignment field, including an absent service,
must match the original remote claim; legacy claims without a pending id are
retired uncertain. The selected transport and pending id are retained for that
original claim, and delivery is attempted at most once.

The returned destination provides `abandon()`. `listenHolderHandoff` invokes it
on every unsuccessful acquired destination, including invalid metadata, current
checks, source failures, late authority resolution, timeout, disconnect and
shutdown. It drains retirement on close, after any borrowed bytes have settled
and been erased. Retirement is consumed before IO and is never retried after a
lost settlement acknowledgement. Every destination must provide the retirement capability; malformed authority
results without it are refused before source access.

Successful holder delivery leaves the central ticket **claimed**. This unit does
not implement the daemon's final completion/uncertainty protocol: that owner must
retain the original ticket separately and settle it after the holder response,
or uncertain on every missing/failed response. No success settlement is inferred
from socket writes. The real TLS tests demonstrate source failure and local
cancellation retiring the claim, and a lost worker acknowledgement retiring it
uncertain even when the original stream received bytes. Trusted admission,
installed standalone composition, production capacity
and staging/value-free accounting remain prerequisites to activation.


### Daemon-owned completion (unactivated)

`secretTickets.admitHandoff(viewer, name, originalPending, configuredHolder)`
returns the original central ticket metadata plus a one-use `dispatch()` closure.
Retain that closure separately from the worker's original pending input. Supply
an owner-configured pinned `localHolderHandoff` client, never a caller's endpoint
or callback. Runtime provenance accepts only the original frozen client minted by
`localHolderHandoff`; copied clients, wrappers and structural lookalikes are
rejected before admission. The holder claims once through the existing authenticated authority;
the daemon retains that exact original claim for completion. For these admissions
the holder can only abandon, not settle success. The dispatch closure alone
settles success after the complete authenticated empty holder acknowledgement and
a synchronous check of the original central claim. Missing/failed responses,
including a lost holder acknowledgement after a successful worker write, retire
the original claim as uncertain without claiming again or retrying delivery.
Early failure before claim also burns the original admission. Failed current
proofs and staging holds cannot be overridden by a successful response.

This API is not wired into installed daemon startup or a public operation.
Production tombstone lifecycle/capacity and staging/value-free accounting
evidence remain prerequisites. Existing legacy `admit`/claim components
remain unactivated and retain their prior holder-owned settlement behavior.

### Real dedicated command startup (unactivated)

`runtime-runner/secret-command.ts` starts an owner-configured executable with a
dedicated fd3 pipe; stdin, stdout and stderr are disconnected. This is a command
consumer protocol: read fd3 to EOF once, then exit. It does not feed credentials
to Claude prompt stdin or assume Claude supports this protocol. The original
process pipe, exact assignment, synchronous owning proof and deadline are
registered before the pending handle is returned. A pinned worker listener is
started for that registry. One delivery closes fd3; the registry erases its
borrowed buffer only after the pipe write settles. Command output is discarded.

The owner retains the returned original pending handle and passes it to trusted
admission. `bindTicket` consumes one admission reply and creates exactly one
`remoteWorkerTicketProof` for the original ticket/pending pair, using endpoints
and pins snapshotted from owner configuration before startup awaits. Delivery
without that proof fails closed. Invalid binding burns the startup; rebinding
cannot replace a retained proof. The original synchronous current proof must
include policy, grants, job and local request replacement. It is checked after
remote authority and immediately before the original pipe write.

Cancellation, process error/exit, expiry and close retire the original pending
input and proof, destroy the pipe, kill and drain the owned process, and close
the listener. `completed` reports only a zero process exit after a pipe write
while the original proof is current; it never settles a central claim or proves
holder acknowledgement. Early process exit can make delivery uncertain even
after the pipe accepted bytes. The original daemon completion remains separate.

Real subprocess tests compose this startup with central admission and the pinned
holder channels, including cancellation while the original central current
response is delayed. These tests call admission directly as trusted test code.
The next section adds trusted worker admission; installed standalone/daemon
startup composition, public typed-command operations and public secret get remain
unactivated.
Production tombstone capacity/lifecycle and staging/value-free accounting remain
required before activation. No real credential consumer is configured here.


### Trusted worker admission and owner startup composition (unactivated)

`listenWorkerAdmission` accepts only configured worker certificate pins over
mutual TLS on a private Unix socket. Owner configuration binds each unique pin
to an exact assignment, the ORIGINAL authenticated Runtime viewer, and the
original minted pinned holder client. A copied viewer loses Signin provenance;
network requests cannot select viewer, assignment, endpoint or holder. Only
name and original pending UUID cross the admission request. Each connection has
a five-second absolute deadline, zero request body and bounded headers. Replies
carry only ticket/pending UUIDs or an empty acknowledgement; errors are generic.

The daemon calls `admitHandoff` once and retains its original completion
capability separately from worker input. A second request, authenticated as the
same configured peer with the original pending/ticket pair, triggers dispatch.
The worker must bind the admission reply before sending that request. There is
no automatic retry, re-admission or reconstruction. Duplicate pending ids remain
consumed by the existing central tombstones. Admission retention is bounded to
1024 entries and 30 seconds; cancellation, unfinished response disconnect,
expiry and listener shutdown abandon the retained admission. A fully sent but
lost admission reply can remain retained until expiry, without dispatch.
Cancellation is best effort; it never makes a pending identity reusable.

`startAdmittedSecretCommand` actually starts `startSecretCommand`, then creates
one pinned admission client for THAT original pending id, binds its original
reply once, and requests dispatch. It exposes only `completed`, `delivery` and
`close`; no caller may substitute a proof or pending request. Admission config,
name, startup config and original request proofs are captured before startup
awaits. `delivery` reports a complete daemon response, separately from the
command's `completed` process result. Failure closes the actual command. Close
fences local input immediately while draining admission requests and attempting
bounded cancellation of a known ticket. A lost reply is consumed, never retried.
The original local proof remains the final synchronous fence after central
worker-current; owner policy, grant, job and request replacement must be included.

The admitted-command TLS/subprocess suite uses this admission path; primitive
command tests retain direct trusted admission for their narrower contracts. Synthetic staging effects are explicitly released by the
test owner before the admission response; without release, dispatch is refused
and no source is read. Pipe cancellation drains while an intercepted native
completion callback remains held. These tests do not establish production
staging/value-free accounting or installed startup ownership. No real consumer,
Claude fd3 compatibility, public operation, production tombstone lifecycle,
installed daemon wiring or host activation is claimed by this source-only unit.


Admission transport entry saturation is not independently exercised; production
central tombstone lifecycle/capacity remains required. The server dispatch flag
rejects duplicate requests before their cleanup can retire a running original
request. A rejected or lost complete admission reply can remain undispatched
until bounded expiry. A deadline may lose acknowledgement even after release;
`delivery: false` never licenses retry. Command expiry closes its admission client.

### Daemon startup ownership (source opt-in, uninstalled)

`startLoom({next:true, secretWorkers})` now owns a single `secretTickets`
instance shared by its actual private admission and ticket-authority listeners.
The explicit in-process configuration supplies separate listener sockets, one
pinned holder endpoint/client identity, and worker pins paired with existing job
credential digests. Signin resolves each original viewer; Runtime derives its
exact current assignment. Configuration accepts no supplied viewer, assignment,
proof, dispatch callback or credential source. The original minted holder client
and original daemon completion remain internal. Owner selections are captured
before startup awaits. Nothing discovers or issues job credentials here.

Startup failure drains any listener/client already created. Normal daemon
shutdown retires admission and drains its dispatches, then stops authority and
closes the holder client before SQLite closes. Staging holds remain enforced by
the owning daemon's OutsideEffects gate; starting listeners grants no release.
Tests use synthetic values and actual pinned TLS plus a real fd3 subprocess.

This source option has no CLI/environment configuration or installed activation.
It selects existing job credentials at daemon startup; it does not yet schedule
runner processes, refresh peers for newly started jobs, or supply a worker's
original local policy/grant/request proof. Trusted runner job startup must own
that lifecycle and call the existing `startAdmittedSecretCommand` path. Production
tombstone capacity/lifecycle and staging/value-free accounting across the whole
installed path remain required before public activation. ClaudeWorkerSession
continues using prompt stdin and is not an fd3 consumer.

### Worker-side job startup owner (source opt-in, uninstalled)

`runtime-runner/secret-worker.ts` provides a separate worker-side startup root.
Owner configuration supplies a local name policy, expiring grants for exact job
assignments, and dedicated fd3 consumer jobs. Startup validates every selection
before IO (including command paths, peer endpoints, pins, arguments, environment
and duplicate normalized socket paths), snapshots configuration, and mints its own private policy, grant,
assignment and request records. It starts the actual commands using the existing
`startAdmittedSecretCommand` path. Neither a daemon response nor an externally
supplied `current` callback creates local authority. Local grants are explicit
owner configuration; they do not create or replace daemon grants.

The returned owner lifecycle handles revoke policy, revoke a grant, stop a job,
cancel a request or close the worker. Each event fences original local records
synchronously before draining started resources, including startup still awaiting
listener creation. Revocations cannot be reversed with equal metadata. Policy
revocation fences every configured job for that name. Each startup attempts each
job once, without restart or retry. TLS file contents, permissions and process
execution are checked during IO; failure retires that job without restarting it.
A fresh assignment requires a fresh worker
and daemon peer configuration. Jobs have distinct input sockets. Delivery and
process completion remain separate results. This root must run in a worker
process, never in the daemon that cannot receive credential bytes.

This is in-process source configuration, with no CLI/environment loader, installed
worker entrypoint, public operation or host activation. Runtime dynamic job/peer
refresh, production tombstone lifecycle/capacity and whole-path staging/value-free
accounting remain required before public activation. No Claude fd3 compatibility
is implied; only explicit command consumers implementing fd3-to-EOF are supported.
