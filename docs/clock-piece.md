# Clock in the new foundation

Work in progress for t-2201. The clock is being built beside the installed clock;
this branch switches no page, command, timer or live data. The new side must never
read the installed piece or its stores. Only the offline importer reads old files.

The upstream contract is `sleepunit-agents/loom-clock` at
`5e362d05389015cf48b5d69bf5f4f00a0b8f1631`: `bin/wake`, `README.md`,
`test/test_wake.py` and `test/smoke.sh`. Its CLI already redirects relays to the
runtime. `loom wake` loads identity and is unrelated to scheduling.

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
before SQLite closes. It is currently installed explicitly by tests only.
Nothing installs it on the existing production path.

The runtime dependency accepts a durable intent and returns started,
definitely-not-started, held, or uncertain. Intent commits before the asynchronous
call. Restart holds any remaining firing intent; stopping the installer prevents
late completion from writing. Cancellation before invocation suppresses the call;
cancellation after invocation records that a body may have started. Uncertain
work cannot be released with fire-now. Known-not-started work alone backs off.
The default runtime is a staging hold. The small runtime and approvals dependency
files are temporary role contracts pending the other pieces' implementations.

The current tests exercise these transitions on `startLoom`/`FakeClock`, including
pause release order, a parked answer and timeout, changed dispatch permission,
live-record aging, and the next occurrence across Chicago daylight saving.
CLI parity, lane assignment, vouch/approval workflows, app and final
new-side composition remain unfinished; the migration still needs cold review
before any merge.

## Old surface inventory and intended replacements

The operations below are the implementation checklist, not a claim that all are
already available. The final PR must replace this sentence with its parity evidence.

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
| `wake vouch`, `wake ask-vouch`, `vouch-approved` action | owner answer through approvals role; never infer owner authority from an unknown wake |
| `wake relay`, `wake relays` | same refusal directing the caller to runtime; already removed upstream |
| `wake reap`, legacy session reaper | dropped: runtime owns every new body and stuck-body handling |
| `wake bundle export/import` | coordinated core backup/import, not an independently encrypted child program |
| `wake api` | foundation HTTP/MCP/direct operations; no subprocess envelope |
| `wake ui` manifest/page | registered Clock app at `/p/clock-preview`; live `wake` and `schedule` |
| UI `now`, `pause`, `resume`, `cancel` | the same operations as CLI, via `call` |
| UI schedule create/edit/remove/run | the same schedule operations as CLI |
| UI lane create/edit/assign/remove | the same lane operations as CLI |
| parked request checks every 5 minutes | role notifications where available, plus daemon deadline/check job |
| schedule fire creates one next occurrence | next row committed with the current fire intent |
| dead-man when spool empty | daemon job, subject to central policy and staging hold |
| transient unit collision recovery | dropped: no transient units in the new side |
| fire/standby lock files | dropped: single daemon owns SQLite and its timers |
| dispatch retry/backoff and quota handling | only known-not-started outcomes may retry; uncertain fires are held, never repeated |
| allocated-house watch/session command launch | dropped from clock: runtime starts and tracks bodies through its role |
| local approvals, standing jobs, continuation handles | preserve capability and approval metadata through runtime/approvals roles; no alternate launcher |

## Required verification before completion

Use `startLoom` with `FakeClock` for operations and daemon lifecycle: overdue while
down; crash after intent and before outcome; late outcome from the stopped daemon;
cancel before dispatch and racing a fire; pause/resume; parked answers and timeout;
one occurrence per schedule; DST; staging holds; owner/member/project/agent policy;
scope aging after 24 hours. No fixed sleeps, subprocesses or browser suite on loom's
machine. The standalone calendar tests cover DST and invalid input directly.

The importer must compare source ids, counts and content, and commit all rows and
its source checksum in one transaction. Test identical-source no-op, different
source refusal, and injected interruption rollback on constructed old-format data.
Preserve opaque old metadata without treating it as new authorization. A source
`_firing` is uncertain, so hold it instead of replaying it.

The generated `loom-wake-client` must share declarative registry command metadata,
hold no domain logic or database access, and match upstream output and exit codes
on fixtures. The Clock app must use the kit, `useRecords` and `call`, with one
browser test for two-window behavior and CI screenshot artifacts at the required
widths and looks.

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
logs, filed approvals and lane text. Restoration of lane operations and explicit
owner provenance adoption are unfinished. Importing alone intentionally does not
authorize or start any work. The coordinator's final cutover must review held
work and reconcile uncertain bodies before enabling any schedule.

## Household lane operations

`clock.laneSet` creates or patches a household lane; `laneAssign`, `laneRemove`,
`lanes` and `laneText` cover assignment, removal and scoped reads. A lane is one
schedule row (`lane/<name>`) carrying its full text, optional repository-relative
source name and local-placement preference. Partial edits preserve omitted fields;
inline text replacement clears the old source name. The daemon never opens that
source path. The generated client will supply file contents when asked to set a
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
while dispatch is in flight. The old page and client formatting are still pending.

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

The entire pinned `bin/wake`, `README.md` (404 lines) and `test/smoke.sh`
(116 lines) have now been read. The Python test suite still requires a complete
read; this is not a final parity claim. In addition to
the command inventory above, the source has these domain obligations:

| Legacy behavior | Current new-side gap or choice |
| --- | --- |
| `pending_full`: 50 wake/parked one-offs per agent; API 40 total and 20 per verified conversation, unknown callers sharing one bucket; API schedules 20 | The shared 50 cap covers at/in, park and ordinary schedule run-now. Lane run-now accounting, API shares, schedule cap and verified conversation provenance are unfinished. A caller's continuation or conversation string cannot establish provenance. |
| `api_may_change`: a body cannot replace/cancel another conversation's work unless the runtime names owner authority | New central agent/project/member policy exists; authenticated conversation provenance still needs reconciliation with runtime, without a piece-specific authority rule. |
| Schedule re-set and run-now narrow the original principal against the caller's; an edit never widens it | Caller Viewer is retained, but the core currently has no runtime principal/conversation seam. Preserve this boundary when reconciling runtime. |
| `schedule_for_file`: a self-rearm within six hours of an authorized schedule is answered with “already scheduled” and arms nothing | Lane creation replaces pending self-chains conservatively; the rearm response and six-hour suppression are not implemented. |
| `inspect_continuation`: authenticated issuer, valid opaque handle and runtime deadline before commit; no file/slot/place/approval/standing/local combination | Current continuation field is opaque data only; validation and runtime capability inspection remain unfinished. It must not convey authority by its presence. |
| `wake_place` / `house_may_join`: a house's named lane joins an existing conversation only with runtime-verified same-conversation provenance | Runtime owns delivery; caller-supplied place must not let work join an arbitrary existing body. The current field has no such validation yet. |
| `unpark` / `spend_words`: exact allowed-action instructions, secret re-request, no body spend for owner-applied cards; denial and timeout have distinct stop instructions | Current role instruction is appended; exact message/note and question-role parity remain unfinished. |
| Local wake: whole prompt and note retained, exact digest, one approval spend, standing job checked again at fire; one pending occurrence per standing target | Approvals integration remains unfinished; a local marker or free approval id is not a grant. |
| Vouch: unknown one-offs only; a person's work stays theirs; owner-applied Allow spends once for canonical ids; denial never re-asks | Provenance adoption, explicit asks and grouped automatic asks remain unfinished. Imported metadata never authorizes them. |
| Empty spool plants a fixed 24-hour dead-man, replaced by real work; initial unconfigured service arms nothing | Dead-man job and explicit configured-agent behavior remain unfinished. Do not synthesize an owner Viewer from a local machine default. |
| Runtime model quota waits for reset (15 minutes to eight days; malformed reset defaults to an hour), does not count as a job failure; quota notice does not retry itself | Current generic not-started retry counts a failure; quota outcome parity and owner notice integration remain unfinished. |
| Retry alerts at failure three, give-up alert at six; clock's Next and jobs shown on agent cards | Clock event history exists; attention role publication and owner notices remain unfinished. |

The client still owes exact stdout/stderr/exit fixtures, including the runtime
relay refusal, nested verb options, and schedule/list/log formatting. The app
still owes lane settings and text replacement, schedule details, distinct held
and parked states, confirmations and relevant undo actions. Local file pickers,
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
check and passes afterwards. Another agent's budget stays separate. API shares
and lane run-now accounting remain part of the unfinished parity work.

The fully read legacy smoke script verifies runtime delivery's id, agent, local
placement, wake place, preamble and prompt, absence of a model override, and that
an available legacy launcher is never invoked. Its systemd and old page checks
need corresponding new-side registry/app assertions rather than a port of the
old subprocess test. The README additionally requires continuation deadline
validation both before commit and before delivery, immutable delivery across
recovery, no retry of a failed continuation, quota reset plus one minute, and
suppression of the runtime-quota triage wake itself. These remain runtime/domain
integration obligations; the new implementation must not restore old launchers.
