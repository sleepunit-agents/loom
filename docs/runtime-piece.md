# Runtime piece (next mode)

The control plane lives in `src/pieces/runtime`. It holds box, job, per-agent
settings and conversation-binding metadata in `loom.db`. The container and
harness runner remains a separate program. Nothing here reads the old runtime's
files, starts containers or changes a running installation.

## Operations delivered

| Old command or API | New operation | Status |
| --- | --- | --- |
| `list` (boxes, houses, preferences) | `runtime.listBoxes`, `runtime.listJobs`, `runtime.listSettings` | Metadata collections; central policy filters each record |
| conversation binding collection | `runtime.listBindings` | Metadata collection |
| `may-host`, `lend-box`, `box-owner`, `box-watch` | `runtime.configureBox` | Existing enrolled boxes; owner-only; `set` contains the fields to change |
| `set-primary` | `runtime.setBoxes` | Agent owner sets up to eight ordered box references |

All writes use the registry envelope `{input, id}`. Configure returns `{box}`;
preferences returns `{agent, boxes}`. Write retry receipts contain these ids,
never credentials or words. Collections have matching live record types:
`runtime.box`, `runtime.job`, `runtime.settings`, `runtime.binding`.

Box references resolve an exact live id first, then a unique live name. Two boxes
may share a name; ambiguity requires an id. Revoked boxes do not resolve.
Preferences store canonical ids and reject duplicates, unavailable references,
report-only boxes, boxes that disallow the agent and boxes neither owned by the
agent's owner nor lent to it. Ownership and lending govern placement eligibility;
caller authorization always uses `src/policy.ts`. A specifically named agent
owner takes precedence over household owners for this eligibility check.

A local runner cannot be report-only and is always on. Report-only runners count
as always on. Setting a single local preference or an empty list stores an empty
list, meaning default placement. No local box is fabricated: local registration
must eventually receive explicit runner metadata from the composition root.
Existing model settings survive a preference change. The structured API accepts
arrays; old command text parsing and stdout/exit parity belong to the generated
client, still pending.

## Remaining before the final move

The full runtime rebuild is in progress. Enrollment (including stranger join,
proof and owner decision), token revocation, runner hello/poll/claim/report,
placement and dispatch, houses/services/body hosts, delivery/results/retries,
model-account metadata and usage, settings, screens, generated command parity,
background jobs and importer are still to be delivered. No old command is
retired by these metadata operations. The final mapping must enumerate the old
runtime's commands, routes and jobs, including any drops and their reasons.

Next mode remains empty until explicit new-side setup or the future importer.
The importer must read a snapshot of old `state.json` and piece bindings/jobs,
commit once with a checksum, compare ids/counts/content, no-op on the same source,
refuse another source and roll back interruptions. It must never modify the old
side. Final cutover requires no live houses and the owner's presence; point the
separate runner at registry operations only during that move. No deploy or real
import is part of the changes described here.
