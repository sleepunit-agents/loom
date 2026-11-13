# Attention: the shared desk records

The explicitly installed `src/pieces/attention` backend holds central asks, agent status and conversation metadata in `loom.db`. Other pieces use `attentionRole(operations)` to raise, answer and resolve the same asks. Installation is composition's choice; importing the module does not install it, and the old page server remains unchanged.

## Current operations

| Old surface | New operation or record | Behavior |
|---|---|---|
| `openNeeds`, Inbox asks from pieces | `attention.raise`, `attention.get`, `attention.ask` | Stable source-owned identity, original scope and wording; repeats do not reopen |
| `answerNeeds`, Inbox done/dismiss/yes/no/reply | `attention.answer` | First person answer wins, central policy, retry receipt; delivery integration is still pending |
| `needs-resolve` external facts | `attention.resolve` | Closes open asks without inventing an answer |
| Agent desk state | `attention.reportStatus`, `attention.agent` | Immutable audience, work/jobs/watches metadata |
| `recordTurn` | `attention.recordTurn` | Agent + venue + place identity, strictly validated metadata, increasing sequence and reply latency |
| `getConversation`, `listConversations` | `attention.conversation`, `attention.conversations`, `attention.conversation` live type | Policy-filtered records; list filters agent, person, venue, since and bounded limit |
| `writeDigest`, `digestsOf`, digest Needs you | `attention.writeDigest`, `attention.digests`, `attention.digest` | One digest per conversation/run, revision-specific central ask, atomic supersession |
| `foldConversations` | `attention.fold`, `attention.retain`, `startAttentionRetention` | Whole UTC days strictly older than 90 days; explicit daemon clock job |
| `daysOf`, `turnStats` | `attention.days`, `attention.stats`, `attention.day` | Held + folded counts and outcomes, per-day rounded reply median |
| `writeFinding`, `findingsOf`, `conversation_findings` | `attention.writeFinding`, `attention.findings`, `attention.finding` | Own held turns only, one checked finding per conversation/turn UTC day |
| `turnsOf` | `attention.turns`, `attention.turn` live type | Bounded operation read after sequence; metadata only, live scope can select conversation as parent |

A turn write takes `{agent, project?, member?, turn}`. Its first write sets the conversation's audience; subsequent writes must carry the same project/member. Delivered text, unknown keys and unknown nested sender fields are rejected before SQL and retry storage. Reply latency uses the first recorded pending message after the last reply (sequence order, including delayed deliveries), clamped to zero. Reply/action/note require the conversation agent as sender, a run and an outcome. Other turn kinds reject run/model/harness/outcome. Dates are normalized to millisecond UTC strings, so min/max and since comparisons are chronological even when writers use different fractional precision. Place labels are kept on the conversation, never copied into every turn. Participants are capped at 32 people and 16 other agents; turns past those caps still count. Retry identity is the central operation id, scoped to the viewer, with the foundation's 30-day receipt window.

Collection operations require a service operation grant through central mayAct, matching the Tasks piece; individual and live reads use maySee type grants. New rows have one immutable policy project. The `projects` list is reserved for the union of digest references; it grants no access. Conversation metadata contains no message words. A private Comms ask must use an opaque label/reference here; its actual question and freeform reply remain encrypted in Comms, including when recording retry receipts.

## Digests

`attention.writeDigest({conversation, run, digest})` holds the agent's authored summary, asks, decisions, tasks and project references. Summary and list limits match the old backend. Question parsing and linting are copied into the piece as pure validation; no old store or runtime module is imported. The older `needs_owner_href` spelling remains accepted. Project names retain the old slug syntax. Composition may supply `DigestReferences` to `installAttention`: a Projects role that resolves visible live names and lists visible live venue matches, plus a Comms callback for a visible thread’s canonical project. Each lookup receives the operation viewer; a refusal aborts the digest before any ask is superseded. Explicit names resolve and deduplicate in authored order, and an unknown name refuses. With none named, a live canonical thread project wins, otherwise exactly one `<venue>:<place>` match is used; zero or several matches give no reference. A thread alias or archived project does not qualify. Without the Projects role, names stay as written and no fallback runs, matching the old absent-store behavior. Reference projects never change the conversation’s policy audience.

The `dg-` identity remains the SHA-256 prefix of conversation, NUL, run. Each deliberate write replaces that run's digest and increments its revision. Its central ask id is `<digest>:<revision>`; a retry of the operation returns its receipt and does not reopen anything. An explicit rewrite can ask again. Every later write resolves prior open conversation asks, including when `needs_owner` is null; answered asks keep their human answer. The nested attention role retains the caller and central policy. If any nested raise/resolve is refused, the entire digest write rolls back. Commit order, stored as a conversation-local order, breaks same-clock ties. `attention.digests` returns newest first, bounded to 500, and the live type filters through central policy. Scope is inherited from the conversation. New digest ids use central mayCreate, including separate project and agent visibility; updates use mayAct on that immutable scope. The project's reference union is recomputed on replacement and never changes its policy project.

Runtime identity binding remains the runtime adapter's responsibility before dispatch; this direct operation accepts an explicit conversation/run just as other registry operations accept their record ids. No legacy caller is wired to it in this unit. Public summaries may quote a line under the old contract; Comms must keep private message words encrypted and raise only opaque desk questions.

## Retention and findings

Schema 4 adds folded days and checked findings. `attention.fold({conversation})` folds a day only if its newest turn is strictly older than 90 days according to the operation clock. It stores kind counts, whole-millisecond rounded median reply latency (null without samples), and outcomes by model (`unknown` when absent). It deletes the held turns, with live deletions published only after commit. Conversations, digest records, findings and the monotonically increasing conversation sequence remain. A folded day rejects all late turns. `attention.days` orders days oldest first; `attention.stats` combines held and folded counts and flattens model outcomes exactly like the old generic render. The pure `dueToProgressSeconds` measure retains the old held-turn run grouping; folded days cannot reconstruct runs.

`attention.writeFinding({conversation,seq,measure,score,text})` accepts an existing held own reply/action/note, not a received message. It stores one printable, trimmed line (maximum 200 characters) per conversation and the turn's UTC day, with the legacy `fd-` hash identity. The score is null or 1–5, matching the old grader route. A second write for that day conflicts; an operation retry returns the original receipt, even after folding. Findings retain the conversation's immutable audience and use central mayCreate, including independent agent/project checks. Under current central policy services cannot create agent-scoped findings merely from a type/operation grant; no piece-specific exception is added. Grader/runtime authorization and review-token validation remain adapter work before final move. The new write never consumes audit text or legacy review tokens. `attention.findings` reads newest first, strictly after `since`, at most 500; it supports conversation and agent filters with policy applied before the limit. Both live types inherit scope. Stats require access to both day and turn types; service collection reads also require the operation grant.

`attention.retain({})` folds every conversation the caller can act on, without the desk list limit, through nested `attention.fold` calls. A refusal rolls back the entire sweep. `startAttentionRetention(operations,viewer,report)` is an explicit composition hook: first run on the clock's next tick, then daily, reporting the operation result. The daemon must supply its authorized viewer, report failures and call the returned stop function before closing the foundation. It never widens that viewer's access (including member-private conversations). It installs no host timer and starts no process. Production composition and runtime authorization are still pending; simply installing Attention does not start retention.

## Completion and final move

The Inbox preview is registered at `/p/inbox-preview` on the kit and reads only `attention.ask` through `useRecords`. It has Needs you, alphabetical agent folders, search, answered/resolved history and a full question reader. Opening a row starts `attention.get`; direct links and invalidated checks offer Check again. It shows answer controls only after that read confirms the ask is open, then repeats that read immediately before `attention.answer`. Connection loss, scope loss, a changed live set or leaving the reader invalidates a pending check. A shared guard above reader navigation permits only one pending check/write, including after closing or switching the reader. One pending call retains its operation id through reconnects; failures are inline and a rejected words answer retains its draft while the reader stays open. Done and Dismiss wait while a words draft is unsent. Drafts are local component state, not saved across closing or reloading.

Approval/task source asks and `waits_on` decisions open the owning preview app rather than recording an ineffective central yes. Member-private asks show no central answer controls: replies must stay encrypted in Comms. Ordinary asks can record yes/no, words (only in words mode), done or dismiss under server policy. This bounded preview **records** an answer; it does not deliver a message or start a body. Runtime delivery, optional public words on yes/no asks and private encrypted replies remain required before final move. The UI states this limitation. The current live type includes every visible ask, including all answered history; there is no second archive cache or legacy Inbox read.

The single Inbox browser test brings a disposable next-mode loom and fake clock, proves two-window first-answer propagation and private/project filtering, and captures 390/1280/1920 screenshots in Neon Noir and Daylight under `artifacts/attention-inbox`, uploaded by the ordinary CI shard artifact. No browser suite runs on loom's machine.

| Old Inbox surface | New preview |
|---|---|
| Needs you / by-agent folders / answered | Central `attention.ask` filtered in the screen; resolved asks appear under Answered |
| Full ask, why, if-yes/no, refs, answer/by/time | Kit Split reader, with HTTP(S)-only authored reference links |
| `/inbox/open`, fresh before action | Socket `attention.get` on opening a row (or Check again for a direct link) and immediately before write |
| Done / Dismiss / words / Yes / No | `attention.answer`; source-owned decisions link to their owning app |
| Conversation reply delivery | Pending runtime composition; preview labels answers as recorded, never delivered |
| Private question/reply wording | Remains in Comms; Inbox uses only opaque central metadata |
| Read/unread marks, local persistent reply drafts, FYI/error folders and bulk actions | Not added to this preview: central asks have no read-mark or notice model; final composition must reconcile owning-piece notices before the old Inbox is retired |

Home has a bounded preview below; final delivery and production role composition remain. The mapping above covers installed operations and the bounded preview, not a completed replacement of every old conversation route or job.

For the final move, the importer must read only a copy of old data and verify ids, counts and content in one transaction. No real import or deployment is part of this implementation. After all pieces and apps are merged and the owner approves the move, the coordinator backs up, imports, starts next mode and verifies the shared counts and answers. Until then, the old side is untouched and the new side depends on no import having run.

## Offline import

`loom migrate attention --home <stopped-new-home> --from <copied-memories.db> --scopes <conversation-audiences.json>` accepts repeated `--from` flags for the whole household batch. All source databases must be stopped copies; none is written. The home is explicit and the CLI holds the daemon's home lock throughout. There is no default home and no automatic discovery of installed pieces or live data. A source cannot also be the destination, including through a hardlink. This implements the importer only; no real import is authorized by this change.

The audience file maps **every** conversation id to `{project?, member?}`. An explicit `{}` means agent audience alone. The agent is preserved from the source; a digest's reference projects never determine policy. The coordinator must reconcile private thread membership with Comms before producing this file. Missing, extra or malformed entries refuse the batch. Approval/task asks are migrated by their owning pieces through the role; this importer covers only conversation asks.

| Old data | Import mapping |
|---|---|
| `conversations` | Same ids, metadata and `last_seq` high-water mark (`turns`), normalized UTC dates with reconciled bounds; project reference union recomputed |
| `conversation_turns` | Same seq, sender, time, kind, run/model/harness/outcome and recorded latency; stable `conversation:seq` ids; original writer retained as `{kind: 'legacy', id: <old writer>}` |
| `conversation_days` | Same counts, median and model outcomes; stable `conversation:day` ids; no replay/recomputation |
| `conversation_digests` | Same ids and authored content; revision starts at 1, order follows old raw timestamp `at,rowid` (SQLite BINARY); stored pre-lint question wording is retained |
| Digest Needs you | Ask id `digest:1`; only newest digest can remain open, including same-clock rowid ties; a newest null resolves older asks |
| `conversation_needs_answers` | Current answers close their asks; done/dismissed/replied/yes/no become done/dismiss/replied/yes/no; resolved retains its reason; actual reply words were never in the source |
| Old answer predating a same-run rewrite | Current ask stays open; original answer metadata retained as digest `legacyAnswer`, without claiming the rewritten wording was what the person answered |
| `findings` | Same ids, seq, day, score, measure, text and time, including findings on folded turns |

Every source is read within one read transaction, including committed WAL data. The batch checksum covers the canonical snapshots (all selected source columns and rowids) and the audience map; filenames and batch order do not affect it. Source stores are separate SQLite databases, so their snapshots are not a cross-database instant: the offline stopped-copy requirement supplies that consistency. Optional old href/json, answer reason and findings tables may be absent. Broken identities, orphans, sender words, invalid dates/JSON, held/folded overlap or inconsistent turn totals refuse the import.

The new records, migration history and receipt are committed in one destination transaction. Import into a nonempty Attention destination is refused. Before the receipt is written, every target table is compared against the complete mapped records (ids, counts and content); any mismatch or interruption rolls everything back. Repeating the same batch and map is a no-op; changing either refuses. The receipt intentionally is not a continuous mirror/check of a destination subsequently used by the daemon. It never gates installation, operations or next-mode startup. Schema 5 only adds the offline receipt table.

`replied` is an import-only answer kind: a delivered reply with no stored words. Runtime answer input still accepts only yes/no/done/dismiss/words. Digest `legacyAnswer` preserves the original verdict, actor, time and optional reason even when it predates a rewrite or the current digest cleared its ask. Old overwritten digest revisions and old delivered message words cannot be recovered and are not invented. Status records are derived from live runtime state, never fabricated from old conversation rows.

Legacy timestamps with mixed fractional precision exposed an old lexical min/max bug. The importer takes the chronological min/max of both stored bounds and all held turns; when this repairs a bound it also retains the exact source strings as conversation `legacyBounds`. Folded turns no longer expose their individual timestamps, so they cannot supply more precise bounds than the source retained. No source record is changed.

## Generated API client

`loom-attention <operation> [json-object]` is an opt-in executable for the new side. `attentionCommands` supplies both the installed operations' CLI metadata and the client's help, write markers and command names. An installation refuses mismatched metadata. Every installed Attention operation is offered. The client sends the JSON object unchanged to `/api/attention/<operation>`; the daemon owns defaults, validation, authorization and all domain behavior. With no JSON argument it sends `{}`. Nested objects, numbers and nulls use JSON rather than a second flag parser.

Set explicit `LOOM_URL` (an HTTP or HTTPS origin) and `LOOM_TOKEN_FILE` (a token for that daemon), then use, for example, `node dist/attention-client.js conversations '{"agent":"art","limit":10}'`. Success prints the operation value as pretty JSON and exits 0; a daemon refusal, connection/configuration error or malformed envelope exits 1 with a generic stderr line and no data; malformed command/JSON usage exits 2. `--help` exits 0 without credentials or a daemon. Redirects are refused; retries are bounded to four attempts, retaining the same operation id and body for a write. The supplied bearer token is redacted from returned string values. It opens only the explicit token file, never a domain store or a legacy executable.

There was no old `loom attention` executable to replace: conversation and digest tools were MCP bindings. This is the direct operation JSON surface, not an adapter for the old MCP envelope. MCP runtime identity/run binding and delivered answers remain separate final-composition obligations. The standalone launcher leaves existing commands and callers untouched until the whole-side move. During that move, compose Attention explicitly and point the launcher at the new daemon; no import receipt selects it. Production Projects/Comms role wiring, public optional words replies and private encrypted Comms delivery remain pending.

## Project reference composition

| Old lookup | New seam |
|---|---|
| `project_names` live slug/alias lookup | `DigestReferences.projects.resolve(viewer, name)` |
| `projects.card_json.links.venues` fallback | `DigestReferences.projects.byVenue(viewer, venuePlace)` |
| `writeDigest(..., threadProject)` trusted thread filing | `DigestReferences.threadProject(viewer, conversation)` |

These synchronous read roles must use the new database and the caller’s central visibility; they return typed failures without falling back on denial or unavailability. Only visible live canonical slugs may be returned. The thread callback must enforce Comms membership and return metadata only. There is no public thread-project argument, old-store reader or production adapter in Attention. Projects has no in-repo role on main yet, so tests supply small fakes as allowed by the rebuild brief. Final composition must reconcile these interfaces with the installed Projects and Comms roles before the move; this seam alone does not complete that integration. Import keeps historical project references as recorded rather than resolving them against current cards.

## Home preview

Next-mode composition installs Attention with no external jobs or delivery adapter. The old startup path is unchanged. The shell's Home surface and `/p/home-preview` use only `useRecords`: `attention.ownedAgent` supplies the roster, `attention.agent` supplies reported work, and `attention.ask` supplies the count, oldest three open questions and each agent's full first question. Answered/resolved questions stop counting everywhere. The roster is derived from the central Sharing snapshot, not from status reports or asks: central `mayAct(..., give-work)` restricts cards to owned agents, including ones with no report. Project access alone never adds a card. A `core.access` change uses the foundation's existing subscription replacement, including removing cards on ownership loss. There is no new roster table or archive.

Cards sort case-insensitively by display name, then id. The current household has canonical agent ids but no new-side People name/mark role, so the roster uses that id as its display name. The newest visible status by `changedAt`, then id, supplies state/work; absent reports say so. Times are shown in Central time. Cards remain visible with no asks/work. Ask loading/offline/denied never says All clear or leaves answer controls; status and roster failures are separate errors. No private Comms words are read here.

The first question reuses the Inbox's complete `AskReader`, including why, both consequences, references, source-app/private restrictions and answer receipt. Its Check again action confirms display; every answer performs a second immediate `attention.get`. A single guard above all cards survives changing the first ask and serializes display/prewrite/write calls across cards through their result. Live snapshot or ownership loss invalidates prewrite checks. Each card also keeps its latest answer receipt visible while advancing to the next question; that receipt is selected from central answer facts, never a local copy. Remaining questions and the top three open the exact Inbox reader. This preview has the same recorded-only/delivery limitation as Inbox.

| Old Home surface | New surface / remaining work |
|---|---|
| Owned cards, alphabetical, including idle | Derived `attention.ownedAgent`; canonical id fallback until People name/face role is composed |
| Needs you total, first three, +N more | Same open `attention.ask` set as Inbox; links open exact ask or full Inbox |
| Full first question | Shared `AskReader` and `attention.answer`, including fresh reads and first-answer policy |
| Current work | Newest visible `attention.agent` report; no status is invented |
| Face/colour, jobs/watches, unread/recent private thread, next Clock wake, last three tape steps, composer, work rail/ticker, phone accordion | Required final desk composition, not implemented by this bounded Home preview; use owning roles/live records and keep private Comms words encrypted/nonpersisting |

One CI browser test covers the actual shell Home and registered Home preview, idle cards, two-window answer/count propagation, project-only visibility versus ownership, private filtering, and six 390/1280/1920 Neon Noir/Daylight screenshots (`artifacts/attention-home`). No browser suite runs on loom's machine. Home/Inbox previews alone do not complete t-2205 or authorize retirement of the old desk.
