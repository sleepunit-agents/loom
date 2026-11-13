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
