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
| `comms.agents` | Empty input; member identity and owned agent ids. Agent desk summaries remain to be added. |
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

The in-process `Comms` role currently exposes `post`, `deliver`, `title` and
stop-consuming `status`. It is not yet the complete old runtime adapter.

Words and new runtime work payloads are age encrypted in `comms_messages`.
The key file is read per crypto operation; no age executable is required.
Retention is 1–14 days, defaults to 14, and arms the clock for the earliest
expiry. Expired words cannot be read or delivered. Deletion cascades message
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
| `/comms` list, archive filter, pins | `thread` records and kit list | Partial: own-thread list and pins work; background jobs, stale working state and aggregate unread still missing. |
| `/comms/new`, `openThread`, `placeFor` | `comms.open` | Partial: first-id/hash dedupe and project gate work; app now retains 16-character base32 ids with drafts through retry/reload; backend rejects ids outside that format before encryption or writes. |
| `/comms/agents`, `agentsComms` | `comms.agents` | Partial: owned ids only; last thread, unread reply count and first unread line missing. |
| Thread page, `/since`, `/before`, `/events`, revision/bump helpers | `thread`/`message` subscriptions and `comms.messages` | Partial: live updates and older pages work; full thread state/digest fallback missing. No old SSE/poll path is needed. |
| `/send`, `addMemberMessage`, `resendMessage`, delivery receipts | `comms.send`, `comms.resend`, runtime role | Partial: encrypted row and dedupe work; durable delivery/restart reconciliation, stale sends, busy and precise runtime errors missing. |
| `/title`, `setTitle`, `comms_title` | `comms.change` and `Comms.title` | Partial: title bounds and member-title precedence work; agent command binding missing. |
| `/project`, `setProject`, filed threads | `comms.change` | Partial: project gate works; project integration and lookup missing. |
| Pin/unpin | `comms.change` | Present: eight-pin cap, idempotent pin, unpin releases capacity. |
| Archive/unarchive/delete | `comms.change` and staged runtime end | Partial: archive and cascade/tombstone work; end effects now have per-archive lifecycle identity and recheck the generation inside the hold, so reopening cancels a delayed old end; durable end recovery and automatic resume after staging release remain missing. |
| `/read`, `markRead`, in-front suppression | `comms.change` | Partial: read sequence is monotonic; foreground presence and notification suppression missing. |
| `/stop`, `/resume`, `/model` | Runtime control seam | Partial: one-shot stop flag only; actual interrupt/resume/model selection and state missing. |
| Adapter `describe` | Runtime role | Missing: member-only brief/readers, project, title guidance and inline-ask guidance. |
| Adapter `post` | `Comms.post` | Partial: encrypted replies, cards, ask refs, agent isolation and id dedupe; harness labels, spawn report refs and continuation receipt semantics need parity. |
| Adapter `reconcile` | Runtime role | Missing: delivered/not-accepted/unresolved/deleted continuation receipt and deadline/clock behavior. |
| Adapter `trace`, `traceOf` | Runtime role | Missing: bounded metadata-only delivery trace and deleted/archived behavior. |
| Adapter `status`, `stateOf`, `settleThread`, `startNotice`, `noteLoopPause` | Runtime role and clock jobs | Partial: consumes stop flag; working/done heartbeat, alive/token facts, queued/failed/retry/no-reply/loop notices and stale transitions missing. |
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

Before release, map old card/step/ask shapes into the app and import conversation
steps. Imported metadata encryption and same-key ciphertext preservation now have
focused tests for both matching and different destination keys.
Source preservation includes the old files and their WAL snapshots; no live
host import has been attempted by this work.

## Composition and evidence still required

The app is registered at `/p/comms-preview`. The browser evidence fixture
installs it explicitly with a fake runtime. Production next-mode composition
must await the key, install Comms, bind attention and runtime roles, provide the
real page-session capability, and drive effect release/recovery. The normal
fixture must install the same pieces with explicit fakes. Existing old mode
must remain usable until the later move.

Focused privacy tests include session invalidation during encryption and
ownership revocation during runtime decryption and staging. Browser evidence
runs in CI, never against the live household. CI evidence at the original
checkpoint is not validation of a later head. Backend/security review has used
two of three rounds; importer review one of three. Finish these obligations
before consuming final review or marking the draft ready.
