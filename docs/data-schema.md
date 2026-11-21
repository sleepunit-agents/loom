# Shared data schema

The approved [how-it-works site](how-it-works/README.md) is the goal. The authored
schema is `src/core/data/schema.ts`: all 82 tables in `model.py` with their named
columns, `model_account_windows`, the ten internal bookkeeping tables listed there,
and the programme restriction and grant tables. Schema 15 added six tables for kit
definitions, person and project grants, outside project membership and use history.
Schema 16 added the scheduled program firing ledger. Schema 17 adds machine inspection
grants and request history. Schema 20 adds a reading sequence and a silence marker to `boxes`, plus `box_readings` (the latest reading of each thing a machine's worker watches on it: the room under each watched disk path, the memory available, whether the container runtime answers; no history, with the last evaluated lines, occasion counters, report sequences, and accumulated unknown and absent observations) and `box_alert_settings` (the household's lines those readings are held to; a default row on installation or upgrade, editable by an owner). Schema 19 adds who made each terminal binding (`terminal_credentials.issued_by`); bindings from before have nobody recorded. Schema 18 adds `model_account_logins`: what loom last
learned about each model account sign-in (account, machine, harness and place), never a
credential. Schema 23 adds private trigger lessons and state, plus the accepting job for each acknowledged trigger delivery. Schema 24 adds `bridge_send_jobs` to record which job queued an intermediate bridge post. Existing posts acquire no job association. Schema 25 records the recipient of an addressed direct message in that private table so the bridge can recheck the account before delivery. It also marks an intermediate post when the job adopts it as its final reply, so that reply can finish delivery after the job ends. Schema 26 adds `imported_task_sequence` to preserve numbers issued to tasks that were deleted before a v1 archive was imported. Schema 27 adds private change review rounds, keyed by reviewer job and indexed by change and commit. Schema 28 records the earliest time a scheduled handoff may run. Schema 29 records provider observations for weekly usage attribution. Schema 32 keeps the original arrival date and recorded outcome for archived Comms questions. Schema 33 keeps original channel numbers on imported threads and the archived member and agent on their deletions. Total: 117 tables. The programme
marker is independent of its record-type and operation rows, so clearing every grant
cannot make a token ordinary. These additional tables contain no raw bearer
credential. Every part of the program reads and writes this one schema; where each
table sits by part, and which stores are outside it, is in
[`architecture.md`](architecture.md).

Import typed table exports such as `tasks`, `taskComments`, `timingDays` and
`measuringSettings`. TypeScript fields use camelCase; SQL names match the site.
`dataDatabase(client)` binds the shared schema to a better-sqlite3 connection
without creating or changing tables. Relations use `<column>Row` in the forward
direction and `<table>By<Column>` in reverse, for example `projectRow` and
`taskCommentsByTask` on tasks. These names disambiguate multiple links to one table.

`createDataSchema(client)` is only for a completely empty database. It refuses
any existing schema and never imports, drops or replaces old tables. First install
(`src/shared-initialize.ts`) calls it once. The generated DDL is packaged in
`assets/data/schema.sql`; regenerate it with `npm run schema:generate`. The test
checks both against the approved source and against a real in-memory SQLite DB.

## Changing the schema

The `migrations` table holds the schema number. Number 1 is the first shape; each
entry in `upgrades` (`src/core/data/database.ts`) is the next number. A fresh
database is created whole and marked with every number.

At every start `upgradeDataSchema` first recognises the database without writing to
it. The database as it is must have exactly the shape the program at its number
installed (columns, defaults, keys, foreign keys and their actions, CHECKs, and each
index and trigger as written): the pinned installation SQL of that number in
`src/core/data/shipped-shapes/`, which ships with the program for this. That
comparison comes before any step, because a step that rebuilds or drops a table
would erase a change made to it by hand and then pass. When steps are pending, the
schema alone is then copied into memory, the steps are run there, and the result
must be exactly a fresh database's shape. Only then are the steps run on the real
file. A foreign, interim, hand-altered or newer database is refused untouched;
moving older data in is the separate real-data move.

To change the schema:

1. Edit `src/core/data/schema.ts` and run `npm run schema:generate`.
2. Add the step to `upgrades`. An index or trigger must be written exactly as the
   generated SQL writes it, because those are compared as text.
3. Copy the new `assets/data/schema.sql` to
   `src/core/data/shipped-shapes/<new number>.sql`. Never edit an earlier one.

A step may rebuild a table (create the new one, copy the rows, drop the old one,
rename): SQLite cannot drop a column that carries a foreign key or change a CHECK
in place. Step 6 does this to drop `conversations.job`, step 7 to take a state
out of `jobs.state`, and step 9 to drop `bridge_files.incoming`. For that reason the steps run with foreign keys
off, inside one transaction, and every reference in the database is checked
(`PRAGMA foreign_key_check`) before the transaction commits; a step that would
leave a row pointing at nothing changes nothing. The same check is made for the
kind-and-id references (`polymorphicReferences`), which triggers enforce and
`foreign_key_check` does not see. A rebuilt table loses its
indexes and triggers with the old one, so the step recreates each, written as the
generated SQL writes it.

When no step is pending, which is every ordinary start, nothing is rehearsed: the
file's own shape is compared with a fresh database's.

`src/core/data/upgrade.test.ts` upgrades the installation SQL of every shipped number
and compares each table with a fresh database in full. It fails if the newest pinned
shape is not today's `schema.sql`, so a schema change with no step cannot pass. It
also stops the steps at every number on the way and compares with that number's
pinned shape, so a household that reached a number by upgrading is recognised there
like one installed at it.

Two things the comparison leaves out on purpose: the order of a table's columns and
a constraint's name, because a column added by a step lands last and unnamed. So an
upgraded database and a fresh one can hold the same table with its columns in a
different order, and no statement may place a value by position
(`src/stored-data.contract.test.ts` fails on an insert that does not name its columns).

Step 10 is the plainest kind: it adds one empty column, `projects.retired_at`, and touches no row.
Step 11 is the same kind: it adds one empty column, `bridge_channels.brief`, and two empty tables,
`bridge_send_files` and `conversation_sessions`. Neither table is read by the query door.

Step 12 adds `job_usage` and backfills each ended job with its model, harness and available claim-to-end time. Historical harness counters stay null. Open jobs receive their usage record when they end.

Step 13 adds the terminal conversation venue and tables for machine-bound credential grants, observed sessions and their individual runs. Existing conversations retain their IDs and contents. Existing agent credentials receive no machine grant.

Step 14 records worker capacity and job placement requirements, preferences and decisions. Existing workers begin with unknown capacity.

Step 15 adds kit definitions, direct and project grants, outside project members and kit use records. Existing households begin with empty kit tables.

Step 16 adds scheduled programs and their firing ledger. Existing time triggers retain their ordinary firing behavior. The upgrade copies job usage counters by column name.

Step 17 adds the nullable explicit reader list on each machine and an empty diagnostic history table. Existing machines keep their hosting settings. No diagnostic answer text is stored in the household database.

A step may also remove data, and steps 6, 7, 8 and 9 do. What each removed and why is in
[`accepted-tradeoffs.md`](accepted-tradeoffs.md).

A change to existing rows belongs in a step. The one exception is a change SQL cannot
make because it needs something only the running program holds; that is done at start
by the module that owns the rule, must change nothing the second time, says what it
did in one line on the program's output, and is listed in
[`accepted-tradeoffs.md`](accepted-tradeoffs.md) ("One rewrite of stored rows runs at
start, outside the upgrade steps").

## Choices where the pages are silent

- Times are UTC ISO-8601 text; durations and usage ratios use real numbers.
- SQL NULL means an optional value is absent. A household task's owner is NULL;
  its required `ownerKind` is `household`. Polymorphic references stay named
  columns. Declared polymorphic references emit SQLite triggers that enforce both
  child writes and parent deletes/key updates.
- Join tables have natural composite keys. Settings tables with one household
  row have a `singleton` key constrained to 1. A household-wide approval rule
  uses the empty person string, so the natural rule key is never nullable.
- Boolean and choice values have database CHECK constraints, as do documented
  numeric ranges. Choices that are not legal GraphQL enum identifiers (such as
  `yes-no`) are typed text plus a CHECK; their stored spellings are unchanged.
- Message ciphertext and image bytes use BLOB columns. Sprite layout is the
  opaque document explicitly permitted by the model. A replay result is opaque
  bytes; raw bridge events are opaque bytes with their own expiry column.
- Internal bookkeeping uses named operation, identity, state and time columns.
  No secret value is stored in the schema or its write journal.
- Measuring's local retention defaults to 90 days, bounded to 0–3650, matching
  the Measuring module. Zero keeps no local history and is accepted only when
  measurements are sent outside. Measuring is off by default.
- Backups retain seven copies by default, at 03:00 in the household's timezone.
  That is the server's own zone from the first write of the household's row, until
  the household sets another; the column's `UTC` default is never what a row gets. Inbox settle time defaults to five seconds and dim to one day.
- Immutable approval audit rows and thread deletion markers reject edits. Thread
  deletion writes its own marker; deleted identifiers cannot be inserted again.
- Live token-label uniqueness includes expiry, evaluated using the connection
  clock (`loom_now`). Pass a clock to `dataDatabase`/`createDataSchema` in tests.

## Query library checks

[Drizzle's GraphQL generator](https://orm.drizzle.team/docs/sqlite/graphql)
accepts this schema and generates table reads, filters and connected records.
Use an explicit `relationsDepthLimit` (the smoke test uses 2): its unlimited
expansion of a densely connected schema consumes unbounded practical memory.
In Vitest, import GraphQL from `graphql/index.js` so the generator and executor
use the same module instance.

The door serves it with [Yoga](https://the-guild.dev/graphql/yoga-server/docs/features/subscriptions)
over Hono's Fetch interface, and `graphql-ws` for multiplexed subscriptions on
one websocket. Yoga's default subscription transport is SSE, so the websocket
is wired explicitly and SSE is refused. [urql Graphcache](https://urql.dev/docs/graphcache/)
is the browser's normalising cache. The door owns caller visibility, subscription
deltas and the transport's lifecycle; the schema itself exposes no unauthenticated
endpoint and no mutations.

## Generated read module

`dataQueries(client, { tables, visibility, relationsDepthLimit? })` in
`src/core/data/queries.ts` generates a **read-only GraphQL schema**. `tables` is
an explicit list of application table exports; plumbing is not eligible. Only
relations between selected tables exist in this schema. Every selected table
requires a function returning a Drizzle SQL predicate. Predicates are combined
with the query's filters before sorting and pagination, at the root and at every
connected table, including singular relations. Missing or non-SQL policies throw
before a statement executes. Policy callbacks receive the columns for their own
query alias; predicates can use SQL subqueries for current sharing membership.

The module decorates a private Drizzle instance's relational builders before
passing it to drizzle-graphql. It keeps the generator's field selection,
filtering, ordering and one-statement relational reads. It does not fetch then
filter rows. Tests observe the actual SQLite statements, denied root and
connected rows, and independently generated caller schemas.

This module does **not** authenticate a caller or supply household permission
rules. The outside door must select safe tables/fields and provide the central
SQL policy for its authenticated caller; never expose a schema generated with
an installed module's unrestricted policy. Construct a separate schema for each
identity/policy, and do not retain authority across session expiry or revocation.
The policy map is copied at construction, but its functions must evaluate any
changing sharing facts in SQL. Default relation depth is 2; supported depths are
0–3. `src/next-data.ts` builds the served schema from it.

Pinned-library limits: drizzle-graphql 0.8.5 conflates differently aliased nested
relation requests, so this module rejects nested relation aliases before SQL,
including aliases inside fragments. Root and scalar aliases work. Use canonical
relation field names; the transport/client integration must retain this guard
until its generator can implement independent aliases. The module wraps visibility
SQL in a deferred SQLWrapper: Drizzle's relational alias rewrite must not change
unrelated table columns inside policy subqueries. Tests cover the otherwise
permissive rewrite at both root and connected tables.

## Authenticated HTTP door

`dataHttp(db, authenticate?)` is the Hono `/graphql` route, mounted by
`src/next-data.ts` on the program's one connection. It uses pinned GraphQL Yoga 6.1.0
([Fetch server documentation](https://the-guild.dev/graphql/yoga-server/docs)).
It accepts POST JSON only, refuses cross-origin browser requests (using the configured
public origin behind a same-host TLS proxy), disables CORS,
GraphiQL and batching, and sends `Cache-Control: no-store`. The generated schema
has no mutations: every write is a registered operation. Subscriptions use graphql-ws
on the one websocket (`src/core/data/socket.ts`); SSE negotiation is refused.

The served schema is the one `src/next-data.ts` builds for the caller. Called with
no schema of its own (as its own tests do), the route serves a small default:
Tasks, comments, links, projects and agent metadata. In either, no session, token,
passkey or plumbing table is reachable, including through reverse relations. Both task-link ends must be visible even
if the request selects only their IDs. Tasks retain project precedence; a
project task cannot be read merely because the caller owns its agent or is its
member owner. General agent metadata uses project-or-owned-agent visibility.
Sharing predicates execute in SQL on every request, including nested relations.
A runner or an outside service gets 403 from this route, rather than being
mistaken for trusted installed code.

`dataAuthentication(db, now?)` resolves raw bearer tokens or the `loom_ui` cookie
using SHA-256 fingerprints in the shared tables. Bearer takes precedence over
cookies. It rechecks session existence, token identity, revocation, expiry and
principal existence. Agent browser sessions last six hours; ordinary sessions
use the existing thirty-day lifetime (the site specifies no ordinary lifetime).
The route checks current authentication after parsing and again before releasing
buffered results. Trusted composition may supply another authentication resolver;
request input never supplies an identity or SQL policy. Installed services call
the shared application services directly without credentials.

This route does not create or upgrade a database; startup does that before the
door opens ("Changing the schema" above). The mounted-route test builds a fresh
in-memory database, writes through `taskService`, and reads those same rows over
actual HTTP; it does not touch a home or installed state.
`tasks.commentCount` is a generated task output extension, also available on
connected task rows when comments are selected in the query schema. A correlated
SQL count uses the same comment visibility predicate and runs inside the one
relational statement; it never issues per-task reads. Counts are current on each
execution and independent of pagination/filtering on a separately selected comment
relation. Scalar aliases, fragments and directives select the count as usual.
An unrequested count adds no SQL work. Counts have no separate stored column,
filter or order input. This output-only detail follows the site's example;
filtering and sorting remain on the schema's real columns.

## Runtime account placement and quota windows

The private `account_week_readings` table keeps accepted readings within each current provider week. Its composite key identifies the account, window, reset and reading time. The weekly report allocates measured increases across overlapping jobs using their token counts. Missing weights, unreadable jobs and usage before the first reading contribute to the unattributed share.

The site specifies an account summary but is silent on providers with concurrent
usage windows. `modelAccountWindows` (`model_account_windows`) stores one row per
`(account, window)`, with `usage`, `usageReadAt`, `resetsAt`, `durationMs` and
`reserve` (default 0.05). Unknown observation fields are NULL; consumers must not
interpret them or a passed reset time as available capacity. Duration must be
positive and finite; usage and reserve are fractions from zero to one. The
account FK and composite key share observations across all agents, rather than
keeping agent-local quota copies. The existing `modelAccounts` fields remain the
site's account summary: a copy worked out from the windows each time they are
recorded, kept because admission reads it without a join
([`accepted-tradeoffs.md`](accepted-tradeoffs.md)). Runtime owns ingestion and the
capacity evaluator.

`jobs.account` is a nullable FK to the account selected for a job, and
`jobs.harness` is the selected harness name. Both may be absent before placement.
Typed relations include `jobs.accountRow`, `modelAccounts.jobsByAccount`, and
`modelAccounts.modelAccountWindowsByAccount`. They add no public GraphQL projection: exact
account observations still require the account-owner/household-owner projection.

## Shared operation receipts

`OperationResults` in `src/core/data/operation-results.ts` implements
`ReceiptPersistence` over the shared `operation_results` table. Its receipt has
`caller`, `id`, `operation`, `inputHash`, `result: Result`, and `expires` (integer
milliseconds). The input fingerprint is a named `input_hash` column; only the
opaque answer is serialized into the result bytes. No input words are retained.

The dispatcher owns caller identity, fingerprints, current access checks,
30-day retention, expiry scheduling with its Clock, and wrapping the effect plus
receipt in the same shared transaction. `insert` refuses duplicate keys;
`recover` inserts a missing receipt or updates only the answer and deadline of a
matching operation and fingerprint. A mismatch throws `OperationError` with
code `conflict`. `get` returns the stored receipt even if expired: the dispatcher
must call `expire(now)` before lookup, as the existing dispatcher does.
`nextExpiry()` returns the next millisecond deadline for its Clock. This adapter
writes canonical millisecond UTC strings and does not create tables, schedule
work, check permission, or publish changes. `src/shared-root.ts` gives it to the
dispatcher, so every operation the program runs keeps its receipt in this table.
