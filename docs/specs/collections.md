# Collections: one shared, permissioned path for app data

*2026-11-09. Status: **draft, for the owner's review** (t-2020, epic t-2019). Nothing here is built. A design doc in
the `docs/specs/` sense: it says what will be built and what each implementation's tests must pin. It defines the
contract that the epic's implementation tasks (t-2021 to t-2032) build to, and it inventories every app data flow
loom has today with the task that moves it, or the reason it stays where it is.*

## Why

> "all data should go out this way that can." — the owner, 2026-11-09 (conversation cv-3bf9030e8e0b)

Every window asks for its own page and recounts what it shows. One changed ask made Home, Inbox and Comms each
fetch a fresh page (3.8 KB, 5.4 KB and 67 B in the measured run). The badge, the Needs-you band and the Inbox list
each count the same asks their own way. The live stream says only `change`, so every open app asks again for
everything it shows (src/ui/live.ts). Pieces are polled every 15 s while an app is open, in case their manifest
moved.

The measured comparison (note:research/2026-11-09-desktop-data-decision) settled the client side: **TanStack DB
collections**, pinned to the tested versions, behind a loom adapter. That isn't reopened here. What it didn't settle,
and this spec does, is the **contract**: how records are named, who may see them, how they're asked for, how
changes reach a window, and how pieces with their own stores take part without core reading those stores.

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
- **Record type**: one kind of record a provider publishes (`task`, `ask`, `thread`, `message`), with a versioned
  schema.
- **Record key**: a record's stable name, `<provider>/<type>/<id>` (below).
- **Viewer**: who is looking: a signed-in member's session, an agent's token, or a house's token. Viewer authority
  decides which records exist for them.
- **Consumer**: the code asking on the viewer's behalf: a core window, a piece's widget, a piece's own page. Its
  capability (granted or not) decides which record types it may ask for at all.
- **Query**: a bounded request for records of one type: filter, order, page, fields.
- **Coverage**: what a query's answer says about completeness: complete, or partial with a total that is exact, a
  lower bound, or unknown.
- **Revision**: a provider's monotonic counter for one **revision domain** (usually one record type). Every record
  carries the revision it was last changed at.
- **Change**: an upsert or a delete of one record at one revision, delivered on the window's stream.
- **Tombstone**: a delete, kept for a while so a window that was away learns of it.
- **Subscription**: a live query: its snapshot, then its changes.

## Identities

### Record keys

```
<provider>/<type>/<id>
loom/thread/cv-80d1a580c2b3
tasks/task/t-2020
approvals/approval/a-7693c00e
runtime/job/<job id>
```

- **`<provider>` is the role, not the package**, for a piece with a role contract (`tasks`, not `taskstore`;
  `runtime`, not `loom-box`). Swapping taskstore for another tasks implementation keeps every key. A piece with no
  role uses its installed name. Core is `loom`. Names follow the existing piece-name rules.
- **`<type>`** is `[a-z][a-z0-9-]{0,31}`, declared by the provider.
- **`<id>` is the provider's own stable id**, opaque to core and the client: `t-2020`, `a-7693c00e`,
  `cv-…`. It must not change when the record changes, must not be reused after a delete within the tombstone
  window, and must not contain `/`. A provider whose source has no stable id (a computed row) must make one that is
  stable for the same underlying thing (a hash of its natural key), never a list position.
- **One record, one key.** The same ask shown on Home, in Inbox, on an agent card and in a thread is one record,
  `approvals/approval/a-…`, read once and shared by every window. Views that need a different shape use a
  projection or a derived selector, not a copy under another key.
- **Cross-record references** are record keys in fields (`"thread": "loom/thread/cv-…"`). The client resolves them
  only if it subscribes to that type; a reference to a record the viewer can't see stays an unresolved key and is
  never an error.

### Versions

- Each record type has a **schema version** `major.minor`. A minor version only adds optional fields. A major
  version is a new type for compatibility purposes: a provider may serve `task@1` and `task@2` side by side while
  consumers move, and drops the old major only when no installed consumer declares it.
- A consumer declares the range it reads (`tasks/task@^1`). A query for a major the provider doesn't serve answers
  `unsupported-version`, never a reshaped record.
- A field a consumer doesn't know is ignored. A field missing from a record means **unknown, not empty, and never
  deleted** (a projection that left it out, or a provider that doesn't fill it).

## Declaring a provider: the `collections` offer

A managed piece declares what it publishes as a sixth offer key in its package's `loom` block, validated at install
like the other five ([extensions.md](../extensions.md), "Offers"):

```jsonc
"loom": {
  "role": "tasks",
  "collections": {
    "query":  ["loom-tasks", "collections", "query", "--json"],   // a batch of queries on stdin
    "types": {
      "task": {
        "version": "1.2",
        "schema": { /* JSON schema of one record, at most 16 KB */ },
        "fields": {
          "title":    { "class": "member" },
          "status":   { "class": "member", "filter": ["eq", "in"], "order": true },
          "priority": { "class": "member", "filter": ["eq", "in", "lte"], "order": true },
          "updated":  { "class": "member", "order": true },
          "description": { "class": "member", "heavy": true }
        },
        "default_fields": ["title", "status", "priority", "updated"],
        "max_page": 200,
        "aggregates": { "count": { "by": ["status"] } },
        "revisions": "type"              // or "provider": one counter for all its types
      }
    }
  }
}
```

- **`query`** is an argv like every other offer's: run through the manifest's runner, `argv[0]` one of the
  package's `bin` names. It takes a **batch** on stdin: up to 32 queries, each with its viewer context, so that one
  window opening ten views costs one subprocess per provider, not ten (offers run as subprocesses with a 3 s budget
  and six at once: per-field or per-row calls would be unaffordable).
- **`fields`** lists every field the type has, with:
  - **`class`**: who may ever be sent it. `household` (any signed-in viewer of the household), `member` (viewers the
    record's audience allows), `owner` (household owners only). **There is no class for secret values**: a token,
    a key or a password is not a field of any record. A provider that has one keeps it behind its own dedicated
    exchange (exceptions, below).
  - **`filter`**: the operators allowed on it (`eq`, `in`, `prefix`, `lt`/`lte`/`gt`/`gte`, `has`). A field without
    `filter` can't be filtered on.
  - **`order`**: whether it can sort a query. Order always ends with the record id, so pages are stable.
  - **`heavy`**: a large field (a body, a transcript, a description) left out of lists unless asked for by name, and
    only for a page of at most `max_page / 10` records.
- **`aggregates`**: the counts the provider computes authoritatively (below). A consumer never derives a total by
  counting rows it happens to hold.
- Validation at install refuses: unknown keys, a type or field name out of grammar, a schema over 16 KB, a
  `max_page` over 500, an aggregate over an undeclared field, a role's type that another installed piece also
  declares under the same provider name.

Core declares its own types (thread, message, memory, knowledge page, person, project, agent, …) in code, through
the same structures, and serves them in-process. **Core's types obey the same contract and the same tests as a
piece's.** Core gets no shortcut that a piece can't have.

## Asking: queries

A query, as a window sends it to core (`POST /collections/query`, a batch of up to 32). It's a UI route like every
other the browser uses: same-origin and CSRF-checked like `/act`, because browsers can never reach `/api/*`
(http-server.ts refuses any `/api` request with an `Origin` header). Agents and houses reach the same queries at
`POST /api/loom/collections/query` with their bearer token, as a viewer of their own kind:

```jsonc
{
  "id": "q1",                                   // the client's, echoed back
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

- **Bounded by construction**: only declared filter operators on declared fields, at most 8 `where` clauses, an
  `in` list of at most 100, `limit` at most the type's `max_page`. No free-form expressions, no joins, no
  provider-side search language. (Search is its own type whose query is the search text, below.)
- **Pages are keyset pages**: `after` is an opaque cursor the provider made from the last row's order values and id.
  Offset paging is not offered.
- **Fields**: the answer carries the record key, its revision, and only the fields named (or the type's
  `default_fields`), further cut down to what the viewer's class allows. A field the viewer may not see is
  **absent**, not null. The answer says which named fields were withheld, so a window shows "hidden", not "empty".
- **Joins are client-side**: a field holding another record's key is resolved by a second query on that type (batched
  with the first). This keeps each provider ignorant of every other.

The answer, per query:

```jsonc
{
  "id": "q1",
  "rows": [ { "key": "tasks/task/t-2020", "rev": 8812, "title": "…", "status": "in_progress", … } ],
  "next": "opaque-cursor" ,                     // or null at the end
  "coverage": { "complete": false, "total": { "n": 214, "exact": true } },
  "aggregates": { "count": { "n": 214, "exact": true, "by": { "open": 190, "in_progress": 24 } } },
  "withheld": ["assignee"],
  "asOf": { "domain": "tasks/task", "rev": 8812 },
  "subscription": "s-…"                         // when subscribe was asked
}
```

- **`coverage.total`** is `{n, exact: true}` (the provider counted), `{n, exact: false}` (at least n), or absent
  (unknown). The UI shows "20 of 214", "20 of 1000+", or "20", accordingly. A badge reads an **aggregate**, never
  `rows.length`.
- **Aggregates are computed under the same viewer authority as the rows**: a count never includes a record the
  viewer couldn't fetch. Bench finding: a count and its rows must be published together (below).
- **`asOf`** is the revision the snapshot reflects. It is the handover point to the change stream.
- **Errors are per query**: `unsupported-version`, `bad-query` (with which clause), `denied` (the consumer may not
  read this type), `unavailable` (the provider timed out or failed). One provider's failure never fails another's
  query in the same batch. A window shows that provider's data as unavailable, keeping what it already held, marked
  stale.

## Who may see what: three separate questions

The bench showed that a cache library's isolation is not loom's permission model. This contract keeps three
questions apart, and each has its own enforcement point:

1. **Viewer authority: may this viewer see this record, and these fields?** Decided **by the provider**, for every
   query and every change, from the viewer context core hands it: the member (and whether they're a household
   owner), or the agent and house, plus the scope core already computes for pages (`LOOM_SCOPE`,
   `LOOM_OWNER_SCOPE`, [owners.md](owners.md)). Core never filters a provider's rows on the provider's behalf, and
   never relaxes a provider's no. Each record carries an **audience** (below) so core can route its changes without
   asking the provider again for every subscriber.
2. **Consumer capability: may this code ask for this type at all?** Decided **by core**, before the provider runs.
   Core's own windows may read any type. A piece's widget or page may read its own provider's types, plus the types
   the grants authority allows it (path `collections/<provider>/<type>`, through the existing `grants` offer:
   t-1746 is the single grants list, and this adds paths to it, not a second authority). Being installed is not a
   grant. A namespace is not a permission.
3. **Code isolation: can this code reach what it wasn't granted?** Same-origin JavaScript shares the page's memory,
   cookies and cache, so **a widget running in the page has every capability the page has**, whatever the
   collection API says. Today's widgets are first-party and run in the page; that's acceptable only because they're
   reviewed code. A piece widget that isn't first-party must run in a sandboxed frame (opaque origin, no
   cookies), talking to the page over a message port that serves only its granted types. The collection runtime
   (t-2023) must not be reachable from a sandboxed frame except through that port. Until that frame exists, only
   first-party pieces may ship widgets (t-2026).

### Audience

Every record carries an `audience`, set by its provider:

```jsonc
"audience": { "household": true }                   // every signed-in viewer
"audience": { "owners": true }                      // household owners only
"audience": { "agents": ["art"], "members": ["jonathan-barket"] }   // these agents' scopes, these members
```

- It uses the scopes core already uses for the live stream: a member who sees agent `art` sees records whose
  audience names `art` ([owners.md](owners.md); src/ui/live.ts, `Sees`).
- It is a **routing hint for changes, checked against the provider's own answer**: core uses it to decide which
  subscriptions a change may reach. When a record's audience *narrows*, the change carries both old and new
  audience, and core sends a delete to every subscriber who's dropped from it.
- A provider whose visibility can't be expressed as an audience (it depends on per-field rules, say) marks the type
  `"audience": "ask"`. Core then re-runs the subscription's query (batched, debounced) for each change rather than
  routing by audience. Slower, never wrong.

### Revocation and sign-out

- A session that signs out, or is revoked, has its stream closed and its subscriptions dropped at once. The client
  runtime clears every record that came through that session from memory (t-2023).
- A grant revoked or a membership changed raises a **scope change** for the affected viewers: core closes their
  subscriptions on the affected types with `{"reset": "scope"}`, and the client drops those collections and asks
  again. A stream opened after a revocation is refused (the bench's revoke-before-open case is a regression test).
- Nothing in a shared collection persists to disk in the browser (no IndexedDB, no service-worker cache) until a
  separate decision says which types may, and how they're cleared.

## Changes: from provider to window

### Provider to core

A provider says what changed by posting to core, as pieces already do for manifests (`POST
/api/loom/pieces/changed`, t-1945), with the piece's own token:

```jsonc
POST /api/loom/collections/changed
{ "domain": "tasks/task", "changes": [
    { "op": "upsert", "id": "t-2020", "rev": 8813, "audience": { … }, "fields": { "status": "closed", … } },
    { "op": "delete", "id": "t-1999", "rev": 8814, "audience": { … } }
  ],
  "aggregates": { "count": { "by": { "open": 189, "in_progress": 23, "closed": … } } },   // optional, see below
  "txn": "optional id: these changes become visible together" }
```

- **Who may post**: a managed piece that declares `collections`, with its own credential, for its own provider's
  domains only. Today only the runtime may call `pieces/changed`; this route is open to every provider, and refuses
  a post for a domain the piece doesn't declare. Core posts its own changes in-process through the same function.
- **Revisions are per domain and monotonic**: a provider never posts a lower revision for a domain than one it has
  posted. Core rejects one that is (and logs it), so an old snapshot can never overwrite a newer change.
- **Fields in an upsert may be partial**: the changed ones plus anything the provider likes. Fields left out keep
  their values. The provider includes every field whose *class* is lower than any it changed, so core can trim per
  viewer without asking again.
- **A batch is atomic for viewers**: all changes in one post (or one `txn` across posts, closed by a final post)
  are delivered to a subscriber in one frame, with the aggregates that go with them. The badge and the list move
  together.
- **A provider that can't say what changed** (its source has no change log) may post `{"domain": …, "invalidate":
  true}` instead. Core then re-runs the domain's open subscriptions' queries (batched, at most once per 1.5 s, the
  existing `GAP_MS`) and diffs the answers itself. That's the bridge for sources not yet migrated (t-2022), and the
  inventory below lists which ones it carries. **A page-wide `change` with no data is retired** once every domain is
  covered (t-2032).

### Core to window

The window keeps its one stream (`GET /events`, today's), and gets frames on it, one per subscription that a change
reaches:

```jsonc
event: rows
data: { "subscription": "s-…", "from": 8812, "to": 8814,
        "upserts": [ { "key": "tasks/task/t-2020", "rev": 8813, "status": "closed" } ],
        "deletes": [ { "key": "tasks/task/t-1999", "rev": 8814 } ],
        "aggregates": { "count": { "n": 213, "exact": true, "by": { … } } } }

event: reset
data: { "subscription": "s-…", "reason": "gap" | "scope" | "provider-gone" | "version" }
```

- **Handover without a gap**: the snapshot's `asOf` is the revision the subscription starts from. Core buffers a
  domain's changes from the moment a subscription is asked until its snapshot is answered, then sends those above
  `asOf`. A change at or below `asOf` is already in the snapshot and is dropped. A change that arrives on the stream
  before its snapshot is held by the client until the snapshot lands.
- **Membership, not just records**: a change can move a record into or out of a subscription's filter (a task
  closed leaves an "open tasks" list). Core evaluates the subscription's `where` against the changed fields and
  sends an upsert (entering) or a delete (leaving). When the change doesn't carry a field the filter needs, core
  re-reads that record through a batched query.
- **Ordering**: within a domain, frames go out in revision order. Across domains there is no global order, and none
  is promised. A view joining two domains shows each at its own revision.
- **Duplicates and old revisions are ignored** by the client: a record's revision only moves forward.
- **One log for every listener**: loom runs several HTTP listeners (LAN, tailnet, localhost) over one `$LOOM_HOME`,
  which today meet only through tick files and polling. So the change buffer is **a table in `household.db`**
  (domain, revision, change, audience, time), written once by whichever listener received the provider's post and
  read by all. A listener learns of new rows the way Comms already does (a tick file plus fs.watch), not by polling
  every provider.
- **Gaps**: core keeps each domain's last 1000 changes or 10 minutes, whichever is more. A window that reconnects
  sends each subscription's last revision. If that is still in the buffer, it gets what it missed; if not, it gets
  `reset: gap` and asks for a fresh snapshot. No replay is promised beyond the buffer, and no zero-transfer resume
  is claimed.
- **Tombstones**: a delete stays in the buffer like any change. A provider must also answer a query from a cursor or
  revision older than the buffer honestly, by core sending `reset`, never by the window keeping a deleted row.
- **Expiry**: a record with a natural end (an ask that expires, a reading's `observedAt` plus its lifetime) carries
  `expires` and the provider posts its delete when it does. The client also hides it at `expires`, in case the
  delete is late.
- **Back-pressure**: at most 64 subscriptions per stream and the existing six streams a session. A window that falls
  more than 256 frames behind is sent `reset: gap` for its biggest subscriptions instead of more frames.
- **Provider removed or replaced**: `reset: provider-gone` for its domains. A replacement under the same role whose
  types satisfy the subscriptions' version ranges gets the next snapshot; otherwise the views show the provider as
  missing (a missing piece is a feature that isn't there, extensions.md rule 3).

## Commands (shared with t-2024)

Actions keep their own routes, CSRF checks, principals, grants and approval semantics. What changes is what they
answer: alongside today's result, an action answers **what it changed**, as the same change records (key, revision,
fields) or as named invalidations, plus an operation receipt (`accepted`, `done`, `failed`, with why). Core
applies those to the acting window at once and they reach every other window through the stream as usual, so no
window refetches after its own action. A window may show its own action as pending, but never shows a grant or an
approval as done until the receipt says so. t-2024 owns the details.

## Read state and other per-viewer records

What a viewer has read is a record, not a side effect of looking. `loom/read-marker/<member>:<item key>` (for an
Inbox item) and the Comms `read_seq` per member and thread (`loom/thread-read/<member>:<thread>`) are both
records whose audience is that member alone, changed only by an explicit action (`POST /inbox/read`, the thread's
`read`). Today `GET /inbox?i=` also marks an item read, and neither `/inbox/read` nor `/appearance/prefs` tells other
windows. Both go: a GET never writes, and every write posts its change. Preferences that follow a member between
devices (`loom/prefs/<member>`) are the same kind of record; the per-device ones stay local.

## Chrome becomes a few small queries

Every page answer today embeds `chrome` (nav, every badge, agent states, tiles, backup, prefs), rebuilt in full on
every request and every refetch, and a 304 saves bytes but none of that work (handler.ts, `chrome()`). Under this
contract chrome stops being a transport. The shell holds a handful of live queries, each answered once and then kept
current by changes: the attention aggregate and per-agent counts (t-2025), Comms unread (t-2027), agent status and
place tiles (t-2028), installed places and nav (t-2031), backup and health (t-2031), and the member's prefs (t-2031).
A page answer carries only what's particular to that page, and the clock, CSRF token and flash stay in the page.

## Search and other query-shaped reads

Search results aren't a filter over one collection: each search is its own result set. They're a record type whose
query is the search text (`loom/search-result`, `where: [["q", "eq", "…"]]`), whose records are references
(`{"ref": "loom/knowledge-page/…", "score": …, "snippet": …}`) and whose subscription isn't live (`subscribe` is
refused). Two searches never share a collection. Launcher suggestions are the same. A newer query cancels the
older one's request.

## The client runtime, in one paragraph (t-2023 builds it)

One registry per signed-in session, keyed by viewer and scope, holding one collection per record type the open
windows read, with one in-flight request per identical query and one subscription per live query, shared by every
window. Windows bind derived views (filters, sorts, joins by key) to it and keep their own presentation state.
Collections nobody reads for 5 minutes are dropped, and any cap on memory drops the least recently read first.
Sign-out, scope change or provider removal clears what they affected, with its listeners. The adapter is the only
code that imports the client library.

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
| `/events` bare `change` | invalidation | replaced by `rows` / `reset` frames (t-2022); retired in t-2032 |
| Page refetch timers (20 s / 60 s / a piece's `refresh`) | polling | retired per domain as it moves (t-2032); a piece's `refresh` becomes its provider's changes |
| Hover prefetch of any link | preload | t-2023 (preload a live query, never a URL that writes) |
| Service worker view cache (every JSON view, per session tag) | offline copies | t-2023 decides; no shared record persists without a separate decision (above) |
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
| clock | wake prompts, lane text, principal statements, raw log | exception: text the owner hasn't shared with every viewer; shown on the clock's own page, not cached | |
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

Pieces installed in one household but not in the catalog (local pieces) are surveyed per household, not here, and
fall under t-2031 unless their rows say otherwise. Every household runs its own survey before t-2031 closes.

### Before any domain moves

The contract can't be met by today's pieces without these, which the domain tasks own:

1. **Ids on attention items** (t-2025): asks, notices and answered rows in a manifest get a provider-stable `id`.
   Until then the Inbox's text hash can't be a record key.
2. **A stable clock job id** (t-2028).
3. **Revisions per record** for tasks (t-2029), the clock (t-2028), approvals (t-2025) and changes (t-2029); and a
   true change log over core's piece store (t-2022), since its revision table is pruned.
4. **Any provider may post its changes** (t-2022): today only the runtime may call `pieces/changed`.
5. **The owner scope in every cache key** that a provider's answer passes through (t-2021).

## What the tests must pin

The conformance suite (t-2026) runs against core's provider and every installed piece's, with fixtures:

- **Identity**: keys are stable across updates; a deleted id isn't reused inside the tombstone window; a replacement
  provider for the same role serves the same keys.
- **Bounds**: an undeclared filter, an operator not allowed, a page over `max_page`, more than 8 clauses, or a heavy
  field in a big list is refused as `bad-query`, before the provider runs.
- **Viewer authority**: for two members and two agents with different scopes, each query and each change reaches
  exactly the records and fields their audience and classes allow; aggregates count only what the viewer could
  fetch; a withheld field is absent and listed in `withheld`.
- **Consumer capability**: a piece widget asking for an ungranted type gets `denied` and the provider never runs; a
  grant revoked mid-subscription resets it.
- **Handover**: a change posted between the query and its answer is delivered exactly once; a snapshot older than a
  delivered change never overwrites it.
- **Order and duplicates**: out-of-order, duplicate and old-revision changes leave the client at the newest
  revision; a provider posting a lower revision is refused.
- **Membership**: an update that moves a record out of a filter deletes it from that subscription and updates the
  aggregate in the same frame.
- **Gaps**: reconnect inside the buffer replays what was missed; outside it, `reset: gap`.
- **Revocation**: sign-out, session revocation, grant revocation and a stream opened after revocation clear or
  refuse as above.
- **Provider failure**: one provider timing out leaves other queries in the batch answered, and its own views marked
  unavailable and stale, not empty.
- **Versions**: a consumer asking for an unserved major gets `unsupported-version`; a minor addition doesn't break an
  older consumer; install, update, remove and replace all reset or continue subscriptions as above.
- **No secrets**: a scan of every type's declared fields and every fixture record finds no field classed or named as
  a credential.

## Open questions for the owner

1. **One stream or two?** This keeps today's single `/events` stream and adds `rows` and `reset` frames to it.
   The alternative is a second stream just for collections. One stream is fewer connections (six per session is
   the cap) and a single gap story. Leaning one.
2. **Audience routing or always ask?** Routing changes by each record's audience is cheap but trusts the provider's
   audience labels as much as its query answers. "Always ask" re-queries per subscriber per change and costs
   subprocesses. Leaning audience, with `ask` per type where needed.
3. **A memory proposal: one item per agent, or one per proposal?** The Inbox shows one item per agent with
   proposals; the per-agent badge and Today count each proposal. One record type can't be both. Leaning one record
   per proposal, with the Inbox grouping them per agent, so every count agrees.
4. **Comms unread: threads or messages?** The dock counts unread threads and the agent card counts unread messages.
   Both can come from the same read-state records, but they'll still show different numbers side by side. Leaning
   threads everywhere, with the message count shown only inside a thread.
5. **Third-party widgets**: should loom allow non-first-party piece widgets at all before the sandboxed frame
   exists? Leaning no (code isolation, above).
