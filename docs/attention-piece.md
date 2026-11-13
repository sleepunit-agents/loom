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
| `turnsOf` | `attention.turns`, `attention.turn` live type | Bounded operation read after sequence; metadata only, live scope can select conversation as parent |

A turn write takes `{agent, project?, member?, turn}`. Its first write sets the conversation's audience; subsequent writes must carry the same project/member. Delivered text, unknown keys and unknown nested sender fields are rejected before SQL and retry storage. Reply latency uses the first recorded pending message after the last reply (sequence order, including delayed deliveries), clamped to zero. Reply/action/note require the conversation agent as sender, a run and an outcome. Other turn kinds reject run/model/harness/outcome. Dates are normalized to millisecond UTC strings, so min/max and since comparisons are chronological even when writers use different fractional precision. Place labels are kept on the conversation, never copied into every turn. Participants are capped at 32 people and 16 other agents; turns past those caps still count. Retry identity is the central operation id, scoped to the viewer, with the foundation's 30-day receipt window.

Collection operations require a service operation grant through central mayAct, matching the Tasks piece; individual and live reads use maySee type grants. New rows have one immutable policy project. The `projects` list is reserved for the union of digest references; it grants no access. Conversation metadata contains no message words. A private Comms ask must use an opaque label/reference here; its actual question and freeform reply remain encrypted in Comms, including when recording retry receipts.

## Digests

`attention.writeDigest({conversation, run, digest})` holds the agent's authored summary, asks, decisions, tasks and project references. Summary and list limits match the old backend. Question parsing and linting are copied into the piece as pure validation; no old store or runtime module is imported. The older `needs_owner_href` spelling remains accepted. Projects currently accept canonical slugs; alias and venue fallback resolution await the Projects role and must be reconciled before final move.

The `dg-` identity remains the SHA-256 prefix of conversation, NUL, run. Each deliberate write replaces that run's digest and increments its revision. Its central ask id is `<digest>:<revision>`; a retry of the operation returns its receipt and does not reopen anything. An explicit rewrite can ask again. Every later write resolves prior open conversation asks, including when `needs_owner` is null; answered asks keep their human answer. The nested attention role retains the caller and central policy. If any nested raise/resolve is refused, the entire digest write rolls back. Commit order, stored as a conversation-local order, breaks same-clock ties. `attention.digests` returns newest first, bounded to 500, and the live type filters through central policy. Scope is inherited from the conversation. The project's reference union is recomputed on replacement and never changes its policy project.

Runtime identity binding remains the runtime adapter's responsibility before dispatch; this direct operation accepts an explicit conversation/run just as other registry operations accept their record ids. No legacy caller is wired to it in this unit. Public summaries may quote a line under the old contract; Comms must keep private message words encrypted and raise only opaque desk questions.

## Completion and final move

The remaining rebuild units must add folded days/retention and findings, the old-format importer with checks and interruption/repeat coverage, generated client bindings, Inbox and Home apps, liveness checks and CI screenshot artifacts. The mapping above covers installed operations, not a completed replacement of every old conversation route or job.

For the final move, the importer must read only a copy of old data and verify ids, counts and content in one transaction. No real import or deployment is part of this implementation. After all pieces and apps are merged and the owner approves the move, the coordinator backs up, imports, starts next mode and verifies the shared counts and answers. Until then, the old side is untouched and the new side depends on no import having run.
