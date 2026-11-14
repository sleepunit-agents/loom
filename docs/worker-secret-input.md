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

This is an unactivated component. Standalone worker startup does not yet create
pending requests or compose this transport with `secretTickets`,
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
This is protocol coverage, not standalone startup: trusted admission transport,
owner-created standalone pending requests, configured holder routing,
`listenHolderHandoff` completion/uncertainty wiring and staging/value-free
accounting remain required. No public operation or installed startup is activated.

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
lost settlement acknowledgement. Existing unactivated destinations may omit the
hook; actual routed composition always provides it.

Successful holder delivery leaves the central ticket **claimed**. This unit does
not implement the daemon's final completion/uncertainty protocol: that owner must
retain the original ticket separately and settle it after the holder response,
or uncertain on every missing/failed response. No success settlement is inferred
from socket writes. The real TLS tests demonstrate source failure and local
cancellation retiring the claim, and a lost worker acknowledgement retiring it
uncertain even when the original stream received bytes. Trusted admission,
standalone runner-owned input creation, daemon completion, production capacity
and staging/value-free accounting remain prerequisites to activation.
