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
Generation-aware failure/retry notices, model accounts, remaining lifecycle,
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
gates. Account/model enrollment, generation-aware failure/retry notices, remaining
lifecycle reconciliation, importer, command parity and screens remain on t-2209.
No deploy, live import or transition is part of this implementation.
