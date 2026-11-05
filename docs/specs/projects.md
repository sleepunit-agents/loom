# Projects: a body of work, and everything about it in one place

*2026-11-02; updated 2026-11-05. Status: **in progress**. Built: the store, tools, CLI, recall resolution, the
identity block, the section seam and the `conversations` section (criteria 1–15). Specified here and not yet built:
repo selectors, the `--repo` feed argument, `waiting` groups and linked items (16–18, which extend 10–11), and the
Projects app (19–23).
Home's Unfiled list is still to come. This is a design doc in the `docs/specs/` sense: it says what loom will build and
the acceptance criteria the implementation's vitest suite must pin. It follows person cards
([person-cards.md](person-cards.md)) closely, on purpose. A project card does for a body of work what a person card
does for a human. Where this doc says "as person cards", person-cards.md is the rule and this doc only adds to it.*

## Why

> "I'm thinking shit like, I wonder what we've got queued up for pond and how conversations from people there are
> going, or hockey or your mud project." "Being able to look at pond and see oh ok, talked to Loren and Matt today,
> here's the digest of those conversations like I would have gotten in discord, tasks related to this conversation
> etc, that'd be rad." — the owner, 2026-11-02

Everything about a project is in loom, or next to it, but scattered:

- **Memories** carry a free-text `project` tag that scopes recall. `src/backends/scope.ts` says it itself: "loom has
  no cross-project id". The tag is a string with nothing behind it.
- **Tasks** live in the tasks piece. Some epics there *are* projects; others are research spikes and decisions.
- **Notes** are grouped by path prefix (`hocket/research/…`), by convention only.
- **Person cards** already have per-project fields: `where.pond` on a colleague's card is "where is this person on
  pond". Nothing collects them by project.
- **Bridge conversations** (shuttle's unit, keyed agent · who · venue; see [bridges.md](bridges.md)) leave no
  readable trace outside the body that had them. Today an agent's bridge briefs can tell a body to flag each
  on-behalf request to the owner in another chat. That's one ping per ask, which is too much noise, and still not a
  digest.

Each question in the quote is answerable today only by a recall query, a task-tree walk, a note listing and asking the
agent what happened. Nothing puts them together as *a project*.

## What a project is (and is not)

1. **A project is an ongoing body of work with a goal**: a product, a client engagement, a season, a long creative
   piece. A research spike, a decision or a one-off task is not a project; it stays the record it is.
2. **A card is current state**, as person cards: one value per field, overwritten in place, past state only in
   revisions, never read at boot.
3. **The hub is computed, never stored.** What's queued, what was said and what's new are read live from where they
   already live. A section whose source isn't there is absent, never an error.
4. **A card has no edges.** Its `links` are *selectors* the hub reads with. loom validates their syntax at write and
   never resolves them as references: archiving a project touches nothing else.

## Vocabulary (to be added to CONTEXT.md)

**Project**:
An ongoing body of work with a goal, identified by a stable slug (`pond`). Its card is the condensed current state;
its hub is everything filed under it, read live.
_Avoid_: epic (a task-store row), workspace, repo, initiative

**Project card**:
The condensed current state of a project: what it is, its goal, where it stands, and the selectors its hub reads with.
_Avoid_: project page (that's the hub as shown), brief, charter

**Hub**:
A project's sections, computed at read: its memories, notes and people, and what pieces contribute.
_Avoid_: dashboard, feed, timeline

**Project name**:
A slug or an alias. Every project name resolves to exactly one live project. **Live** means not archived, whatever its
`status`: a paused or done project keeps its names.
_Avoid_: tag (that's the memory field a name matches), key

**Section feed** (seam):
A managed piece's contribution to a hub: a command loom runs that returns grouped items for one project.
_Avoid_: plugin, integration, widget

**Conversation digest**:
A body run's own summary of its conversation: what was asked, decided and done, and whether the owner is needed.
A core record ([conversations.md](conversations.md), "Digests").
_Avoid_: transcript (that's the session), summary (that's a card field), episode (that's a 48h memory)

## Shape

```jsonc
{
  "slug": "pond",                        // [a-z0-9]+(-[a-z0-9]+)*, ≤ 32 chars (see "People" for why 32)
  "name": "pond",                        // required on create, ≤ 80
  "status": "active",                    // active | paused | done; optional on create, default active
  "summary": "…",                        // what it is, ≤ 1,200, agent-written; loom never generates it
  "goal": "…",                           // what done looks like, ≤ 400
  "where": {                             // where it stands: field name -> envelope
    "now":  { "value": "dev soak; prod cutover blocked on the WAF", "verified_at": "2026-11-02T15:00:00Z",
              "source": "tasks", "stale_after_days": 7 },
    "next": { "value": "the remaining sites back online" }
  },
  "links": {                             // selectors for the hub
    "aliases": ["on-pond", "toad"],      // other project names: memory tags that mean this project
    "notes":   ["pond"],                 // note path prefixes; absent: [slug]
    "epic":    "t-210",                  // passed to piece feeds as --epic; loom gives it no meaning
    "repos":   ["github:acme/pond"],     // repo selectors: passed to feeds as --repo; core never fetches them
    "venues":  ["slack:C0POND"]          // passed to piece feeds as --venue
  }
}
```

**Schema** (the write path rejects anything else, naming the field):

- Top-level keys: exactly those above. Unknown keys are rejected.
- `where`: ≤ 12 fields, names `[a-z0-9_]`, ≤ 32 chars. An envelope is as person cards (`verified_at`, `source`,
  `stale_after_days`) except `value`, which here is **a string only, ≤ 400 chars**. No numbers, booleans or arrays: a
  project's state is prose.
- `links.aliases`: ≤ 16 project names, each following the slug rule. `links.notes`: ≤ 16 entries, each ≤ 200 chars and a
  valid note path prefix (`NOTE_PATH` in `src/notes.ts`), stored without a trailing slash. `links.venues`:
  ≤ 16 strings, each ≤ 200. `links.epic`: one string, ≤ 64.
- `links.repos`: ≤ 16 **repo selectors** ([changes.md](changes.md), "Ids"). An entry is split at its first `:` when
  that comes before any `/`: the part before is the `forge`, `[a-z][a-z0-9-]{0,23}`, and the rest the locator. An entry
  with no such `:` is the **bare form**, `<owner>/<repo>` (written before selectors existed), and means
  `github:<owner>/<repo>`. A locator (or the bare form) is **literal**, as changes.md's "Ids": two to four
  `/`-separated segments of `[A-Za-z0-9._-]`, ≤ 120 chars, so nothing in it reads as a pattern.
  Reads return what was written; feeds get the bare form as `github:…`. Two entries equal after that are rejected.
  Core checks the syntax only: which forges exist, and whether a locator's case matters, is the reading piece's
  business.
- Reserved names: person cards' list (`tier`, `field`, `projects`, `scope`, `trust`) may not be a slug, an alias or a
  `where` field name.
- **A slug is a project's for good.** `projects` is keyed by slug, archived rows included, so a slug is never reused.
  A write that would create a project with an existing slug (live or archived) is rejected, naming it.
- **Aliases are unique across live projects** (not archived; `status` doesn't matter), and no alias may equal any
  project's slug. A write that would give an alias to a second live project, or list a project's own slug as its
  alias, is rejected, naming the field and the holder.

**Merge and replace** (person cards' rules, with these keys):

- `merge: true` (the default):
  - `name`, `status`, `summary` and `goal` replace when passed.
  - `where` merges one level deep exactly as person cards (`null` on a field deletes it).
  - `links` also merges one level deep. A key passed replaces that key's whole value: passing `epic` keeps `aliases`.
    A key passed as `null` removes it.
  - `null` anywhere else is rejected, naming the path. That includes `name`, `status`, `summary`, `goal`, `where` and
    `links` themselves.
- `merge: false`: the card becomes exactly what was passed. `name` is required. An omitted `status` is `active`, and
  omitted sections are empty.
- **`status` vs archive.** `paused` and `done` are states of a live project: it keeps its names, its hub and its feeds,
  and the Projects app lists it under its status. Archiving retires it: hidden, names freed. `done` is "finished,
  still findable"; archive is "gone".
- No-op detection, timestamps (`updated`; `synthesized_at`, moved by passing `summary`), staleness markers,
  archive/restore and revisions follow person cards. The implementation shares that code.
- **Archive and restore with names.** Archiving frees the project's aliases (never its slug). Restoring re-checks
  them: if any alias is now held by a live project, the restore is rejected whole, naming the alias and holder.
  Nothing is partially restored.

## Rendering

```
## <name> (<slug> · <status>)
<summary, or "_(no summary)_">
**Goal:** <goal>
**Where:** next: the remaining sites back online [unverified] · now: dev soak; prod cutover blocked on the WAF [ok]
```

For the card above: `## pond (pond · active)`, then the summary, then
`**Goal:** …` and `**Where:** next: the remaining sites back online [unverified] · now: … [ok]`. Fields are in name
order, markers as person cards. A line whose section is empty is left out, and `links` are never
rendered. Cap: 2,000 chars at worst-case render (every marker at its widest), checked at write. As with person cards,
the field maxima can't all be used at once under the cap. That's deliberate: the cap is the rule, and the per-field
limits only stop one field eating it.

## The hub

`project_hub({slug, since?, include_archived?})` returns the card and its sections. `since` is an ISO-8601 time and
defaults to 7 days ago.

- A missing project returns `{found: false}`. An archived project without `include_archived` returns
  `{found: true, archived: true}` and no sections. With `include_archived`, its sections are computed as a live
  project's, with its names taken from its card (slug and `links.aliases`), since `project_names` no longer holds them;
  feeds run too.
- The result also carries `activity`: the latest of the card's `updated`, its newest matching memory and its newest
  note. It's a field, not a section, and it's what `project_list` sorts by.
- **Sections** are keyed. The core ones are `memories`, `notes`, `people` and `conversations`; a piece's is `piece:<piece name>`. They
  are returned in that order: core first, then pieces by piece name. The page may let the owner reorder them; that
  order is page state.
- **Failures are per section.** A section whose store doesn't exist yet (no notes store) is absent, as a piece that isn't installed is. A section whose source exists but throws, times out or
  doesn't validate becomes `{key, error: "<why>"}`. Either way, every other section still returns. A feed that
  answers `{"groups": []}` is a present, empty section ("nothing here").

**Core sections.** `since` doesn't filter them. It marks items as `new` when they changed after `since`.

| Key | Contents |
|---|---|
| `memories` | memories, not archived and not expired, whose `project` tag is one of the project's names: the union of two sets taken over all matches, the 20 newest by `created`
and the 10 with the highest stored `salience` column (ties: newer `created` first), deduplicated by `ref`. That's 20
to 30 items, returned newest first. Each item: `ref`, category, snippet (≤ 200),
created, updated, `new`. Plus a count per category over all matches |
| `notes` | notes under any `links.notes` prefix (or the slug), excluding expired ones (`expires` before now, even if not swept yet): path, lifespan, updated, `new`. The 20 most recently `updated`, newest first, plus the total count |
| `people` | active person cards with a `where` field named by any of the project's **field names**, where a name's field name is the name with `-` replaced by `_`. Each item: the person's slug and name, which field, its value and its marker, ordered by the person's name. Slugs are ≤ 32 chars for this reason: a field name is ≤ 32 |
| `conversations` | the 20 conversations with the newest `last` whose digests name the project ([conversations.md](conversations.md), "Projects"). Each item: id, venue label, label, people, last, the newest digest's summary, any open `needs_owner`, and `new` (`last` after `since`). `conversationsSection` in `src/conversations.ts` |

**Recall resolves names, both ways.** A recall scoped to any name of a project (its slug or an alias) treats a memory
as in that project when the memory's tag is any name of the same project. The recall reads the project's name set
from `project_names` once, before filtering, and `isVisibleInProject` takes that set instead of one string. A name
that belongs to no live project, or a store that can't be read, keeps today's exact match. No memory is rewritten.

**Only reads resolve.** Recall and `find_similar` (the two callers of `isVisibleInProject`) resolve names. The
`project` filters on `forget`, `memory_list` and every other write or bulk operation stay **exact matches**: a
`forget` of project `pond` never touches a memory tagged `on-pond`.

## Section feeds (the seam)

Only a **managed** piece (pieces-install.md) can offer a section. A piece on `PATH` has no package for loom to read,
so loom never runs a feed from one. The piece declares the feed in its package's `loom` block. loom reads it from the
copy of that block in the piece's `piece.json`: the installer already writes one (`PieceRecord.loom` in
`src/cli/pieces-managed.ts`), and pieces-install.md is to document it (see "Edits this forces").

```jsonc
"loom": { "sections": { "project": { "label": "Tasks", "argv": ["loom-tasks", "project-feed", "--json"],
                                     "unfiled": false } } }
```

- **The declaration's schema.**
  - `sections` has exactly one key today: `project`. Any other key is rejected.
  - `project` has `label` (required, ≤ 40 chars) and `argv` (required: 1–16 strings, each ≤ 200).
  - `argv[0]` must be one of the piece's own `bin` names.
  - `unfiled` is an optional boolean, default false.
  - Unknown keys are rejected.

  A block that fails any rule is rejected at install, like any invalid `loom` block.
- loom passes feeds a `since` no earlier than 8 days ago (a longer `since` still reaches the core sections; feeds get
  8 days), so a day-grouped feed never needs more than 8 groups. `since` is passed as UTC, `YYYY-MM-DDTHH:MM:SSZ`.
- loom runs `argv` plus `--project <slug> --since <iso>` and, when the card has them, `--epic <id>`, then `--name <n>`
  for every alias, `--venue <v>` for every venue and `--repo <r>` for every repo selector (normalized: a bare
`owner/repo` passed as `github:owner/repo`), each in the card's order. It runs in the piece's own environment, through the same runner
  as manifests (extensions.md "Limits"): **3 s**, the process group killed afterwards, at most 6 pieces at once.
  Results are not cached, with one exception: the Projects index's counts (below).
- `"unfiled": true` says the piece can also be asked with `--unfiled --since <iso>`, for items that belong to no
  project. loom's Home asks it with `since` 7 days ago, through the same runner, and shows the result as "Unfiled".

**Output.** One JSON object on stdout, ≤ 64 KB. Anything else becomes the section's `{key, error}`:

```jsonc
{ "groups": [
    { "title": "Waiting on you",                          // required, ≤ 80
      "waiting": true,                                    // optional: these items wait on the owner (counted below)
      "items": [
        { "title": "Approve the WAF exception",           // required, ≤ 200
          "when": "2026-11-02T14:10:00Z",                 // optional, ISO-8601 UTC
          "who": ["Loren", "Matt"],                       // optional, ≤ 8 display names, each ≤ 80
          "person": ["loren-smith"],                      // optional, ≤ 8 person slugs (the page shows their avatars)
          "status": "open",                               // optional, ≤ 24, free text the page shows as a badge
          "ref": "t-1271",                                // optional, ≤ 200, shown as text
          "page": "task/t-1271",                          // optional, ≤ 200: a page of this piece, or loom:<page>
          "href": "https://…",                            // optional, ≤ 500, https only: opens outside
          "body": "…" } ] } ] }                           // optional, ≤ 600, shown folded
```

≤ 8 groups and ≤ 50 items in total. An item has at most one of `page` and `href`. A `page` follows the page path rule
(extensions.md, "Pages"), optionally with a `?query`; it links to the feed's own piece (`/p/<piece>/<page>`) unless it
starts with `loom:`, which follows the manifest's `loom:` rule. Keys not listed here are rejected (so a typo fails loudly, not silently). The
piece decides its own grouping and order; loom renders what it's given.

## Conversation digests

Conversations and their digests are core records: [conversations.md](conversations.md) defines them, the `dg-` id
(over the conversation's id and the body run's), the digest's fields and caps, how a digest's projects resolve, and
the `conversations` core section above. That replaces the shuttle feed this section used to describe: the bridges
piece no longer keeps digests or offers a section for them. A digest with `needs_owner` is an ask from core in loom's
Inbox, until a later digest in that conversation has none.

## The tasks piece's side

- The tasks piece's feed returns the epic's tree in four groups: waiting on the owner, ready, blocked, and
  done since `since`. It also matches tasks outside the tree whose text names the project (any of its names), with `status` "outside the
  tree". A task made from a conversation cites the digest's id (`dg-…`) in its description, and the tasks feed
  puts that id in the item's `body`, so the two sections cross-reference by text.

## Surfaces

**Write**: `project_write`, `project_verify` (stamps `where` fields, as person cards' `person_verify`),
`project_archive`/`project_restore` (`reason` required), `project_history`, `project_revision_restore`.

**Read**:
- **Every surface that takes a `slug` takes any live name**: an alias resolves to its project, reads and writes alike,
  and the result carries `resolved_from: "<alias>"`. An archived project is reached by its slug only.
- `project({slug, include_archived?})`: the card, its render, `archived`, `updated` and `synthesized_at`, as `person`.
- `project_list({status?, include_archived?})`: per project, slug, name, status, `links`, activity (the list is sorted by it, most recent first), stale and
  unverified counts, and `memories_since_synthesis`. That's the non-archived, non-expired memories tagged with any of
  its names whose `created` is after `synthesized_at` (all of them while it's null), which is how a consolidation lane finds summaries that have fallen
  behind. Without `status`, every non-archived project is listed.
- `project_hub`: as above.
- `project_orphans()`: tags on non-archived, non-expired memories (any scope) that are no live project's name, with
  counts, most first (ties by tag). An archived project's names come back here, which is deliberate: they're tags with nothing
  behind them again. That's where a lane finds
  projects that ought to have a card.
- CLI: `loom project show|list|hub|orphans [<slug>] [--json]`. Exit codes: 0 found (for `hub`, even with failed
  sections; the failures are in the output), 3 no such project, 4 archived without `--include-archived`.

**Identity**: `identity({..., project: "<name>"})` adds a `# This project` block with the rendered card. It goes after
the tape and before Top of Mind, and before `# In the room` when that is present too. The block is the heading line
`# This project` and the rendered card, so it is at most 2,015 chars (heading, newline, card) and never needs truncating (the card's cap is
checked at write),
best-effort as person cards: a missing, archived or unreadable card gives the line `_(no project <name>)_`, `_(project <name> is archived)_`
or `_(project <name> is unreadable)_`, never a failure. A body
working in a project's repo or conversation passes it, the way a bridge passes `people`.

**loom's page: the Projects app.**

- **Where it lives.** A tile in **Places**, `Projects` (icon `folder-kanban`), after People. It's somewhere the owner
  goes regularly ("what's queued up for pond"), so it's a place, not Setup, and it is the household's, like People: a
  member who owns only some agents (an agent owner, owners.md) doesn't get it, as with Knowledge and People. A loom
  without a household has it too, beside Mind and People.
- **The index**, `/projects`: summary, then drill in. One `list` row per live project, from every agent in the
  household (each row carrying its agent's mark when the household has more than one), ordered: projects with
  something waiting on the owner first, then those with a section error, then by activity. Each row: the name, and as
  its meta, the status (when not active), what's waiting on you in words ("2 waiting on you"), and the last activity
  as an age. It links to the hub. Paused and done projects are in a folded "Paused and done" section. With no projects:
  one line saying what a project is and that an agent makes one with `project_write`.
- **What's waiting on you**, per project, is the number of open `needs_owner` asks in its `conversations` section and
  of items in its feed groups marked `waiting`, as those sections return them (their caps apply). To count, the index
  runs each project's feeds with `since` 7 days ago, through the same runner and its pool (6 at once across the whole
  index), and keeps each project's result 60 s in the daemon's memory, keyed by agent and slug. The index waits at most
  5 s for them: a project whose feeds haven't answered by then, or one that failed, shows "couldn't count" instead of a
  number and sorts with the errors. The hub page never reads or writes that cache.
- **A project's hub** is `/projects/<agent>/<slug>` in a household (the index always links this form) and
  `/projects/<slug>` without one. In a household, `/projects/<slug>` resolves when exactly one agent has a live project
  whose slug or alias that is, and is not found otherwise. The card's name is the title and its summary the intro.
  Both pages only read: no actions, no buttons (the card is written by agents, with `project_write`). Then, in this order, each only when its section is present:
  1. **Goal and where it stands**: `kv` of the goal and each `where` field with its marker in words ("checked 2 days
     ago", "not checked", "stale for 9 days").
  2. **Waiting on you**: every `waiting` feed item and every open `needs_owner` ask, one list, tone `warn`.
  3. **Each piece section**, under its `label` (Changes, Tasks…), its groups as lists, items linking by their `page`
     or `href`, with `when` (as an age), `who` and `ref` in the row's meta, `status` as its badge, the first `person`'s
     avatar, and `body` folded under the row. Groups marked `waiting` are left out here, since they're shown above. A `{key, error}` section is a
     muted line, "<label> couldn't answer: <why>".
  4. **People**: each person (avatar), the field and its value.
  5. **Conversations**: each with its digest's summary, linking to `loom:conversation/<id>`.
  6. **Notes** and **Memories**: folded, newest first, memories linking to their page.
  A missing project is the not-found page; an archived one says it's archived.
- The page's `since` is 7 days (the open question below still stands).
- **No new block types**, so the app adds nothing to the first page's script: the pages are drawn by loom's existing
  blocks, and the tile's icon comes from the lazily loaded icon set (its name is the only thing the shell gains).

## Storage

The `projects`, `project_revisions` and `project_names` tables live in the memory database, next to `people`, added by
a new migration entry. A project, like a person, is about the agent's work, so it sits on memory's side of the
memory/knowledge line.

`projects` columns: `slug` (PK), `name`, `status`, `card_json`, `archived_at`, `archived_by`, `archive_reason`,
`updated`, `synthesized_at`. `project_names` has `name` (PK), `slug` and `kind` (`slug` or `alias`). It holds every live project's slug and
aliases, so "every project name is unique" is a primary-key constraint, not a check. A write updates `projects` and
`project_names` in one transaction. Archiving deletes the project's rows from `project_names`; restoring re-inserts
them or rolls back. Cards belong to the database, as people do.

## Edits this forces elsewhere

- **extensions.md:** the core line becomes "identity, memory, knowledge, person cards, project cards". It gains a
  "Sections" subsection pointing here.
- **pieces-install.md:** the `loom` block schema gains `sections`, and `piece.json`'s description lists the `loom` copy
  it already keeps.
- **src/backends/scope.ts:** its header comment ("loom has no cross-project id") is updated: projects are that id.
- **CONTEXT.md:** the vocabulary above.

## Acceptance criteria (loom vitest)

1. `project_write` creates, merges and replaces by the rules above. A test passes `links.epic` alone and keeps
   `links.aliases`, removes a key with `null`, and rejects each schema violation naming its field.
2. Name uniqueness: a second project claiming a slug or alias is rejected, naming the holder. A `done` or `paused`
   project keeps its names and its aliases still resolve. Archiving frees the names. A restore whose names are taken
   is rejected whole and changes nothing.
3. No-op detection, revisions, archive/restore and revision restore behave as person cards. Atomicity as person cards'
   criterion: two concurrent writes giving the same alias to two projects leave exactly one holder, and a failed write
   leaves `projects` and `project_names` both unchanged.
4. The render: a project named "Pond Rebuild" with slug `pond` renders `## Pond Rebuild (pond · active)` first, then
   the summary, goal and where lines by the grammar above. The worst-case render is ≤ 2,000 chars, and a write over
   it is rejected.
5. Staleness markers on `where`, as person cards.
6. `memories`: tagged with the slug or any alias, archived and expired excluded; the 20 newest plus the 10 highest by
   stored `salience` (ties by newer `created`), deduplicated by `ref`; `new` against `since`. With 25 matching
   memories whose salience order differs from their age order, the test checks the exact set.
7. `notes`: under each prefix, the slug by default; an expired but unswept note is excluded; `new` against `since`. A
   missing notes store means the section is absent, not an error.
8. `people`: a person card with `where.on_pond` appears in the hub of a project aliased `on-pond`. A card with
   `where.pond` appears in project `pond`'s hub. An archived card does not.
9. Recall scoped to `pond` returns a project-scoped memory tagged `on-pond` when `on-pond` is an alias of `pond`, and
   recall scoped to `on-pond` returns one tagged `pond`. Neither does when the alias is removed.
10. Feeds:
    - A managed piece with `sections.project` is run with exactly the documented arguments, in its environment.
    - Its output is validated by every rule above, each tested.
    - Invalid output, a timeout over 3 s, or a non-zero exit gives `{key: "piece:<name>", error}`, and the other
      sections still return.
11. A piece without `sections.project`, or one found only on `PATH`, is never run. Each declaration rule rejects at
    install: an unknown section key, a missing or over-long `label`, an empty or over-long `argv`, an `argv[0]` that
    isn't the piece's bin, an unknown key. The flags are passed in the card's order. With `unfiled: true`, Home's call
    gets `--unfiled --since` 7 days ago. A feed answering `{"groups": []}` gives a present, empty section.
12. `project_hub` on a missing project gives `{found: false}`; on an archived one without `include_archived`, gives
    `{found: true, archived: true}` and runs no feed.
13. `identity({project})` puts the block after the tape and before Top of Mind, before `# In the room` when both are
    present, within its cap, and never fails identity.
14. Every slug-taking surface resolves an alias with `resolved_from`, and `forget({project: "pond"})` leaves a memory
    tagged `on-pond` alone. A new project can't take an archived project's slug. `project_orphans` counts only non-archived, non-expired memories,
    lists an archived project's former names, and leaves out a live project's. `project_list` returns `links`, and
    its `memories_since_synthesis` excludes archived, expired and older memories.
15. The CLI's four verbs with `--json` and the exit codes above.
16. Repo selectors: `github:acme/app`, `forgejo:codeberg.org/acme/app` and a bare `acme/app` are accepted; a space, `#`,
    `@`, an empty locator, an uppercase or over-long forge, and two selectors equal after normalizing are rejected,
    naming the field. A feed gets `--repo github:acme/app` for a bare `acme/app`, after the venues, in the card's order.
17. Feed output: `waiting` must be a boolean; `page` and `href` are each checked (path rule, `loom:` rule, https only,
    caps), an item with both is rejected, and an unknown key still is.
18. A feed item's `page` links to its piece's page (`/p/<piece>/<page>`), and a `loom:` one to loom's page.
19. The Projects tile is in Places after People for a household's owner, absent for a member who owns only some
    agents, and present in a loom without a household.
20. The index orders projects with waiting items first, then errors and "couldn't count", then by activity; counts
    `waiting` items plus open `needs_owner` asks; folds paused and done; and, loaded twice within 60 s, runs each
    project's feeds once (a fake feed counts its runs). A feed slower than 5 s gives "couldn't count", not a slow page.
21. The hub page shows its sections in the order above, leaves out an absent one, shows a failed feed as its line,
    lists a `waiting` group's items once (under Waiting on you), and runs the feeds on every load, whatever the index
    has cached.
22. In a household, `/projects/<agent>/<slug>` reaches that agent's project; `/projects/<slug>` reaches it when only
    one agent has the slug and is a 404 when two do; an unknown slug is a 404.
23. The web app gains no block type, and its budget test still passes.

## First slice

1. The store, tools, CLI, recall resolution and identity block: criteria 1–9 and 12–15.
2. The section seam (10–11), with the tasks piece's `project-feed` as the pilot; then repo selectors, `--repo`,
   `waiting` and item links (16–18).
3. Digests are core's ([conversations.md](conversations.md)), and so is the `conversations` section. An agent
   whose bodies are told to message the owner on every request drops that instruction in favour of digests (the
   agent's own configuration, outside loom).
4. The Projects app (criteria 19–23), then Home's Unfiled list.

**Done**, outside loom's tests:
- an owner opens a seeded project and sees what's queued (the tasks feed), the week's conversations with their
  digests (the `conversations` section), and the person cards' fields for it.

## Decided, not open

- **Core, not a piece, and not work tracking.** extensions.md sends work tracking to a piece, and that stays true: a
  project card tracks no work. It holds no tasks, states or queues; the tasks piece does, and reaches the hub only
  through the seam. By extensions.md's test, a project manages the agent's continuity and knowledge: memories
  already scope by project, recall now resolves its names, and identity carries it. Piece sections go through the seam,
  so tasks and bridges stay swappable.
- **Per-agent**, like person cards.
- **No live state stored.** Counts, `new`, and what's queued are computed.

## Open questions

- **The owner's "since I last looked."** The page's default `since` would be a per-owner read mark rather than 7
  days. That's page state, left to the page PR.

## Sources

The quotes and the problem statement come from the owner's conversation with the agent on 2026-11-02, recorded in the
agent's own operations repo and task store. They are provenance only and are not needed to implement this doc.

## Review gate

As person cards: before this doc merges, a context-stripped reviewer from outside loom's authors reviews it, and every
finding is recorded in the PR thread as folded, accepted as a trade-off, or rejected with a quote.
