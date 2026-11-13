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
| `turnsOf` | `attention.turns`, `attention.turn` live type | Bounded operation read after sequence; metadata only, live scope can select conversation as parent |

A turn write takes `{agent, project?, member?, turn}`. Its first write sets the conversation's audience; subsequent writes must carry the same project/member. Delivered text, unknown keys and unknown nested sender fields are rejected before SQL and retry storage. Reply/action/note require the conversation agent as sender, a run and an outcome. Other turn kinds reject run/model/harness/outcome. Dates are normalized to millisecond UTC strings, so min/max and since comparisons are chronological even when writers use different fractional precision. Place labels are kept on the conversation, never copied into every turn. Participants are capped at 32 people and 16 other agents; turns past those caps still count. Retry identity is the central operation id, scoped to the viewer, with the foundation's 30-day receipt window.

New rows have one immutable policy project. The `projects` list is reserved for the union of digest references; it grants no access. Conversation metadata contains no message words. A private Comms ask must use an opaque label/reference here; its actual question and freeform reply remain encrypted in Comms, including when recording retry receipts.

## Completion and final move

The remaining rebuild units must add digest operations (revision-specific central ask identities), folded days/retention and findings, the old-format importer with checks and interruption/repeat coverage, generated client bindings, Inbox and Home apps, liveness checks and CI screenshot artifacts. The mapping above covers installed operations, not a completed replacement of every old conversation route or job.

For the final move, the importer must read only a copy of old data and verify ids, counts and content in one transaction. No real import or deployment is part of this implementation. After all pieces and apps are merged and the owner approves the move, the coordinator backs up, imports, starts next mode and verifies the shared counts and answers. Until then, the old side is untouched and the new side depends on no import having run.
