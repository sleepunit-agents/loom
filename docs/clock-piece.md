# Clock in the new foundation

Clock is installed on the new side in next mode, beside the installed legacy
clock. The rebuild remains incomplete under t-2201; the remaining work is listed
below. These changes switch no existing command, timer or live data.
The new side must never read the installed piece or its stores. Only the offline importer reads old files.

The upstream contract is `sleepunit-agents/loom-clock` at
`5e362d05389015cf48b5d69bf5f4f00a0b8f1631`: `bin/wake`, `README.md`,
`test/test_wake.py` and `test/smoke.sh`. Its CLI already redirects relays to the
runtime. `loom wake` loads identity and is unrelated to scheduling.

## Remaining work and evidence

At base `27a1e59`, runtime installs `runtime.startBody` and next mode composes
Clock with `src/pieces/runtime/clock.ts`. The bridge accepts plain prompt wakes
only after agent house configuration and waits for runner-confirmed running or
waiting state. Queue acceptance alone is never reported as started. Missing
features (lane files, continuations, slots, approvals, local wakes) remain held;
private body delivery and account selection are refused. Conversation delivery
and authenticated continuation resolution remain blocked on t-2209.

Independent work remains: exact local-approval filing/recovery,
standing-job rechecks and app/client flow; and other imported provenance recovery
or explicit deliberate drops. Runtime-dependent work remains: conversation-bound
mutation/join, original schedule principal narrowing, API 40/conversation 20 and
origin-bearing schedule 20 quotas, agent-authored self-rearm eligibility, and
continuation issuer/handle/deadline/place validation. These are gaps, not deliberate
drops. Archived strings and caller-supplied handles cannot fill them.

Merged evidence: foundation/importer #864; capacity/quota #878; exact unpark #887;
owner-authored self-rearm #901; continuation failure #910; desk reads #917;
Clock app #931; generated client #949; migrate-all #951; notices #956;
Home composition #963; parked answers #973; continuation exclusions #980;
configured safety wake #986; owner-vouch backend #993 and client #1003.
Clock screenshots: #931's `artifacts/clock-app/` CI artifact. Home composition's
six screenshots: #963 artifact `14028440535`. Behavioral fixtures live in
`src/pieces/clock/*.test.ts`, `src/next.test.ts`, and the Clock/Home browser proofs.
These references do not certify the remaining workflows or authorize a live move.

## Calendar choices

`src/pieces/clock/time.ts` calculates absolute UTC deadlines from wall times in
America/Chicago, independently of the daemon host's timezone. Recurrences are
strictly after the supplied instant. A nonexistent spring-forward time is skipped;
an ambiguous fall-back time runs once, at its first occurrence. A once-weekly
schedule whose time falls in the gap waits until the following week. Explicit
one-off dates in the gap are refused. Durations represent elapsed time, so a day
in a duration means 24 hours. These choices need no host timezone configuration
or additional package.

## Implemented foundation unit

`installClock` installs the prefixed tables, scoped operations, live `wake`,
`schedule` and pause records, and daemon timers. The installer returns `close`;
the composition root registers it with the foundation's `onClose` so timers stop
before SQLite closes. It is installed in next mode and explicitly in tests.
Nothing installs it on the existing production path.

The runtime dependency accepts a durable intent and returns started,
definitely-not-started, held, or uncertain. Intent commits before the asynchronous
call. Restart holds any remaining firing intent; stopping the installer prevents
late completion from writing. Cancellation before invocation suppresses the call;
cancellation after invocation records that a body may have started. Uncertain
work cannot be released with fire-now. Known-not-started work alone backs off.
The default runtime is a staging hold. The Clock runtime dependency remains an
uncomposed start-result contract.
The read-only approval dependency is composed with the owning Approvals and
Secrets roles in next mode; it is not a receipt-spending interface.

The current tests exercise these transitions on `startLoom`/`FakeClock`, including
pause release order, a parked answer and timeout, changed dispatch permission,
live-record aging, and the next occurrence across Chicago daylight saving.
The opt-in client, Clock app, Home composition, parked answers, owner-vouch
backend/client and explicit safety wake are merged. Ask-vouch, local-approval
recovery and runtime-dependent parity remain incomplete. The foundation and
importer migration reviews are complete.

## Old surface inventory and replacements

The table distinguishes implemented operations from remaining workflows.
The source-audit table below records the narrower behavioral gaps; existence of
an operation does not imply executable runtime dispatch.

| Old command, route or job | New operation or job |
| --- | --- |
| `wake at`, `wake in` | `clock.at`, `clock.in`; parse time on the daemon |
| `wake park --on a-…` or `q-…` | `clock.park`; approvals/request role and a 24-hour deadline |
| `wake list` | `clock.list`; same records as live `wake` |
| `wake log --since --grep` | `clock.log`; clock event rows |
| `wake cancel` | `clock.cancel`; skip one schedule occurrence and arm its next |
| `wake now` | `clock.now {agent,note?}` creates a fresh owner wake; `{id}` fires an existing wake, including while paused |
| `wake fire` (internal) | daemon due-job dispatch; durable intent before `runtime.startBody` |
| `wake rearm` | `clock.rearm`; rebuild in-process deadlines from rows |
| `wake run`, `keep_armed` (service) | daemon clock lifecycle; no child service or systemd |
| `wake pause`, `wake resume` | `clock.pause`, `clock.resume`; keep due work, release once |
| `wake schedule set/rm/list/run` | `clock.scheduleSet`, `clock.scheduleRemove`, `clock.schedules`, `clock.scheduleRun` |
| `wake lane set/assign/rm/list/text` | schedule rows carrying lane text and assignment; corresponding `clock.lane*` operations |
| `wake vouch`, `vouch-approved` action | `clock.vouch`, opt-in owner client, app action, and atomic Approvals application |
| `wake ask-vouch` | `clock.askVouch`, the generated client and the single-wake app action file exact selections; automatic grouping remains unfinished |
| `wake relay`, `wake relays` | same refusal directing the caller to runtime; already removed upstream |
| `wake reap`, legacy session reaper | dropped from Clock: runtime owns body lifecycle; executable runtime dispatch remains blocked |
| `wake bundle export/import` | coordinated core backup/import, not an independently encrypted child program |
| `wake api` | foundation HTTP/MCP/direct operations; no subprocess envelope |
| `wake ui` manifest/page | registered Clock app at `/p/clock-preview`; live `wake` and `schedule` |
| UI `now`, `pause`, `resume`, `cancel` | the same operations as CLI, via `call` |
| UI schedule create/edit/remove/run | the same schedule operations as CLI |
| UI lane create/edit/assign/remove | the same lane operations as CLI |
| parked request checks every 5 minutes | role notifications where available, plus daemon deadline/check job |
| schedule fire creates one next occurrence | next row committed with the current fire intent |
| dead-man when spool empty | Explicit configured-agent fixed 24-hour daemon job; central policy and staging hold apply |
| transient unit collision recovery | dropped: no transient units in the new side |
| fire/standby lock files | dropped: single daemon owns SQLite and its timers |
| dispatch retry/backoff and quota handling | only known-not-started outcomes may retry; uncertain fires are held, never repeated |
| allocated-house watch/session command launch | dropped from Clock: runtime owns starts/tracking; executable start/delivery composition remains blocked |
| local approvals, standing jobs, continuation handles | Local filing/recovery/standing and authenticated continuation inspection remain unfinished; imported metadata stays inert |

## Implemented verification and remaining completion boundary

Implemented in-process fixtures use `startLoom` with `FakeClock` for operations and daemon lifecycle: overdue while
down; crash after intent and before outcome; late outcome from the stopped daemon;
cancel before dispatch and racing a fire; pause/resume; parked answers and timeout;
one occurrence per schedule; DST; staging holds; owner/member/project/agent policy;
scope aging after 24 hours. No fixed sleeps, subprocesses or browser suite on loom's
machine. The standalone calendar tests cover DST and invalid input directly.

Importer fixtures compare source ids, counts and content, with all rows and
the source checksum in one transaction. They cover identical-source no-op,
different-source refusal and injected interruption rollback on constructed old-format data.
Preserve opaque old metadata without treating it as new authorization. A source
`_firing` is uncertain, so hold it instead of replaying it.

The opt-in `loom-wake-client` shares declarative registry command metadata and
keeps domain logic in daemon operations. Client fixtures cover output, exit codes
and receipt retries, including a lost committed HTTP answer. The Clock app uses
the kit, `useRecords` and `call`; its two-window browser proof and six screenshots
are described below. Remaining vouch/local-approval flows are not covered by
these completion claims.

## Final move (coordinator, owner present)

After the complete new side has been used in staging and the owner says go: stop
the old daemon and clock writers, back up both homes, snapshot the old clock data,
run the offline clock importer, verify its comparison, then start next mode. Remove
old transient wake units at that sitting and switch the scheduling command to the
API client. Check pending/parked/schedule counts, one due fire, one cancellation,
pause/resume, and offline identity. Keep the untouched old stores for rollback;
retire the old piece only after the coordinator verifies the move. This
implementation body performs none of these host steps.

## Offline import unit

`loom migrate clock --home <stopped-new-home> --from <old-WAKE_DATA-directory>`
reads agent subdirectories (`spool.jsonl`, `schedules.json`, `paused`, `wake.log`,
`filed.json`, `sessions.json`, `vouch.json`, `places.json`) plus household
`lanes.json` and legacy `fire` configuration (archived, never applied). Stop the old writer
before copying the source. The CLI holds the new home's daemon lock for the
whole import. It never starts timers or reads prompt files.

The import transaction includes migrations, records, base64-encoded exact source bytes and the
SHA-256 marker. It compares sorted ids, counts and content before committing.
An identical byte snapshot is a no-op; a different snapshot or populated unmarked
destination is refused. Two source reads detect concurrent source changes; this
is a check, not a substitute for stopping the old writer. Schedule ids become
`<agent>/<legacy-name>` to preserve equal names in separate agents' clocks;
wake ids remain unchanged, and duplicates are refused.

Legacy principal strings and continuation metadata confer no new authority.
Imported wakes are held for provenance review and schedules disabled. Their
`by` is an inert runner viewer: central policy cannot dispatch clock work as a
runner, even if a household member happens to use the same id. In-flight and old
runtime watch records are held uncertain and cannot use fire-now. All original
wake fields are retained in `legacy`; the exact source archive retains schedules,
logs, filed approvals and lane text. New-side lane operations are implemented; imported schedules remain disabled.
Explicit owner adoption exists only for eligible unknown plain one-offs, as
described below. Known-person/owner imports, schedules and capability-bearing
work still need owning recovery or a documented deliberate drop. Importing alone intentionally does not
authorize or start any work. The coordinator's final cutover must review held
work and reconcile uncertain bodies before enabling any schedule.

## Household lane operations

`clock.laneSet` creates or patches a household lane; `laneAssign`, `laneRemove`,
`lanes` and `laneText` cover assignment, removal and scoped reads. A lane is one
schedule row (`lane/<name>`) carrying its full text, optional repository-relative
source name and local-placement preference. Partial edits preserve omitted fields;
inline text replacement clears the old source name. The daemon never opens that
source path. The opt-in client supplies file contents when asked to set a
lane from a file. Long text stays in the row and the dispatch prompt points to
`wake lane text`. The local marker is runtime input, never a host launcher or grant;
the staging runtime holds every start regardless of placement.

Central household policy governs lane administration; the target agent must also
pass the existing create/give-work policy. Ordinary schedule editing cannot replace
a household lane, and schedule removal applies the household policy for lane rows.
Reads use the schedule's agent scope. Assignment cancels pending/held occurrences
and arms one for the new assignee in the same transaction. An already firing
intent remains attributable to its original agent; its outcome cannot create a
second next occurrence. A file-backed lane replaces matching same-agent pending
self-chained work, retaining cancellation history rather than deleting the wake.

The lane operation fixtures port the old set/assign/text/remove, partial sheet
edits, long text/local marker, slot and file self-chain cases, plus reassignment
while dispatch is in flight. The Clock app and client now expose lane settings, text replacement and assignment.

Each lane revision has a version carried by its occurrences. If a superseded or
removed lane's in-flight runtime call returns definitely-not-started, that
occurrence is cancelled instead of retried on the former assignee. Started and
uncertain outcomes retain their original attribution and are never silently
repeated. Lane removal through either operation also requires target
create/give-work policy, in addition to household policy. Names and slots use the
legacy lowercase-letter-first, 40-character format; the inline-text limit remains
6,500 characters.

Immediate runs of a household lane keep the schedule link, so reassignment also
cancels a run-now occurrence that has not dispatched. Run-now requires the same
target give-work policy as other lane administration. A database abort fixture
interrupts reassignment after occurrence cancellation and verifies full rollback
of both wake and schedule rows.

Reassignment and removal preserve held-uncertain intents verbatim, including
original attribution and outcome: those bodies still need runtime reconciliation.
File-lane adoption conservatively replaces only pending one-offs created by the
assignee agent itself. Member-created work and parked approvals remain intact;
this deliberately narrows the legacy local clock's broad same-file replacement,
because a matching path alone does not establish that a member's work was a
self-chain. Members can explicitly cancel that work through the normal operation.

## Wake now without an existing wake

`clock.now {agent,note?}` preserves the old page/command's fresh one-off behavior:
it uses the legacy no-lane prompt, names the authenticated caller, defaults the
note to `woken now from loom`, is due immediately and bypasses pause. Household
authority and target create/give-work policy are both required. Attribution is
the caller's Viewer; user-supplied identity or prompt fields are refused. The
runtime still applies its staging hold and owns model selection when omitted.
This owner action retains the old exemption from the ordinary one-off quota.

`clock.now {id}` remains the existing-wake action, including its refusal to repeat
uncertain work. Mixed `{id,agent}` inputs are refused. Job fixtures cover fresh
creation, exact prompt/default and custom notes, original future work remaining
intact, paused dispatch, runtime attribution, staging, denied actors and targets,
and ambiguous input leaving no rows. The permission addition joins the outstanding
core operations cold review before merge; the completed importer and lane reviews
do not cover it.

## Ordinary schedule replacement during dispatch

Each ordinary schedule edit creates a revision carried by its recurring
occurrences. Replacement and removal preserve firing intents and held uncertain
outcomes verbatim. A superseded occurrence whose runtime call subsequently
confirms that no body started is cancelled, rather than retried with the old
prompt. An unchanged schedule still retries definite not-started work. Ordinary
run-now remains an independent one-off, as in the old command; removing its
source schedule does not cancel that explicit run or its retry. Household lane
run-now retains its existing schedule link and reassignment behavior.

Five job cases cover replacement/removal in flight, replacement/removal after an
uncertain result, and the independent run-now retry. Against the preceding
implementation, three cases fail: replaced and removed work retries the old
prompt, and replacement cancels the uncertain record. All pass with this change.

## Legacy source audit

The entire pinned `bin/wake`, `README.md` (404 lines), `test/smoke.sh`
(116 lines) and `test/test_wake.py` (4,098 lines) have now been read.
This is not a final parity claim. In addition to
the command inventory above, the source has these domain obligations:

| Legacy behavior | Current new-side gap or choice |
| --- | --- |
| `pending_full`: 50 wake/parked one-offs per agent; API 40 total and 20 per verified conversation, unknown callers sharing one bucket; API-originated schedules 20 (only new origin-bearing schedules count) | The shared 50 cap covers at/in, park and ordinary or lane schedule run-now. API shares, schedule cap and verified conversation provenance are unfinished. A caller's continuation or conversation string cannot establish provenance. |
| `api_may_change`: a body cannot replace/cancel another conversation's work unless the runtime names owner authority | New central agent/project/member policy exists; authenticated conversation provenance still needs reconciliation with runtime, without a piece-specific authority rule. |
| Schedule re-set and run-now narrow the original principal against the caller's; an edit never widens it | Caller Viewer is retained, but the core currently has no runtime principal/conversation seam. Preserve this boundary when reconciling runtime. |
| `schedule_for_file`: a self-rearm within six hours of an authorized schedule is answered with “already scheduled” and arms nothing | Owner-authored schedule suppression and its client response are implemented below; agent-authored eligibility still needs authenticated runtime provenance. |
| `inspect_continuation`: authenticated issuer, valid opaque handle and runtime deadline before commit; no file/slot/place/approval/standing/local combination | New writes reject file/slot/place/approval/exact-local-marker combinations. The continuation remains opaque; issuer, handle and deadline inspection await runtime and confer no authority today. |
| `wake_place` / `house_may_join`: a house's named lane joins an existing conversation only with runtime-verified same-conversation provenance | Runtime owns delivery; caller-supplied place must not let work join an arbitrary existing body. The current field has no such validation yet. |
| `unpark` / `spend_words`: exact allowed-action instructions, secret re-request, no body spend for owner-applied cards; denial and timeout have distinct stop instructions | Current role instruction is appended; exact message/note and scoped next-mode approval/secret-answer composition are implemented below. |
| Local wake: whole prompt and note retained, exact digest, one approval spend, standing job checked again at fire; one pending occurrence per standing target | Local filing/recovery/standing integration remains unfinished; a local marker or free approval id is not a grant. |
| Vouch: unknown one-offs only; a person's work stays theirs; owner-applied Allow spends once for canonical ids; denial never re-asks | Owner adoption of eligible unknown plain imports and atomic owner-applied Allow are implemented, with owner client and app actions. Ask filing, grouping, denial suppression and other imported recovery remain unfinished. |
| Empty spool plants a fixed 24-hour dead-man, replaced by real work; initial unconfigured service arms nothing | Explicit configured-agent fixed 24-hour safety wakes are implemented below; default configuration is empty and no owner Viewer is synthesized. |
| Runtime model quota waits for reset (15 minutes to eight days; malformed reset defaults to an hour), does not count as a job failure; quota notice does not retry itself | Structured quota outcomes now defer to reset plus one minute without counting a failure, bounded to 15 minutes–eight days, and suppress quota-triage repeats. Owner notices are implemented through the Attention source described below. |
| Retry alerts at failure three, give-up alert at six; clock's Next and jobs shown on agent cards | Clock event history, owner failure/quota notices, scoped Next/jobs reads and live Home agent-card composition are implemented. |

Client fixtures cover runtime relay refusal, nested options, schedule/list/log
formatting and owner vouch. The app covers lane settings/text, schedules, held
and parked states and confirmations. Pause has Resume as its inverse; cancellation
does not offer an undo that could repeat a body. Ask-vouch and local-approval
app/client workflows remain incomplete. Local file pickers,
house allocation/watch, harness session reaping, transient units, launcher
fallbacks and independent bundle encryption are replaced by the new client,
runtime or coordinated core move as listed above; they must not be reintroduced
as daemon subprocesses or reads of the installed piece.


## Shared one-off capacity

Timed one-offs, parked waits and ordinary schedule run-now share the same
per-agent 50-active-one-off check, within their operation transaction. Refusal
leaves all rows untouched. Cancelled history and recurring occurrences do not
consume those slots; cancelling a parked wait frees one for run-now. Fresh owner
wake-now keeps its legacy exemption. The job fixture fills the budget with 49
timed wakes and one parked wait, refuses each additional one-off path, then
cancels the wait and runs an ordinary schedule once. It failed before the shared
check and passes afterwards. Another agent's budget stays separate. Lane run-now keeps its schedule link for reassignment but carries an explicit
`runNow` marker for one-off accounting. Persisted immediate runs from before
that marker are recognized by their lane revision and existing pause-bypass flag.
New accelerated recurring occurrences explicitly retain `runNow: false`, so they
do not consume one-off capacity. A pre-marker accelerated lane occurrence is
indistinguishable from a pre-marker lane run-now; conservatively count that old
ambiguous shape until it terminates rather than risk overfilling the budget.
An ordinary recurring occurrence never uses this fallback. Its recurring occurrence does not consume
that budget. API shares remain unfinished.

The fully read legacy smoke script verifies runtime delivery's id, agent, local
placement, wake place, preamble and prompt, absence of a model override, and that
an available legacy launcher is never invoked. Its systemd and old page checks
need corresponding new-side registry/app assertions rather than a port of the
old subprocess test. The README additionally requires continuation deadline
validation both before commit and before delivery, immutable delivery across
recovery, no retry of a failed continuation, quota reset plus one minute, and
suppression of the runtime-quota triage wake itself. The reset and triage
suppression behavior is implemented below; continuation validation remains a
runtime/domain integration obligation; the new implementation must not restore old launchers.

## Foundation review corrections

Dispatch revalidates target create/give-work policy, including when a member keeps
project visibility after losing ownership of the target agent. Existing fire-now
and ordinary schedule run-now require target give-work policy too. Replacing an
ordinary schedule binds its new words and subsequent occurrences to the authenticated
editor; it never retains a previous author's authority for new words.

Cancelling a firing intent leaves it held uncertain, with its attempt and original
attribution retained. Repeated cancellation cannot turn it into expiring terminal
history or make fire-now eligible. This is conservative even if cancellation wins
before the runtime microtask invokes the role; reconciliation owns its resolution.
Pause records enumerate the pause table as well as work, so an otherwise empty
paused agent is present on first subscription and reconnect.

## Runtime quota waits

A runtime result `{state: 'not-started', code: 'quota', reason, retryAfter?}`
confirms that no body started. `retryAfter` is an ISO instant with a timezone;
missing or malformed values default to an hour. The clock adds one minute and
clamps the wait to 15 minutes through eight days. A quota result never increments
the existing failure count, including on repeated waits, and a persisted deadline
survives restart. Ordinary definite failures retain exponential backoff and the
six-failure limit. A continuation instead becomes terminal `failed` on its first
definite non-quota failure, even if runtime supplies a retry time. Its report
authority belongs to that firing. Structured quota waits remain eligible for
deferral without spending a failure. Uncertain or thrown outcomes remain held.
Superseded work is cancelled before applying either retry path. Continuation
handle, issuer and deadline validation still require the runtime resolver.

The clock keeps the same wake id with a fresh dispatch intent after a confirmed
not-started outcome; there is no old HTTP delivery-id adapter. It records
`quota-wait` in event history. A quota result for `alert:runtime-quota` instead
cancels the triage wake and records `quota-notice`, preventing recursive triage
when no model has room. Other alert work still waits. Only a structured quota
code selects this behavior; arbitrary reason text conveys no status or authority.
The Attention source below publishes one owner notice per wake; repeated quota
waits do not reopen it. Runtime dispatch composition remains unfinished.

## Parked continuation messages

Answered parks prepend the legacy continuation instructions and label the note
once: Allowed, Denied, expired Allow and unanswered after 24 hours remain distinct.
The request id and answer stay on the wake; notes use human words. Saved kind and
target are display snapshots, never spending authority: the current visible role
answer supplies exact instructions or the current action. A denial or timeout
never receives an Allow's instructions. Grant, vouch, principal reset, box write-off
and host answers are applied by their piece; the continuation spends nothing.
Secret answers ask the new house to request again. A local-wake answer without
trusted stored-word recovery instructions tells the continuation to refile rather
than consuming an unusable receipt. Full local-approval creation and recovery is
still a later server slice. An incomplete current Allow without instructions or action details tells the body to stop and inspect the approval rather than guessing from a saved snapshot. This deliberately drops the old generic “spend with --approval” fallback: it cannot identify the allowed action. No approval is spent by unpark itself.

Ported cases: legacy Python tests for exact merge action, local words missing,
owner-applied vouch, secret re-request and resumed-note prefix replacement.
Daemon fixtures cover answer notification, 24-hour unanswered timeout, restart
before Deny, and restart after the resumed wake fires without a second body.

## File-lane self-rearm suppression

`clock.at` and `clock.in` return `{alreadyScheduled:true,schedule,due}` without
creating a wake when a file self-rearm falls within six elapsed hours (inclusive)
of the next pending occurrence of an enabled owner-authored schedule. Ordinary
file schedules and household lanes with a matching `source` both qualify. File
names are exact repository-relative strings; the server does not open or resolve
them. Work validation and central create policy run before this result; a no-op
uses no one-off capacity. Extra runs beyond that window are still armed.

A schedule must have the same agent, project and member scope, a currently
authorized owner author, and a pending future occurrence of its current revision.
The caller is either that owner or the assignee agent itself. Paused agents,
held/firing work, explicit run-now rows, continuations, approvals and delivery
places do not qualify. Agent-authored schedules cannot substitute for a rearm
until authenticated runtime conversation provenance is available; that remaining
parity obligation is tracked on t-2201. Non-owner member requests remain explicit
extra work. This deliberately narrows the old local clock's file matching while
preserving its six-hour boundary. The opt-in client renders this result
as `already scheduled: <schedule>, next at <time> (nothing armed)`.


## Desk reads

`clock.agentNext {agent}` and `clock.jobs {agent}` are read-only projections,
exposed to other pieces by `clockRole(operations)`. Both retain the caller and use
central wake visibility: the agent's clock must be visible and every returned
wake is checked separately, including private member scope. Counts and selection
use only those visible active wakes. Consumers must call with the actual viewer,
not an owner synthesized for the desk.

`agentNext` returns `{agent,paused,held,next}`. `next` is the earliest pending
wake's `{id,due,text}`, or null when paused or no pending wake is visible. A park's
answer-check deadline and a held or firing intent are not a scheduled body start;
this deliberately makes the old Next reading more precise. `held` counts visible
held rows. `jobs` includes every visible active wake, ordered by deadline and id,
with scheduled, waiting (parked/held/paused), or running (firing) status. Finished,
failed and cancelled work disappears immediately. A firing row remains running
even if the clock is subsequently paused. Recurring jobs use their schedule name;
other labels use the note or file name, capped at 300 characters. Unique task ids
come from the note. Prompt words, continuation/approval handles, saved viewers and
opaque import metadata are not returned. Authenticated conversation links remain
owed with runtime provenance; legacy metadata is never promoted into them.

All deadlines are epoch milliseconds for the consuming kit to format in the
viewer's timezone. The Clock preview link opens the registered app. These reads do not write
Attention status or duplicate runtime job state. Home composition and live refresh
are implemented as described below; wake/clock records signal refreshes.

## Clock preview app

`/p/clock-preview` is a registered kit Split app on live `wake`, `schedule` and
`clock` records. It offers active wakes, recent terminal history, ordinary schedules
and household lanes, with search and agent filtering. A person can create a timed
wake, create/edit/remove a schedule, run an extra occurrence, create/edit/reassign
a lane, replace its full text, pause/resume an agent, start fresh work or cancel a
wake. Whole lane text is available in its reader. Repository paths stay strings;
there is no daemon file picker. Times display in CT.

Destructive and immediate actions require a concrete confirmation, including in
the phone reader. Pause has Resume as its inverse. Cancelled wakes and removed
schedules retain server-defined history; the app does not invent an undo that
could repeat a body. Parked answer checks, paused rows, staging holds and uncertain
dispatches have distinct labels. An uncertain wake cannot be run or cancelled again.

Writes use `call` once in an event handler. A window-wide pending receipt survives
reader/tile navigation and blocks another clock mutation until the original
transport retry settles. Rejections remain visible, drafts remain intact and
non-live subscriptions disable mutations and clear readers. All authority remains
in the server's central policy. The app neither spends approvals nor adopts
imported provenance. Those workflows remain part of later server slices.

Next mode owns Clock's lifecycle and stops its timer before database shutdown.
Until runtime dispatch composition exists, every start remains held by Clock's
default runtime even outside staging; nothing calls the old program. Next mode composes scoped approval and secret answers as described below.

One in-process browser test exercises two windows, live creation/cancellation,
pause, lane text edits/reassignment, direct-link reload, phone confirmations,
staging hold and member isolation. It captures Neon Noir and Daylight at 390,
1280 and 1920 pixels in `artifacts/clock-app/`. CI uploads that directory with
its shard artifact.

## Opt-in wake client

`loom-wake-client` uses `LOOM_URL`, `LOOM_TOKEN_FILE` and optional `WAKE_AGENT`.
It does not replace `loom wake` (identity) or install a host command. Agent tokens
default to their own clock; members select `--agent` or `WAKE_AGENT`. The shared
command declarations generate registry CLI metadata and help. Parsing, calendar
validation, policy and human formatting run in `clock.command` in the daemon.
One outer write receipt covers nested operations and exact stdout/stderr/exit;
transport retries keep the same body and id. Redirects are refused, retry counts
are bounded and bearer text is redacted from errors and output.

Timed `-f` remains a relative repository filename for the runtime. Only `lane set
-f` reads a file in the caller's filesystem and sends its text and relative source
name. The daemon opens no prompt files. Absolute source names are deliberately
refused by the new lane operation. No local account or default agent is inferred
from old config. Legacy model defaults are replaced by runtime model choice.

Fixtures cover at/in token joining, set/list/cancel, parked messages, pause/resume,
fresh now, schedule set/list/run/rm, lane set/assign/text/rm, six-hour suppression,
global agent selection, scoped refusals, retry receipts and runtime relay refusal.
The daemon owns rearming; its new confirmation replaces obsolete systemd counts.
Empty list says `no pending wakes`: no missing-deadman warning before explicit
deadman configuration. List reports real held/firing states, never a transient
unit's armed status. Log prints structured new event time/kind/outcome or note,
with legacy duration/grep/last-2000 filtering; old subprocess log details are not
reconstructed. Schedule ids created here are namespaced by agent; existing raw
ids remain addressable only on their own agent's clock.

`vouch <id> [<id> …]` calls the existing owner-only `clock.vouch` operation.
The binding sorts and deduplicates ids into its canonical target; the operation
retains every policy, eligibility and batch-size check. The legacy owner
confirmation line is preserved; partial results add `unchanged: <ids>` rather
than claiming that every ineligible row fired. `--approval` is deliberately
refused: Allow is applied and spent by Approvals itself, never by this client.
The authenticated owner token replaces the old host-terminal identity test and
interactive typed-id confirmation. Agent tokens cannot vouch. `ask-vouch <id> [<id> …]` files one exact selected set through the owning Approvals role. Internal fire/run/reap, old UI/API envelopes and piece-local bundles are
refused in favor of the daemon, runtime, Clock app and core migration. This client
slice does not claim completion of provenance, local approvals or runtime
dispatch; those remain on t-2201. Importer-all registration is implemented in #951.


| Old client detail | New client choice and reason |
| --- | --- |
| Full argparse usage/error paragraphs | Concise `wake:` diagnostics; usage errors exit 2, operation/connection refusals exit 1. Interpreter-specific usage wrapping is not retained. |
| Implicit local agent/model from installed configuration | Agent token identity or explicit clock selection; runtime chooses an omitted model. New clients read no old configuration. |
| Raw per-agent schedule names | Namespaced internal ids, names shown in confirmations. Legacy raw ids and household lanes remain addressable on their own agent's clock. An ambiguous new-side name refuses instead of choosing work. |
| Old empty-spool warning, systemd armed flag and boot counts | Truthful empty/held/firing states and daemon rearm confirmation; no transient unit exists. |
| Subprocess-dependent log messages | New structured event time, kind and outcome/note, filtered as displayed, with the legacy duration and last-2000 rule. |
| A separate lane registry surviving removal of its schedule | One owning schedule row. Removing it through either command removes the lane; no orphaned registry is kept. |
| Caller-supplied principal statement | Refused; only the authenticated viewer and future runtime resolver can establish provenance. |

## Attention start-failure notices

When composed with Attention's trusted household source, each wake raises one
notice at the third definite start failure, one when automatic retries stop
(including the first failed continuation), and one on model quota deferral or
suppressed quota triage. Stable wake-and-kind identities prevent receipt retries,
repeated quota waits and restarts from reopening an acknowledged notice. The
outcome and notice commit together. A source failure rolls back both; the daemon
then holds the dispatch uncertain rather than retrying an unrecorded outcome.

Notices link to Clock and carry only the wake id, generic explanation and failure
category. Prompt, note, file, project/member scope and runtime error text never
enter a household notice. Only household owners can see or acknowledge them under
Attention's existing policy. Acknowledgement does not retry, cancel, approve or
start work; the Clock reader remains the place to inspect the wake. Next mode
registers this source using the installed Attention registry capability, including
when an installer already supplied Attention. Independent Clock installations
may omit it. Existing staging/uncertain outcomes do not report definite failures.

The offline registry merged in #951 already registers Clock after household;
`loom migrate all` invokes the same transactional importer as the standalone
command, with its old WAKE_DATA directory selected from the validated snapshot.
No import or live move is performed by either implementation slice.

## Home Clock composition

The new Home subscribes to the scoped live `wake` and `clock` records. Each owned
agent card shows Clock's Next and complete active Clock jobs, independently of a
reported runtime status. The browser and server share the same projection; paused
clocks, parked answer checks and held starts never become a promised Next. Job
rows open the Clock app. Reported jobs remain separately labelled as reports.
Both streams must be live before Home shows Clock words or times. Losing either
stream clears stale values; losing ownership removes the card. The existing Home
browser proof checks two-window create/pause/cancel updates and captures the
composed panels in its six-size/look evidence. No caller authority or dispatch
capability is added by these read-only panels.

## Parked-answer composition

Next mode supplies Clock with read-only owning roles for Approvals and, when
installed in the same foundation, Secrets requests. Each read retains the wake's
original viewer and checks the owning piece's current central visibility. Missing
or invisible requests remain unreadable; saved kind/target fields cannot stand
in for a current answer. Approval expiry is computed at the current clock time.
Secret revocation is reported as cancellation. No secret names, house scope,
values or request details enter this answer projection.

Committed approval, secret-request and access changes notify parked work through
the live observer; Clock removes its observer on close. Restart uses the same
roles and persisted park deadlines. Existing unpark messages distinguish Allow,
Deny, expiry and the unanswered deadline. A secret Allow tells the new body to
request again; it never carries a house grant forward. Other resource questions
report that their piece applied the access and ask the body to check it; they
never give secret-house recovery instructions or spend an approval receipt. No answer read spends an
approval or grants access, and runtime dispatch remains held until its owning
implementation is composed. Local-wake filing/recovery/standing remains unfinished. Owner-vouch application
is composed separately as described below; ask-vouch filing remains unfinished. This composition replaces the
previously missing next-mode approval parking seam.


### Continuation input exclusions

New wake, park and schedule writes reject a continuation combined with a lane
file, slot, place, explicit approval or the exact `<!-- house: local -->` marker.
Validation precedes storing work or replacing a schedule. These are the legacy
`cmd_set` exclusions, applied to the shared work validator so API clients cannot
bypass the command grammar. A plain prompt continuation remains accepted as
opaque data; issuer authentication, handle/deadline inspection and dispatch-time
validation remain unfinished and runtime dispatch remains held by default.
This change does not validate or adopt imported capabilities.

## Fixed 24-hour safety wake

`installClock({deadmanAgents: ['art']})` is a trusted composition opt-in;
`startLoom`/next mode forwards `clockDeadmanAgents`. The default is an empty list.
Neither a request nor the presence of an owner, imported metadata, an agent row,
or a legacy setting enables it. Each named agent supplies only that agent's
central-policy authority. No owner Viewer is synthesized. The normal runtime
hold remains in force; this configuration does not enable executable dispatch.

For each configured agent, an empty clock gets one fixed-word, agent-scoped wake
exactly 24 elapsed hours later, including across a DST boundary. Its durable row
and deadline survive restart. Pending, parked, firing and held work all make a
clock nonempty. Other agents' clocks are independent. On mutation, replacement
and insertion commit together: real work cancels pending or definitely-held
safety wakes, while firing and uncertain intents retain their existing safety
rules. The safety wake does not consume a one-off request slot. Terminal work
is history, so cancellation, schedule removal or confirmed completion can plant
a fresh default. Pause/resume, bounded retry/quota waits and staging apply as for
ordinary work. Removing the configuration prevents an existing default from
being dispatched; it becomes permission-held when due. Re-enabling does not
silently release that held row.

This replaces legacy `ensure_deadman` with the same fixed prompt/note and 24-hour
interval, using daemon jobs and durable records. Deliberate authority difference:
the old clock stamped its own default as owner work; the new clock acts as an
explicitly configured agent. It never reads old configuration or discovers an
owner to impersonate. No live configuration or installed command changes here.

Safety-wake fixtures inject a replacement-insert abort and compare the original
row and events, run quota deferral plus all six definite failures across restart,
and guard legacy file access and subprocesses during creation/restart/dispatch.
The required prompt and note are asserted as literals independently of constants.
A deferred runtime fixture inserts real work while a default is firing, compares
its unchanged intent, then restarts and confirms the held intent is never replayed.
Capacity coverage retains an uncertain default alongside 49 ordinary requests:
the 50th request succeeds and the 51st is refused, without altering the default.

## Owner vouch for unknown imported wakes

`clock.vouch {target: "art:w-aaaaaa,w-bbbbbb"}` adopts eligible one-off imports
as the authenticated household owner making the decision. The target is canonical,
sorted and unique, at most twelve compact/UUID wake ids and 200 characters, matching
Approvals. Current central visibility and target create/give-work policy apply to
every existing row on the target; a wrong-agent or private row refuses the whole
operation. The result lists `done` and `gone`; an entirely gone/ineligible set
refuses. This preserves the legacy approval action's partial-application behavior.

Only `held/provenance` rows from the offline importer, explicitly marked unknown
(`for: "-"`, `kind: "wake"`) in the archive, qualify. New-side agent rows are not
assumed unknown. Recurring/parked work, uncertain or attempted dispatches, local,
standing, continuation, placement or other archived capability-bearing work is
excluded. Missing legacy provenance and known-person/owner imports require their
separate recovery flow. Archived words can restrict eligibility but never supply
a Viewer. Current executable words and relative file paths are validated again; invalid
rows are reported as gone without preventing other eligible rows on the card.

The decision preserves ids, words, deadline, failures and the inert archive, stamps
`vouched` with the actual owner/time, and records a vouch event. The wake becomes
pending under that owner's current authority. Pause, revocation, staging and the
default held runtime still apply. No archived capability is restored or spent.

Next mode composes `clockVouchApplication` into newly installed Approvals. Its
owner Allow calls Clock synchronously on the same foundation transaction; Clock
rechecks policy, and Approvals spends the exact receipt once. Failure rolls back
both pieces and events. Deny changes no wakes. An installer supplying Approvals
itself must explicitly supply this application role; an uncomposed installer
continues to fail closed. Clock never reads Approvals tables or spends its receipt.

This is the backend owning application for legacy `vouch-approved` and the owner
vouch action. The wake client exposes the owner action as described above. The app
shows “Count as my work” only for a live, eligible wake visible to the current owner
with target create authority. Its confirmation retains the saved words and due time,
explains overdue dispatch and pause, and sends the existing operation through the
window’s retained retry receipt. The live `canVouch` hint is advisory; the mutation
rechecks authority and eligibility. Provenance-held work has no Run now button.
Automatic grouped asking, other imported adoption/recovery, and runtime-authenticated
provenance remain unfinished on t-2201. No live import, configuration or dispatch
is enabled by this slice.

## Explicit ask-vouch filing

`clock.askVouch {target}` and `ask-vouch <id> [<id> …]` let the authenticated
assignee agent or current household owner request adoption of selected eligible
unknown imports. Every row must remain visible and pass current create policy.
Private/member-scoped and project-scoped imports are also refused by this filing
path: an agent-scoped approval cannot carry their saved words. Scope-preserving
filing remains future work. Known-person, steered, other-agent and capability-bearing imports are refused;
archived words supply no authority. The target uses the same canonical grammar
and bounds as owner vouch. Clock generates the question and lists every id and
saved due time within Approvals' details cap. Each line includes a saved-note and
executable prompt or file excerpt, marking truncated words with `...`. Long notes
cannot consume the executable excerpt's space. These are excerpts for review;
Allow retains the complete saved words.

Next mode supplies the owning Approvals filing role; missing composition or
current central service access fails closed. No caller-supplied principal,
question, approval or details is accepted. Filing leaves work held and never
spends. Existing Approvals owns exact-target deduplication, overlapping-card
refusal and permanent Deny suppression across restarts. Existing owner Allow
applies and spends atomically through the previously shipped Clock application.
The command refuses `--approval`. A retained outer request receipt covers retry
of the command or operation after a lost response.

This unit supports explicit selections only. Automatic candidate grouping,
replacement of an unanswered grouped card and waiting overflow remain unfinished. Old service-side delayed filing is replaced for this
explicit path by a synchronous local transaction; no polling body is needed.

The Clock app exposes “Ask owner to count this work” for an eligible visible
single wake under the same authenticated assignee/owner and create checks. Its
confirmation retains the saved words and due time and states that filing starts
nothing. The existing operation files the card through the window’s retained
retry receipt; feedback names the card and its returned state. Work stays held
until owner Allow. The viewer-specific `canAskVouch` display hint grants no
authority; the operation rechecks eligibility and policy. Ineligible scoped,
steered, capability-bearing and malformed imports do not offer the action.

## Automatic owner-vouch grouping

The daemon checks held unknown imports on startup, after Clock writes, and every
minute while vouchable imports remain. Automatic candidates additionally require
archived `origin: agent:<assignee>` and `for_why: none`, with no people, member or
project scope. These hints only restrict selection; they never authenticate a
Viewer. Current executable validation and central agent see/create policy still
apply. Explicit asking remains available for eligible missing/unverified reasons.

Clock passes current eligible rows to the owning direct-only
`approvals.piece-group-vouch` operation through its composed filing role. Approvals
filters its permanent Deny history, keeps allowed cards intact, and atomically
replaces unanswered Clock cards when a new selected candidate appears. Previously
explicitly asked ids remain candidates while eligible. A partially stale card is
kept while some listed work remains and no new selected id enters; an empty card
is withdrawn. Other filers' pending/allowed cards remain intact and their ids are
excluded. No Clock-side card or denial ledger exists.

Sorted groups hold up to twelve ids within the existing 200-character target cap
(fewer UUID ids fit); overflow waits for a later pass after the current card is
answered. The owning renderer reserves every id and saved due first, then shares the
remaining details budget across executable excerpts and notes. Explicitly asked
ids take priority over new automatic candidates at capacity; separate explicit
cards remain intact when all their eligible ids cannot fit into one group. A missing role or
service access fails closed and is retried by the next daemon check. Filing never
changes the held work; only the existing owner Allow application adopts it. No
old stores, polling subprocesses or systemd jobs are involved.
