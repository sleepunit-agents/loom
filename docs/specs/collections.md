# Collections: one shared, permissioned path for app data

*2026-11-09. Status: **reviewed and accepted by the owner, 2026-11-09** (t-2020, epic t-2019). Built so far: queries (t-2021: the `collections` offer, `POST /collections/query` and `/api/loom/collections/query`, core's `agent` and `thread` types; `src/collections/`). A design doc in
the `docs/specs/` sense: it says what will be built and what each implementation's tests must pin. It defines the
contract that the epic's implementation tasks (t-2021 to t-2032) build to, and it inventories every app data flow
loom has today with the task that moves it, or the reason it stays where it is. Four cold review rounds and a fresh
independent read are folded in (changes are pulled, not pushed; revisions never reach a window; core keeps today's
owner filter; counts and searches can't reveal hidden records; Comms words never enter the log).*

## Why

> "all data should go out this way that can." — the owner, 2026-11-09

Every window asks for its own page and recounts what it shows. One changed ask made Home, Inbox and Comms each
fetch a fresh page (3.8 KB, 5.4 KB and 67 B in the measured run). "Needs you" is counted eight different ways
(below). The live stream says only `change`, so every open app asks again for everything it shows
(src/ui/live.ts), and every piece's manifest is re-run every 15 s per open scope to notice whether it moved.

The measured comparison (t-2018) settled the client side: **TanStack DB collections**, pinned to the tested
versions, behind a loom adapter. That isn't reopened here. What it didn't settle, and this spec does, is the
**contract**: how records are named, who may see them, how they're asked for, how changes reach a window, and how
pieces with their own stores take part without core reading those stores.

## Decided (by the owner, before this spec)

1. **TanStack DB on the client**, the tested versions pinned, behind an adapter (t-2018).
2. **Pieces keep their own stores.** Core never reads a piece's store or imports its code ([extensions.md](../extensions.md),
   rules 1 and 2). A piece publishes its data through a declared offer, like `sections` and `venues`.
3. **Named role contracts stay.** "Tasks" is a role and taskstore one implementation. A replacement piece that
   honours the role's contract serves the same records under the same names.
4. **The contract is independent of GraphQL and of the client library.** Nothing below names a TanStack or GraphQL
   type. Swapping the client library changes the adapter (t-2023) and nothing else.
5. **No blanket loading of private data into browser caches.** A window gets the rows and fields it asked for, that
   its viewer may see, and no more.
6. **Local stays local.** Drafts, scroll, layout, window position, open sheets and filter text are not shared
   records.

## Vocabulary (to be added to CONTEXT.md)

loom already says **collection** for a piece's *store* collection ([piece-storage.md](piece-storage.md): named JSON
documents in a piece's store). The two must not be confused, so this spec always qualifies:

- **Store collection**: where a piece *keeps* documents (piece-storage.md). Private to the piece.
- **Shared collection** (or just *collection* in this doc): a typed set of **records** a **provider** *publishes*
  for windows to read. It may be computed from any number of store collections, files or other sources. Its shape is
  a contract; its storage is the provider's business.
- **Provider**: what serves a shared collection. Core is the provider for its own records (`loom`); a piece is the
  provider for its role's records.
- **Record type**: one kind of record a provider publishes (`task`, `approval`, `thread`), with a versioned schema.
- **Record key**: a record's stable name, `<provider>/<type>/<id>` (below).
- **Domain**: what a provider's revisions count over: one record type, or all of a provider's types (`<provider>/*`).
- **Revision**: `(epoch, rev, txn)`, **server-side only**. `rev` is a provider's commit sequence for one domain;
  `txn` is the committing transaction's id, random and unique for the store's whole life; `epoch` is minted and kept
  by core alone (random, 64 bits or more). **Revisions never reach a window**: a domain-wide counter would show a
  viewer how much hidden activity happened, and when.
- **Stream sequence**: what a window sees instead: a counter per stream, counting only what that stream was sent.
- **Viewer**: who is looking: a member's session (a household owner, or an owner of some agents), an agent's
  token, or a house's token. Viewer authority decides which records and fields exist for them.
- **Consumer**: the code asking on the viewer's behalf: a core window, a piece's widget, a piece's own page.
- **Query**: a bounded request for records of one type: filter, order, page, fields.
- **Coverage**: what a query's answer says about completeness: complete, or partial with a total that is exact, a
  lower bound, or unknown.
- **Change**: an upsert or a delete of one record at one revision.
- **Subscription**: a live query: its snapshot, then its changes, on one stream.
- **Enter / leave**: a record joining or leaving one subscription. Not the same as an upsert or a delete: a task that
  closes *leaves* "open tasks" and *enters* "closed tasks", and still exists.

## Identities

### Record keys

```
<provider>/<type>/<id>
loom/thread/cv-80d1a580c2b3
tasks/task/t-2020
approvals/approval/a-7693c00e
```

- **`<provider>` is the role, not the package**, for a piece with a role contract (`tasks`, not `taskstore`;
  `runtime`, not `loom-box`). Swapping taskstore for another tasks implementation keeps every key. A piece with no
  role uses its installed name. Core is `loom`, which is reserved. **Install refuses** a piece whose provider name
  is already taken, by another piece's role or installed name, and a second installed piece with the same role.
- **`<type>`** is `[a-z][a-z0-9-]{0,31}`, declared by the provider.
- **`<id>` is the provider's own stable id**, opaque to core and the client: `t-2020`, `a-7693c00e`, `cv-…`. It
  never changes while the record lives, and it matches `[A-Za-z0-9._:-]{1,128}` (no `/`). A provider whose source has
  no stable id (a computed row) makes one that is stable for the same underlying thing (a hash of its natural key),
  never a list position. **Text is not a natural key**: an ask's wording is not its identity, because rewording it
  would make a new item and a hash of short text can be guessed back. Asks get provider ids (Inventory, "Before any
  domain moves"). An id may come back after a delete; the new record is a new record.
- **One record, one key.** The same ask shown on Home, in Inbox, on an agent card and in a thread is one record,
  read once and shared by every window. Views that need a different shape use a projection or a derived selector,
  not a copy under another key.
- **Cross-record references** are record keys in fields (`"thread": "loom/thread/cv-…"`). The client resolves them
  only if it subscribes to that type. A reference to a record the viewer can't see stays an unresolved key and is
  never an error. That a key exists can show that a hidden record exists. That's accepted; a provider that must hide
  even that leaves the field out for viewers who can't see the target.

### Versions

- Each record type has a **schema version** `major.minor`. A minor version only adds optional fields. A major
  version is a separate collection: a provider may serve `task@1` and `task@2` side by side while consumers move,
  and drops the old major only when no installed consumer declares it. **The client keys collections by
  `type@major`**, and one consumer reads one major of a type.
- A consumer declares the range it reads (`tasks/task@^1`). A query for a major the provider doesn't serve answers
  `unsupported-version`, never a reshaped record.
- A field a consumer doesn't know is ignored. **A field missing from a record means unknown**: a projection left it
  out, or the viewer may not see it. A provider clears a field with an explicit `null`.

## Declaring a provider: the `collections` offer

A managed piece declares what it publishes as a sixth offer key in its package's `loom` block, validated at install
like the other five ([extensions.md](../extensions.md), "Offers"):

```jsonc
"loom": {
  "role": "tasks",
  "collections": {
    "owners": 2,                                                   // agent owners may see its records (below)
    "query":   ["loom-tasks", "collections", "query", "--json"],   // one viewer, a batch of queries, on stdin
    "changes": ["loom-tasks", "collections", "changes", "--json"], // whole records committed after a revision
    "search":  ["loom-tasks", "collections", "search", "--json"],  // optional
    "types": {
      "task": {
        "version": "1.2",
        "schema": { /* JSON schema of one record, at most 16 KB */ },
        "agent": "agent",               // the field naming the agent a record belongs to, if any
        "fields": {
          "agent":       { "class": "member", "filter": ["eq", "in"] },
          "title":       { "class": "member", "search": true },
          "status":      { "class": "member", "filter": ["eq", "in"], "order": true },
          "priority":    { "class": "member", "filter": ["eq", "in", "lte"], "order": true },
          "updated":     { "class": "member", "order": true },
          "assignee":    { "class": "member", "filter": ["eq", "has"] },
          "description": { "class": "member", "heavy": true, "search": true }
        },
        "default_fields": ["title", "status", "priority", "updated"],
        "max_page": 200,
        "aggregates": { "count": { "by": ["status"] } },
        "domain": "type",               // or "provider": one counter for all its types, named tasks/*
        "audience": "rows",             // or "ask" (below)
        "houses": false,                // the default: task houses' tokens never see this type
        "services": false               // the default: service houses' tokens never see it, whatever "houses" says
      }
    }
  }
}
```

- **`query`**: an argv run through the manifest's runner. It gets **one viewer**, the current time, and up to 32
  queries for that viewer on stdin, so a window opening ten views costs one subprocess per provider, not ten. A
  batch never mixes viewers. **Its answer says what it read at**: `{rev, txn}` for each domain it read, taken in the
  same read transaction as the rows, so rows and revision are one consistent read.
- **`changes`**: an argv that gets each domain's last revision and answers the whole records committed after it,
  in commit order, each **as of its own revision** (the next section).
- **`search`**: optional. It gets one viewer, the field classes that viewer may see, and a query text, and answers
  references and snippets (below).
- **Their limits are their own** (`OFFER_LIMITS`): 15 s; 1 MB an answer, with each query in a batch given its own
  share (a query that would overflow its share answers `too-big` alone and the others still answer), and each
  `changes` page bounded by bytes as well as by count; and a pool apart from the page's pieces (four running,
  sixteen waiting per provider), so live data can't starve page loads or the other way round.
- **`owners: 2`**, declared here and fixed at install: the gate [owners.md](owners.md) already has for pages.
  **A provider that doesn't declare it answers only household owners**, and core refuses any other viewer's query
  before running it. It's read from the installed declaration, never from a cached manifest, so it can't flap when a
  manifest times out.
- **`agent`**: the field that names the agent a record belongs to. It's what lets core apply today's owner filter
  itself (Who may see what, below). A type without one is household-owners-only for agent owners.
- **`fields`** lists every field the type has:
  - **`class`**: who may ever be sent it. `household` (household members, and agents and houses only where the
    record's audience admits them), `member` (viewers the record's audience admits), `owner` (household owners
    only). **There is no class for secret values**: a token, a key or a password is not a field of any record. A
    provider that has one keeps it behind its own dedicated exchange (exceptions, below).
  - **`filter`**: the operators allowed on it: `eq`, `in`, `prefix`, `lt`, `lte`, `gt`, `gte`, and `has` (the field
    is present and not null). A field without `filter` can't be filtered on.
  - **`order`**: whether it can sort a query. Order always ends with the record id, so pages are stable.
  - **`heavy`**: a large field (a body, a transcript, a description) left out of lists unless asked for by name, and
    only for a page of at most `max_page / 10` records.
  - **`search`**: whether search may match it. Search sees only searchable fields of a class the viewer may see.
  - **`kept`**: `false` for a field core must never store anywhere: not in its change log, its index or a change
    it holds. It's read from the provider on demand, for one request. A Comms message's words are the first such
    field ([comms.md](comms.md): no other table holds them, and no decrypted words are cached). A `kept: false`
    field is always `heavy` too.
- **`aggregates`**: the counts the provider computes. A consumer never derives a total by counting rows it happens
  to hold. Who gets them is under Asking, below.
- Validation at install refuses: unknown keys, a type or field name out of grammar, a schema over 16 KB, a
  `max_page` over 500, an aggregate, filter or `agent` naming an undeclared field, and a provider name or role
  already taken.

Core declares its own types (thread, message, memory, knowledge page, person, project, agent, …) in code, through
the same structures, and serves them through the same `query` and `changes` interface. **Core's types obey the same
contract and the same tests as a piece's.** Core gets no shortcut that a piece can't have.

## Asking: queries

A window sends a batch of up to 32 queries to `POST /collections/query`. That's a UI route like `/act`: it needs the
same-origin check and the session's `_csrf`, because browsers can never reach `/api/*` (http-server.ts refuses any
`/api` request with an `Origin` header). A bearer token on a UI route needs no CSRF token, as today. Agents and
houses send the same queries to `POST /api/loom/collections/query`, as viewers of their own kind (Who may see what,
below), and may not subscribe there: there is no stream on `/api`.

```jsonc
{
  "id": "q1",                                   // the client's: it names the subscription too
  "stream": "e-…",                              // the stream its changes go to (below)
  "type": "tasks/task@^1",
  "where": [["status", "in", ["open", "in_progress"]], ["priority", "lte", 2]],
  "order": [["priority", "asc"], ["updated", "desc"]],
  "limit": 50,
  "after": null,                                // the cursor from the previous page
  "fields": ["title", "status", "priority", "updated", "assignee"],
  "aggregates": ["count"],
  "subscribe": true
}
```

- **Bounded by construction**: only declared operators on declared fields, at most 8 `where` clauses, an `in` list
  of at most 100, `limit` at most the type's `max_page`. No free-form expressions, no joins, no provider-side search
  language.
- **Never on a hidden field.** Core refuses a query as `bad-query` when a `where`, `order` or `aggregates.by` names
  a field the viewer's class can't see, before the provider runs. Otherwise a viewer could learn a hidden value from
  which rows come back, character by character with `prefix`, or from the order.
- **Pages are keyset pages**: `after` is an opaque cursor. Core seals every cursor (a MAC over the provider's cursor,
  the viewer, the scope and the query), so a cursor can't be read, edited or reused by another viewer or query.
- **Fields**: an answer carries the record key and only the fields named (or the type's `default_fields`), further
  cut down to what the viewer's class allows. A field the viewer may not see is **absent**, not null, and the answer
  lists which named fields were withheld, so a window shows "hidden", not "empty". A record's `audience` is sent to
  household owners only; anyone else gets nothing that names other members or agents.
- **Joins are client-side**: a field holding another record's key is resolved by a second query on that type
  (batched with the first). This keeps each provider ignorant of every other.

The answer, per query:

```jsonc
{
  "id": "q1",
  "rows": [ { "key": "tasks/task/t-2020", "title": "…", "status": "in_progress" } ],
  "next": "sealed-cursor",                      // or null at the end
  "coverage": { "complete": false, "total": { "n": 214, "exact": true } },
  "aggregates": { "count": { "n": 214, "exact": true, "by": { "open": 190, "in_progress": 24 } } },
  "withheld": ["assignee"],
  "at": 1207,                                   // the stream sequence this answer is consistent with
  "scope": 41                                   // the viewer's scope epoch (below)
}
```

- **`coverage.total`** is `{n, exact: true}` (the provider counted), `{n, exact: false}` (at least n), or absent
  (unknown). The UI shows "20 of 214", "20 of 1000+", or "20", accordingly. A badge reads an **aggregate**, never
  `rows.length`.
- **Counts and totals are something core can't check**: it can drop a row the viewer may not see, but it can't
  recount a number. So a provider's `aggregates` and `coverage.total` go **to household owners only**, unless the
  type declares `scoped_counts: true`, which it may do only once its conformance run passes the per-viewer count
  fixtures (an agent owner's count excludes other agents' records; a member's excludes others' threads). Without
  it, other viewers get `total` absent and no aggregates from the provider. **Where a subscription's coverage is
  complete, core counts the keys it has delivered to it itself** (they've all passed core's checks), so an agent
  owner's badge still counts their own ([owners.md](owners.md): "Badges count your own"). The attention types are
  small and complete, so t-2025 relies on this; a count over a partial list says "20" rather than a number it can't
  trust.
- **A provider counts only what its viewer may see**, household owners included: a record whose audience is
  `members` alone is counted only for the members it names. Core can't recount, so it does what it can: when it
  drops any row of an answer (the provider answered a row this viewer may not have), it drops that answer's
  provider totals and aggregates too. Until the conformance suite exists (t-2026), install refuses `scoped_counts`
  and `scoped_search`.
- **`at`** is the point on the window's stream this answer is consistent with: frames after it apply on top of it.
- **Errors are per query**: `unsupported-version`, `bad-query` (with which clause), `too-big`, `denied` (the viewer
  or the consumer may not read this type), `unavailable` (the provider timed out or failed). One provider's failure
  never fails another's query in the same batch. A window shows that provider's data as unavailable, keeping what
  it already held, marked stale.

## Who may see what: three separate questions

The bench showed that a cache library's isolation is not loom's permission model. This contract keeps three
questions apart, and gives each its own enforcement point.

### 1. Viewer authority: may this viewer see this record, and these fields?

A record is visible to a viewer when **every one** of these holds:

1. **The provider admits them.** For a query, the provider decides first, from the viewer core hands it: the member
   (whether they're a household owner, and which agents they own), or the agent, house and service of a token,
   plus the scope core already computes for pages (`LOOM_SCOPE`, `LOOM_OWNER_SCOPE`, [owners.md](owners.md)). For a
   change, there's no viewer to hand it (one change goes to many), so the provider's word is the record's
   `audience`; a type whose rules an audience can't express declares `"audience": "ask"` (below).
2. **The audience admits them** (below). Core checks this on every row of every answer and every change, whatever the
   provider said: a provider that ignores who's asking leaks no rows. Nor does it leak through what core does
   about it: a shorter page, a missing `next` or an error would each tell the viewer a hidden record matched their
   query, so a provider that answers any row its viewer may not have is **out of contract**. That answer, and every
   answer from it after, to anyone, is `unavailable` until it's reinstalled or loom restarts (one bit, once per
   listener). So is a page with a `next` that isn't full: a provider that paged first and filtered after would be
   saying hidden records matched. A row of the viewer's own that core can't send (a bad id, a bad expiry) fails only
   that answer.
3. **The agent rule admits them.** For an owner of some agents, core admits only records whose `agent` field names
   one of their agents. A record with no agent, or of a type with no `agent` field, is household owners' only, except
   through a `members` term that names that member: their own read markers, prefs and session list are theirs. This is
   today's `forOwner` filter (handler.ts), kept in core, and it applies on top of every audience term, `members`
   included: a member who stops owning an agent stops seeing its threads at once, without waiting for any provider.
4. **The piece allows agent owners at all**: a provider without `owners: 2` answers household owners only.

Fields are then cut to the viewer's class.

### Audience

Every record carries an `audience`, set by its provider. Its terms are a **union** (and the agent rule above still
applies on top):

```jsonc
{ "household": true }                    // every household member
{ "owners": true }                       // household owners
{ "ownersOf": ["art"] }                  // members who own agent art (and household owners)
{ "members": ["jonathan-barket"] }       // these members only
{ "agents": ["art"] }                    // agent art's own tokens; its houses only where the type allows (below)
```

- Household owners are admitted by every term but `members`. A Comms thread uses `members` alone, so another owner
  of the same agent never sees a member's private thread ([comms.md](comms.md)).
- **Hiding a field record by record** (a field some viewers may see on some records but not others, beyond its
  class) needs `"audience": "ask"`: an audience is per record, so only a per-viewer re-query can hide one field of
  one record.
- **`"audience": "ask"`**: core re-runs each affected subscription's query, as its viewer, when the domain changes
  (batched, at most once per 1.5 s, in the provider's own pool, at most 16 subscriptions per domain per round, the
  rest taken in turn in the next rounds) rather than routing by audience. Slower, never wrong.

### 2. Consumer capability: may this code ask for this type at all?

- Core's own windows may read any type their viewer may.
- **Agent and house tokens ask the grants authority**, with `{agent, house, service}` and path
  `collections/<provider>/<type>` (t-1746 is the single grants list; this adds paths to it, not a second
  authority), and fail closed exactly like `/api/<piece>/…` today. With no grants authority installed, agent and
  house tokens are denied every collection, core's own types included (there's no per-piece agent list to fall back
  on here; agents still have their MCP tools).
- **A house's token never reads a type that doesn't allow it**, whatever the grants say: a task house needs
  `houses: true`, and a service house (one that other people, strangers included, can steer) needs
  `services: true` as well. Both default to false.
- Piece, peer, review and runtime tokens are refused on the query route: they're programs with their own seams.
- **A piece's widget or page in the window** may read its own provider's types, plus the types the grants authority
  allows it. But core can't tell which code in a page sent a request: the session cookie is the page's. So **this
  check is advisory for code running in the page**, and it's enforced only where the code is separable: at the
  sandboxed frame's port (below) and for tokens.

### 3. Code isolation: can this code reach what it wasn't granted?

Same-origin JavaScript shares the page's memory, cookies and cache, so **a widget running in the page has every
capability the page has**, whatever the collection API says. Today's widgets are first-party and run in the page;
that's acceptable only because they're reviewed code. A piece widget that isn't first-party must run in a sandboxed
frame (opaque origin, no cookies), talking to the page over a message port that serves only its granted types. The
collection runtime (t-2023) must not be reachable from a sandboxed frame except through that port. Until that frame
exists, only first-party pieces may ship widgets (t-2026).

### The viewer is checked on every frame

- Core resolves a stream's viewer again before every frame it sends, the way the Comms thread stream already
  re-checks its member (`may()`, comms-live.ts): the session still live, the member's agents unchanged, the token not
  revoked. Every listener learns of a change to the household file, sessions or tokens from a tick file, as Comms
  does, so a session revoked on one listener ends on all of them.
- Each viewer has a **scope epoch** that changes when anything their authority rests on changes: membership, agents
  owned, a session, a grant. Every answer and frame carries it. On a change, core resets the viewer's affected
  subscriptions (`reset: scope`), and the client drops those collections and any answer still in flight from the
  older epoch.
- **Grants change in the grants authority**, which is a piece: it publishes them as a collection (`runtime/grant`,
  t-1746), and core subscribes to it as the core viewer (below) to bump scope epochs.
- Sign-out or revocation closes the session's streams and drops its subscriptions at once. The client runtime clears
  every record that came through that session from memory (t-2023). A stream opened after a revocation is refused
  (the bench's revoke-before-open case is a regression test).
- Nothing in a shared collection persists to disk in the browser (no IndexedDB, no service-worker cache) until a
  separate decision says which types may, and how they're cleared.

### Core as a viewer

Core does work with no window open: the push watch, Needs auto-resolve, applying an owner's Allow. For that it reads
as the **core viewer** (presented to a provider as `{"kind": "core"}`), which sees everything, members-only Comms
threads included, which push needs. It's unreachable from any route, and it's never handed to a window. Whatever it
produces for a person is filtered for that person again: a push goes to the ask's owners only (owners.md), through
the same checks.

## Changes: from provider to window

### Core pulls; anyone may nudge

A provider never pushes records to core. Core **pulls** them with the provider's `changes` verb:

```jsonc
// stdin
{ "tasks/task": { "rev": 8812, "txn": "9f0c4e2a7d1b3e58" } }
// stdout
{ "tasks/task": { "head": 8814, "changes": [
    { "op": "upsert", "id": "t-2020", "rev": 8813, "txn": "c41e…", "audience": { … }, "record": { /* whole, as of 8813, kept fields only */ } },
    { "op": "delete", "id": "t-1999", "rev": 8814, "txn": "c41e…" }
  ], "more": false } }
```

- **The provider answers from a commit-ordered log**: every change it committed after that revision, in order, up to
  1000 changes or its byte budget a call (`more: true` asks core to call again). `rev` is assigned inside the commit,
  under the same lock, never allocated before it, so a cursor can't skip a change committed later with a lower
  number, and two writers racing can't reorder the log.
- **Every change carries a `txn` id that is unique for the store's whole life**: random, 64 bits or more, never
  derived from `rev` or a counter.
- **Core proves the log didn't go backwards on every pull.** It sends, with its cursor, the `txn` it holds at that
  revision, and the provider answers `{"reset": true}` unless its own log has that transaction at that revision.
  The answer's `head` below the cursor is the same reset. A store restored by any route, even one that has since
  written past the cursor, fails the check. On a reset core mints a new epoch for the domain (compare-and-set in
  `household.db`, so two listeners can't mint two), as it also does on install, replacement and restore, and resets
  the domain's subscriptions. A revision older than the provider's log is a reset too.
- **A change carries the whole record as of its own revision** (every non-heavy field, `kept: false` fields left
  out), so core can trim it for each subscriber and decide membership without asking again.
- **A transaction is never split**: an answer ends on a transaction boundary, except a transaction bigger than one
  page, which ends with `more: true`; core holds it until its last change arrives. One transaction reaches a
  subscriber in one frame, with the aggregates that go with it. A transaction that spans types is atomic in one
  frame only for a provider with `"domain": "provider"`.
- **No change log yet**: a provider that can't say what changed answers `{"invalidate": true}`. Core then re-runs
  the domain's open subscriptions' queries **as the core viewer** (batched, at most once per 1.5 s, the existing
  `GAP_MS`), diffs the whole answers, and logs the differences under an epoch and sequence of its own; each
  subscriber then gets them through the usual checks. A diff is never computed from one viewer's trimmed answer, so
  one viewer losing access can't become a delete for everyone. **A row missing from a re-run is a delete only if
  that answer was complete, or a lookup by key confirms the record is gone**; otherwise it just fell off a limited
  page, and that one subscription gets a leave. When the provider gains a log, its first real answer
  starts a new epoch, and the domain resets once.
- **When core pulls**: whenever it's nudged, and every 15 s for every domain that has an open subscription. Nudges
  coalesce: at most one pull per domain per `GAP_MS`, however many arrive. One listener at a time holds a domain's
  pull lease (as one listener holds the push watch today, `takePushWatch`), renewed on every `changes` call and
  expiring 30 s after the last, so a listener that dies holding it doesn't stop the domain.
- **A nudge** is `POST /api/loom/collections/nudge {"domain": …}` with an agent, house, owner or piece token
  (never a peer or review token), at most one a second per token; or `loom collections nudge <domain>` on loom's
  machine. **A nudge carries nothing but a domain name, and core answers the same whether or not the domain
  exists**, so a nudge can't probe what's installed, and a forged one costs at most one pull. A piece's CLI run
  directly by an agent, which has no token of its own, can still say it wrote.
- **Today's 15 s manifest round stays**, per scope, for every piece whose pages or manifest fields are still read
  (it is what sends `page` frames, below), and shrinks as each piece's fields move.
- **Expiry**: a record with a natural end (an ask that expires, a reading's `observedAt` plus its lifetime) carries
  `expires`, which core keeps in its index. When it passes, core logs a delete as a row of its own (next in its row
  sequence), and only if the record is still at the revision that carried that `expires`; a renewal (a later
  change with a new `expires`) wins because it's newer. Providers get the current time with every `query`, and must
  not answer expired rows or count them; core drops any that slip through, and clients hide rows past `expires`
  themselves in case a frame is late.
- **Core's own stores pull the same way.** Memories, knowledge, people and conversations are written by MCP and CLI
  processes outside the HTTP listeners, so core can't log their changes in-process. Each core store gets its own
  commit log, in its own database and committed with the write it records, and core pulls it like any provider's.

### Core's change log and index

- loom runs several HTTP listeners (LAN, tailnet, localhost) over one `$LOOM_HOME`. So the log is **a table in
  `household.db`**: a row sequence core assigns, domain, epoch, revision, transaction, key, audience, agent, the
  record's kept fields, time. Rows are ordered by core's row sequence. A provider's rows are unique on
  `(domain, epoch, rev)` and written insert-or-ignore, so a pull that overlaps another writes nothing twice; core's
  own rows (expiry deletes, bridge diffs) have no provider revision and are keyed by the row sequence alone, so they
  never collide with a provider's. Whichever listener pulls writes it once; every listener learns of new rows from a tick file and reads them.
- It keeps each domain's last 1000 changes or 10 minutes, whichever is more, and never more than 5000. A window
  further behind gets `reset: gap`.
- **Beside the log, core keeps an index of current state per key**, not pruned: revision, audience, agent,
  `expires`, and the fields any declared filter, order or aggregate uses. It's written **only from whole records**
  (a `changes` answer, or a snapshot core takes as the core viewer), and **only forward**: a row is replaced only by
  a higher `(epoch, rev)`. It never takes values from an answer trimmed for one viewer. A key's row goes when its
  delete leaves the log.
- **The log and the index are caches**: derived from providers, left out of the household bundle, rebuilt by
  snapshot after a restore. Neither ever holds a `kept: false` field.

### Core to window

A window opens its one stream (`GET /events`, today's), which first says who it is:

```
event: hello
data: { "stream": "e-…", "scope": 41, "seq": 0 }
```

Queries name that stream, and their changes come on it. Every frame carries the stream's next `seq`:

```jsonc
event: rows
data: { "seq": 1208, "sub": "q1", "scope": 41,
        "upserts": [ { "key": "tasks/task/t-2020", "status": "closed", "title": "…" } ],
        "leaves":  [ "tasks/task/t-1990" ],
        "deletes": [ "tasks/task/t-1999" ],
        "aggregates": { "count": { "n": 213, "exact": true, "by": { … } } } }

event: reset
data: { "seq": 1209, "sub": "q1", "reason": "gap" | "scope" | "provider-gone" | "epoch" | "version" }

event: page
data: { "seq": 1210, "piece": "clock" }
```

- **No revision reaches the window.** Frames and answers are ordered by the stream's own `seq`, which counts only
  what this stream was sent, so nothing in them shows activity the viewer can't see.
- **The stream check is `/act`'s**: same origin (`Sec-Fetch-Site` or `Origin`) and the session, so a page on another
  port of the same host can't open streams in a member's name. A stream holds at most 64 subscriptions. Core
  refuses a query naming a stream that isn't its own session's.
- **Handover without a gap**: the provider's answer says the `{rev, txn}` it read at. Before answering, core pulls
  the domain until its log has reached that `rev`, and checks that its log has that `txn` there; a mismatch means the
  store's history changed, and core resets the domain (new epoch) and asks again rather than stamp new history with
  an old epoch. An answer read at a revision older than the oldest the log still holds can't be checked, so core
  asks again rather than accept it unchecked. Only then are the answer and the log known to agree. The answer's `at` is the stream `seq` it is
  consistent with; core sends that subscription's later changes as frames after `at`. The answer and the stream are
  separate HTTP exchanges, so a frame can arrive first: **the client holds frames for a subscription it has asked
  for until that answer arrives**, then applies those with `seq` above `at`. When a later page extends a
  subscription (below), the same rule applies to the keys in that page only.
- **Delivered keys**: core keeps, per subscription, the set of keys it has sent. A change sends a **leave** only to
  subscriptions that hold the key, and an **enter** (an upsert, the record whole as far as the subscription asked
  for it) only where it now belongs. So when a record's audience narrows, the viewers dropped from it get a leave
  for exactly the subscriptions that held it, and nobody else learns the key; this needs no prior state from the
  index or the log.
- **Membership is per subscription, not per record.** A `leave` takes a record out of one subscription; a `delete`
  says it's gone. The client tracks membership per subscription, and keeps a record in its shared collection while
  any subscription holds it: a task that leaves "open tasks" and enters "art's tasks" in the same frame stays.
- **Upserts are trimmed** to the subscription's `fields`, the viewer's class, the audience and the agent rule, like
  an answer.
- **Which changes reach a subscription** is defined by its **window**: the records matching its `where` that sort no
  later than its **boundary**, the order-key tuple of the last row it loaded, fixed as loaded until the client loads
  further (all of them, once it has loaded the last page). The boundary doesn't move when that last row itself
  changes or leaves. Loading the next page sends the same `id` with `after`, which extends that subscription's
  window; a new `id` is a new subscription. **A window holds at most 1000 records**: past that, core sends leaves for
  the rows past the boundary of the first 1000, moves the boundary up to the last one kept, and marks the
  subscription's coverage partial, so an order like `updated desc` can't grow it without end.
- **Aggregates are kept per subscription by core**, starting from the provider's (where the viewer may have them,
  above): core adds and subtracts as records enter and leave, using the index for a record's prior state, and asks
  the provider again when it can't (an `ask` type, an invalidated domain, a total that wasn't exact, a key with no
  index row).
- **Back-pressure**: a window more than 256 frames behind is sent `reset: gap` for its biggest subscriptions
  instead of more frames.
- **Reconnecting is a new snapshot.** Subscriptions, delivered keys and boundaries live in one listener's memory, so
  a client that reconnects (to the same listener or another) sends its queries again and gets fresh answers. Today
  six streams a session is the cap and the oldest is closed; a seventh window shares an existing stream instead of
  opening one (t-2023), so windows don't evict each other.
- **Provider removed or replaced, or a new epoch**: `reset: provider-gone` (removed) or `reset: epoch` (replaced,
  restored, or found to have gone backwards) for its domains, and the client clears that domain's collections.
  A replacement under the same role whose types satisfy the subscriptions' version ranges answers the next
  snapshot; otherwise the views show the provider as missing (a missing piece is a feature that isn't there,
  extensions.md rule 3).
- **Piece pages stay piece-rendered**, as blocks. They aren't records, so a `page` frame tells a viewer's windows
  that a piece's pages moved (today's manifest fingerprint, now per piece and per viewer). Only the page-wide bare
  `change` is retired (t-2032).

## Commands (shared with t-2024)

Actions keep their own routes, CSRF checks, principals, grants and approval semantics. What changes is what they
answer: alongside today's result, an action answers an operation receipt (`accepted`, `done`, `failed`, with why).
Its changes go into the log like any other, and core pulls the domain before answering so they're there. They reach
every window, the acting one included, through the stream, trimmed as usual. So no window refetches after its own
action, and none gets a record its viewer couldn't read. A window may show its own action as pending, but never
shows a grant or an approval as done until the receipt says so. t-2024 owns the details.

## Read state and other per-viewer records

What a viewer has read is a record, not a side effect of looking:

- `loom/read-marker/<member>:<hash of the item key>` for an Inbox item, and `loom/thread-read/<member>:<thread>` for
  Comms' read cursor. Both have audience `members: [<member>]`.
- They change only by an explicit action (`POST /inbox/read`, the thread's `read`). Today `GET /inbox?i=` also
  marks an item read, and neither `/inbox/read` nor `/appearance/prefs` tells other windows. Both go: a GET never
  writes, and every write lands in the log.
- Preferences that follow a member between devices (`loom/prefs/<member>`) are the same kind of record; the
  per-device ones stay local.

## Chrome becomes a few small queries

Every page answer today embeds `chrome` (nav, every badge, agent states, tiles, backup, prefs), rebuilt in full on
every request and every refetch, and a 304 saves bytes but none of that work (handler.ts, `chrome()`). Under this
contract chrome stops being a transport. The shell holds a handful of live queries, each answered once and then kept
current by changes:

- the attention aggregate and per-agent counts (t-2025);
- Comms unread (t-2027);
- agent status and place tiles (t-2028);
- installed places and nav, backup and health, and the member's prefs (t-2031).

A page answer carries only what's particular to that page. The clock, CSRF token and flash stay in the page.

## Search and other query-shaped reads

Search results aren't a filter over one collection: each search is its own result set.

- **One result type**, `loom/search-result`, whose query is the text (`where: [["q", "eq", "…"]]`) and whose records
  are references (`{"ref": "tasks/task/t-2020", "score": …, "snippet": …}`). It can't be subscribed to, and two
  searches never share a collection. A newer query cancels the older one's request.
- **Core asks each provider's `search` verb** as that viewer (core can't index a piece's store), with the field
  classes the viewer may see, plus its own, and merges by score. A provider without `search` isn't searched.
- **Search matches only fields declared `search: true` of a class the viewer may see**, so a hit can't reveal a
  hidden field ("never on a hidden field" applies to search as to `where`). Core can't re-check *why* a provider
  matched, so this rests on the provider: like counts, a provider's search answers go to household owners only
  unless the type declares `scoped_search: true`, which it may do only once its conformance run passes the
  hidden-field search fixtures. Snippets come only from those fields,
  and each hit is checked against its target's audience and the agent rule like any row. Launcher suggestions work
  the same way.

## The client runtime, in one paragraph (t-2023 builds it)

The client keeps one registry per signed-in session, keyed by viewer, scope epoch and `type@major`. It holds one
collection per record type the open windows read, membership per subscription, one in-flight request per identical
query, and one subscription per live query, shared by every window, over at most one stream per window group.
Windows bind derived views (filters, sorts, joins by key) to it and keep their own presentation state. A record no
subscription holds is dropped; a collection nobody has read for 5 minutes is dropped, and any memory cap drops the
least recently read first. Sign-out, a scope change, a new epoch or a provider's removal clears what it affected,
along with the listeners. The adapter is the only code that imports the client library.

## What stays on its own transport (exceptions)

Each needs its own rationale, and safe status and metadata about them still go through collections:

| Kind | Why it keeps its own path | What still goes through collections |
| --- | --- | --- |
| Static assets, the app bundle, icons, fonts | Cached by the browser by URL and content hash; not records | — |
| Raw files and media (attachments, images, audio, exports, bundle downloads) | Bytes, often large, range-requested; the 256 KB record cap | The file's record: name, size, type, owner, link |
| Sign-in, passkey challenges, session cookies, token links | Single-use, never cached, security-sensitive | Session list metadata (device, last seen), without tokens |
| Secret values (loom-secrets), model-account credentials | Must never enter a browser cache or a shared record | Secret names, requests and their states; account status and usage, without credentials |
| Comms message words | Encrypted at rest, never cached decrypted, swept on schedule ([comms.md](comms.md)) | The message record (seq, author, time, state); its words are a `kept: false` field read per request |
| Terminal, log tail and other byte streams, model token streams | Ordered byte streams, high rate, no record identity | The job or step record, its status and progress |
| Local UI state: drafts, layout, scroll, open sheets, filter text | The viewer's own, per window | — |
| Service-worker push payloads | The push service forwards an opaque payload | The notification's record, read on open |
| Piece-to-piece reads (one piece's CLI or API answering another) | Program reads under the grants authority, not app data for a window | — |

## Inventory: every flow and where it goes

Surveyed on 2026-11-09 against loom main `6ab2a79` and the catalog pieces at HEAD. The full row-by-row inventory,
with file and line for every route, consumer, poller and offer, is in two appendices:
[collections-inventory-core.md](collections-inventory-core.md) and
[collections-inventory-pieces.md](collections-inventory-pieces.md). This section is the
assignment: every flow has a task that moves it, or a stated exception. **A task under the epic doesn't close with
a row here unassigned**, and a new flow added before t-2032 gets a row here.

### What the survey found

- **One transport carries almost everything.** Every page address returns the app's HTML or, asked for JSON, a
  *view* of that page plus `chrome`. Pieces reach the browser only through core: their manifest (`ui --json`)
  folded into chrome, Home and the Inbox; their pages proxied as views; and core's own calls into their APIs and
  offers. No piece has a data endpoint of its own for the browser.
- **The only change signal is "something changed"**, except Comms' per-thread `seq` stream, which is already a
  real cursor and the model for this contract. Only the runtime may tell core it moved, and it says nothing about
  what. Every other piece is found out by core re-running every manifest every 15 s per open scope.
- **"Needs you" is counted eight ways** (Home's item set, the Inbox badge's separate arithmetic, the per-agent
  badge that counts each memory proposal where the Inbox counts one per agent, the Inbox folders in the browser, the
  Inbox "From" counts, each project's "waiting", push's own 60 s pass, the Boxes alerts). Comms unread is counted
  by threads on the dock and by messages on the agent card. The full Inbox item set is rebuilt for Home, the Inbox,
  every visible ask card on every change (`/inbox/open`), every Comms pull and chip lookup, and before every answer.
- **Agent status is derived four ways** in core (`agentCards`, `agentStateOf`, `onOf`, `moving`) and merged again
  in the browser.
- **Read state lives in three places** (Inbox opened-keys in the sessions file, Comms `read_seq`, an optimistic set
  in the browser), and two writes (Inbox read, prefs) tell no other window.
- **No piece has per-record revisions.** Core's piece store has a per-document `rev` and a store-wide revision id,
  but it's pruned to 20 per document and skips `history: false` collections, so it isn't a change log yet. Tasks has
  an ordered interactions log that nothing reads. Tasks re-reads all of its ~2,100 tasks on every manifest poll.
- **Some records have no stable identity**: manifest asks, notices and answered rows carry no id (the Inbox keys
  them by a hash of their text, so a reworded ask is a new item), and the clock's wake ids are re-minted on every
  retry, resume, defer and schedule occurrence.
- **Lists are capped slices, not pages**: asks ≤10 and notices ≤20 per piece, approvals' first 10 pending with no
  "more", the runtime's newest 50, Changes ≤500, approvals keeping only the newest 300.
- **The manifest cache key leaves out the owner scope** (`src/ui/pieces.ts`, `manifestFor`); today core's own
  per-owner filter (`forOwner`) is the real boundary. A provider design must not inherit that key (t-2021).

### Core

| Flow (today) | What it carries | Goes to |
| --- | --- | --- |
| Home view `/` (household): `needs`, `stack` | the attention item set, first 4, unread | t-2025 |
| Home view: agent `cards`, `moving` | state, reason, doing, jobs, problems, readings, last seen | t-2028 |
| Home view: recent tape steps per agent | activity | t-2030 |
| Single-agent Home `/` | core tiles, piece tiles, piece asks | t-2025 (asks), t-2028 / t-2031 (tiles) |
| Agent Today `/a/<agent>`: `waiting`, asks | per-agent attention | t-2025 |
| Agent Today: head, about, bio; thread (30 tape items) | agent profile, activity | t-2030 |
| Agent Today: tiles, next wake, last wake | clock and runtime readings | t-2028 |
| Agent piece tab `/a/<agent>/p/<piece>/…`, household piece page `/p/<piece>/…` | piece pages (blocks) | pages stay piece-rendered; their records move with the piece (below) |
| Agent setup `/a/<agent>/setup` | identity, tokens list, face, mark, backup row | t-2031 (tokens metadata, backup), t-2030 (identity) |
| Mind `/a/<agent>/mind`, memory detail, agent people | memories, proposals, history | t-2030 |
| Conversation page `/conversation/<cv>` | turns, digests, needs | t-2027 |
| Inbox `/inbox` (items, folders, inline piece page, done toasts) | every ask, notice, answered, FYI | t-2025 |
| `GET /inbox?i=` marks read; `POST /inbox/read` | read state | t-2025 (read-marker records; the GET stops writing) |
| `/inbox/open` per visible ask card | is this ask still open | t-2025 (a local lookup; the action re-checks) |
| Activity `/activity` | digests, conversations, episodes by day | t-2030 |
| Knowledge `/knowledge` (whole index each time) | pages, freshness, topics | t-2030 |
| People `/people`, person detail, their threads strip | contacts | t-2030 (threads strip: t-2027) |
| Projects index and hubs (feeds from every `sections.project` piece) | cards, waiting, changes, sections | t-2029 |
| Pieces `/pieces` (installed, catalog, install jobs) | piece catalog and jobs | t-2031 |
| Members `/members` | members, their agents | t-2031 |
| Profile `/account`: passkeys, sessions, push devices | device and session metadata | t-2031 (metadata only; credentials stay on the auth exchange) |
| Profile `me` (name, since, agents, states) | person and agent profile | t-2030 |
| Sheets: places, setup | nav and catalog re-projections | t-2031 |
| Sheets: appearance, accessibility | prefs | t-2031 |
| Find `/find` (asks, knowledge, people, memories) and launcher suggestions | search | t-2030 (its "Do" group reads t-2025) |
| Desk boot's `/find` call for the owner's name | one field already in Profile | t-2030 (reads the person record) |
| Comms list `/comms` (+ archived, background), dock count | threads, unread by thread | t-2027 |
| Comms thread `/comms/<t>`, `/since/<seq>`, `/before/<seq>`, thread SSE | messages, thread state, its asks | t-2027 (asks: t-2025) |
| `/comms/agents` (60 s poll) | unread replies per agent, first line | t-2027 |
| `/comms/<t>/work` (60 s poll), `/comms/<t>/refs` | the thread's tasks, PRs, notes; chips | t-2029 for tasks and PRs, joined by key in t-2027; chips become client joins over t-2025 / t-2027 / t-2029 / t-2030 records |
| `/comms/<t>/model` | the thread's harness choice | t-2028 |
| `/pieces.json` | every visible manifest | t-2031 (retired once nothing reads it) |
| `chrome.shell.asks`, per-agent asks | badges | t-2025 (aggregates) |
| `chrome.shell.agents[]` labels, marks, faces | agent profiles | t-2030 |
| `chrome.shell.agents[]` working, last active | agent status | t-2028 |
| `chrome.shell.core` Comms count | unread | t-2027 |
| `chrome` nav, places, tile stat, tone, alerts | catalog; tile readings | t-2031 (catalog), t-2028 (readings, Boxes alerts) |
| `chrome.shell.backup`, backup ask and FYI, setup row | backup status in four places | t-2031 (one health record; the ask is t-2025's) |
| `chrome.prefs`; `POST /appearance/prefs` | the member's prefs | t-2031 |
| `chrome.shell.permissions`, `chrome.shell.icons` | links, icon set version | t-2031 |
| `/events` bare `change` | invalidation | replaced by `rows` / `reset` frames (t-2022), plus `page` frames for piece-rendered pages; the bare `change` is retired in t-2032 |
| Page refetch timers (20 s / 60 s / a piece's `refresh`) | polling | retired per domain as it moves (t-2032); a piece's `refresh` becomes its provider's changes |
| Hover prefetch of any link | preload | t-2023 (preload a live query, never a URL that writes) |
| Service worker view cache (every JSON view, per session tag) | offline copies | not carried over: collection routes are POST and the worker never caches them; no shared record persists without a separate decision (above). The view cache goes with the views (t-2032) |
| Push watch (60 s), push display | notifications | t-2025 (notification metadata from the same attention records); delivery stays Web Push |
| Needs auto-resolve (60 s; reads approvals `state`, tasks `run show`) | cross-piece resolution | t-2025 (subscribes to the approval and task records it waits on) |
| Comms sweep, fold, audit sweep | retention jobs | t-2027, t-2030 (their deletes land in the change log) |
| Backup tick | health | t-2031 |
| Actions: `/act/<piece>`, `/a/<agent>/act/…`, `/act/loom` (household, pieces, account), Comms writes | mutations | t-2024 (receipts and changes); each in its domain |
| MCP-App widgets (`widgets/`: hello, display modes, top of mind, proposals) | probes, memory | exception: MCP transport, not the web app (top of mind and proposals read t-2030's records if ever bridged) |
| Static: fonts, icons, web manifest, `sw.js`, `/app/*`, sign-in scripts, SPA shell, redirects | assets | exception: static assets |
| Faces `/faces/…`, pixel icons | media | exception: raw media (their version pointers are fields of t-2030 / t-2031 records) |
| Sign-in, sign-in links, passkeys, logout, push key and subscription, CSRF, flash | auth | exception: auth and key exchange |
| Machine APIs (`/api/loom/deliver`, turns, audit, comms adapter, review, venues, people ensure, store, `/cli`, `/mcp`) | programs | exception: machine API; the records they write land in the change log (t-2027, t-2030) |
| Local: look and access settings, drafts, recent places, tile layout, back stacks, folds, boot flags, timers | per-window | exception: local state |

### Catalog pieces

| Piece | Flow (today) | Goes to | Needs first |
| --- | --- | --- | --- |
| runtime | boxes, houses, services, agent cards (state, doing, jobs, readings), models and accounts, login progress | t-2028 | change-log entries and nudges for box polls and login progress (today they send nothing) |
| runtime | asks from manifest | t-2025 | ids on asks |
| runtime | delivery, turns, relay, spawn, conversation control and origins | t-2027 | |
| runtime | grants, policy, gates, gate proposals, house config | t-2031 (gates as people: t-2030) | already in its piece store; needs a change log over it |
| runtime | box credentials, join codes, house claim tokens, model login links and codes, remote-control URLs, body proofs, sealed slots, review token | exception: secrets and credentials | |
| clock | wakes, schedules, lanes, next and last wake, jobs | t-2028 | **a stable job id** (wake ids churn); key by schedule, lane or place meanwhile |
| clock | deliveries on the `wake` venue | t-2027 | |
| clock | wake prompts, lane text, principal statements, raw log | exception: text the owner hasn't shared with every viewer; shown on the clock's own page only | those pages answered `no-store`, kept out of core's page cache and the service worker |
| approvals | pending and answered approvals, their states | t-2025 | ids on its manifest asks (they're only in `actions[].fields.id` today); deletes for records past its 300 kept |
| approvals | standing rules, grant metadata | t-2031 | per-member filtering of `for`, `people`, where |
| tasks | tasks, ready and blocked queues, details, comments | t-2029 | **a revision per task** (none today; its interactions log can seed one); paging instead of re-reading every task |
| tasks | project and thread section feeds | t-2029 | |
| tasks | backlog jobs on agent cards | t-2028 | |
| changes | pull requests, checks, merge state, rule verdicts | t-2029 (verdicts read approvals' rules: t-2031) | revisions from its snapshot's change detection |
| changes | GitHub tokens | exception: credentials | |
| secrets | requests (Allow, Always, Deny) | t-2025 | |
| secrets | secret names, policy, usage | t-2031 (household owners only) | |
| secrets | every value, `get`, `issue`, bundle | exception: secret values | |
| shuttle | route map (owner only), until it moves to the runtime | t-2031 | the rest of shuttle is superseded |
| discord, slack | `status` | t-2031 | |
| discord, slack | messages in and out | t-2027, through core's conversations (they deliver; they don't publish collections) | |
| discord, slack | bot, app and deliver tokens, signing secret, strangers' channel text read back | exception: credentials; text stays in its conversation's audience | |
| core and pieces | piece-to-piece reads through each other's CLI or API: changes → approvals rules and grants; runtime → approvals (spending) and the clock (labels); core → approvals state and tasks `run show` (needs auto-resolve); discord → shuttle route map; a local piece reading a channel through discord | exception: program reads between pieces under the grants authority, not app data for a window. Core's own server-side reads become subscriptions as the core viewer (below) in t-2025 | |

Pieces installed in one household but not in the catalog (local pieces) are surveyed per household, not here, and
fall under t-2031 unless their rows say otherwise. Every household runs its own survey before t-2031 closes.

### Before any domain moves

The contract can't be met by today's pieces without these, which the domain tasks own:

1. **Ids on attention items** (t-2025): asks, notices and answered rows in a manifest get a provider-stable `id`.
   Until then the Inbox's text hash can't be a record key.
2. **A stable clock job id** (t-2028).
3. **Revisions per record** for tasks (t-2029), the clock (t-2028), approvals (t-2025) and changes (t-2029); and a
   true change log over core's piece store (t-2022), since its revision table is pruned.
4. **A `changes` verb** for every provider (t-2022, t-2026): a commit-ordered log it can answer from, with
   lifetime-unique transaction ids; and the same for each of core's own stores.
5. **The owner scope in every cache key** that a provider's answer passes through (t-2021); `owners: 2` and an
   `agent` field declared by every piece whose records agent owners should see; `kept: false` on Comms words.

## What the tests must pin

The conformance suite (t-2026) runs against core's provider and every installed piece's, with fixtures:

- **Identity**: keys are stable across updates; a replacement provider for the same role serves the same keys;
  install refuses a taken provider name or role.
- **Bounds**: an undeclared filter, an operator not allowed, a page over `max_page`, more than 8 clauses, or a heavy
  field in a big list is refused as `bad-query`, before the provider runs; a query over its byte share answers
  `too-big` alone.
- **Hidden fields**: a `where`, `order` or `aggregates.by` on a field the viewer can't see is refused; a search whose
  only match is in a field the viewer can't see returns nothing; a sealed cursor replayed by another viewer or for
  another query is refused.
- **Viewer authority**: for a household owner, an owner of some agents, two members sharing an agent, an agent
  token, a task house's token and a service house's token, each query, search result and change reaches exactly the
  records and fields that the provider, the audience, the agent rule and the classes allow; a withheld field is
  absent and listed in `withheld`; a provider that ignores the viewer leaks no rows and is taken out of contract (core's own checks); a record
  with no agent never reaches an agent owner; a provider without `owners: 2` answers only household owners; a
  member's Comms thread never reaches another owner of the same agent, and stops reaching its member the moment
  they stop owning its agent; `audience` is never sent to anyone but household owners.
- **Counts**: without `scoped_counts`, no viewer but a household owner gets a provider's total or aggregate; with it,
  an agent owner's counts exclude other agents' records, and a member's exclude others' threads; over a complete
  subscription, an agent owner's badge counts exactly their own.
- **Search**: without `scoped_search`, no viewer but a household owner gets a provider's search results; with it, a
  match only in a field the viewer can't see returns nothing.
- **Own records**: an owner of some agents reads their own read markers, prefs and sessions, and no one else's.
- **No leaks by key or number**: a viewer outside a record's audience never receives its key, including when its
  audience narrows or core has no index row for it; no answer or frame carries a provider revision, an epoch or a
  transaction id.
- **Consumer capability**: an agent token or a house token asking for an ungranted type gets `denied` and the
  provider never runs; a type without `houses: true` is denied to every house token, and one without
  `services: true` to every service house's token; a grant revoked mid-subscription resets it; a widget in a
  sandboxed frame reaches only its granted types through its port.
- **Revocation**: sign-out, session revocation on another listener, an agent owner's agents narrowed, and a stream
  opened after revocation all close, reset or refuse; an answer from an older scope epoch is dropped by the client.
- **Pull**: a change committed by a process that dies before nudging still arrives within one pull period; two
  writers committing out of order are delivered in commit order; a forged nudge causes at most one pull and no
  change, and answers the same for a domain that doesn't exist; a store restored to an earlier copy and then
  written past core's cursor is caught on the next pull (its `txn` at the cursor differs), and every subscription in
  the domain resets; no two changes share a `txn`; two listeners pulling at once mint one epoch.
- **Handover**: a provider's rows and the `{rev, txn}` it answers come from one consistent read; an answer read from
  a restored store's new history resets the domain instead of being stamped with the old epoch; a change committed
  between the query and its answer is delivered exactly once; a frame that arrives
  before its answer is held, then applied; a row deleted between page 1 and page 2 of one subscription never stays
  as a ghost.
- **Windows and membership**: a record that leaves a filter, or moves past the boundary, gets a leave for that
  subscription and the aggregate moves in the same frame; one that enters arrives whole; a record that leaves one
  subscription and enters another in the same frame stays in the client; a window over 1000 records trims its tail
  and says it's partial.
- **Transactions**: a transaction's changes and the aggregates they move arrive in one frame.
- **Gaps and epochs**: past the log, `reset: gap`; a reconnect is a fresh snapshot; a replaced or restored provider
  gets a new epoch and every subscription in its domains resets.
- **Expiry**: an expired record leaves lists and aggregates together, with no provider run; a renewal after the
  expiry delete is logged brings it back.
- **Invalidate bridge**: one viewer losing access to a record in an invalidated domain never removes it for another;
  a record pushed off a limited page is a leave for that subscription, not a delete.
- **Expiry rows**: an expiry delete and a provider's next change never collide in the log.
- **Comms words**: no message text is found in the change log, the index or any held change, and none survives in
  memory past the request that read it.
- **Provider failure**: one provider timing out leaves other queries in the batch answered, and its own views marked
  unavailable and stale, not empty.
- **Versions**: a consumer asking for an unserved major gets `unsupported-version`; a minor addition doesn't break an
  older consumer.
- **No secrets**: a scan of every type's declared field names and every fixture record's values finds nothing
  shaped like a credential.

## Owner decisions

The owner accepted the contract as written (2026-11-09), so each question's leaning is now the decision.

1. **One stream or two?** This keeps today's single `/events` stream and adds `hello`, `rows`, `reset` and `page`
   frames to it. The alternative is a second stream just for collections. One stream means fewer connections (six
   a session is the cap) and one story for gaps. Decided: one.
2. **A memory proposal: one item per agent, or one per proposal?** The Inbox shows one item per agent with
   proposals; the per-agent badge and Today count each proposal. One record type can't be both. Decided: one record
   per proposal, with the Inbox grouping them per agent, so every count agrees.
3. **Comms unread: threads or messages?** The dock counts unread threads and the agent card counts unread messages.
   Both can come from the same read-state records, but they'll still show different numbers side by side. Decided:
   threads everywhere, with the message count shown only inside a thread.
4. **Third-party widgets**: should loom allow piece widgets that aren't first-party before the sandboxed frame
   exists? Decided: no (code isolation, above).
