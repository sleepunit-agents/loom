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

## Knowledge page actions and durable retries

`installMindKnowledgeActions(operations, {path, sharing, verify})` adds the two
page actions beside the read installer. Composition injects the synchronous
`verifyKnowledgePages` primitive; the piece does not import the old backend or
initialize its content schema. The connection requires an existing file and
never creates a missing Knowledge store. Both actions use central `mayAct` for
the household Knowledge surface and require an operation id.

| Old page action | New operation | Preserved effect |
| --- | --- | --- |
| `knowledge-verify` / Still true | `mind.knowledgeVerify({slug})` | Confirmed audit, successful stamp, original confirmation note |
| `knowledge-recheck` / Check again | `mind.knowledgeRecheck({slug})` | Stale audit and original recheck note; successful stamp stays unchanged |

Attribution is the authenticated viewer id, and timestamps use the operation
clock. Missing pages return not-found; archived pages require restoration. The
installer remains additive and is not yet registered in next mode.

A write's `Context.receipt` carries the registry's canonical viewer, operation
id/name, parsed-input hash and thirty-day expiry. The action installer applies
numbered source metadata migrations, recorded in `mind_source_migrations`;
unknown or changed migration history refuses startup. Each migration is atomic.
The separate source transaction commits verification and
`mind_operation_receipts` together. These are retry metadata, not content tables
or pending intents: only migration SQL, identity, hash, expiry and the small
verification result are retained. No page body or note is copied into loom.db or
the receipt table. Existing content table definitions and old callers are unchanged.

The content transaction and the core receipt are **not** one atomic transaction.
If content commits but the core receipt fails, the caller gets unavailable;
that must never be interpreted as an unchanged content store. Retrying the same
id, including after restart, finds the source receipt, returns the original
result and republishes the changed slug without another audit, note or stamp.
The registry's optional `recover` hooks run before `may` for every registered
write, deduplicated by function identity. Each source checks the shared viewer/id
namespace, so an unrelated operation cannot reuse an id whose source committed
but whose core receipt failed. Like the core receipt lookup, replay acknowledges
an already-committed effect even after permission
loss. Fresh effects still require authorization. A `RecoveredWrite` carries the
original expiry into the core receipt, so delayed recovery never renews the
thirty-day window. Source lookup is checked again under its immediate write lock
to handle another daemon committing between lookup and mutation.
Different input or either action with that id conflicts. Source receipts expire
at thirty days and are pruned on the next action, matching the core retry window;
a new request after that window may act again. Source receipt failures roll back
the content effect. Live publication occurs after the core transaction succeeds,
so recovery also repairs publication missed by a failed core receipt.

This does not close the remaining daemon source/socket lifecycle work, enable
next mode, or finish any of the four apps. The composition root must install and
close both connections and bind outside-write notifications before rollout.

External receipt readers participate in the registry's global write-id lookup.
If an installed source receipt reader fails, new writes fail closed: the source
may already reserve that viewer/id. Cached core retries remain available. This
couples new-write availability to the installed source's metadata reader; silently
skipping an unreadable source would sacrifice the global conflict guarantee.

## Next-mode Knowledge app

`serve --next` now installs Knowledge reads and the two check actions at startup,
with the verifier injected by the composition root. No metadata means an empty
reader, even if unlisted files exist. Missing files remain absent; inventory and
file presence are a startup snapshot. Reader/action connections close with the
foundation, after HTTP/WebSocket and source transports have stopped.

Existing source files select private touch endpoints: commons admits Knowledge
slugs and directory people (`commons:<slug>`); listed agents admit memory refs,
people and project cards (`<agent>:<local-id>`). The socket binds the source
identity and the operation checks its canonical namespace. Only Knowledge has a
record reader in this unit; announcing another type does not expose content.
Startup probes endpoints under the daemon home lock, preserves live listeners and
non-socket files, and removes only refused socket endpoints whose inode still
matches. Failed binding closes acquired listeners before readers and the lock.

The registered app is `/p/knowledge-preview`, in `web/src/pieces/knowledge`.
It uses the kit Split and the shared live feed, including a scoped page feed for
direct links beyond the 2,000-page list. It preserves topics, title/domain search,
recent and due folders, freshness, markdown, sources, referring pages and both
check actions. Calls start only in handlers and retain their retry state. Missing,
loading and connection/access failures are separate states. A content-free
`knowledge.access` record carries the current viewer’s central-policy result and
per-action eligibility (including create); an empty store cannot masquerade as a denied surface. Add a fact uses `mind.knowledgeAdd`, preserving title-derived create-only slugs,
trimmed/lowercase topics, sourced web citations or provisional owner citations,
actor attribution and the existing freshness class derivation. Page, citation
and retry receipt commit in one immediate source transaction. Core receipt
failure recovers the source receipt without creating a second page/citation.
Missing stores stay absent; an existing title (including archived) conflicts.
The form retains its draft/request across disconnect; a successful request must
be reset with Add another before another submission.

| Old page surface | New surface |
| --- | --- |
| `/knowledge` list and topic/search filters | `knowledge` live records + local filters |
| `/knowledge?p=<slug>` and page/cited-by navigation | scoped `knowledge` live records + `/p/knowledge-preview/page/<slug>` |
| Still true / Check again | `mind.knowledgeVerify` / `mind.knowledgeRecheck` |
| Add a fact (`newFactPage` / `fact-add`) | retained form + `mind.knowledgeAdd` |

CI's single two-window test writes six screenshots to `artifacts/knowledge-app`
(390/1280/1920; Neon Noir/Daylight), retained in its shard artifact. It exercises
checks, reload, markdown links, cited-by navigation, search, time aging and an
outside archive. In-process tests cover metadata-only selection, no creation,
source namespace refusal, two-window outside writes, retries after restart,
occupied/non-socket preservation and stale endpoint recovery.

The action installer also receives the pure freshness classifier from composition.
No host rollout is included. The coordinator must assemble the final new home,
verify copied existing content paths and database household metadata, stop any
competing source listener, and start/verify next mode at the final coordinated
move. There is no Mind importer or content-table migration.
People, Projects and Activity remain separate app units under t-2207.

## Next-mode People

`/p/people-preview` reads `person` records, canonically `commons:<slug>` for
shared directory cards and `<agent>:<slug>` for relationships. Source inventory
comes only from household database metadata; files absent at startup stay absent
until restart. Each record uses central policy independently. The household
owner sees the directory; an agent or partial member sees only its authorized
relationship cards. Project membership never widens a relationship. The reader
honors directory merge redirects, archived cards, stale contact fields and active,
unexpired user/feedback evidence. Memory expiry and contact staleness have live
clock deadlines. Other person/memory writes refresh derived records per viewer.

| Old People surface | New surface |
| --- | --- |
| `/people`, kind/search filters | `mind.peopleList`, `person` records and local kind/name/agent filters |
| `/people/<slug>`, `/a/<agent>/people/<slug>` | `mind.personRead({id})`, scoped records, combined directory/authorized relationship reader |
| Reach/facts/relationships/newer memories/evidence/recorded permissions | Existing source SQL projection, no copied content tables |
| Owner roles and linked projects | Central household sharing metadata and authorized existing project cards |
| Conversation links | `PeopleConversations` metadata role; explicit unavailable state until installed |
| Access link | New Sharing app; card text never grants access |
| `person-add` form | `mind.personAdd`, contact details in directory, summary in default agent relationship |

Person MCP maintenance tools (verify/archive/restore/merge/history/revision
restore/write) have no buttons on these old screens and are not replaced by this
app unit. Existing source writers continue to announce `core.touched`.

Creation requires both existing sources. It creates cards, never updates an
existing or archived slug. Source retry metadata uses the already versioned Mind
receipt schema. Each half commits with its own receipt. These are separate source
transactions: a failed relationship commit can leave a directory card visible.
The request remains unsuccessful until both halves exist; retrying its original
id/input resumes the second half, and a different operation/input cannot steal
that id. `Call.retry()` explicitly resends an unavailable save using the retained
id/input; its subscribers and current `result` promise observe the new attempt.
No timer or effect retries a completed error. The form retains its draft/request
across navigation/disconnect, freezes an unavailable attempt for explicit retry,
and requires Add another after success. Complete source receipts recover a failed
core receipt across restart without duplicating either card. Partial retries still
require current authorization. Receipts contain only the slug result and identity,
not copied contact or summary text. No content schema is created or imported.

The new full conversation owner has not landed in this base. Composition may
supply `PeopleConversations.list(viewer, person)`; it must enforce its own central
member/private scope and return metadata links only. Without it, People says the
service is unavailable, rather than claiming there are no conversations.
Final coordinator composition must wire that role when available. No host rollout
or source discovery is included.
