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

`attention.writeDigest({conversation, run, digest})` holds the agent's authored summary, asks, decisions, tasks and project references. Summary and list limits match the old backend. Question parsing and linting are copied into the piece as pure validation; no old store or runtime module is imported. The older `needs_owner_href` spelling remains accepted. Projects currently accept canonical slugs; alias and venue fallback resolution await the Projects role and must be reconciled before final move.

The `dg-` identity remains the SHA-256 prefix of conversation, NUL, run. Each deliberate write replaces that run's digest and increments its revision. Its central ask id is `<digest>:<revision>`; a retry of the operation returns its receipt and does not reopen anything. An explicit rewrite can ask again. Every later write resolves prior open conversation asks, including when `needs_owner` is null; answered asks keep their human answer. The nested attention role retains the caller and central policy. If any nested raise/resolve is refused, the entire digest write rolls back. Commit order, stored as a conversation-local order, breaks same-clock ties. `attention.digests` returns newest first, bounded to 500, and the live type filters through central policy. Scope is inherited from the conversation. New digest ids use central mayCreate, including separate project and agent visibility; updates use mayAct on that immutable scope. The project's reference union is recomputed on replacement and never changes its policy project.

Runtime identity binding remains the runtime adapter's responsibility before dispatch; this direct operation accepts an explicit conversation/run just as other registry operations accept their record ids. No legacy caller is wired to it in this unit. Public summaries may quote a line under the old contract; Comms must keep private message words encrypted and raise only opaque desk questions.

## Retention and findings

Schema 4 adds folded days and checked findings. `attention.fold({conversation})` folds a day only if its newest turn is strictly older than 90 days according to the operation clock. It stores kind counts, whole-millisecond rounded median reply latency (null without samples), and outcomes by model (`unknown` when absent). It deletes the held turns, with live deletions published only after commit. Conversations, digest records, findings and the monotonically increasing conversation sequence remain. A folded day rejects all late turns. `attention.days` orders days oldest first; `attention.stats` combines held and folded counts and flattens model outcomes exactly like the old generic render. The pure `dueToProgressSeconds` measure retains the old held-turn run grouping; folded days cannot reconstruct runs.

`attention.writeFinding({conversation,seq,measure,score,text})` accepts an existing held own reply/action/note, not a received message. It stores one printable, trimmed line (maximum 200 characters) per conversation and the turn's UTC day, with the legacy `fd-` hash identity. The score is null or 1–5, matching the old grader route. A second write for that day conflicts; an operation retry returns the original receipt, even after folding. Findings retain the conversation's immutable audience and use central mayCreate, including independent agent/project checks. Under current central policy services cannot create agent-scoped findings merely from a type/operation grant; no piece-specific exception is added. Grader/runtime authorization and review-token validation remain adapter work before final move. The new write never consumes audit text or legacy review tokens. `attention.findings` reads newest first, strictly after `since`, at most 500; it supports conversation and agent filters with policy applied before the limit. Both live types inherit scope. Stats require access to both day and turn types; service collection reads also require the operation grant.

`attention.retain({})` folds every conversation the caller can act on, without the desk list limit, through nested `attention.fold` calls. A refusal rolls back the entire sweep. `startAttentionRetention(operations,viewer,report)` is an explicit composition hook: first run on the clock's next tick, then daily, reporting the operation result. The daemon must supply its authorized viewer, report failures and call the returned stop function before closing the foundation. It never widens that viewer's access (including member-private conversations). It installs no host timer and starts no process. Production composition and runtime authorization are still pending; simply installing Attention does not start retention.

## Completion and final move

The remaining rebuild units must add the old-format importer with checks and interruption/repeat coverage, generated client bindings, Inbox and Home apps, liveness checks and CI screenshot artifacts. The mapping above covers installed operations, not a completed replacement of every old conversation route or job.

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
