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
| `wake now` | `clock.now`; owner fire-now, including while paused |
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
