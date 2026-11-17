# Shared data schema

The approved [how-it-works site](how-it-works/README.md) is the goal. The authored
schema is `src/core/data/schema.ts`: all 81 tables in `model.py` with their named
columns, `model_account_windows`, the eight internal bookkeeping tables listed there
and three internal programme restriction/grant tables: 93 tables. The programme
marker is independent of its record-type and operation rows, so clearing every grant
cannot make a token ordinary. These additional tables contain no raw bearer
credential. This module
replaces per-part table definitions as each part is connected to it.

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
it: the schema alone is copied into memory, the pending steps are run there, and the
result must be exactly a fresh database's shape (columns, defaults, keys, foreign
keys and their actions, CHECKs, and each index and trigger as written). Only then
are the steps run on the real file. A foreign, interim, hand-altered or newer
database is refused untouched; moving older data in is the separate real-data move.

To change the schema:

1. Edit `src/core/data/schema.ts` and run `npm run schema:generate`.
2. Add the step to `upgrades`. An index or trigger must be written exactly as the
   generated SQL writes it, because those are compared as text.
3. Copy the new `assets/data/schema.sql` to
   `src/core/data/shipped-shapes/<new number>.sql`. Never edit an earlier one.

A step may rebuild a table (create the new one, copy the rows, drop the old one,
rename): SQLite cannot drop a column that carries a foreign key, and step 6 does
this to drop `conversations.job`. For that reason the steps run with foreign keys
off, inside one transaction, and every reference in the database is checked
(`PRAGMA foreign_key_check`) before the transaction commits; a step that would
leave a row pointing at nothing changes nothing. A rebuilt table loses its
indexes and triggers with the old one, so the step recreates each, written as the
generated SQL writes it.

When no step is pending, which is every ordinary start, nothing is rehearsed: the
file's own shape is compared with a fresh database's.

`src/core/data/upgrade.test.ts` upgrades the installation SQL of every shipped number
and compares each table with a fresh database in full. It fails if the newest pinned
shape is not today's `schema.sql`, so a schema change with no step cannot pass.

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
- Measuring's local retention defaults to 90 days, bounded to 1–3650, matching
  the existing Measuring module. Measuring is off by default.
- Backups retain seven copies by default, at 03:00 UTC until the household sets
  its timezone. Inbox settle time defaults to five seconds and dim to one day.
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

The subsequent endpoint unit uses [Yoga](https://the-guild.dev/graphql/yoga-server/docs/features/subscriptions)
with Hono's Fetch interface and `graphql-ws` for multiplexed subscriptions on
one websocket. Yoga's default subscription transport is SSE, so websocket
integration must be explicit. [urql Graphcache](https://urql.dev/docs/graphcache/)
is the chosen normalising client cache. The endpoint unit owns caller visibility,
subscription deltas, transport lifecycle, and removing replaced Tasks reads;
this schema unit exposes no unauthenticated generated endpoint or mutations.

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

The first outside projection exposes Tasks, comments, links, projects and agent
metadata. No session, token, passkey, plumbing or other table is reachable,
including through reverse relations. Both task-link ends must be visible even
if the request selects only their IDs. Tasks retain project precedence; a
project task cannot be read merely because the caller owns its agent or is its
member owner. General agent metadata uses project-or-owned-agent visibility.
Sharing predicates execute in SQL on every request, including nested relations.
Runner and outside service projections currently return 403, rather than being
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

This route does not initialise, import or migrate a database. The next root
still has interim startup/installers; its fresh-schema startup and the separate
real-data move must supply the approved shared database. No fallback reads of
interim task/token/session tables are provided. The mounted-route test builds a
fresh in-memory shared database, writes through `taskService`, and reads those
same rows over actual HTTP; it does not touch a home or installed state.
`tasks.commentCount` is a generated task output extension, also available on
connected task rows when comments are selected in the query schema. A correlated
SQL count uses the same comment visibility predicate and runs inside the one
relational statement; it never issues per-task reads. Counts are current on each
execution and independent of pagination/filtering on a separately selected comment
relation. Scalar aliases, fragments and directives select the count as usual.
An unrequested count adds no SQL work. Counts have no separate stored column,
filter or order input. This output-only detail follows the site's example;
filtering and sorting remain on the schema's real columns.

Remaining on t-2235: other outside table projections, file-backed Memory roots,
websocket deltas and normalized Tasks client, deleting replaced
interim reads/tables, and configurable database providers.

## Runtime account placement and quota windows

The site specifies an account summary but is silent on providers with concurrent
usage windows. `modelAccountWindows` (`model_account_windows`) stores one row per
`(account, window)`, with `usage`, `usageReadAt`, `resetsAt`, `durationMs` and
`reserve` (default 0.05). Unknown observation fields are NULL; consumers must not
interpret them or a passed reset time as available capacity. Duration must be
positive and finite; usage and reserve are fractions from zero to one. The
account FK and composite key share observations across all agents, rather than
keeping agent-local quota copies. The existing `modelAccounts` fields remain the
site's account summary. Runtime owns ingestion and the capacity evaluator.

`jobs.account` is a nullable FK to the account selected for a job, and
`jobs.harness` is the selected harness name. Both may be absent before placement.
Typed relations include `jobs.accountRow`, `modelAccounts.jobsByAccount`, and
`modelAccounts.modelAccountWindowsByAccount`. These are schema additions for a
fresh database, not a migration. They add no public GraphQL projection: exact
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
work, check permission, or publish changes. Mounting it and removing the legacy
receipt table remain composition work; its presence alone does not switch the
running program.
