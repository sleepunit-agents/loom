# Mind: agents' stores on the desk

Memory, knowledge, person and project cards stay in their existing stores. There
is no importer and no new content table. The reading operations and four apps
are being built in t-2207; this first change supplies their outside-writer seam.

## Outside writes

`installTouched` registers `core.touched(type, id)`. Its resolver is supplied by
the composition root: it admits only registered source identities for the bound
viewer. Notifications are available on direct and MCP doors, not to windows.
They name no content and cannot change a record. The ordinary live record reader
loads the committed record separately for every subscribed viewer, using policy.

The daemon calls `listenForTouches` for each existing agent/commons store
directory. Each socket is `.loom-live/touched.sock`, mode 0600, inside a directory restricted to
0700 before binding (including with a permissive umask). The daemon binds its
source's viewer and maps local ids to globally unique live ids; the writer cannot
claim a viewer. The operation resolver validates those canonical ids. A second
listener fails rather than stealing a socket. Daemon startup must remove stale
socket endpoints while holding its home lock, before opening these listeners.
Closing a listener removes its endpoint. The reading-piece installation owns
listener creation and shutdown; these helpers alone do not start a listener.

After a successful mutation, a store checks for the local socket. When absent,
it opens no connection, starts no timer, and never traverses mutation results.
When present it sends only `{type, id}` and has an absolute 250 ms deadline, including connection setup.
Errors are swallowed; there is no retry or delivery ledger. A missed notification
costs a stale tile until a later update or reconnect. No store is watched or polled.

| Existing write boundary | Notification |
| --- | --- |
| Memory backend remember, forget, update, prune, archive, restore, revision restore, supersede, merge | `memory`, every affected ref in the result (prune dry run excluded) |
| Knowledge backend write, archive, restore, supersede, move, merge, purge, verify, revision restore, citations | `knowledge`, affected slugs, including both sides of moves |
| Person card table commit, including household directory/relationship writes and merges | `person`, actual stored slugs |
| Project card table commit | `project`, actual stored slugs |

Memory and knowledge hooks wrap their existing successful mutation boundary;
only declared identity fields and the result's pages/losers are inspected. Card
hooks collect actual stored slugs in the existing transaction, discard them on
rollback, and send after its owned outer commit. Card APIs reject a caller-owned outer
transaction before writing; callers use the store mutation boundary instead. Hooks introduce no schema changes.
Direct raw SQL outside those APIs is not an announced store mutation.

## Evidence

The in-process test creates a real MCP server over stdio streams, a daemon with
a fake clock, and three WebSocket windows. A person write reaches two authorized
windows; the third gets no record. Archiving sends `del`. Further tests exercise
all four store hooks, source/door refusal, offline writes without extra active
resources, identity-only extraction and a rolled-back card transaction.

## Final move

The mind reading-piece installer must bind each source directory and close its
listeners with the daemon. The source-local types above map to its live record
identities. No import or change to existing content is part of that move.

## Knowledge read foundation

`installMindKnowledge(operations, live, {path, sharing})` installs the read-only
Knowledge projection. The composition root supplies the commons knowledge path
from household database metadata (or a fixture); it closes the returned reader
after stopping the daemon. It retains one read-only SQLite connection, uses a
read transaction for each projection, and never creates a missing store. A store
created after installation requires a daemon restart.

| Old reader | New surface |
| --- | --- |
| `knowledgeView` list | `mind.knowledgeList` |
| `knowledgeView` open page | `mind.knowledgeRead({slug})` |
| Active pages and each page's own changes | `knowledge` live records, id = slug |
| Freshness and recently verified aging | Live deadlines at 7, 20 and 30 days |

This is an additive read foundation, not the complete Knowledge app. Existing
30-day freshness, 7-day recent verification, stale outcome, author, citations,
referring pages and display caps are preserved. Only central policy grants
access; partial agent ownership does not grant the household Knowledge surface.
There are no new content tables, migrations, importers, jobs or commands.

The composition root still needs to register `core.touched` and bind/close its
commons socket under the daemon home lock.
Verification actions, People, Projects, Activity, generated clients and all four
apps remain subsequent units. This installer is not yet registered in next mode.

### Derived records and the role

Knowledge opts into Live's `refreshOn(change)` hook for knowledge changes. Once
per change batch, Live rereads the union of each subscription's current candidate
ids and previously sent ids, using that subscription's viewer. A scoped page
therefore refreshes when a different page changes its `citedBy` list; a disappeared
page still sends `del`. Removed links, archives, restores, renames and purges do
not require retaining old bodies or a dependency cache. Time boundaries still use
the ordinary per-record clock deadlines.

This deliberately rereads every subscribed Knowledge candidate on any knowledge
change. It favors correctness for the bounded commons reader over a cached link
graph. Only opted-in record types do this; other types retain identity updates.
Within a batch each candidate is read once per subscription. Permission checks
remain in the record reader for every viewer, including dependent refreshes.

Other pieces call `mindRole(operations).call(viewer, verb, input, operationId?)`,
the same direct registry role pattern as Tasks. It carries no store paths and
does not bypass operation policy. Only Knowledge list/read are installed so far.

## Synchronous verification primitive

`verifyKnowledgePages(db, input, now)` in `src/backends/knowledge-verification.ts`
contains the existing verification SQL and its immediate transaction/retry boundary.
It receives an already-open store and the operation clock; it neither opens a
path nor creates schema. The existing Promise backend delegates to it and keeps
its outside-write notification wrapper. `deriveSlaClass` remains exported from
the backend for existing callers.

Confirmed and corrected checks advance the successful stamp; a stale check only
adds its audit record. Explicit `verified_at` controls the check time; a note's
content update uses `now`. Batch refusal, body caps, anchors and audit attribution
retain their existing semantics. Tests run this primitive inside a synchronous
operation on `startLoom`, with a fake clock.

This is a prerequisite for the two Knowledge actions, not their registration.
The helper alone supplies no receipt spanning the content store and loom.db.
The action integration must avoid repeating a committed verification when saving
the core retry receipt fails, and publish live changes after a successful commit.

## Source inventory and transport ownership

`mindSources(db, home)` reads a startup snapshot of the household metadata in
`loom.db`. It returns the commons knowledge/people paths and each listed agent's
memories path. Missing metadata returns no inventory, even if household.json is
present. It neither creates directories/stores nor discovers unlisted agents.
Household source changes take effect on restart; the caller supplies the home.

`listenForTouchSources(operations, sources)` owns a group of source listeners.
If one bind fails, startup closes all listeners it acquired and preserves the
original error. Closing a successful group is idempotent, including concurrent
close calls. The foundation's synchronous reader shutdown remains separate:
composition must await transport shutdown before closing readers and loom.db.

These are additive composition helpers, not next-mode enablement. Composition
still must select existing stores, supply source viewers and canonical resolvers,
hold the daemon home lock, and handle stale endpoints before starting the group.
An occupied endpoint is always refused; this helper never removes one. Knowledge
actions/receipts and the complete source binding remain required before enablement.
