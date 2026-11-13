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
background jobs are still to be delivered; the offline importer is described below. No old command is
retired by these metadata operations. The final mapping must enumerate the old
runtime's commands, routes and jobs, including any drops and their reasons.

Next mode remains empty until explicit new-side setup or the future importer.
The importer reads a snapshot of old `state.json` and piece bindings/jobs, and must
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

This is a metadata handshake, not permission to start a container. Its acknowledgement returns
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

Completion now also accepts the bounded exit/log fields described below. Native
history collection, cooperative stop and service restarts
remain to be implemented with their owning lifecycle operations. `stopped` and
`lost` are not accepted here: write-off is an owning owner-answer operation rather than a runner report.
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


## House build configuration

The build-identity portion of old `set-agent` / `setAgent` maps to
`runtime.configureHouse {agent, house: {repo, houseFile?, branch?}}`. The central
`agent-setup` rule requires the calling member to own this agent. Household
ownership alone does not confer setup of another member's agent; agents,
runners and services cannot configure houses. The acknowledgement is `{agent}`.

`runtime.settings.house` stores the build identity, visible through the existing
centrally scoped settings collection/live type. Only credential-free HTTPS
URLs with a nonempty raw authority and no userinfo or query/fragment delimiters
(including empty ones), `git@host:path` locators and absolute
repository paths are accepted. Git hostnames contain only letters, digits, dot,
underscore or hyphen and start with a letter or digit. The structured API deliberately refuses old
HTTPS locators containing credentials or query/fragment material: repositories
are metadata, never a credential carrier. Private repository access must use
the future secret-reference grant path. Nothing opens or checks the repository.
`houseFile` is a relative repository path with no empty, dot or parent segments,
defaulting to `house/house.json`; branch uses the old bounded character grammar.
These are data, never shell commands; a future runner must pass them as arguments.

Each save replaces the build identity (omitting branch clears it) while
preserving box preferences and model settings. Preference saves preserve house
configuration. Existing settings need no rewrite: the JSON record gains an
optional field, with no new SQL migration. Identical saves preserve `changedAt`
and publish nothing; changed saves publish `runtime.settings` after commit.
Configuration, notification and retry receipt use the shared transaction. A
replay returns its old acknowledgement without restoring an older configuration.

This operation grants no nested containers, GPU, ports, tailnets, secrets,
repository credentials, harness logins, scopes or steering rights. Those old
`set-agent` fields remain required in a separate centrally authorized grant path,
including alias/scope preservation and checks; they are strictly rejected here.
No capabilities are inferred from a repository or house file. Claim snapshots and
per-job build reporting are described below; agent-wide build discovery and
execution invalidation still require the future daemon release path.
`queueBody` continues to accept nonexecutable intent before configuration.
Configured build identity alone does not enable input fetch, credentials,
`startBody`, slots/sessions, daemon staging release or runner execution. Those
obligations in Durable body requests remain required before the final move.


## Claimed house identity and build reports

The metadata part of old `claim` now snapshots the current `settings.house` as
`job.made` and server `claimedAt`, atomically with the starting transition and
receipt. A queued job can precede house setup, but claim conflicts until setup
exists. Failed attempts leave the same operation id available after setup.
A repeated successful claim preserves its original snapshot and time. A fresh
claim clears any previous image metadata on the queued row.

The build part of old `report` maps to `runtime.reportJob {job, state:"running",
build?}`. The existing assigned-runner and central report-job checks apply.
The image must match `loom-house-<agent>:<20 lowercase hex>` for this job's
agent; an optional `localhost/` prefix is removed. Unlike the old route's
silent ignoring of malformed tags, an explicit invalid tag is refused. The
first reported image is immutable for this job; a later different image
conflicts. Waiting reports cannot carry an image. Older jobs lacking a claim
snapshot still accept ordinary progress, but cannot acquire build attribution.
No caller can supply `made` or `claimedAt`. Fields are optional JSON metadata,
so no SQL migration or rewrite of older jobs is needed.

`configuredBuild(job, house)` is an internal helper for subsequent build
selection: a build is usable only with claim provenance and an exact matching
repo, houseFile and branch. A settings change keeps the historical job image
and snapshot for inspection, while making that image ineligible for the new
configuration. Changing any one of those fields suffices. The helper does not
select a newest build across jobs or authorize execution. No global current
build, build-check route, warm body-host upgrade or repo-secret binding is
implemented yet; the separate secret grant path must extend build identity
before private repository access can be released.

Snapshots and image tags are centrally scoped job metadata, never input words
or credential references. Report acknowledgements remain `{job,state}`; changes
publish only after commit, no-ops do not publish, failed receipts roll back image
writes, and retries cannot restore an earlier progress state. This remains a
metadata handshake even in staging: it performs no repository/image IO, issues
no credential and releases no executable input. The daemon must revalidate the
claimed configuration and grants immediately before outside-effect release;
these records are not an execution grant or authenticated body proof.

## Owner house grants

`runtime.configureGrants {agent, grants}` stores owner-controlled house grants
separately from the build locator. Central `agent-setup` authorizes the exact
agent; agent, runner and service callers cannot change them. This is the grant
configuration part of old `set-agent`, alongside `runtime.configureHouse`.
It preserves boxes, model and house settings, and those operations preserve the
grants. Only references are stored: this operation reads no repository, socket,
login or secret value and releases no work or credential.

The structured fields are `nested`/`gpu` booleans, optional `repoSecret` store
name, `secrets` mapping house alias to store name (32), `ports` as `{ip,port}`
(8, IPv4, 1024–65535, unique port), `tailnets` as `{name,socket}` (4, unique
name, absolute path ending in `tailscaled.sock` without dot/parent segments,
including `/tailscaled.sock`),
`logins` (`claude` and/or `codex`), `scopes`, and `steers`. Missing capabilities
reset to false/empty; missing `repoSecret` removes that reference. No secret
value, token, inferred principal or caller-provided scope history is accepted.

Omitted or empty-object `scopes`/`steers` preserve existing restrictions, as an
untouched old form does; the explicit string `none` clears them. A supplied
nonempty map replaces the corresponding map. Scopes name house-visible secret
aliases or `tailnet:<name>`, with up to ten `owner`, project slug or
`service:<name>` words joined by `+`. New scope names must name an existing
grant; old scopes survive removal so re-adding a secret does not drop its
restriction. Internal `scopeStores` remembers those secrets' store names across
multiple saves. Aliases of one store must have identical scope strings,
including removed aliases still held by scope history. Aliases of one currently
granted socket must also have identical scopes. As in the old path, tailnet
history is by name; removing/renaming a socket needs explicit owner scope
configuration. Scope strings compare exactly, as before (order matters).
Map keys are stored in a canonical order; reordering a map on save does not
change `changedAt` or publish a settings notification.

Steers map a person slug to one through ten project slugs; `owner` is excluded
from both. These are future release configuration, not proof that a given job
acts for that person. Login omission preserves the prior list, `[]` grants
none, and `default` removes the explicit choice; the eventual release path must
apply the old household-owner/box-ownership defaults and eligibility, never
interpret omission as a universal grant. CLI text parsing belongs to the
future generated command client; this endpoint accepts structured lists/maps.

A claim snapshots `repoSecret` with repo/file/branch in `job.made`.
`configuredHouse(settings)` assembles the effective current build identity;
`configuredBuild` now compares the repository-secret reference too. A historical
job without that reference cannot provide a build for a currently credentialed
repository. Rotating the value behind the same reference is not a different
build identity, matching the old reference-based comparison. Historical records
are unchanged; optional JSON fields need no SQL migration.

These grants have no executable consumer yet. Before any input/secret/login or
host capability is released, the aftercommit daemon must revalidate current
central policy, house configuration, grants and authenticated job/principal
provenance, apply scopes/steers, and pass `beforeOutside`. Unknown provenance
must fail closed. Claim metadata is not a grant to execute; queue acknowledgements
are not `started`. Actual secret-role lookup, repository access/build discovery,
body-host lifecycle, dispatch and default-login resolution remain required.

## Reported build discovery

`runtime.buildStatus {agent}` returns `{agent, build: {image, job, at} | null}`
from the caller's visible new-side job records, matching the current effective
house identity, including its repository-secret reference. It is the discovery
portion of old `noteBuild`/`s.builds`; it does not check a repository or image.
The caller needs central visibility of this agent's runtime settings; each
candidate separately needs central runtime job visibility. Services need both
settings and job type grants plus the exact operation grant. Runners cannot
read agent settings and cannot use this endpoint. Hidden private/project jobs
do not influence selection, even if they carry the newest report. The answer
is consequently caller-relative, not a global authoritative current image.

A first image report now stores server `job.buildAt` with the image, metadata
and receipt in the same transaction. Later progress, duplicate reports and
receipt replay preserve that time. Claim clears stale queued image and time.
Discovery selects the greatest report time, with lexical job id breaking equal
times. It excludes undated historical reports, missing claim provenance,
invalid agent tags, report times before claim or in the future, and changed
repo/file/branch/secret-reference identities. Completed jobs remain candidates;
completion does not erase a successfully reported build. Existing records are
not rewritten: `buildAt` is optional JSON metadata, no SQL migration. Repeating
an undated old image does not invent its original report time; a new job must
report a new build. This deliberately avoids using `changedAt`, which later
progress or completion can change independently of the image.

The read operation creates no receipt, notification or outside effect and
returns no locator, secret reference or input words. No current-build cache or
parallel store is introduced. Actual `build-check`/`build-report`, trusted body
hosts, warm-host upgrades, repository credential release and daemon execution
remain outstanding. This metadata is neither execution authorization nor proof
that an image exists on a box; an eventual execution consumer must revalidate
current central authority/configuration/grants after commit before release.


## Bounded job output

The exit/log portion of old `report` maps to optional `exit` and `log` fields
on `runtime.reportJob` and `runtime.finishJob`. The assigned authenticated runner,
box and state checks remain the same; completion still revokes the exact job's
central credentials in the same transaction. Output, metadata and retry receipt
commit together. A failed build report or later write rolls output back too.
Retries return the original metadata acknowledgement without restoring old output.
Omitted fields preserve earlier values; an explicit empty log clears the log.
Exit codes must be safe integers, including negative runner failure codes.
Malformed structured fields are refused rather than silently ignored as before.

Logs retain the last 4,000 JavaScript characters, preserving the first line when
it starts `the box couldn't start it: ` and is shorter than 300 characters, then
filling the remainder with the tail (the old refusal diagnostic rule). Input
logs are bounded to 1,000,000 characters before storage, within the API's existing
transport cap. Reports replace the stored tail, rather than append to it.

The additive third runtime migration stores output separately in
`runtime_results`, keyed by job. It is not a collection or live type. Logs and
exit codes never enter `runtime.job` or acknowledgement/receipt results. A changed
output notifies the job id after commit; consumers refetch explicitly. Identical
output and progress preserve job timestamps and produce no runtime notification.
No output record is created when both fields are omitted.

`runtime.jobResult {job}` returns `{job,result:{exit?,log?}|null}`. Each call
uses the job's **current** central `mayAct` scope. Private/member, project and
agent visibility follow the central rule. Services require both the
`runtime.job` type grant and the exact `runtime.jobResult` operation grant.
Runners cannot use this read operation under the central `act` rule; they already
supply their own diagnostics. Unknown and hidden jobs both deny. The read writes
no receipt or notification. Output persists across restart and is not a source
of conversation words or body membership proof.

| Old report behavior | New operation / remaining obligation |
| --- | --- |
| Progress exit/log | `runtime.reportJob {job,state,exit?,log?}` |
| Completion exit/log + credential revoke | `runtime.finishJob {job,state,exit?,log?}` |
| `houseView` diagnostics | Explicit scoped `runtime.jobResult`; list/live stays metadata only |
| Short box refusal headline survives long logs | Same 4,000-character tail rule |
| Native history, service crash/restart decisions, cooperative stop | Still required with their owning lifecycle operations |

This does not release executable inputs, issue credentials, run repositories or
containers, dispatch bodies or resolve `startBody`. Account results, native
history collection, output retention/deletion and the screens/client/importer
remain required before the final move. No old endpoint is retired here and no
outside effect occurs, including in staging.

## Structured quota refusal parsing

`refusals.ts` ports the pure `claudeRefusal`, `codexRefusal`, `lastRefusal`
and `refusedUntil` portions of old `logins.mjs`. Only structured quota/billing
codes count; authentication failures and prose do not. JSONL bookkeeping and
uncoded failure wrappers preserve a refusal, while later work, a new prompt or
an explicit nonquota error clears it. Malformed lines are ignored. Reset
selection takes the latest future reset among full windows, otherwise the
nearest future reset; missing resets use `nextQuotaHold`'s blind backoff.
Nonfinite readings/resets are ignored. Time is explicit, in seconds.

These are internal helpers, with no operation or daemon consumer yet. They
open no transcript, login or file and change no state. Authenticated account/job
report binding, account grouping, usage report validation and transactional
hold persistence still belong to the future account layer. Parsing a supplied
harness event grants no authority and is not trusted body or account proof.


## Repository snapshot build inspection

`inspectBuild` in `build-inspection.ts` ports old `box.mjs`'s `buildTagAt`
and the build-reading portion of `buildNow` behind an asynchronous snapshot
reader. It reads the house file and resolves the context, Containerfile and
watched paths at one immutable commit supplied by the caller. With no watches,
tags retain the old context-id prefix plus Containerfile-id prefix; with watches,
they retain the old SHA-256 of the ids and sorted, deduplicated path/id pairs.
Unrelated commits therefore preserve an image name. Watch renames or content
changes rotate it. SHA-1 and SHA-256 Git object ids are accepted.

The helper validates only the build declaration: relative paths without dot,
parent or empty segments, a tree context, a blob Containerfile, up to 64 watch
paths, and a house file of at most 4 MiB. Other house fields are deliberately
not interpreted. Full executable house validation remains required before a
runner builds or launches anything. Missing paths, malformed JSON or object
ids, unknown build keys and reader failures reject the inspection.

This is an internal, uncalled helper, not an operation or a concrete Git reader.
It starts no process, fetches no repository, reads no old store or credential,
changes no record and announces no current build. The separate runner must
supply the immutable snapshot after fetching. Fetch scheduling, repository
credential access, trusted body-host build-check/report, daemon staging gates,
current grant revalidation and actual build/launch still remain. A computed tag
alone proves neither image availability nor execution authority.

## Full repository house manifest validation

`house-manifest.ts` ports the declarative parsing part of old `house.mjs`'s
`parseHouseFile` and `runSpec`. `parseHouseManifest` validates the whole house
and up to 16 services, normalizing command/task defaults, secret destinations,
static environment, allowed mount kinds, requested harnesses, nested containers,
hostname, ports, tailnets, attach command and canonical build watches. Unknown
fields, reserved or conflicting environment variables, duplicate destinations,
invalid paths/ports and oversized lists reject. Harness-owned environment names
cannot be supplied when that harness is requested. Services have their own run
settings and no task field. No task settings are implicitly inherited by a service.

`inspectHouseBuild` composes that validator with `inspectBuild`: one house-file
read must pass full validation before context/Containerfile/watch object reads,
all pinned to the original immutable commit. The original `inspectBuild` remains
build-only for callers explicitly needing that narrower contract. Both are
internal and uncalled by the daemon or registry.

The structured parser explicitly refuses null and nonobject declaration maps;
the old parser incidentally treated some null values as omitted and some arrays
as empty maps. Omit optional fields for defaults. Normalized output matches the
old run shapes, but errors use Zod diagnostics rather than old CLI prose. The
4 MiB byte cap applies to standalone parsing too. These choices fail closed on
malformed declarations without changing an executable consumer.

This validates declarations, not grants or credentials. Secret aliases and login
names are only requested destinations; no secret value is read or returned. A
future runner still needs an actual fetched snapshot, filesystem/symlink checks
for materialized build paths, current central authorization and grants, staging
and outside-effect gating, and build/launch implementation. No repository fetch,
process, container, credential issuance, permission rule or live installation
changes in this slice.

## Git snapshot reader

`gitSnapshot` supplies `BuildSnapshot` from an already fetched Git repository
through the runner's asynchronous, repository-bound `SnapshotGit` argv executor.
It resolves HEAD, a full ref or an object id to one commit once; revision
expressions and short ambiguous branch names are refused. Every later lookup
uses that commit, literal paths and replacement objects disabled. Exact NUL
terminated tree entries retain their kind; symlinks, missing or multiple entries
and inconsistent modes reject. Text reads require a regular blob, check its
size before reading, enforce the 4 MiB byte limit and verify the returned byte
count. SHA-1 and SHA-256 repositories are supported.

This ports the Git-reading portion of old `buildNow`/`buildTagAt`; composing it
with `inspectHouseBuild` validates the complete manifest and computes the old
image tag. Git failures propagate. Tests use an in-process argv fixture, with
no child processes. No registry operation or daemon calls this reader yet.
The executor must enforce the supplied output bound during reads, reject failed
commands and own cancellation/timeouts and its environment. Repository fetch,
credentials, filesystem materialization checks, current authority and staging
checks, process adapter and build/launch remain runner integration work. This
reader neither fetches nor checks whether an image exists on a machine.

## Claimed runner input release

The input-fetch part of old claim/poll is `runtime.takeInput {job}` over
HTTP. It uses asynchronous dispatch and the real next-mode `OutsideEffects`
gate, outside the registry transaction. Only the exact assigned active runner
can take input from a claimed `starting` job. Private member jobs remain denied
by central policy. Current hosting, box capabilities and claimed house identity
are checked before release and again after preparation. No credential values,
login, ports or sockets are supplied.

In staging the first request creates a held `body-start` effect with id
`runtime:input:<job>`. The owner's existing `core.releaseEffect` action permits
one subsequent fetch. Normal next mode permits that fetch immediately. The
payload contains job/agent, claimed house identity, brief and needs. It is a
read response, never stored in registry retry results or live records. Input
fetch does not mark a body started: `reportJob {state:"running"}` is the runner's
confirmation. A claim without that report remains `starting`.

The release is intentionally consumed once, including across daemon restart.
A lost response or a crash after consuming the gate is uncertain: reconcile
that job, never retry an automatic start. Repeated fetch is refused. This
conservative choice uses the existing gate without inventing a second dispatch
ledger; reliable runner recovery/acknowledgement is still required before the
final move. Trusted body credentials, conversation in/out and Comms linkage
remain outstanding. This operation does
not claim to implement those paths or change the separate runner program.

## Start intents and Clock confirmation

`runtime.startBody` now implements the durable request part of old
`bodies.mjs:startBody`. It creates a queued job with the existing placement and
house configuration, and stores the brief in `runtime_inputs`. Its reply is
`{job,state}`, never a claim that a body has started. It is available through
the same registry doors as the runtime role. Members must own the requested
agent; an agent may start its own work under central scope checks. Runners cannot
create starts. Service type/operation grants confer no agent authority: current
central `mayCreate` also denies agent-scoped service starts with both grants.
Public member-scoped startBody requests and model-account selection fail unavailable.
Private Comms work uses the trusted acceptance path below; caller-supplied
conversation metadata alone never opens that path.
An optional model request reaches the runner's one-time input payload.

A source kind/id is scoped to the authenticated caller and agent, producing a
stable job id. Repeating it with a fresh operation id, after receipt expiry or
after restart finds the same intent; different work conflicts. Without a source,
the caller's operation id identifies the intent. Briefs never enter reply
receipts or live records. This is metadata and input storage, not a second
credential or authority store. A conversation field is inert metadata here and
confers no conversation access.

Next mode installs the actual Clock adapter. A prompt wake queues a start under
its original viewer with its wake id as the stable source. An in-process change
observer waits for the assigned runner's `running` or `waiting` report before
returning `started` to Clock. Queue, claim and input acknowledgements leave the
wake firing. Before a queue exists, a placement refusal is definitely not
started and Clock may use its normal retry policy. Missing house configuration,
lanes (including inlined file-backed lanes), lane files, continuations, slots, approval-bearing and local wakes are held
without creating a job; those trusted inputs remain required follow-up work.

The confirmation deadline is 60 seconds on the daemon's clock. A still-held
staging input returns held; every other unconfirmed accepted intent returns
uncertain, including a terminal job without observed start confirmation.
Closing/restarting during dispatch also stays uncertain. These outcomes require
reconciliation, and never authorize another automatic start. A late runner
report updates its job but does not automatically resolve an already-held wake.
The runner still releases input through the staging gate described above.

Tests run the actual next API with bearer-authenticated fake runners through
start, queue, claim, held input, owner release, input, start confirmation and
completion. Clock tests also cover definite refusal, staging, missing and lost
confirmation, and restart without duplicate dispatch. The private conversation path below adds authenticated reads and replies.
Automatic start retries, model accounts, remaining lifecycle,
importer and screens are still required for the full runtime rebuild; this
does not claim the whole task is complete or unblock dependent tasks.


## Private conversation path in next mode

Next mode installs Comms with its private key and the real runtime delivery role.
Member messages remain encrypted in Comms; runtime stores only routing receipts,
a private binding and a generic instruction to read the bound conversation.
Acceptance and startBody enqueue share one registry transaction. Later messages
reuse the active job. An uncertain or lost accepted job remains held for
reconciliation; another message never starts a replacement automatically. An authorized thread filing change moves its private job
and binding together under central move policy; message words stay in Comms.
Queue, claim and input acknowledgements do not mark a
thread working; assigned runner running/waiting reports confirm its start.

| Old path | Next path |
| --- | --- |
| Comms delivery to startBody | Comms RuntimeDelivery -> direct runtime.acceptConversation -> runtime.startBody |
| Runner finds pending work | runtime.claimableJobs returns assigned job ids only |
| Runner takes startup input | runtime.takeInput releases a reference plus a central job credential once |
| Bound body's comms_thread | runtime.readConversation uses the authenticated job proof |
| Bound body's reply | runtime.reply uses Comms encrypted deduplication, returns seq only |
| Working/done heartbeat and stop | runtime.conversationStatus updates Comms and generic Attention status |
| Archive/delete ends body | Comms end role stops the bound job and revokes its central body credentials |

Signin retains job provenance on the exact authenticated viewer object. A shared
agent token, a caller-supplied job id, another job's token or a reconstructed
viewer object confers no private read/post capability. The runtime checks the
current binding, job state, box, house configuration and member access on every
body call; Comms checks the proof again after asynchronous crypto. Job credentials
are issued through central Signin into the existing token store, expire after
24 hours, and are revoked on job completion or box revocation. They are returned
only by the one-time read-style input release, never written into retry results.
The assigned runner can control a private job only with runtime-owned binding
proof under central policy; it cannot list the private record or read messages.

The fixture exercises a real member socket and runner/body HTTP authentication,
private input and reply, denied callers, restart, revocation and both staging
gates. Account/model enrollment, automatic start retries, remaining
lifecycle reconciliation, importer, command parity and screens remain on t-2209.
No deploy, live import or transition is part of this implementation.


### Authoritative final-start failure and member retry

An assigned runner may finish an unconfirmed `starting` job with
`runtime.finishJob({job, state: 'failed', startFailure: 'not-started'})` only
when it has fenced that claim so no body has started or can subsequently start.
This is an authoritative runner attestation, not a timeout or an ordinary exit
failure. Runtime rejects this attestation for any other state. The terminal
write, credential revocation, durable `startFailed` marker and registry receipt
commit together. Later runner reports cannot resurrect the job.

Next composition reconciles this marker into Comms' encrypted `startNotice`,
echoing the accepted message sequence and generation. Restart recovers a missed
notice; duplicate reconciliation uses Comms deduplication. Comms checks current
scope and generation again after encryption. Only the member's existing
`comms.retryStart` action advances the generation and queues a new start.
Another message also retains the failed binding; replacement requires the next generation of a previously accepted message. There is no automatic start retry. An ordinary failed accepted claim remains held even when another member message arrives; it cannot silently queue a replacement. A normal failed exit, accepted-but-unknown
start, lost runner, or timeout supplies no final-start proof and no retry notice.
A failure after running/waiting is never described as a failure to start.

Automatic bounded start retries and broader execution reconciliation remain
part of t-2209, along with its enrollment, accounts, screens, importer and client.


## Trusted Approvals caller

`conversationRuntime(...).approvalCaller(viewer, proof)` is composed as
`ApprovalOptions.caller` in next mode. The optional string is untrusted and does
not establish identity. Central Signin retains authenticated agent/service identity even without a job,
and optional job proof on the exact Viewer object; copying a Viewer removes that proof. Runtime
rechecks job state, current house/hosting eligibility and box revocation, then
uses the same current binding and Comms membership checks as private body reads.
A proven member is the principal (household owners become `owner`), and its one
person, conversation and current project come from the database. The `who.where`
value is the job id with the centrally authenticated service suffix in parentheses
when present, preserving Approvals' service-house spend constraint. A service
credential without a job retains its suffix with `a body` as the location, even
though its principal remains unknown; losing that suffix would widen spending.

A shared agent credential, missing job or copied Viewer establishes no principal.
An authenticated job without current private membership remains `?`; starting a
job or carrying a project is not evidence of its requesting person. Runtime's
owner application for principal-reset and box-write-off remains pending.
This resolver reads only next-mode state and creates no authority store.

| Old permission command | New behavior |
| --- | --- |
| Per-agent piece/path grants (`grants set`, legacy `grant` approval) | Retired in favour of central record scope; no Runtime ACL or blanket service grant substitutes for them. Imported pending approval cards are withdrawn, never applied or spent. Service record-type/operation grants and secret-use grants remain separate. |

### Retirement inventory and scope audit

The complete noncredential inventory is the coordinator's t-2209 comment:
old `commons/stores/runtime.db`, collection `grants`, key `household`, revision 7,
updated `2026-11-08T04:38:58Z`. The household has Art and Mark. Every listed
path is `*`; `*` agent entries expand to those two agents. Relay permits Art to
Mark and Mark to Art, every possible other-agent pair. This retirement changes
neither relay nor any secret-use or service authority.

| Old piece | Art | Mark | New boundary (both agents unless stated) |
| --- | --- | --- | --- |
| approvals | `*` | `*` | `approvals/index.ts`: scoped cards through central maySee/mayAct/mayCreate; person/owner answers and household rules denied to agents. Legacy grant cards cannot create authority. |
| box | `*` | `*` | Runtime: household box records/revoke/configure denied; jobs/settings/bindings filtered by record scope. Runner-only reports/claims are unavailable to agent viewers. |
| clock | `*` | `*` | `clock/index.ts`: wake/schedule/log reads filtered by scope, create/mutate through central policy; lane setup, vouch, pause/resume and rearm owner-only. Self deadman restricted to the authenticated agent. |
| machine | `*` | `*` | No next-mode machine command/host shell operation. Runtime health is an assigned runner's own report; metadata does not grant host execution. |
| packages | `*` | `*` | No next-mode package-install operation. Old piece installation/catalog programs are outside the new request path, retired by the foundation spec. |
| runtime | `*` | `*` | `runtime/index.ts` and scoped operation modules: own/project jobs, settings and bindings only; mayCreate validates new scope. Household boxes and owner setup denied; input/words require exact authenticated runner/job or private body proof. |
| secrets | `*` | `*` | `secrets/index.ts`: household names/setup/answers denied; own requests/grant metadata and own may/request/require only. Value release still needs the separate owner-granted secret-use role; legacy piece grants never substitute. |
| shuttle | `*` | `*` | Bridges + Runtime: no public venue-send/receive or bridge reply operation. Private Comms has separate current job/member binding proof. External Runtime delivery is still pending and grants no authority now. |
| tasks | `*` | `*` | `tasks/index.ts`: read filtering, existing-target checks, mayCreate/mayMove for creation and scope changes, including parent/link targets. Unfiled household records denied. |
| discord | `*` | `*` | `bridges/index.ts`: all venue/route/link/send metadata is household-only (even though venues name an agent). Setup and disposition require owner. Adapter IO is a trusted service role, not an agent operation. |
| slack | `*` | denied | Same Bridges boundary as Discord. Mark cannot read Art's Slack venue/routes/links/traffic or change setup/disposition. Agent-scoped Art Slack Runtime bindings are hidden from Mark; the current private reply/read API requires authenticated current job/binding proof. No public external send operation exists. |

`approvals/retirement-scope.test.ts` exercises all 22 pairs against central
policy (own agent allowed; other agent, absent project, member-private and
household denied; household/setup/person-answer actions denied). Its actual
next-mode fixture with an Art Slack venue, route, person link, held send and
agent-scoped Slack binding verifies positive owner reads, Mark's excluded Live
reads, real authenticated Mark HTTP setup/disposition/read/reply refusal, no
binding enumeration, no public bridge reply/delivery operation, and unchanged
setup/send state. Existing private conversation tests additionally exercise real
job credentials and cross-binding refusal.

No off-scope or household reach was found. This is evidence about current
registered operations, not a claim that external Slack delivery is finished.
When Runtime external delivery lands, it must authenticate the body and bind
replies to the original agent/venue before invoking the trusted Bridges role;
never expose the role directly as a viewer-free operation. Its absence is already
part of this piece's remaining delivery work. The old gate's only denied pair
therefore gains no authority from this retirement.


## Owner recovery applications

Next mode composes Runtime's synchronous ApprovalApplication on the same database
as Approvals. A body cannot invoke the application operation or supply a card. Approvals
marks the exact callback object with a private, database-bound in-flight proof;
the exported Runtime role rejects copied Allow fields even inside a transaction.
Every request saves the exact original card and its owning snapshot. Allow
rechecks the original card and current state before any change; Deny changes
no runtime state. Answer, application, credential revocation, registry receipt
and committed notifications succeed together or roll back together.

| Old operation | New operation / state |
| --- | --- |
| askOwnerReset / reset-approved | runtime.askPrincipalReset / Approvals owner Allow |
| noteSender / resetActsFor | private runtime_provenance and immutable source-key metadata |
| writeOffAsk / writeOffBox | runtime.askWriteOff / Approvals owner Allow |
| hostHeard | authenticated runtime.bodyHeartbeat, private body operations and runner report timestamps |

Reset applies only to nonprivate household-owned conversations with no named
nonowner history. Household-owned means its assigned owners equal all household
owners (or it has no specific assignment and inherits all household owners); an
agent assigned to just one of two household owners is not household-owned here. Private Comms membership remains unchanged. The card lists at
most twelve eligible source descriptions within 650 characters. Only those
original keys can be adopted; late arrivals are recounted. Person sources and
explicitly named wakes are never adopted. The owner attestation retains its
approval, person and time. Every job holding the previous conversation is
centrally revoked; live jobs stop and the binding drops its job and harness home.
No prior body or harness session can be resumed through that binding.

Provenance ingestion derives private Comms senders from its authenticated owning
source. There is no public sender-history operation. General venue delivery and
trusted Clock provenance ingestion remain later delivery work on t-2209; these
applications do not make runtime.deliver usable. The private source store records
source keys independently of its pending queue, so consumption and restart do
not let a source retry rewrite sender history. Queue consumption keeps history.

Write-off requires a remote active non-report-only box silent for ten minutes,
and snapshots only live, nonprivate, nonservice jobs for the requested agent.
The card covers all eligible jobs present at filing, states their count, and
lists ids when the whole list fits its 1000-character limit; the durable owning
request always retains the complete exact set. This keeps large covered sets
recoverable without silently dropping jobs. The card binds the exact box heartbeat epoch and covered body heartbeat times.
A renewed box or covered body report prevents Allow. Administrative job writes
never count as heartbeat. Later jobs, private jobs, services, runner credentials,
box configuration and preferences are untouched. Covered body credentials are
revoked and jobs become lost/ended with a durable writtenOff marker naming the
approval, person and time. runtime.jobControl returns stop:true and history:discard for this marker when
the assigned runner reconnects; an ordinary lost/uncertain job does not mean written off.
Uncertain or ordinary lost work returns history:unknown, never a write-off.
The external runner's stop/history reconciliation remains lifecycle work on
t-2209. Late reports cannot turn a written-off terminal job back into live work.


## Offline Runtime import

`loom migrate runtime --home <stopped-new-home> --from <completed-snapshot>
--mapping <runtime-mapping.json>` imports Runtime after Household. It uses the
same registered importer as `loom migrate all`; for a standalone import, use `loom migrate verify --snapshot <snapshot> --home <home> --runtime-mapping <runtime-mapping.json>`. All-imported homes use the usual saved plan. Verification independently
projects source rows and compares every destination column, count and id, including
the private archive. Verification never executes the importer or trusts its no-op
receipt. Generic import does not discover live paths or run old piece programs.

The coordinator first collects a fresh snapshot with both explicit roots:
`loom migrate snapshot --from <old-loom-home> --runtime <LOOM_BOX_HOME>
--runtime-data <LOOM_BOX_DATA> --to <fresh-snapshot>` (alongside the other pieces'
roots). Defaults in the **old** program were `~/.config/loom-box` and
`~/.local/share/loom-box`. They are documentation, never importer defaults.
Discovery of any Runtime input without both inventoried roots refuses; an empty
state or data directory is explicitly recorded in the manifest. An empty state root creates no invented local box. Snapshots predating this
inventory require a fresh collection. Real snapshots/imports and rollout remain
coordinator-only, with the owner's presence at the final move.

Prepare the editable plan, then fill Runtime's `boxes`, `jobs` and `conversations`
maps. Every source id must appear exactly once, with no extra keys. Initial nulls
are unresolved and prevent import. Each box maps to an existing household member;
an explicit old owner must match. Each job/conversation maps to `{member?,project?}`;
`{}` is a deliberate agent-and-owner audience, while a member makes it private.
Old Comms (`loom`) conversations require their exact member/agent/place from the owning copied `household.db`; an arbitrary household member is refused. Unknown agents/members/projects
refuse. The fresh all-imported Household has no projects; project scopes require
an explicitly configured destination project and are unavailable in fresh-all
verification. Do not widen a private audience merely to make an import pass.
The standalone mapping file is the Runtime options object, not the whole plan.

| Old persisted source | Destination / disposition |
| --- | --- |
| `commons/stores/runtime.db` `docs` | Every collection/key/revision/update/writer/document in private `runtime_import_documents`, exact backed-up DB bytes also retained |
| Same DB `revisions`, including deletes | Every revision in private `runtime_import_revisions`; unknown tables refuse rather than disappear |
| `gates/<agent>`, `gate-proposals/*`, `policy/<agent>` | Complete private archive; later gate/policy/proposal operations must adopt their exact records before external delivery can be called usable |
| `grants/household` | Complete private archive; legacy per-piece path grants are retired, never reissued as central authority |
| `LOOM_BOX_HOME/state.json` boxes | `runtime_boxes`: explicit owner, names, hosting/lending, facts/labels, watch/report-only, original timestamps/revocation |
| `primaries`, `agents` house settings | Ordered box preferences in `runtime_settings`; complete old house configuration and grants remain archived together until explicit reconciliation |
| `houses` | Same ids and explicit audiences in `runtime_jobs`; terminal states preserved, active/wanted/stopping work becomes uncertain |
| `services`, `serviceState`, `remotes`, `builds`, `logins` workflow metadata | Exact state archive; lifecycle/enrollment operations must reconcile these before execution |
| `models`, `modelChoices`, `quotaHolds`, `accountSalt`, box account/usage reports | Exact state archive; account/model operations and migration into their eventual records remain part of the full rebuild |
| `seq`, `pendingRevokes`, `writeOffAsks`, unknown future state fields | Exact state archive; no reset of sequence, loss of retry metadata, or manufactured owner approval |
| `delivery/conversations/*.json` | Same conversation/agent/venue/place and explicit audience in `runtime_bindings`, except deleted Comms bindings below; no old body/job/home/run-key pointer is activated |
| Old conversation principal history / signed reset / queued words | Exact private source archive; imported live provenance is unknown, never a new owner attestation; delivery reconciliation must consume the actual source before release |
| `repos/<agent>.git` in the data root | Excluded by named `runtime-rebuildable-repo-mirror` rule: source-created remote mirrors, rebuilt with `clone --mirror` / `fetch --prune`, mounted read-only into houses; no house worktree or delivery state is excluded |
| `delivery/seen/*.json`, `slots/*.age`, `*.home.age`, notices/fallbacks/continuation-policy, discarding/files, principal key/wake handovers | Exact private byte archive streamed into bounded BLOB parts; these queues, dedup receipts and sealed sessions can be only copies, and no signed handover becomes executable authority |
| `bodies/*.json`, native launch admissions and every other regular file in the supplied data roots except named cache/login exclusions | Exact private byte archive, including otherwise unknown names and directories called `runs`, `current`, etc.; no automatic native-history adoption |
| `LOOM_BOX_DATA/logins/` | Runner-owned credential values stay on the runner; the snapshot manifest names this explicit exclusion without reading the values |
| `.git`, `node_modules`, lock/SQLite coordination files, special files and out-of-root aliases | Existing collector exclusions, recorded in the snapshot manifest; committed SQLite WAL contents use the backup API |
| `LOOM_RUNTIME_KEYS_DIR` (default `~/.local/state/loom-runtime/keys`), per-house native-history mounts, runner-local harness logins | Separately inventory on the workers before the final move; old bearer keys are not new credentials and host history is not silently adopted |

### Deleted and private Comms bindings

Both `loom` and `spawn` conversations are private Comms threads. Their mapping
must name the owning member, checked against exactly one copied `household.db`
thread with the same conversation id, agent and member. For `loom`, the place
must also match the thread id; `th:<id>` accepts either the table's full
`th:<id>` or bare `<id>`. For `spawn`, the place is its own `job-h-<n>` or
`sp-<24 hex>` handle, preserved exactly; it need not equal the thread id.
Other venues retain their original places, including free-text wake labels with spaces.
A missing owning thread still refuses unless `comms_deleted` proves that exact
thread and agent were deleted; a non-null tombstone conversation must also match.
Conflicting live/deleted evidence refuses.

For a source-proven deleted thread, retain its explicit conversation mapping
entry as `{}` (or the same owning member, without a project). Import keeps the
original binding bytes in the private archive but creates neither a binding nor
provenance. Standalone import and `all` reports list only the conversation id and
`skipped: owning Comms thread deleted`, including on repeat imports. Independent
verification expects those live tables to exclude the deleted binding and still
compares its exact archived bytes. This disposition never restores the thread.
Snapshot inventory refusals name an unlisted relative path, including accidental
SQLite `-wal`/`-shm` sidecars; discovery and verification open snapshot SQLite
without creating those files.

### Source basis for the repository and delivery disposition

The installed Runtime source and catalog pin inspected for this decision is
[`a2c33d724e1d64964cde1d65298c793ef8e86551`](https://github.com/sleepunit-agents/loom-box/tree/a2c33d724e1d64964cde1d65298c793ef8e86551).
[`src/box.mjs` checkout/syncMirror](https://github.com/sleepunit-agents/loom-box/blob/a2c33d724e1d64964cde1d65298c793ef8e86551/src/box.mjs#L214-L250)
creates `data/repos/<agent>.git` with `clone --mirror`, sets the remote and fetches
with `--prune`, then clones a separate working tree for each house. Other mirror
uses only inspect commits/build trees; the house receives the mirror through
[`dirs.mirror`](https://github.com/sleepunit-agents/loom-box/blob/a2c33d724e1d64964cde1d65298c793ef8e86551/src/box.mjs#L605-L624),
whose mount is explicitly
[`read-only`](https://github.com/sleepunit-agents/loom-box/blob/a2c33d724e1d64964cde1d65298c793ef8e86551/src/house.mjs#L307).
This source has no writer of house work into those mirrors. The directory-only
root rule is based on that ownership, never its size. A regular file named
`repos`, nested unrelated `repos` directories and house workdirs remain archived.
The offline direct reader applies the same root rule before enumerating it.

By contrast,
[`src/delivery.mjs`](https://github.com/sleepunit-agents/loom-box/blob/a2c33d724e1d64964cde1d65298c793ef8e86551/src/delivery.mjs#L1-L31)
keeps durable conversation queues, delivery receipts and sealed continuity slots;
[slot publication and restoration](https://github.com/sleepunit-agents/loom-box/blob/a2c33d724e1d64964cde1d65298c793ef8e86551/src/delivery.mjs#L3240)
is not a remote cache. Retain **all** delivery bytes privately by streaming,
including unknown files, without activating old queues or principal evidence.
Worker-local unpushed work/history still requires its separate final-move
inventory; dropping the fetched mirror does not waive that obligation.
No Runtime data or credentials were read to make this decision.

All imported jobs carry an import fence: assigned runners get `stop:true` and
`history:unknown`, or `history:discard` for an old written-off job. No fake new
approval id is attached to the old marker. Claims/reports cannot revive uncertain
or terminal imported jobs. There is no release operation yet: the full rebuild's
lifecycle reconciliation must explicitly settle old jobs, services, revocations,
queued delivery, gates and account state before any replacement body can run.
This importer does not make general delivery, models/accounts or services usable.

The following archive layout requires
[streaming migration PR1100](https://github.com/sleepunit-agents/loom/pull/1100)
to merge first; ship this cache disposition only in a release containing that fix.
Private `runtime_import_sources` holds per-file SHA-256/size descriptors; ordered
`runtime_import_chunks` holds exact source bytes in at most 1 MiB BLOB parts, including sealed
slots, words and inert old keys; it has no live collection or read operation.
Never put this archive, its contents or raw source errors on the page or in logs.
CLI login values are refused even by the direct reader. The migration transaction
includes schema, archive, metadata, provenance and checksum/mapping receipt.
A simulated interruption rolls all of it back. Same source and mapping are a no-op;
a changed source/mapping or a nonempty unowned destination refuses. Independent
verification still catches corruption after a successful receipt/no-op.

Imported change timestamps are source-derived (box/job creation time) or zero
(settings/bindings have no trustworthy source change time). No import receipt or
destination timestamp supplies an expected value to Runtime verification. Runtime
archive namespaces are excluded from other pieces' discovery, so an opaque file
called `comms.salt`, `memories.db` or `changes.json` remains a Runtime archive file.


## Bounded nonconversation start attempts

Next mode now owns automatic retries for newly accepted nonprivate manual/spawn
`runtime.startBody` work without a conversation. The original caller and complete
start intent are private owning data in `runtime_start_attempts`, created with
the first job. Old jobs/imported archives and `queueBody` are never enrolled.
Clock, Comms and general venue conversations keep their own generation/binding
contracts and are excluded; adopting bounded retries into those owning sources
remains required before full t-2209 completion and general delivery usability.

Only the assigned runner's `finishJob` with `startFailure: not-started` schedules
a retry. This attestation means the runner fenced its claim against ever starting,
including late asynchronous launch completion. An ordinary failed exit, silence,
unknown input release, lost runner, or timer expiry cannot schedule a replacement.
The failed job and its revoked body credentials remain terminal. No old body,
principal, home or native history is carried into the next attempt.

The three waits are 1, 4 and 10 minutes, matching old `delivery.mjs`'s bounded
start backoff. Each attempt has a fresh deterministic job id and its own one-time
input/staging effect. The fourth definitively failed attempt exhausts the chain.
A transaction commits each new job, input and owning pointer together. Restart
recovers the original deadline; replaying the finish receipt never moves it.
Local storage failure rolls back and backs off five seconds rather than spinning.

Before retrying, Runtime rechecks the original caller with central `mayCreate`
and `give-work` policy, the exact failed attempt's configured house, and current
placement ownership, lending and host eligibility. The replacement retains its
expected house in startRequest; a later setup change blocks claim, and input
release rechecks the claimed house again. A withdrawn permission, changed
house, recovery/import fence or unavailable placement holds the chain. No owner
approval is fabricated and there is no release/revival operation in this unit.
A held or exhausted chain remains inspectable and cannot silently restart.
The exact original model, brief, title, explicit box and project remain the
accepted intent. An explicit box is pinned to the initially resolved id; a
revoked id never falls back to another box with the same display name. A renamed
original box keeps its identity. Owner setup changes do not create different work under that intent.

`runtime.startProgress {job: <original job>}` returns only the root/current ids,
attempt number, state and optional deadline, filtered by central job scope.
`startBody` replay still acknowledges the original id; use progress to find the
current attempt. Successful/ordinary terminal completion settles the chain.

| Old command/job | New behavior in this unit |
| --- | --- |
| `delivery.mjs` `startFails` / `retryAt` tick | Durable bounded nonconversation start deadlines in the daemon Clock, no systemd poller |
| Runner definitive pre-start failure | Authenticated assigned `runtime.finishJob` with atomic credential revocation and retry scheduling |
| Delivery retry status | `runtime.startProgress`, ids/state only; source notices and conversation integration remain owning delivery work |
| Transient old-store polling | No old transport on next mode; local retry transaction failures back off five seconds without consuming an attempt |

This is a reversible code change before cutover, with no running-home changes.
Importer verification requires the new attempt table to remain empty: archived
old failures do not become new automatic starts. External execution/history,
original queued-delivery reconciliation, owner gate/policy adoption, trusted
Bridges intake/replies and their notifications remain unfinished full-rebuild work.

## Body policy preparation for external delivery

`body-policy.ts` ports the old `policy.mjs` compilation boundary without
installing a public operation. The owning source must supply authenticated
senders, current gates and policy, complete platform roster and current
principal history. Platform descriptions explicitly name `kind: channel|dm|group`;
Every platform description names the actual gate venue identifier.
A DM has exactly one member and a group has at least two; only a DM can carry
a person’s exclusive standing authority. Channels never carry that authority.
DMs and groups require the complete member roster, while channels use owner
policy and gate venue readers. Missing kind or malformed gate keys refuse.
Adapter tiers, grants, cards and brief prose cannot supply
that authority. Standing restrictions follow every named person; standing
authority appears only for a tier-2 person alone, asking solely for themselves,
with no other or unknown historical sender or owner participation.

Guest status includes the sender, every room member, configured guest places,
gate venues and retained narrowing. A guest requires a deny list, a repo floor
reference, complete bounded readers and all of their cards; another member's
card is never included while a guest reads. Invalid rosters/readers fail rather
than being truncated. All file references must be inside the agent repository.
The compiler does no filesystem IO; the separate runner must resolve every
required reference and refuse missing, empty, oversized or escaping files.

The complete effective rules (including gates words, deny list, file references
and included cards) determine the session key. `sameBodyRules` permits only an
exact match, so policy edits cannot keep a body with older rules. Compilation
snapshots inputs before asynchronous card lookups; owning delivery must recheck
current policy and authenticated binding after awaits before any release.
Compilation never grants a registry permission or authorizes a launch.

| Old helper | New helper / remaining owning work |
| --- | --- |
| `policyProblem` | `bodyPolicy` validates the whole document |
| `rulesFor`, `gatesWords` | `compileBodyRules`: typed sections, narrowing and complete effective-rule key |
| `sameRules` | `sameBodyRules`: exact effective-key match, including policy and file changes |
| `briefs.mjs` filesystem composition | `src/runtime-runner/brief.ts`: runner-local required sections and resolved history key; launch integration remains |

Persisting/adopting archived gates, policies and original proposals, authenticated
Bridges intake, body feed/reseat/history, runner file composition and actual
reply integration remain required on t-2209 before external delivery is usable.
The existing Bridges missing-role hold remains installed. This compiler alone
activates no archived restrictions or authority and starts no bodies.

## Persistent owner permission documents

The private `runtime_body_policy` table stores paired gates/policy documents and
original pending proposal rows. Only household owners can call
`runtime.readBodyPolicy`, `runtime.adoptBodyPolicy` or
`runtime.configureBodyPolicy`; agents, runners and services cannot read or edit
these documents through the registry. There is no live collection of permission
words. The read returns the exact source rows alongside current documents so an
owner can see what is being adopted. Sources over 1 MiB refuse whole review,
never a truncated approval surface.

For a fresh home, configure both complete documents with `revision: 0`.
For an imported agent, read first and adopt using the returned `archive` digest.
Adoption copies the exact gates, policy and original proposal rows, including
source revisions, before/entry, relay words and original question metadata. It
never creates or answers an approval. Missing or invalid logical documents stay
blocked; repair requires an explicit paired configuration edit at the current
revision. Original proposal rows survive every configuration edit. Decision,
People merge and pending-request reconciliation remain later owning work; these
operations do not offer Allow or Deny for an imported proposal.

Configuration edits require the current revision. An operation receipt replay
returns its original acknowledgement without restoring older documents. Adoption,
edits and receipts commit together. The immutable import archive remains intact;
a changed source digest fences active reads and edits rather than dropping a
late proposal or bypassing an older restriction. Import verification expects
this new table empty: imported bytes alone never become active permissions.

`currentBodyPolicy` is a private owning accessor for later delivery composition.
It refuses missing configuration, unreconciled archives and malformed documents,
returning exact owner documents and a version key only after those checks. Its
caller must re-read after awaits and check authenticated binding/current policy
before release. The accessor grants no registry permission and launches no work.

| Old source / command | New behavior in this unit |
| --- | --- |
| `gates/<agent>`, `policy/<agent>` | Exact paired owner configuration; whole-document validation without inserting schema defaults |
| Archived `gate-proposals` | Exact original rows copied with adoption, preserved through edits; no manufactured approval |
| Gates export/import review | Owner read plus digest-bound adoption from the already imported private archive |
| Owner policy replacement | Revision-bound `runtime.configureBodyPolicy`, blocked until original archive adoption |

The household-DM path merged in #1104 is now guarded by
`bodyPolicyExecutionHeld`: any active owner configuration or associated imported
permission/proposal source holds admission, delivery, input and body reads/replies
until that path enforces compiled body rules. Adoption alone never removes this
hold. Existing bound runners receive stop/discard; delayed outbox sends also
recheck owning policy synchronously after asynchronous admission and at final
outbound authorization and at the adapter’s actual POST boundary, after its
last await. Fresh household DMs without owner configuration or
archived permission sources keep #1104's central member binding contract.

General external delivery, compiled-policy enforcement by the separate runner,
proposal decisions, lifecycle/history, source queues and original pending owner
requests, accounts/models, Clock/Comms retry integration, Runtime Kit screens,
generated client and complete old-command parity remain on t-2209. No running
home, worker or real import is changed by this code unit.


## Worker checkout brief preparation

`src/runtime-runner/brief.ts` is separate-runner code, not installed in the
loom daemon or exposed as a registry operation. `prepareRunnerBrief` consumes
compiler sections and the exact tool deny list. It resolves required files
in order on the worker checkout; no permission files are read on loom’s machine.
A required file that is missing, empty, invalid UTF-8, nonregular, oversized or
unsafe refuses the whole preparation. Each file is at most 20,000 bytes; the
complete brief is at most 1 MiB across at most 40 sections. Nothing is truncated.

The Linux worker pins directory descriptors and opens every component with
`O_NOFOLLOW`, including every ancestor of the absolute checkout path. Empty and dot path
components (including trailing slashes) are refused before opening. All symlinks
are refused, including
links within the checkout. This deliberately stricter choice prevents a
check-then-read path race. Other operating systems refuse file sections until
they have equivalent safe descriptor-relative reads. Inline-only briefs need
no checkout. File descriptors close on both success and refusal.

The returned immutable preparation contains the complete brief, exact deny
list, original compiler policy key and a resolved key over policy identity,
deny and every resolved section’s contents. A file edit therefore changes the
resolved key even when the compiler’s repo-relative references do not change.
The eventual runner must preserve this key with its own native history and
also verify the original agent/venue binding; a body-supplied key is no proof.

This helper does not launch a harness, enforce its deny list, authorize history
reuse or remove `bodyPolicyExecutionHeld`. Those end-to-end runner and owning
binding checks remain required before configured-policy delivery is enabled.

## Worker-owned Claude session execution

`src/runtime-runner/session.ts` runs a foreground Claude turn on the worker:
`-p --output-format json`, with the exact `prepareRunnerBrief` deny list in
`--disallowedTools` and the resolved brief plus message on stdin. It accepts no
extra harness arguments or caller-supplied native session id. The worker supplies
the executable and environment; no credentials are read from the daemon or old
stores. Other harnesses are not supported by this execution unit.

One controller owns the ORIGINAL agent, conversation, venue and place. It generates
its own UUID and retains resume authority only after a successful, bounded harness
result naming that UUID. A changed binding permanently closes the controller.
Changed policy/file bytes, deny list or checkout starts a fresh UUID. No receipt
from a body, adapter, imported record or a previous worker process authorizes
history reuse. Concurrent turns refuse; close kills the active foreground child.
Any uncertain child failure closes the controller permanently, preventing overlap
with a child still exiting. A later controller starts fresh.

The owning `current` predicate must synchronously check current policy revision,
binding and job control. It is checked before preparation, immediately before
spawn, immediately before input release and after the final await before returning
words. False or throw permanently closes the controller and discards history. The
owning lifecycle must call `close` on revocation and cancellation while a turn is
active. This unit has no scheduler or periodic control poll; it does not promise
to discover revocation during a silent turn by itself.

This worker component is not installed or called by next mode. The daemon still
needs to compose `currentBodyPolicy` and `compileBodyRules` with authenticated
source evidence, release that policy to the assigned worker, and connect ongoing
control/replies. `bodyPolicyExecutionHeld` remains intact. Account selection,
runner enrollment, process recovery, Codex and the complete runner program remain
on t-2209. No configured/imported agent becomes executable from this change.
