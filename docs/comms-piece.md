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
crypto and inside the effect hold before handing words to runtime.

The in-process `Comms` role currently exposes `post`, `deliver`, `title`, private startup `describe`, metadata-only `trace` and
stop-consuming `status` with optional working/done heartbeats. `reconcileEnds` retries durable archive/delete end jobs at startup and can be called by the frame after staging release. `reconcileDeliveries` resumes staging-held sends at startup or on an explicit frame call, and settles archived, expired or revoked pending sends without decrypting them. Eligible `sending`/`failed` sends use an optional routing-only runtime receipt lookup: accepted settles delivered without crypto, authoritative not-accepted retries through the gate, and unknown/errors remain unchanged. Without the lookup they remain untouched. Recovery calls coalesce and recheck snapshots, ownership and retention after lookup. It is not yet the complete old runtime adapter.

Words and new runtime work payloads are age encrypted in `comms_messages`.
The key file is read per crypto operation; no age executable is required.
Retention is 1–14 days, defaults to 14, and arms the clock for the earliest
expiry. Page reads recheck every row at return after all decryption completes,
stripping expired words and work fields even before the sweep callback runs.
Answers recheck the ask deadline at commit before calling attention. Expired words cannot be read or delivered. Deletion cascades message
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
| Adapter `status`, `stateOf`, `settleThread`, `startNotice`, `noteLoopPause` | Runtime role and clock jobs | Partial: consumes stop flag and accepts optional working/done heartbeats, preserving turn start and updating beat without moving thread activity. Archive clears working state; heartbeats cannot restart archived threads. Working state expires after 90 seconds without a beat, including startup settlement (missing beats fall back to turn start or last activity). Trusted `activity(agent,thread,{at,tokens?})` now records monotonic body movement (epoch milliseconds, integer tokens 0–1e12), ignores duplicate/older or >60-second-future samples, and clears a missing token count on a newer sample. It neither starts nor extends working state, moves thread activity nor appends messages. Thread Live records and trace show these facts only while working and within the turn-start/future bounds; idle and prior-turn facts stay hidden. The connected thread header renders the latest body activity time in CT and the exact optional token count (including zero), and hides it on turn completion or connection loss. Queued/failed/retry/no-reply/loop notices and production runtime binding remain missing. |
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

Body activity browser evidence checks the Live update in the thread header, exact timestamp, absent-token clearing, completion hiding and zero-token rendering. The header reports the sampled activity time; it does not infer quiet/stuck state or step limits. Those richer old status semantics remain unfinished.
