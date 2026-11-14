# Shared data schema

The approved [how-it-works site](how-it-works/README.md) is the goal. The authored
schema is `src/core/data/schema.ts`: all 79 tables and 551 named columns in
`model.py`, plus the eight internal bookkeeping tables listed there. This module
replaces per-part table definitions as each part is connected to it.

Import typed table exports such as `tasks`, `taskComments`, `timingDays` and
`measuringSettings`. TypeScript fields use camelCase; SQL names match the site.
`dataDatabase(client)` binds the shared schema to a better-sqlite3 connection
without creating or changing tables. Relations use `<column>Row` in the forward
direction and `<table>By<Column>` in reverse, for example `projectRow` and
`taskCommentsByTask` on tasks. These names disambiguate multiple links to one table.

`createDataSchema(client)` is only for a completely empty database. It refuses
any existing schema and never imports, drops, upgrades or replaces old tables.
The real-data move is separate work. The generated DDL is packaged in
`assets/data/schema.sql`; regenerate it with `npm run schema:generate`. The test
checks both against the approved source and against a real in-memory SQLite DB.
Nothing calls this initializer on an installed home yet.

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
