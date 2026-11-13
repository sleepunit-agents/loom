# Runtime piece (next mode)

The control plane lives in `src/pieces/runtime`. It holds box, job, per-agent
settings and conversation-binding metadata in `loom.db`. The container and
harness runner remains a separate program. Nothing here reads the old runtime's
files, starts containers or changes a running installation.

## Operations delivered

| Old command or API | New operation | Status |
| --- | --- | --- |
| `list` (boxes, houses, preferences) | `runtime.listBoxes`, `runtime.listJobs`, `runtime.listSettings` | Metadata collections; central policy filters each record |
| conversation binding collection | `runtime.listBindings` | Metadata collection |
| `may-host`, `lend-box`, `box-owner`, `box-watch` | `runtime.configureBox` | Existing enrolled boxes; owner-only; `set` contains the fields to change |
| `set-primary` | `runtime.setBoxes` | Agent owner sets up to eight ordered box references |

All writes use the registry envelope `{input, id}`. Configure returns `{box}`;
preferences returns `{agent, boxes}`. Write retry receipts contain these ids,
never credentials or words. Collections have matching live record types:
`runtime.box`, `runtime.job`, `runtime.settings`, `runtime.binding`.

Box references resolve an exact live id first, then a unique live name. Two boxes
may share a name; ambiguity requires an id. Revoked boxes do not resolve.
Preferences store canonical ids and reject duplicates, unavailable references,
report-only boxes, boxes that disallow the agent and boxes neither owned by the
agent's owner nor lent to it. Ownership and lending govern placement eligibility;
caller authorization always uses `src/policy.ts`. A specifically named agent
owner takes precedence over household owners for this eligibility check.

A local runner cannot be report-only and is always on. `alwaysOn` stores the
configured watch flag; `boxAlwaysOn` also counts report-only runners as always on
without making that flag sticky when report-only is later disabled. Setting a single local preference or an empty list stores an empty
list, meaning default placement. No local box is fabricated: local registration
must eventually receive explicit runner metadata from the composition root.
Existing model settings survive a preference change. The structured API accepts
arrays; old command text parsing and stdout/exit parity belong to the generated
client, still pending.

## Placement selection

`placement.ts` ports `control.mjs`'s `placeHouse`, `primaryOf`, `boxUp` and
`meets` as the internal `placeBody` helper for the future start operation. It
reads new-side records only and returns a box id. It does not authorize the
caller, enqueue a job or dispatch anything; the eventual operation must use
central `give-work` policy before calling it.

An explicit live id or unique name must permit this agent and meet every need;
it may be silent (work waits there). Otherwise, eligible preferences retain
their stored order: first heard within two minutes, then first eligible even
if silent. If no eligible preference remains, only explicitly registered,
eligible local metadata is the default. An empty home fails with a conflict;
the old environment-derived imaginary local box is deliberately removed.

Needs match reported facts plus owner labels, with exact keys and
case-insensitive substring values. With needs, choose the first live matching
preference, then a matching primary, then a single eligible matching box.
Multiple other matches require an explicit choice. Missing individual needs
and needs split across different boxes produce distinct conflicts.
Report-only and revoked boxes never host work. Ownership/lending and host
permission use the existing `canHost` predicate. Internal local metadata initialization and heartbeat updates are described
below; their authorized operations and drill/write-off state remain unfinished.
Placement alone makes no claim to implement their lifecycle.

## Remaining before the final move

The full runtime rebuild is in progress. Enrollment (including stranger join,
proof and owner decision), central credential integration, runner hello/poll/claim/report,
placement integration and dispatch, houses/services/body hosts, delivery/results/retries,
model-account metadata and usage, settings, screens, generated command parity,
background jobs and importer are still to be delivered. No old command is
retired by these metadata operations. The final mapping must enumerate the old
runtime's commands, routes and jobs, including any drops and their reasons.

Next mode remains empty until explicit new-side setup or the future importer.
The importer must read a snapshot of old `state.json` and piece bindings/jobs,
commit once with a checksum, compare ids/counts/content, no-op on the same source,
refuse another source and roll back interruptions. It must never modify the old
side. Final cutover requires no live houses and the owner's presence; point the
separate runner at registry operations only during that move. No deploy or real
import is part of the changes described here.

## Box revocation

`revoke-box` maps to `runtime.revokeBox {box}` and returns `{box, revoked:true}`.
A household owner may revoke an enrolled, nonlocal box by live id or unique
name. Revocation sets `revokedAt`, marks its nonterminal jobs `lost` with an
`endedAt`, and removes the box from every agent's preferences, preserving their
order and model settings. Terminal jobs remain unchanged. Credentials for all
jobs on the box, including terminal jobs, are revoked defensively. No runner or
container call happens during revocation; the runner loses access and its work
is recorded as lost.

Next mode now supplies `centralRuntimeCredentials`, an adapter over central
`TokenDatabase` and `HouseholdRows` on the caller's connection. It revokes all
exact `runner:<box>` tokens, disables that central runner principal, and revokes
all agent tokens whose authenticated `@<job>` suffix exactly matches any job
on the box, including terminal jobs and service-qualified agent roles. Labels
are never used as identity. Unbound agent tokens and other boxes/jobs remain
untouched; existing revocation timestamps are preserved. Reactivating the runner
principal cannot revive its old tokens. No credential is returned or copied.

The role requires the registry transaction. Credential changes, principal
disabling, runtime metadata and retry receipt commit together or all roll back.
A committed `core.access` invalidation rechecks existing sockets as well as
future requests. Integration tests use the real central sign-in resolver and
bearer HTTP requests, including later-write failure, rollback, exact job ids,
terminal jobs, duplicate labels and multiple runner tokens. A new empty home
without a token document still permits disabling/revoking an enrolled box.
Standalone installers without the optional `RuntimeCredentials` role continue
to fail unavailable before mutations. Enrollment, credential issuance and
trusted body/conversation attribution remain future work; this adapter consumes
the central role grammar already accepted by sign-in and invents no authority.

A retry with the same registry id returns the original acknowledgement without
calling the role again. A new attempt at a revoked box is `not-found`; local
runners cannot be revoked. The old `pendingRevokes` file retry queue is replaced
by the shared transaction: a role failure rolls back all changes and leaves no
successful retry receipt, so the caller can retry the same id.

## Internal box lifecycle helpers

`lifecycle.ts` provides `initializeLocalBox` and `hearBox` for subsequent setup
and runner operations. Neither is registered as an operation or called by next
mode yet. Both require the caller's database transaction and return
`{box, changed}`; the caller must announce `runtime.box` after commit only when
changed. They read no environment, files, credentials or clock.

`initializeLocalBox` replaces the metadata-creation part of old `state.mjs`'s
`empty`/`load` with explicit `{id, name, owner}` from trusted composition. The
caller must validate the owner. A new local record permits all agents, starts
with empty facts/labels/loans, is always on and is not report-only. It has no
invented heartbeat. An identical repeat preserves all owner configuration and
timestamps. A second local identity, changed name/owner, revoked id or promotion
of an existing remote record conflicts. Renaming and moving a local runner need
an explicit later operation; restarting the daemon never silently moves one.

`hearBox` ports only the metadata part of `hello`/`pollState`: a current enrolled
id receives the supplied server time as `lastSeen`; optional facts replace its
previous report, omitted facts preserve it, and an empty array clears it.
Facts retain the old 32-entry limit and key/value grammar; the structured API
uses arrays and deduplicates exact repeats. Labels, ownership, loans, hosting
permissions, report-only and watch configuration remain owner-controlled.
Reports resolve exact ids only, never names, and cannot recreate or revive a
missing/revoked runner. They create no jobs or dispatch effects.

The future runner operation must derive the id from the central authenticated
runner principal before calling `hearBox`. The future setup path must authorize
local initialization centrally. This slice does not implement those public
operations, hello/poll responses, account/harness reports, report-only enrollment
choice, health alerts, drills, write-off, dispatch or credential lifecycle.

## Internal quota calculations

`quota.ts` ports the calculation part of old `accounts.mjs`. It is internal and
uncalled: it stores nothing, exposes no operation and reads no clock, file,
environment, login or provider API. Every call receives explicit server time.
Reading `checked`, resets and holds use seconds; the server time uses
milliseconds. These helpers do not yet implement an accounts collection.

| Old calculation | New internal helper | Scope |
| --- | --- | --- |
| `mergeUsage` | `mergeUsage` | Newest reading per window across all supplied sources, fuller on equal timestamps; unread sources add nothing |
| `hasRoom`, `windowNow` | `hasRoom` | General windows plus the requested model window; 97 percent is full; elapsed reset restores room |
| `roomAt` | `roomAt` | Latest hold/full-window reset; null means either room now or an unknown reset, distinguished by `hasRoom` |
| `holdAccount` arithmetic | `nextQuotaHold` | Structured refusal holds, 30 minute blind backoff, eight day cap, preserve longer active hold, bounded reason |

Two choices make the documented old behavior independent of incidental state:
merge readings chronologically so an older known future reset survives a newer
reading without a reset regardless of input order; reset a blind streak after
a day without a refusal even when the old hold has not yet been pruned. Known
reset refusals end the blind streak. Missing/nonfinite reset times use blind
backoff. Nonfinite usage passed to `hasRoom` fails closed; `mergeUsage` consumes
numeric report metadata, with untrusted report validation still the future
caller's responsibility.

The future account layer must supply only readings of the same owner/salted
short CLI identity, including stale copies' readings while offering only live
copies. It must authenticate the reporting box/body, enforce login eligibility
centrally, validate/clamp reports and persist the selected account's hold in the
caller transaction. API key accounts use secret references only, never values.
Account grouping, metadata schemas/storage, retention, owner-only keys versus
labels, account operations and UI, `usageOf`, resolver/model settings and provider
refusal parsing are unfinished. No legacy account command or runner behavior is
changed by this calculation module.

## Authenticated runner heartbeat

`POST /api/runtime/hearBox` accepts `{input: {facts?: string[]}, id}` through
next mode's central bearer authentication. Only a `runner:<box-id>` token whose
central principal is active may report. The exact authenticated id must name a
live enrolled box; a display name, missing record or revoked box is refused.
The new central `report-box` action permits this write without permitting box
registry reads. Members, agents and services cannot report, even with service
type and operation grants. The operation returns only `{box: id}`.

This replaces the facts/lastSeen portion of old `hello` and `pollState`, using
`hearBox` in the registry transaction. Facts are validated with the existing
32-entry grammar, deduplicated, preserved when omitted and cleared by `[]`.
Only facts and server `lastSeen` change. Owner metadata, labels, configuration,
report-only status and hosting permissions remain untouched. A changed report
publishes `runtime.box` after commit; an identical report at the same server
time publishes nothing. A retry with the same operation id returns its original
acknowledgement without refreshing `lastSeen`; every new heartbeat needs a fresh
id. A later database failure rolls back the report, receipt and notification.

This endpoint does not enroll or issue credentials, choose local identity,
return jobs or account/harness reports, dispatch work or replace the full old
hello/poll response. Those interfaces and central runtime credential lifecycle
remain required before the final move. No runner installation or live host
change accompanies this endpoint. Earlier lifecycle helper descriptions of a
future runner operation now refer to this facts-only endpoint; the broader
runner API remains unfinished.

## Runner claim and progress metadata

| Old route | Registry operation | Delivered scope |
| --- | --- | --- |
| `claim` | `runtime.claimJob {job}` | Assigned queued job becomes starting; acknowledgement only |
| `report` | `runtime.reportJob {job, state}` | Claimed job becomes running or waiting; acknowledgement only |

The authenticated runner id must equal both the assigned job runner and its box
id. The box must still be enrolled and unrevoked. Central `report-job` policy
also excludes member-private jobs. Claims recheck current ownership/lending,
host permission and report-only status. Reports remain accepted after hosting
permission is withdrawn so an already claimed runner can describe progress.
Unknown and off-assignment jobs share the same denial. No caller can reassign a
job or set timestamps through this API. Reports use server `changedAt` and only
publish when metadata changes. Registry receipts make lost-response retries
safe without making a fresh claim of a starting job succeed.

This is a metadata handshake, not permission to start a container. It returns
no credentials, input words or results, calls no runner and performs no outside
effect, including in staging. Input fetch, credential issuance and terminal
reports with credential revocation remain required on this task before a real
runner can execute. A runner cannot end, revive or report uncertain/lost work
through these two operations. The fake runner test seeds queued jobs internally;
public job creation and `startBody` remain unfinished.

## Completion metadata and job credential revocation

The completion portion of old `report` maps to `runtime.finishJob {job, state}`,
where state is `done` or `failed`. Only the exact assigned authenticated runner
may complete a starting, running or waiting job, using the same central
`report-job` check, enrolled box and privacy restrictions as progress reports.
Withdrawing hosting permission does not prevent a claimed job from finishing.
The acknowledgement contains only `{job, state}`. Server time sets `endedAt`
and `changedAt`. A new report cannot overwrite a terminal job; a retry with the
original registry id returns its original acknowledgement without revoking
again or changing timestamps.

`RuntimeCredentials.revokeJob` synchronously revokes every central agent token
with the exact `@job` suffix, including service-qualified agent roles. Runner
credentials, unbound agent credentials and other jobs remain valid. It uses
the same central role grammar as box revocation and never matches display
labels. Earlier revocations keep their timestamps. Missing token documents
need no cleanup. The job update, central revocation and retry receipt share one
transaction; a failure or asynchronous credential role rolls everything back.
An after-commit `core.access` change invalidates existing authentication handles.
An installer without central credentials fails unavailable before changing data.

This is completion metadata only. Exit codes, log/result words, builds, native
history collection, cooperative stop, written-off jobs and service restarts
remain to be implemented with their owning lifecycle operations. `stopped` and
`lost` are not accepted here: there is no stop-intent or write-off protocol yet.
Input delivery and execution still require the outside-effect staging gate;
this endpoint releases no work and performs no outside effect, even in staging.
Earlier text describing terminal reports as future work now refers to those
remaining result and lifecycle portions, rather than done/failed metadata.


## Durable body requests

`runtime.queueBody {agent, title, brief, project?, member?, box?, needs?}`
creates a queued job and its private input in one registry transaction. It
returns only `{job, state:"queued"}`. The caller must satisfy central
`give-work` and `mayCreate` for every supplied scope. An owner may give work
only to an agent they own; project membership alone cannot give work to an
agent. Private requests must name the calling member. Agents, runners and
services cannot queue through this operation under the current central rule.

Placement uses `placeBody`, including canonical box references, ordered
preferences, ownership/lending, hosting permission and capability needs. An
explicit silent box can receive queued work. The server chooses the job id,
runner/box, state and timestamps. There is no caller-supplied conversation,
source authority, credential, model or account selection in this operation.
A registry retry returns the original acknowledgement without re-placement,
even after the selected box is revoked; a changed request with the same id
conflicts. Independent request ids create independent jobs.

The caller-supplied `title` is visible job metadata, like the existing
`runtime.job.title`; use a nonprivate summary, never a copy of sensitive brief
content. Central scope controls who receives that metadata. The full `brief`
and capability needs are private inputs.

`runtime_inputs` stores the brief and capability needs separately from live
job metadata. It is not a registry collection; no input-read operation is
provided yet. Job, input and retry receipt commit together, and only committed
job changes publish. Words never enter acknowledgement/retry results. The
additive second runtime migration preserves existing metadata.

This replaces only the durable request/placement portion of old `up`, not its
house configuration validation, slots, sessions or trusted body-host creation.
A queued request is not executable: house configuration, model/account
resolution, input-fetch authorization, credential issuance and daemon release
through `OutsideEffects.beforeOutside` must land before any runner receives
its inputs. Queueing performs no outside effect in either mode and does not
claim a body started. `runtime.startBody` and the Clock adapter remain
unimplemented until they can honor their started/held/uncertain contract.
Input retention/cleanup must be part of the final job lifecycle; this slice
retains inputs and provides no deletion operation. No old route is retired.
