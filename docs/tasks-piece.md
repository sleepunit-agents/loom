# Tasks in the foundation

The in-repo tasks piece is registered alongside the legacy Tasks app during its
transition. This change imports no real data and switches no existing command or
page. The policy is `src/policy.ts`; the piece has no separate permission rule.

`tasks.<verb>` offers every taskstore core verb on all four foundation doors.
The declarative `taskCommands` descriptions are both the registry's CLI metadata
and the generated client's command surface; the client interprets these descriptions
and carries no domain transitions, store access, or plain-word rules.
`tasks.command` is the generic binding for the unchanged contract corpus, including
unknown or malformed commands. Other pieces use `tasksRole(operations)` through
`src/pieces/tasks/role.ts`, with their caller's viewer and operation id.

A domain answer, including a domain rejection, is preserved at
`{ok:true,value:{result:<taskstore answer>}}`. Central policy and transport failures
use the foundation's `{ok:false,code,message}`. Writes require a caller operation
id in the outer API envelope. Raw domain writes carry `actor` and RFC3339 `at`, as
in taskstore's contract; CLI-bound writes (`cli:true`) get missing attribution/time
from the authenticated viewer and daemon clock. The compatibility client supplies
`TASKSTORE_ACTOR` (default `art`) and prints only the inner domain answer. CLI binding
rules (plain words, warnings, owner asks, edge echoes) run in the daemon. The legacy
owner-ask name defaults to `jonathan`, as before. No task content is copied to a
mutable JSON mirror: the API's export operation is the exit door.

Task fields `project` and `agent` are optional strings. Create inherits its parent's
project unless explicitly supplied; it never inherits the parent's agent. An agent
creating a task with neither an effective project nor an agent gets its own agent
scope; an owner member's unscoped create stays household-only. Update can
set either field or clear it with an empty string. A scope-only update still validates
ordinary domain attribution/time. Live records include full show content and numeric
`changedAt` (daemon epoch milliseconds); list/ready/report retain upstream shapes.
Closed tasks age out one week after their last committed content/relation change;
open and in-progress tasks stay live. Imported tasks start their live week at import.
Readiness uses the complete graph before visibility filtering, so a hidden blocker
still blocks without exposing its id. Relations to hidden tasks are omitted on reads.

The production composition temporarily adapts the existing household members and
ownership to Sharing, with empty project/service maps: legacy metadata has neither.
The fixture/test composition injects full Sharing. The household foundation must
supply actual shared projects before project-based production cutover; no local
project file or second policy store is introduced here.

## Coordinator cutover (owner present)

Run these steps on loom's machine only after the Tasks app and household-sharing
work are ready. No implementation body runs them against the live home.

1. Back up the old taskstore database using SQLite's backup API to a stopped-source
   copy, including all WAL-visible commits. Back up the target loom home. Keep both
   paths in the cutover record. Stop the daemon and existing taskstore writers.
2. Prepare a JSON object mapping epic ids to household project slugs, based on the
   existing project cards' epic references, e.g. `{"t-100":"pond"}`. No title guessing
   is done. An epic's explicit project field is also recognized; a conflicting mapping is refused. Unmapped tasks without such an epic arrive without a project. Existing agent
   fields and other legacy content are preserved.
3. With the built loom executable, run:
   `node dist/index.js migrate tasks --home <home> --from <source-copy.db> --projects <epic-projects.json> --agent <queue-agent>`.
   The default agent replaces the agent on every task with no inferred project,
   participates in the checksum, and must match on a repeated import.
   The importer takes the production daemon's home lock, opens the source read-only,
   snapshots its ordered tasks, links and sequence in a read transaction, and hashes
   that canonical snapshot (rather than just the main database bytes, which omit WAL).
   One target transaction runs migrations, imports and compares ids, counts, content
   and sequence, then stores the checksum and map. Same snapshot/map is a no-op;
   different input is refused. Corrupt sequences that could reuse ids are refused.
   A failure rolls back the import and its marker; keep the old path active and
   restore the backup if the cutover comparison fails.
4. Start the daemon with the approved sharing configuration. Point `LOOM_URL` at its
   URL (a trailing `/mcp` is accepted) and `LOOM_TOKEN_FILE` at the existing token file.
   Verify `node dist/taskstore-client.js export`, ids/counts/content, policy and live
   updates against the imported copy before retiring the old store.
5. Switch the household's `taskstore` launcher to execute
   `node <installed-loom>/dist/taskstore-client.js "$@"` with those environment values.
   The package exposes this opt-in launcher as `loom-taskstore`; it deliberately
   does not install a `taskstore` bin that would take over before this step. Existing
   `loom tasks`, the old tasks piece pin and the old Tasks page remain intact in this
   implementation; their cutover/deletion belongs to the coordinated Tasks app step.
6. Validate ready/show/create/claim/unclaim/close/reopen/comment/link/unlink/update/
   list/report/export using a disposable task. Unlink exits 0 for removal, 3 for a
   valid miss, 1 for rejection, 2 for usage. Duplicate link exits 3 too. With the daemon
   stopped the new client reports unavailable; it never opens `TASKSTORE_DB`.
   Retire the legacy writers and store only after that verification, with the owner.

## Recorded upstream

The contract pair and pure domain are copied from sleepunit-agents/taskstore at
`3736e1c72bee3cbd3e65c65768996476bc5c4a7a`; see `spec/taskstore-core/SOURCE.md`.
The concurrent-writers corpus input is unchanged and is driven by eight independent
HTTP clients of the in-process `startLoom`, since only the daemon writes SQLite.
The frozen legacy CLI parser/formatter is test-only; it provides a separate output
oracle for every verb, warnings, refusals and all four exit statuses.
