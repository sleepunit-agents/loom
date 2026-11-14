# Shared database statements

Hot next-mode paths use `statement(db, sql)` from `src/core/db/index.ts`.
Pass static SQL and bind arguments to `get`, `all` or `run` on each call.
The wrapper caches a prepared statement for that SQL and connection. It exposes
no permanent binding or statement configuration methods, so a caller cannot
change the next caller's bindings or output format. SQLite recompiles prepared
statements when schemas change; no database schema migration is introduced here.

`statementMetrics(db)` returns copies with calls, failures, execution milliseconds,
prepare count and prepare milliseconds per cached SQL statement. Execution failures
are counted and rethrown; transaction and rollback behavior remain SQLite's.
Arguments, result rows and outputs are never retained. These metrics are in-process
metadata, with no endpoint or export added by this change.

The cache is a 512-entry LRU per connection, held weakly. Eviction also drops that
entry's history and increments the reported eviction count. A later lookup can
prepare the same SQL anew. Opening another home or reopening a closed connection
starts fresh. History is bounded and does not survive restart.

| Before | After |
| --- | --- |
| Operations, household row reads, Tasks store and Attention prepare each call | Those paths use the shared cache and record statement counts/timings |
| Calls configure native statements directly | Shared statements expose get/all/run only; bind every invocation |
| No statement measurements | Local per-SQL counters and monotonic timings, including failures |

Other callers can move to this wrapper incrementally. Startup migrations and
legacy code retain their existing preparation behavior. Query and operation
semantics, stored records and imports are unchanged; importer queries in Attention
also use the wrapper. No importer, CLI, screen or move step is added for this
internal API. The owner-only local monitoring page and per-request/sweep attribution
remain measurement work in task t-2234.
