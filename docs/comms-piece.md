# Comms on the new foundation

This is an implementation map for the rebuild, not a completion claim. The old
side remains available until the whole new side is ready to move. The governing
contract is [web-foundation.md](specs/web-foundation.md); the behavior inventory
is [comms.md](specs/comms.md), including its appended job and attachment rules.

`src/pieces/comms` owns its tables, encryption, operations, live records and
runtime role. `web/src/pieces/comms` renders records through the shared data
client and kit. The importer is an offline command, not a second running data
path. Neither running piece nor browser reads the old stores.

## Current operations and records

All `comms.*` operations require a socket authenticated as a real page session
and the thread's original member, who must still own the agent. Ownership of a
project or the household never grants access to another member's thread.
`Authentication.window` is a trusted server capability, never a token claim.

| Operation | Input and result |
| --- | --- |
| `comms.agents` | Empty input; member identity, owned agent ids and private summaries (unread open-thread count, latest thread, first unread reply line). |
| `comms.open` | Agent, client id, words, optional project; thread/sequence acknowledgement. |
| `comms.send` | Thread, client id, words; acknowledgement. Duplicate ids require matching words. |
| `comms.messages` | Thread and optional before-sequence; newest 100 records, in sequence order. |
| `comms.change` | Thread and title/project/pin/unpin/archive/unarchive/read/stop/delete action. |
| `comms.resend` | Thread and sequence; retry an undelivered member message. |
| `comms.answer` | Thread, attention reference, yes/no; encrypted answer record. Freeform words are refused pending the private attention seam. |

The `thread` live record contains thread state with the first-message dedupe
fields removed. The `message` record resolves ciphertext outside transactions.
The live dispatcher rechecks access and the exact record after resolution;
operation preparation rechecks session validity and permission before commit.
Records are window-only. Runtime delivery rechecks thread ownership after
crypto and inside the effect hold before handing words to runtime. Decrypted sends
remain bound to the original member, conversation, project and exact message
snapshot (including its receipt); changed rows receive neither stale words nor
settlement from the old attempt. Unrelated title/read changes remain permitted.
Runtime posts check original-member ownership, archive state and instance
closure before encryption and again inside the commit transaction. A changed
member or conversation during encryption rejects the post, including card
updates, without changing messages or thread activity.

The in-process `Comms` role currently exposes `post`, `deliver`, `title`, private startup `describe`, metadata-only `trace` and
stop-consuming `status` with optional working/done heartbeats. `reconcileEnds` retries durable archive/delete end jobs at startup and can be called by the frame after staging release. `reconcileDeliveries` resumes staging-held sends at startup or on an explicit frame call, and settles archived, expired or revoked pending sends without decrypting them. Eligible `sending`/`failed` sends use an optional routing-only runtime receipt lookup: accepted settles delivered without crypto, authoritative not-accepted retries through the gate, and unknown/errors remain unchanged. Without the lookup they remain untouched. Recovery calls coalesce and recheck snapshots, ownership and retention after lookup. It is not yet the complete old runtime adapter.

Words and new runtime work payloads are age encrypted in `comms_messages`.
The key file is read per crypto operation; no age executable is required.
Retention is 1–14 days, defaults to 14, and arms the clock for the earliest
expiry. Page reads recheck every row at return after all decryption completes,
stripping expired words and work fields even before the sweep callback runs.
Answers snapshot the original member/agent/conversation/project and exact ask row before encryption, then recheck them, the ask deadline and instance availability at commit before calling attention. Unrelated thread title/read updates remain allowed. Expired words cannot be read or delivered. Deletion cascades message
rows and retains a wordless tombstone. `secure_delete` is enabled.

`exportDatabase` omits all Comms tables and their migrations. Production export
and backup consumers must use that snapshot; copying `loom.db` includes private
words. Frame composition and its callers still need verification.

## Old-to-new behavior inventory

“Partial” and “Missing” are unfinished obligations. An operation with a new
transport name must preserve the old behavior; removing polling or HTTP page
data does not remove the behavior it delivered.

| Old surface | New home | State / remaining behavior |
| --- | --- | --- |
| `/comms` list, archive filter, pins | `thread` records and kit list | Partial: own-thread list and pins work; background jobs and aggregate unread still missing. |
| `/comms/new`, `openThread`, `placeFor` | `comms.open` | Partial: first-id/hash dedupe and project gate work; app now retains 16-character base32 ids with drafts through retry/reload; backend rejects ids outside that format before encryption or writes. |
| `/comms/agents`, `agentsComms` | `comms.agents` | Backend present: owned ids plus latest open thread, count of unread open threads and first unread line (160 graphemes). Desk UI binding remains. Summaries recheck ownership, exact thread/message snapshots and retention after crypto; read results are never persisted in retry storage. |
| Thread page, `/since`, `/before`, `/events`, revision/bump helpers | `thread`/`message` subscriptions and `comms.messages` | Partial: live updates and older pages work; full thread state/digest fallback missing. No old SSE/poll path is needed. |
| `/send`, `addMemberMessage`, `resendMessage`, delivery receipts | `comms.send`, `comms.resend`, runtime role | Partial: encrypted row and dedupe work; retries of held sends that are now archived or expired settle as failed, preserving completed receipts. Startup and explicit recovery now resume staging-held sends and settle ineligible held/sending/failed sends without crypto. Eligible sending/failed sends now support an optional authoritative runtime receipt lookup; the production runtime binding, automatic staging-release binding, busy and precise runtime errors remain missing. |
| `/title`, `setTitle`, `comms_title` | `comms.change` and `Comms.title` | Partial: title bounds and member-title precedence work; agent command binding missing. |
| `/project`, `setProject`, filed threads | `comms.change` | Partial: project gate works; project integration and lookup missing. |
| Pin/unpin | `comms.change` | Present: eight-pin cap, idempotent pin, unpin releases capacity. |
| Archive/unarchive/delete | `comms.change` and staged runtime end | Partial: archive and cascade/tombstone work; end effects now have per-archive lifecycle identity and recheck the generation inside the hold, so reopening cancels a delayed old end; archive/delete now journal metadata-only end jobs in the same transaction and retry them on startup. Reopening cancels the old archive job, completion removes only its own generation, and failed/held ends remain retryable through `reconcileEnds`. Runtime end must tolerate replay after an uncertain crash. Automatic staging-release binding remains missing. |
| `/read`, `markRead`, in-front suppression | `comms.change` | Partial: read sequence is monotonic; foreground presence and notification suppression missing. |
| `/stop`, `/resume`, `/model` | Runtime control seam | Partial: one-shot stop flag only; actual interrupt/resume/model selection and state missing. |
| Adapter `describe` | `Comms.describe` | Partial: original-member readers, private/tool-use/source guidance, inline-ask guidance and conditional project/title guidance. Denies wrong agents, revoked ownership, archived/deleted threads and closed instances; refuses nonprintable or over-300-character brief lines without truncating routing identities. Trusted in-process capability only; actual runtime binding and private inline-ask synchronization remain missing. |
| Adapter `post` | `Comms.post` | Partial: encrypted replies, cards, ask refs, agent isolation and id dedupe; harness labels, spawn report refs and continuation receipt semantics need parity. |
| Adapter `reconcile` | Runtime role | Partial: message recovery supports accepted/not-accepted/unknown runtime receipts with snapshot/ownership/retention checks; production binding and full continuation/deleted/deadline semantics remain missing. |
| Adapter `trace`, `traceOf` | `Comms.trace` | Partial: newest 100 routing/delivery facts in sequence order, agent-isolated, archived allowed and deleted denied, without decryption. Fixed delivery statuses only; private tool/run/error details remain encrypted and omitted. Runtime trace command binding and richer working/queued state remain missing. |
| Adapter `status`, `stateOf`, `settleThread`, `startNotice`, `noteLoopPause` | Runtime role and clock jobs | Partial: consumes stop flag and accepts optional working/done heartbeats, preserving turn start and updating beat without moving thread activity. Archive clears working state; heartbeats cannot restart archived threads. Working state expires after 90 seconds without a beat, including startup settlement (missing beats fall back to turn start or last activity). Trusted `activity(agent,thread,{at,tokens?})` now records monotonic body movement (epoch milliseconds, integer tokens 0–1e12), ignores duplicate/older or >60-second-future samples, and clears a missing token count on a newer sample. It neither starts nor extends working state, moves thread activity nor appends messages. Thread Live records and trace show these facts only while working and within the turn-start/future bounds; idle and prior-turn facts stay hidden. The connected thread header renders the latest body activity time in CT and the exact optional token count (including zero), and hides it on turn completion or connection loss. Trusted `notice(agent,thread,{kind,id})` now records encrypted no-reply/loop notices and clears working state atomically on first insertion. Its id is a stable run/event identity; retries never clear a later turn or resurrect expired words. Trusted `startNotice(agent,thread,{seq,kind,attempt,retryAt?,reason?,run?})` now maintains one encrypted retry/failure line per member message. Attempts are monotonic; a same-attempt failure wins over retry, and final failures never reopen. Body progress suppresses late notices, including after heartbeat expiry/restart. An existing retry line now reads “couldn't start at first” with a settled work flag after progress, including after restart. The app shows a retained unsettled retry time in CT and removes it after settlement. The app now projects working/quiet/stuck and running-step time limits. Runtime binding, queued/busy timing and final-start Send again controls remain missing. |
| Adapter `spawn`, `isJob`, `isBackground` | Runtime role and thread app | Missing: preserve supplied conversation without starting a body, brief/parent, report dedupe, background grouping and follow-up promotion. |
| Watching / Join in | Thread app and runtime role | Missing: read-only watching, joined state, no interrupt on opening/closing, explicit join. |
| Activity route, `postActivity` | `Comms.post` cards plus activity role | Partial: replaces encrypted card payload and does not resurrect swept words; batch validation, run-scoped identity, timing/body limits, heartbeat and non-thread conversation steps missing. |
| `conversationSteps` | Encrypted step records | Missing: viewer gate, private-thread fail-closed routing, pages of 100, cap of 1000, export exclusion and retention. Importer currently does not import this table. |
| `comms_thread`, `agentThreadRead` | Bound internal runtime role | Partial: trusted in-process `Comms.reader` snapshots agent/conversation/house restrictions and exposes read-only pages (default 30, cap 100), with validity/ownership/row checks after crypto and retention at return. Runtime tool binding remains to be connected; no bearer operation is exposed. |
| Inline asks, kept asks, `/act`, Inbox sync | Comms ciphertext and opaque attention reference | Partial: distinct reference id and original-member yes/no forwarding work. Need private ask creation, state/history/Inbox synchronization and freeform answers without plaintext attention rows or retry results. |
| `/work`, `comms-work` piece feeds | Shared piece roles and live records | Missing: made-here tasks/changes, status ordering, project/member filtering and source links. |
| `/refs`, `comms-refs`, chip cards | Shared piece roles | Missing: authorized ref resolution, safe links and live chip updates. |
| `/about`, `/route`, `comms-about`, Chat about this | Comms operations and shell action | Missing: recipient rule, quoted attachment, validation, about-key matching and five recent owned threads. |
| Digests after words expire | Conversation role / thread app | Missing: metadata remains useful without resurrecting words. |
| Push and desktop unread integration | Attention/frame notification seam | Missing: opener-only destinations, foreground/background suppression, no private words on shared events. |
| Markdown, drafts, optimistic send, settings | Kit Comms app | Partial: safe markdown and per-member/thread drafts with stable base32 retry ids work; reply following/scroll behavior, attachment/ref rendering and disconnected/reconnect parity need completion. |

## Offline import

`loom migrate comms --home <stopped-new-home> --from <old-home>` acquires the
new home's daemon lock, opens both source databases read-only and imports
threads, messages, asks and tombstones into one destination transaction. It
preserves source ids, hashes, read marks and the old dedupe salt. With matching
keys it copies message, ask and step ciphertext byte for byte; otherwise it rekeys
in memory. Legacy card/run and answer metadata use a separate destination-key
envelope, resolved only for authorized readers and removed with words at retention. Comparison
words never enter returned diagnostics. A checksum makes exact repeats a no-op;
a changed source or populated destination is refused. A failed first import
rolls back its schema as well as its rows.

The app maps imported nested card tool/state and step details, ask question/reason/outcome
lines, and kept answer verdicts. Answered, expired, freeform and unreferenced asks do not
offer boolean answer buttons. Conversation steps still need importing before release. Imported metadata encryption and same-key ciphertext preservation now have
focused tests for both matching and different destination keys.
Source preservation includes the old files and their WAL snapshots; no live
host import has been attempted by this work.

## Composition and evidence still required

The app is registered at `/p/comms-preview`. The browser evidence fixture
installs it explicitly with a fake runtime. Production next-mode composition
must await the key, install Comms, bind attention and runtime roles, provide the
real page-session capability, and drive effect release/recovery (`reconcileEnds` exists for durable end jobs; `reconcileDeliveries` exists for held-send recovery and stale-send settlement; the release binding and production runtime receipt adapter remain missing). The normal
fixture must install the same pieces with explicit fakes. Existing old mode
must remain usable until the later move.

Focused privacy tests include session invalidation during encryption and
ownership revocation during runtime decryption and staging. Browser evidence
runs in CI, never against the live household. CI evidence at the original
checkpoint is not validation of a later head. Backend/security review has used
two of three rounds; importer review one of three. Finish these obligations
before consuming final review or marking the draft ready.

Archive/delete recovery tests restart the foundation against the same database after a staged end, then restart again to prove completed ends do not repeat. They also cover held/failed retries, concurrent recovery coalescence, reopened/rearchived lifecycle cancellation and an old in-flight completion preserving a newer delete job. This journal starts with newly committed archive/delete operations; it does not infer historical end requests.

Delivery recovery tests restart with staging-held sends, restart again after completion, coalesce concurrent retries, preserve eligible uncertain sending/failed states, and settle archived/expired/revoked sends without decrypting. With recovery disabled, four new cases fail (zero recovered deliveries, or held instead of failed); with recovery restored all 104 focused tests pass, as does TypeScript checking. No local browser run or web change in this unit.

Receipt recovery tests cover accepted/not-accepted/unknown/error, restart after completion, routing-only lookup without crypto, coalescing, and archive/ownership/receipt changes during a suspended lookup. Disabling the receipt branch makes all seven new cases fail. The runtime must guarantee that a not-accepted result fences any older attempt; otherwise it must return unknown. No schema change or production adapter is included.

Runtime describe tests cover exact brief/readers, conditional project/title guidance, no decryption or message words, agent/ownership/lifecycle denial, closed instances and malformed or oversized imported routing facts. The first test fails before implementation with `describe is not a function`; this role still needs its production runtime binding.

Heartbeat tests first failed because status ignored working/done and accepted invalid states. They now cover repeated beats, persisted turn start across restart, done, one-shot stop, archive clearing, malformed input, wrong agent, revoked ownership and closed instances. Two further tests first failed with working still true after expiry. They now cover exact 90-second settlement, heartbeat extension, restart, missing-beat fallback and close cancellation without changing message words or thread activity. This internal capability still needs runtime binding.

Body activity browser evidence checks the Live update in the thread header, exact timestamp, absent-token clearing, completion hiding and zero-token rendering. The header reports the sampled activity time and exact optional tokens. The connected working line now uses the shared pure step/status calculation for working, quiet and possibly stuck states; see the current display unit below.

Runtime post regression tests first resolved successfully after ownership
revocation, closure or conversation replacement during encryption. They now
reject with unchanged rows and activity. Tests cover replies and existing card
updates across revocation, closure, archive, deletion, member replacement and
conversation replacement; initially unavailable posts of all four kinds are
refused before encryption. All 132 focused tests and TypeScript checking pass.

Delivery snapshot regression tests pause decryption or staging, then replace the
member, conversation, project, ciphertext, message kind or receipt. All twelve
first failed because runtime still received the original words. The guarded
delivery now refuses them, preserves replacement rows, and permits unrelated
title/read changes. A foreign-agent attempt cannot alter the held receipt.
Late runtime acceptance or failure also preserves a replaced receipt. All 149
focused tests, TypeScript checking and the web production build pass after the
conflict-required rebase; no local browser ran.

Terminal runtime notice tests first failed with `notice is not a function`. Seven
cases now cover encrypted no-reply/loop wording, atomic working-state settlement,
stable retry identity across restart and a later turn, retention without
resurrection, strict input/agent validation, transaction rollback, and revoked,
closed, replaced-conversation or archived threads during encryption. Notice
words, event kind and run metadata are encrypted with the existing post path.
This is an internal capability; the runtime must call no-reply only when the
completed run reports no reply, and supply a stable run/event id. Production
binding remains required; start retry/failure persistence is described below.

Start notice tests initially failed with `startNotice is not a function`. The
trusted role now keeps one encrypted line for each member-message sequence,
updates retry attempts in place, preserves a reason when a later event omits it,
and makes final failure terminal. Reasons remain in encrypted work details,
never the headline. Strict schemas bound attempts to 1–1000 and accept an ISO
retry time only for retries. A routing-only started-through sequence remembers
body progress after working state clears, without changing the schema.

Tests cover restart, duplicate/older attempts, same-attempt failure, new-message
lifecycles, working/done/card/reply/no-reply suppression, progress during crypto,
revocation during prior-notice decryption, routing/source/notice replacement and
closure/archive during encryption, transaction rollback and retention. Crypto
stays outside transactions; changes after an awaited operation are rejected.
An overlapping notice update reports a conflict so the runtime can retry with
the same identity. No notice details enter plaintext records. Production
binding, queued/busy timers and app retry-time/Send again rendering remain
required. This unit supplies the internal persistence role only.

Runtime write guard follow-up: `post` also snapshots the original project across
sealing; a change to a different permitted project cannot redirect either a new
reply or an existing card update. `title` now refuses revoked ownership, closed
instances and archived threads, alongside wrong-agent/deleted denial and the
existing member-title precedence. Before the fix five cases failed (two project
races and three unavailable title writes). All 188 focused tests and TypeScript
checking pass afterward. No production binding or web change is included.

Existing start-retry notices now resolve to “couldn't start at first” and a
`step.settled` flag once durable body progress covers their member-message
sequence. This is a read projection from the same progress used to suppress
late start notices; it leaves encrypted rows, retention deadlines and thread
activity intact. Working/done, cards, replies and no-reply events invalidate
the existing notice Live records. Pages recheck settlement after all rows
finish decrypting. Final start failures remain failures, and prior progress
does not settle a newer member-message retry.

Before this change five new cases failed because progress never invalidated
the existing notice. Eight added cases now cover all five progress sources,
actual signed-in Live refresh, progress during page decryption, restart,
heartbeat expiry, late failure suppression, retained encrypted details, final
failure/new-message separation and expiry without resurrection. All 196 focused
tests and TypeScript checking pass. Runtime binding and app retry controls
remain required; no web code or production composition changes are included.

The app now draws “Next try at … CT” from the authorized encrypted retry
payload, with a semantic timestamp. It hides the time after body progress settles
the notice, after expiry, for final failures, and for malformed retry dates.
Imported error-card retry metadata follows the same rule. One regression test
failed before the change with no nextRetry projection; all 197 focused tests,
TypeScript checking and the web build pass after it. The existing two-window
browser proof now checks the retry timestamp and its Live removal after progress;
its six screenshots capture the retry state. Browser validation runs in CI only.

Final-start Send again remains unfinished: the current resend operation skips
messages already accepted by runtime, including starts which later fail. Adding
a button without changing that runtime receipt/start lifecycle would acknowledge
a resend while doing nothing. Transport failure and staging-held resend controls
remain separate from this missing start-failure retry behavior.

The connected working line now reuses the old app’s pure liveness calculation:
quiet at two minutes without body movement or a step start/end, possibly stuck
at twelve minutes or when any running step exceeds its limit plus thirty seconds.
A page timer updates it without another server record. It uses authorized retained
current and imported cards, excludes prior-turn steps and plans from limit alarms,
and disappears on done or connection loss. Heartbeats do not count as movement.
This changes no runtime lifecycle, storage, delivery receipt or privacy policy.
Two added unit cases cover exact thresholds, future samples, zero tokens,
completion/disconnection, imported step completion, expired words, prior turns,
plans and an overdue helper behind a newer child. The existing browser proof now
checks timer-only quiet/stuck transitions and a step-limit alarm; it runs in CI.
All 199 focused tests and TypeScript checking pass. Production runtime bindings,
queued/busy timing and final-start resend lifecycle remain required.
