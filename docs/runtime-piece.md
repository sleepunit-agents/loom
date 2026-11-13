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

The central household credential implementation is not yet supplied by next
mode. `installRuntime` accepts an optional `credentials: RuntimeCredentials`
role; without it revocation fails `unavailable` before changing anything. The
role must revoke every runner credential for the box and every body credential
for the supplied job ids synchronously on the supplied database transaction,
with no independent commit or outside effect. Absent/already-revoked credentials
are success. Runtime owns no credential store. Its in-process test fake uses a
test-only SQL table to prove that credentials roll back with runtime metadata.
The composition root must wire the central role once household issuance and
principal binding land, and integration tests must prove real credentials stop
authenticating. This remains required before enrollment or the final move.

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
