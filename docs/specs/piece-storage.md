# Piece storage: an extension's data lives in loom

*2026-10-28. Status: **proposed**. Jonathan, terminal: "shuttle is a loom
extension, right? so loom the ecosystem can own it just fine. it can still
belong to shuttle if that's what makes sense. extensions need the ability to
store proper data and such." With notes/decisions/2026-10-28-loom-owns-the-data.md
in Art's repo ("if it's a file and not coming right out of loom's db, it's
probably wrong"). A design doc in the `docs/specs/` sense. Companion to
[bridges.md](bridges.md), whose gates are its first user.*

## Why

Every piece keeps its data in files it invents, beside its code:

| Piece | Its data today |
|---|---|
| box | `state.json` (boxes, houses, services, agents' house settings) |
| secrets | an encrypted store, `policy.json`, `requests.json` |
| subscriptions | a JSON file of subscriptions and orders |
| shuttle | `people.json`, `routes.json`, `shuttle.json`, per agent |
| clock | `lanes.json`, schedules, a spool per agent |
| approvals | `approvals.json` |

So:
- Each piece re-solves locking, atomic writes, permissions, history and backup.
- Each needs its own `bundle export`/`import` to be in the household bundle.
- Nothing can say who may write what. The 2026-10-21 decision kept shuttle's
  gates out of loom for exactly that reason: "any body can write loom,
  including a body woken by an outside Slack user."

## What loom gives a piece

**A store of its own, in loom's database**: named collections of JSON
documents, each by key, under the piece's name. Pieces can't see each other's
stores.

```
loom store <piece> get  <collection> <key>
loom store <piece> put  <collection> <key>      (the document on stdin)
loom store <piece> list <collection> [--prefix p] [--limit n]
loom store <piece> del  <collection> <key>
```

The same calls exist over loom's API (`POST /api/loom/store/<piece>/…`) for a
piece's code running elsewhere, such as a service house on another box.

- **Writes are whole documents, compared and swapped**: a put can name the
  revision it read, and fails if someone wrote in between. No piece hand-rolls
  a lock again.
- **Every write is a revision** that names its writer (the piece, the member, or
  the agent), so a collection's history can be shown and reverted, as People's
  is.
- **Size limits** keep it a data store, not a blob store: 256 KB a document, and
  a quota per piece. Big files stay files, in the piece's `data/`.

## Who may write

A piece declares its collections in its manifest, each with who may write it:

```json
"store": {
  "gates":  { "writers": "owner" },
  "routes": { "writers": "owner" },
  "convos": { "writers": "piece" },
  "inbox":  { "writers": "agent" }
}
```

- **`owner`**: written only while the piece is handling a page action from a
  household owner. loom hands that call a write grant good for that call alone.
  Nothing else can write it: not the piece on its own, not an agent's token,
  and not the piece answering an agent's API call. This is the enforced
  owner-only surface the 2026-10-21 decision asked for.
- **`piece`**: the piece's own code writes it, whoever it's serving. This is
  for its bookkeeping, like conversations and cursors.
- **`agent`**: an agent's calls through the piece write it, each agent only
  its own documents (keyed under its name).
- **Everyone with a reason can read**: the piece always; owners on the page;
  an agent only where the piece serves it.

## In the bundle, on the page

- **The bundle carries every store** with no verbs from the piece: loom
  exports the database, encrypted to the owner. A piece's own
  `bundle export`/`import` stays for what isn't in its store, like secrets'
  values, which loom-secrets encrypts itself.
- **Each piece's Setup gets a Data view** for household owners: its
  collections, their sizes, and a document's history with a revert.

## Moving there

1. **The store in core**: the database, the CLI and API calls, revisions,
   compare-and-swap, quotas, the manifest's `store`, the write grant for owner
   collections, and the bundle.
2. **Shuttle first** ([bridges.md](bridges.md) steps 2 and 3): gates and routes
   into owner collections, conversations into a piece collection.
   `people.json` and `routes.json` are migrated, then retired.
3. **The rest, one piece at a time**: approvals, subscriptions, clock lanes and
   schedules, box state. Each piece's migration reads its old file once and
   leaves it as a read-only backup for a release.

## What the tests must pin

- A piece reads and writes only its own store; another piece's name is refused.
- An `owner` collection is written during an owner's page action, and refused
  to the same piece serving an agent's call, to an agent token, and to the
  piece on its own.
- A put that names a stale revision fails, and nothing is written.
- Every write is a revision naming its writer; a revert restores the document.
- `loom export` then `loom restore` brings every store back byte for byte.
- A piece with no `store` declared behaves as today.

## Open questions

- **One database or one per piece?** One file per piece (under loom's home,
  opened only by core) keeps a runaway piece's writes from slowing loom's
  memory, and makes quotas simple. Leaning per piece.
- **Agents' documents and agent owners**: does an agent owner see the `agent`
  documents of their agents on the Data view? Probably yes, by the same rule
  as everything else in owners.md.
