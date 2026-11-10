# Collections: one shared, permissioned path for app data

*2026-11-09. Status: **draft, for the owner's review** (t-2020, epic t-2019). Nothing here is built. A design doc in
the `docs/specs/` sense: it says what will be built and what each implementation's tests must pin. It defines the
contract that the epic's implementation tasks (t-2021 to t-2032) build to, and it inventories every app data flow
loom has today with the task that moves it, or the reason it stays where it is. One cold review round is folded in
(changes are pulled, not pushed; owner and grants gates kept; hidden fields can't be queried on).*

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
- **Domain**: what a revision counts over: one record type, or all of a provider's types (`<provider>/*`).
- **Revision**: `(epoch, rev)`. `rev` is a provider's monotonic counter for one domain; `epoch` is minted by the
  provider at install, replacement and restore, so a new implementation or a rolled-back store never collides with
  an old counter.
- **Viewer**: who is looking: a member's session (a household owner, or an owner of some agents), an agent's
  token, or a house's token. Viewer authority decides which records and fields exist for them.
- **Consumer**: the code asking on the viewer's behalf: a core window, a piece's widget, a piece's own page. Its
  capability (granted or not) decides which record types it may ask for at all.
- **Query**: a bounded request for records of one type: filter, order, page, fields.
- **Coverage**: what a query's answer says about completeness: complete, or partial with a total that is exact, a
  lower bound, or unknown.
- **Change**: an upsert or a delete of one record at one revision.
- **Subscription**: a live query: its snapshot, then its changes, on one stream.

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
  domain moves"). An id may come back after a delete: the new record has a higher revision, which is what keeps a
  late copy of the old one from winning.
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
  "owners": 2,                                                     // agent owners may see its records (owners.md)
  "collections": {
    "query":   ["loom-tasks", "collections", "query", "--json"],   // one viewer, a batch of queries, on stdin
    "changes": ["loom-tasks", "collections", "changes", "--json"], // domains and their last revisions, on stdin
    "search":  ["loom-tasks", "collections", "search", "--json"],  // optional
    "types": {
      "task": {
        "version": "1.2",
        "schema": { /* JSON schema of one record, at most 16 KB */ },
        "fields": {
          "title":       { "class": "member" },
          "status":      { "class": "member", "filter": ["eq", "in"], "order": true },
          "priority":    { "class": "member", "filter": ["eq", "in", "lte"], "order": true },
          "updated":     { "class": "member", "order": true },
          "assignee":    { "class": "member", "filter": ["eq", "has"] },
          "description": { "class": "member", "heavy": true }
        },
        "default_fields": ["title", "status", "priority", "updated"],
        "max_page": 200,
        "aggregates": { "count": { "by": ["status"] } },
        "domain": "type",               // or "provider": one counter for all its types, named tasks/*
        "audience": "rows",             // or "ask" (below)
        "houses": false                 // house tokens never see this type (below)
      }
    }
  }
}
```

- **`query`**: an argv run through the manifest's runner. It gets **one viewer** and up to 32 queries for that
  viewer on stdin, so a window opening ten views costs one subprocess per provider, not ten. A batch never mixes
  viewers.
- **`changes`**: an argv that gets `{domain: {epoch, rev}}` and answers what changed in each domain after that
  revision, in commit order (the next section).
- **`search`**: optional. It gets one viewer and a query text, and answers references and snippets (below).
- **Their limits are their own** (`OFFER_LIMITS`): 15 s, 1 MB an answer, and a pool apart from the page's pieces
  (four running, sixteen waiting per provider), so live data can't starve page loads or the other way round.
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
- **`aggregates`**: the counts the provider computes authoritatively (below). A consumer never derives a total by
  counting rows it happens to hold.
- **`owners: 2`** is the gate [owners.md](owners.md) already has: **a provider without it answers only household
  owners**, and core refuses any other viewer's query before running it.
- Validation at install refuses: unknown keys, a type or field name out of grammar, a schema over 16 KB, a
  `max_page` over 500, an aggregate or filter over an undeclared field, and a provider name or role already taken.

Core declares its own types (thread, message, memory, knowledge page, person, project, agent, …) in code, through
the same structures, and serves them in-process. **Core's types obey the same contract and the same tests as a
piece's.** Core gets no shortcut that a piece can't have.

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
  a field the viewer's class can't see, before the provider runs, and the provider refuses the same for `member`
  fields it hides by record. Otherwise a viewer could learn a hidden value from which rows come back, character by
  character with `prefix`, or from the order.
- **Pages are keyset pages**: `after` is an opaque cursor. Core seals every cursor (a MAC over the provider's cursor,
  the viewer, the scope and the query), so a cursor can't be read, edited or reused by another viewer or query.
- **Fields**: an answer carries the record key, its revision, its audience, and only the fields named (or the
  type's `default_fields`), further cut down to what the viewer's class allows. A field the viewer may not see is
  **absent**, not null, and the answer lists which named fields were withheld, so a window shows "hidden", not
  "empty".
- **Joins are client-side**: a field holding another record's key is resolved by a second query on that type
  (batched with the first). This keeps each provider ignorant of every other.

The answer, per query:

```jsonc
{
  "id": "q1",
  "rows": [ { "key": "tasks/task/t-2020", "rev": 8812, "audience": { … }, "title": "…", "status": "in_progress" } ],
  "next": "sealed-cursor",                      // or null at the end
  "coverage": { "complete": false, "total": { "n": 214, "exact": true } },
  "aggregates": { "count": { "n": 214, "exact": true, "by": { "open": 190, "in_progress": 24 } } },
  "withheld": ["assignee"],
  "asOf": { "domain": "tasks/task", "epoch": "e7f2", "rev": 8812 },
  "scope": 41                                   // the viewer's scope epoch (below)
}
```

- **`coverage.total`** is `{n, exact: true}` (the provider counted), `{n, exact: false}` (at least n), or absent
  (unknown). The UI shows "20 of 214", "20 of 1000+", or "20", accordingly. A badge reads an **aggregate**, never
  `rows.length`.
- **Aggregates are computed under the same viewer authority as the rows**: a count never includes a record the
  viewer couldn't fetch.
- **`asOf`** is the revision the snapshot reflects: the handover point to its changes.
- **Errors are per query**: `unsupported-version`, `bad-query` (with which clause), `denied` (the viewer or the
  consumer may not read this type), `unavailable` (the provider timed out or failed). One provider's failure never
  fails another's query in the same batch. A window shows that provider's data as unavailable, keeping what it
  already held, marked stale.

## Who may see what: three separate questions

The bench showed that a cache library's isolation is not loom's permission model. This contract keeps three
questions apart, and gives each its own enforcement point:

1. **Viewer authority: may this viewer see this record, and these fields?**
   - **The provider decides first**, for every query and every change, from the viewer core hands it: the member
     (and whether they're a household owner, and which agents they own), or the agent, house and service of a
     token, plus the scope core already computes for pages (`LOOM_SCOPE`, `LOOM_OWNER_SCOPE`, [owners.md](owners.md)).
   - **Core checks again, on everything that passes it**: it drops every row in an answer and every change whose
     `audience` doesn't admit the viewer, and every field above the viewer's class. Today core's own owner filter
     (`forOwner`) is the real boundary, and it stays one: a provider that ignores who's asking leaks nothing.
   - **A provider without `owners: 2` answers household owners only**, as above.
2. **Consumer capability: may this code ask for this type at all?** Decided by core, before the provider runs.
   - Core's own windows may read any type.
   - A piece's widget or page may read its own provider's types, plus the types the grants authority allows it
     (path `collections/<provider>/<type>`, through the existing `grants` offer: t-1746 is the single grants list,
     and this adds paths to it, not a second authority). Being installed is not a grant. A namespace is not a
     permission.
   - **An agent or house token asks the grants authority too**, with `{agent, house, service}` and the same path,
     and fails closed exactly like `/api/<piece>/…` today. A house's own token never reads a type that doesn't
     declare `houses: true`, whatever the grants say: a service house that strangers can steer must not see the
     household's asks because its agent may.
   - Piece, peer, review and runtime tokens are refused on the query route: they're programs with their own seams.
3. **Code isolation: can this code reach what it wasn't granted?** Same-origin JavaScript shares the page's memory,
   cookies and cache, so **a widget running in the page has every capability the page has**, whatever the
   collection API says. Today's widgets are first-party and run in the page; that's acceptable only because they're
   reviewed code. A piece widget that isn't first-party must run in a sandboxed frame (opaque origin, no cookies),
   talking to the page over a message port that serves only its granted types. The collection runtime (t-2023) must
   not be reachable from a sandboxed frame except through that port. Until that frame exists, only first-party
   pieces may ship widgets (t-2026).

### Audience

Every record carries an `audience`, set by its provider. Its terms are a **union**: a viewer any term admits is in.

```jsonc
{ "household": true }                    // every household member
{ "owners": true }                       // household owners
{ "ownersOf": ["art"] }                  // members who own agent art (and household owners)
{ "members": ["jonathan-barket"] }       // these members only, whatever agents they own
{ "agents": ["art"] }                    // agent art's own tokens; its houses only where the type says houses: true
```

- Household owners are admitted by every term but `members`. A Comms thread uses `members` alone, so another owner
  of the same agent never sees a member's private thread (comms.md).
- **Core keeps each key's last audience** in its change log. When a record's audience narrows, core works out who
  was dropped and sends them a delete; it doesn't rely on the provider remembering the old audience. A delete is
  routed by the last audience core holds.
- A provider whose visibility can't be expressed as an audience (per-field rules, say) declares
  `"audience": "ask"` for the type. Core then re-runs each subscription's query when the domain changes (batched,
  at most once per 1.5 s, in the provider's own pool, and at most 16 subscriptions per domain per round, the rest
  reset) rather than routing by audience. Slower, never wrong.

### The viewer is checked on every frame

- Core resolves a stream's viewer again before every frame it sends, the way the Comms thread stream already
  re-checks its member (`may()`, comms-live.ts): the session still live, the member's agents unchanged, the token not
  revoked. Every listener learns of a change to the household file, sessions or tokens from a tick file, as Comms
  does, so a session revoked on one listener ends on all of them.
- Each viewer has a **scope epoch** that changes when anything their authority rests on changes: membership, agents
  owned, a session, a grant. Every answer and frame carries it. On a change, core closes the viewer's affected
  subscriptions with `reset: scope`, and the client drops those collections and any answer still in flight from the
  older epoch.
- **Grants change in the grants authority**, which is a piece: it publishes them as a collection
  (`runtime/grant`, t-1746), and core subscribes to it as the core viewer (below) to bump scope epochs and re-check
  consumers.
- Sign-out or revocation closes the session's streams and drops its subscriptions at once. The client runtime clears
  every record that came through that session from memory (t-2023). A stream opened after a revocation is refused
  (the bench's revoke-before-open case is a regression test).
- Nothing in a shared collection persists to disk in the browser (no IndexedDB, no service-worker cache) until a
  separate decision says which types may, and how they're cleared.

### Core as a viewer

Core does work with no window open: the push watch, Needs auto-resolve, applying an owner's Allow. For that it reads
as the **core viewer**, which sees what a household owner sees, and is never handed to a window. Whatever it
produces for a person is filtered for that person again: a push goes to the ask's owners only (owners.md), through
the same audience check.

## Changes: from provider to window

### Core pulls; anyone may nudge

A provider never pushes records to core. Core **pulls** them with the provider's `changes` verb:

```jsonc
// stdin
{ "tasks/task": { "epoch": "e7f2", "rev": 8812 } }
// stdout
{ "tasks/task": { "epoch": "e7f2", "changes": [
    { "op": "upsert", "id": "t-2020", "rev": 8813, "txn": "x91", "audience": { … }, "record": { /* whole, non-heavy */ } },
    { "op": "delete", "id": "t-1999", "rev": 8814, "txn": "x91" }
  ], "more": false } }
```

- **The provider answers from a commit-ordered log**: every change it has committed after that revision, in order,
  up to 1000 a call (`more: true` asks core to call again). Two writers racing can't reorder it, because the log's
  order is the commit order. A crash between a write and a nudge loses nothing, because the next pull still finds
  it.
- **A change carries the whole record** (every non-heavy field) and its audience, so core can trim it for each
  subscriber and work out filter membership without asking again. Heavy fields are re-read only when a subscription
  asked for them.
- **A transaction is never split**: an answer ends on a transaction boundary, and core delivers one transaction to a
  subscriber in one frame, with the aggregates that go with it.
- **Too old**: a revision older than the provider's log answers `{"reset": true}` for that domain. A new epoch (a
  replaced implementation, a restored store) answers with the new epoch and no changes. Either way core resets the
  domain's subscriptions.
- **No change log yet**: a provider that can't say what changed answers `{"invalidate": true}`. Core then re-runs
  the domain's open subscriptions' queries (batched, at most once per 1.5 s, the existing `GAP_MS`), diffs the
  answers, and numbers the differences with its own sequence for that domain. That's the bridge for sources not yet
  migrated (t-2022), and the inventory lists which ones it carries.
- **When core pulls**: whenever it's nudged, and every 15 s for every domain that has an open subscription (this
  replaces today's 15 s manifest round). A nudge is `POST /api/loom/collections/nudge {"domain": …}` with any token
  core accepts on `/api`, or `loom collections nudge <domain>` on loom's machine (it touches a tick file every
  listener watches, as Comms does). **A nudge carries nothing but a domain name**: a forged one costs one pull. So a
  piece's CLI run directly by an agent, which has no token of its own, can still say it wrote.
- **Expiry**: a record with a natural end (an ask that expires, a reading's `observedAt` plus its lifetime) carries
  `expires`. Core writes its delete into the log at that time itself, so aggregates and lists drop it together
  whether or not the provider is ever run again.
- Core posts its own changes into the same log, in-process.

### Core's change log

- loom runs several HTTP listeners (LAN, tailnet, localhost) over one `$LOOM_HOME`. So the log is **a table in
  `household.db`**: domain, epoch, revision, transaction, key, audience, the trimmed record, time. Whichever listener
  pulls writes it once; every listener reads it.
- It keeps each domain's last 1000 changes or 10 minutes, whichever is more, and never more than 5000. A window
  further behind gets `reset: gap`.

### Core to window

A window opens its one stream (`GET /events`, today's), which first sends its id:

```
event: hello
data: { "stream": "e-…", "scope": 41 }
```

Queries name that stream, and their changes come on it:

```jsonc
event: rows
data: { "sub": "q1", "scope": 41, "domain": "tasks/task", "epoch": "e7f2", "from": 8812, "to": 8814,
        "upserts": [ { "key": "tasks/task/t-2020", "rev": 8813, "status": "closed", "title": "…" } ],
        "deletes": [ { "key": "tasks/task/t-1999", "rev": 8814 } ],
        "aggregates": { "count": { "n": 213, "exact": true, "by": { … } } } }

event: reset
data: { "sub": "q1", "reason": "gap" | "scope" | "provider-gone" | "epoch" | "version" }

event: page
data: { "piece": "clock" }
```

- **Subscriptions belong to a stream.** The client names them (`id`), and a stream holds at most 64. The stream
  check is the one `/act` has: same origin (`Sec-Fetch-Site` or `Origin`), plus the session, so a page on another
  port of the same host can't open streams in a member's name and push out their real ones.
- **Handover without a gap**: a subscription starts at its snapshot's `asOf`. Core sends the log's changes above it
  as soon as the answer has gone, and drops any at or below it. A frame never reaches a client before its answer,
  because both are sent by the same listener in order.
- **Reconnecting**: listeners keep subscriptions in memory, so a client that reconnects (to the same listener or
  another) sends its queries again, each with the revision it last held. Inside the log it gets what it missed; past
  it, `reset: gap`. An unknown subscription is `reset`.
- **Upserts are trimmed** to the subscription's `fields`, the viewer's class and its audience, like an answer. A
  record that enters a subscription arrives whole (as far as the subscription asked for it), never as a partial
  row.
- **Which changes reach a subscription** is defined by its **window**: the records matching its `where` that sort no
  later than the last row it has loaded (all of them, once it has loaded the last page). A changed record that
  enters the window is an upsert; one that leaves it (no longer matches, or now sorts past the last loaded row) is a
  delete; one outside the window sends nothing but its aggregate. Changes carry the whole record, so core always has
  the fields to decide.
- **Aggregates are kept per subscription by core**, not posted by providers: core adds and subtracts as records enter
  and leave the subscription's `where` for its viewer, and asks the provider again when it can't (an `ask` type, an
  invalidated domain, a total that wasn't exact).
- **Ordering**: within a domain, frames go out in revision order. Across domains there is no global order, and none
  is promised. A view joining two domains shows each at its own revision.
- **Duplicates and old revisions are ignored** by the client: a record's `(epoch, rev)` only moves forward, and a
  new epoch arrives only after a reset.
- **Back-pressure**: a window more than 256 frames behind is sent `reset: gap` for its biggest subscriptions
  instead of more frames.
- **Provider removed or replaced**: `reset: provider-gone` (removed) or `reset: epoch` (replaced or restored) for
  its domains. A replacement under the same role whose types satisfy the subscriptions' version ranges answers the
  next snapshot; otherwise the views show the provider as missing (a missing piece is a feature that isn't there,
  extensions.md rule 3).
- **Piece pages stay piece-rendered**, as blocks. They aren't records, so a `page` frame tells a viewer's windows
  that a piece's pages moved (today's manifest fingerprint, now per piece and per viewer). Only the page-wide bare
  `change` is retired (t-2032).

## Commands (shared with t-2024)

Actions keep their own routes, CSRF checks, principals, grants and approval semantics. What changes is what they
answer: alongside today's result, an action answers an operation receipt (`accepted`, `done`, `failed`, with why)
and the revision its effect landed at, if the provider has one. Its changes go into the log like any other and reach
every window, the acting one included, through the stream, trimmed as usual and in revision order. So no window
refetches after its own action, and none gets a record its viewer couldn't read. A window may show its own action as
pending, but never shows a grant or an approval as done until the receipt says so. t-2024 owns the details.

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
- **Core asks each provider's `search` verb** as that viewer (core can't index a piece's store), plus its own, and
  merges by score. A provider without `search` isn't searched.
- **Snippets come only from fields the viewer may see**, and the result is checked against the target's audience
  like any row. Launcher suggestions work the same way.

## The client runtime, in one paragraph (t-2023 builds it)

The client keeps one registry per signed-in session, keyed by viewer, scope epoch and `type@major`. It holds one
collection per record type the open windows read, one in-flight request per identical query, and one subscription
per live query, shared by every window. Windows bind derived views (filters, sorts, joins by key) to it and keep their
own presentation state. A collection nobody has read for 5 minutes is dropped, and any memory cap drops the least
recently read first. Sign-out, a scope change or a provider's removal clears what it affected, along with the
listeners. The adapter is the only code that imports the client library.

## What stays on its own transport (exceptions)

Each needs its own rationale, and safe status and metadata about them still go through collections:

| Kind | Why it keeps its own path | What still goes through collections |
| --- | --- | --- |
| Static assets, the app bundle, icons, fonts | Cached by the browser by URL and content hash; not records | — |
| Raw files and media (attachments, images, audio, exports, bundle downloads) | Bytes, often large, range-requested; the 256 KB record cap | The file's record: name, size, type, owner, link |
| Sign-in, passkey challenges, session cookies, token links | Single-use, never cached, security-sensitive | Session list metadata (device, last seen), without tokens |
| Secret values (loom-secrets), model-account credentials | Must never enter a browser cache or a shared record | Secret names, requests and their states; account status and usage, without credentials |
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
| Comms sweep, fold, audit sweep | retention jobs | t-2027, t-2030 (they post deletes) |
| Backup tick | health | t-2031 |
| Actions: `/act/<piece>`, `/a/<agent>/act/…`, `/act/loom` (household, pieces, account), Comms writes | mutations | t-2024 (receipts and changes); each in its domain |
| MCP-App widgets (`widgets/`: hello, display modes, top of mind, proposals) | probes, memory | exception: MCP transport, not the web app (top of mind and proposals read t-2030's records if ever bridged) |
| Static: fonts, icons, web manifest, `sw.js`, `/app/*`, sign-in scripts, SPA shell, redirects | assets | exception: static assets |
| Faces `/faces/…`, pixel icons | media | exception: raw media (their version pointers are fields of t-2030 / t-2031 records) |
| Sign-in, sign-in links, passkeys, logout, push key and subscription, CSRF, flash | auth | exception: auth and key exchange |
| Machine APIs (`/api/loom/deliver`, turns, audit, comms adapter, review, venues, people ensure, store, `/cli`, `/mcp`) | programs | exception: machine API; the records they write post changes (t-2027, t-2030) |
| Local: look and access settings, drafts, recent places, tile layout, back stacks, folds, boot flags, timers | per-window | exception: local state |

### Catalog pieces

| Piece | Flow (today) | Goes to | Needs first |
| --- | --- | --- | --- |
| runtime | boxes, houses, services, agent cards (state, doing, jobs, readings), models and accounts, login progress | t-2028 | its own change posts for box polls and login progress (today they send nothing) |
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
4. **A `changes` verb and an epoch** for every provider (t-2022, t-2026): an ordered log it can answer from, and an
   epoch it mints at install, replace and restore.
5. **The owner scope in every cache key** that a provider's answer passes through (t-2021), and `owners: 2` declared
   by every piece whose records agent owners should see.

## What the tests must pin

The conformance suite (t-2026) runs against core's provider and every installed piece's, with fixtures:

- **Identity**: keys are stable across updates; a re-created id carries a higher revision than its delete; a
  replacement provider for the same role serves the same keys; install refuses a taken provider name or role.
- **Bounds**: an undeclared filter, an operator not allowed, a page over `max_page`, more than 8 clauses, or a heavy
  field in a big list is refused as `bad-query`, before the provider runs.
- **Hidden fields**: a `where`, `order` or `aggregates.by` on a field the viewer can't see is refused; a sealed
  cursor replayed by another viewer or for another query is refused.
- **Viewer authority**: for a household owner, an owner of some agents, two members sharing an agent, an agent
  token and a house token, each query, aggregate, search result and change reaches exactly the records and fields
  their audience and classes allow; a withheld field is absent and listed in `withheld`; a provider that ignores the
  viewer leaks nothing (core's own check); a provider without `owners: 2` answers only household owners; a member's
  Comms thread never reaches another owner of the same agent.
- **Consumer capability**: a piece widget, an agent token or a house token asking for an ungranted type gets
  `denied` and the provider never runs; a type without `houses: true` is denied to every house token; a grant revoked
  mid-subscription resets it.
- **Revocation**: sign-out, session revocation on another listener, an agent owner's agents narrowed, and a stream
  opened after revocation all close, reset or refuse; an answer from an older scope epoch is dropped by the client.
- **Pull**: a change committed by a process that dies before nudging still arrives within one pull period; two
  writers committing out of order are delivered in commit order; a forged nudge causes one pull and no change.
- **Handover**: a change committed between the query and its answer is delivered exactly once; a snapshot older than
  a delivered change never overwrites it.
- **Windows and membership**: an update that moves a record out of a filter, or past the last loaded row, deletes
  it from that subscription and updates the aggregate in the same frame; one that enters arrives whole.
- **Transactions**: a transaction's changes and the aggregates they move arrive in one frame.
- **Gaps and epochs**: reconnect inside the log replays what was missed; outside it, `reset: gap`; a replaced or
  restored provider answers a new epoch and every subscription resets.
- **Expiry**: an expired record leaves lists and aggregates together, with no provider run.
- **Provider failure**: one provider timing out leaves other queries in the batch answered, and its own views marked
  unavailable and stale, not empty.
- **Versions**: a consumer asking for an unserved major gets `unsupported-version`; a minor addition doesn't break an
  older consumer.
- **No secrets**: a scan of every type's declared field names and every fixture record's values finds nothing
  shaped like a credential.

## Open questions for the owner

1. **One stream or two?** This keeps today's single `/events` stream and adds `hello`, `rows`, `reset` and `page`
   frames to it. The alternative is a second stream just for collections. One stream means fewer connections (six
   a session is the cap) and one story for gaps. Leaning one.
2. **A memory proposal: one item per agent, or one per proposal?** The Inbox shows one item per agent with
   proposals; the per-agent badge and Today count each proposal. One record type can't be both. Leaning one record
   per proposal, with the Inbox grouping them per agent, so every count agrees.
3. **Comms unread: threads or messages?** The dock counts unread threads and the agent card counts unread messages.
   Both can come from the same read-state records, but they'll still show different numbers side by side. Leaning
   threads everywhere, with the message count shown only inside a thread.
4. **Third-party widgets**: should loom allow piece widgets that aren't first-party before the sandboxed frame
   exists? Leaning no (code isolation, above).
