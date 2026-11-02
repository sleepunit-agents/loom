# Projects: a body of work, and everything about it in one place

*2026-11-02. Status: **proposed**. This is a design doc in the `docs/specs/` sense: it says what loom will build and
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
- **Bridge conversations** (the bridges piece's unit, keyed agent · who · venue; see [bridges.md](bridges.md)) leave no
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
A slug or an alias. Every project name resolves to exactly one active project.
_Avoid_: tag (that's the memory field a name matches), key

**Section feed** (seam):
A managed piece's contribution to a hub: a command loom runs that returns grouped items for one project.
_Avoid_: plugin, integration, widget

**Conversation digest**:
The bridges piece's record of one conversation on one day: who, where, what was asked, decided and done, and whether
the owner is needed. It belongs to the bridges piece, not loom.
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
    "repos":   ["acme/pond"],            // shown, never fetched
    "venues":  ["slack:C0POND"]          // passed to piece feeds as --venue
  }
}
```

**Schema** (the write path rejects anything else, naming the field):

- Top-level keys: exactly those above. Unknown keys are rejected.
- `where`: ≤ 12 fields, names `[a-z0-9_]`, ≤ 32 chars. An envelope is as person cards (`verified_at`, `source`,
  `stale_after_days`) except `value`, which here is **a string only, ≤ 400 chars**. No numbers, booleans or arrays: a
  project's state is prose.
- `links.aliases`: ≤ 16 project names, each following the slug rule. `links.notes`: ≤ 16 entries, each a valid note
  path prefix (`NOTE_PATH` in `src/notes.ts`), stored without a trailing slash. `links.repos` and `links.venues`:
  ≤ 16 strings, each ≤ 200. `links.epic`: one string, ≤ 64.
- Reserved names: person cards' list (`tier`, `field`, `projects`, `scope`, `trust`) may not be a slug, an alias or a
  `where` field name, and may not appear as a key inside any value.
- **Every project name is unique across active projects.** A write that would make a slug or alias resolve to a
  second active project is rejected, naming the project that holds it.

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
- No-op detection, timestamps (`updated`; `synthesized_at`, moved by passing `summary`), staleness markers,
  archive/restore and revisions follow person cards. The implementation shares that code.
- **Archive and restore with names.** Archiving frees the project's names. Restoring re-checks them: if any is now
  held by an active project, the restore is rejected whole, naming the conflicting name and holder. Nothing is
  partially restored.

## Rendering

```
## pond (active)
<summary, or "_(no summary)_">
**Goal:** <goal>
**Where:** next: the remaining sites back online [unverified] · now: dev soak; prod cutover blocked on the WAF [ok]
```

Fields are in name order, markers as person cards. A line whose section is empty is left out, and `links` are never
rendered. Cap: 2,000 chars at worst-case render (every marker at its widest), checked at write. As with person cards,
the field maxima can't all be used at once under the cap. That's deliberate: the cap is the rule, and the per-field
limits only stop one field eating it.

## The hub

`project_hub({slug, since?, include_archived?})` returns the card and its sections. `since` is an ISO-8601 time and
defaults to 7 days ago.

- A missing project returns `{found: false}`. An archived project without `include_archived` returns
  `{found: true, archived: true}` and no sections.
- **Sections** are keyed. The core ones are `memories`, `notes` and `people`; a piece's is `piece:<piece name>`. They
  are returned in that order: core first, then pieces by piece name. The page may let the owner reorder them; that
  order is page state.
- **Failures are per section.** A section that throws, times out or doesn't validate becomes
  `{key, error: "<why>"}`, and every other section still returns.

**Core sections.** `since` doesn't filter them. It marks items as `new` when they changed after `since`.

| Key | Contents |
|---|---|
| `memories` | memories, not archived and not expired, whose `project` tag is one of the project's names: the newest 20 plus the 10 most salient, deduplicated by id. Each item: id, category, snippet (≤ 200), created, updated, `new`. Plus a count per category over all matches |
| `notes` | notes under any `links.notes` prefix (or the slug): path, lifespan, updated, `new`. The newest 20, plus the total count |
| `people` | active person cards with a `where` field named by any of the project's **field names**, where a name's field name is the name with `-` replaced by `_`. Each item: the person's slug and name, which field, its value and its marker. Slugs are ≤ 32 chars for this reason: a field name is ≤ 32 |
| `activity` | the latest of: the card's `updated`, its newest memory, its newest note. It's what `project_list` sorts by |

**Recall resolves names.** `isVisibleInProject` (and every recall scoped to a project) treats a memory as in the
project when its tag is any of that project's names. A tag that belongs to no active project keeps today's exact
match. No memory is rewritten.

## Section feeds (the seam)

Only a **managed** piece (pieces-install.md) can offer a section. A piece on `PATH` has no package for loom to read,
so loom never runs a feed from one. The piece declares the feed in its package's `loom` block, and loom reads it from
the `loom` copy it keeps in `piece.json` at install:

```jsonc
"loom": { "sections": { "project": { "label": "Tasks", "argv": ["loom-tasks", "project-feed", "--json"],
                                     "unfiled": false } } }
```

- `argv[0]` must be one of the piece's own `bin` names. A declaration that fails this, or any other rule here, is
  rejected at install like any invalid `loom` block, and pieces-install.md's block schema gains `sections`.
- loom runs `argv` plus `--project <slug> --since <iso>` and, when the card has them, `--epic <id>`, then `--name <n>`
  for every alias and `--venue <v>` for every venue. It runs in the piece's own environment, through the same runner
  as manifests (extensions.md "Limits"): **3 s**, the process group killed afterwards, at most 6 pieces at once.
  Results are not cached.
- `"unfiled": true` says the piece can also be asked with `--unfiled --since <iso>`, for items that belong to no
  project. loom's Home uses that (see Surfaces).

**Output.** One JSON object on stdout, ≤ 64 KB. Anything else becomes the section's `{key, error}`:

```jsonc
{ "groups": [
    { "title": "Waiting on you",                          // required, ≤ 80
      "items": [
        { "title": "Approve the WAF exception",           // required, ≤ 200
          "when": "2026-11-02T14:10:00Z",                 // optional, ISO-8601 UTC
          "who": ["Loren", "Matt"],                       // optional, ≤ 8 display names, each ≤ 80
          "person": ["loren-smith"],                      // optional, ≤ 8 person slugs (the page shows their avatars)
          "status": "open",                               // optional, ≤ 24, free text the page shows as a badge
          "ref": "t-1271",                                // optional, ≤ 200, shown as text
          "body": "…" } ] } ] }                           // optional, ≤ 600, shown folded
```

≤ 8 groups and ≤ 50 items in total. Keys not listed here are rejected (so a typo fails loudly, not silently). The
piece decides its own grouping and order; loom renders what it's given.

## Conversation digests (the bridges piece's side)

This part is the bridges piece's code, not loom's. It is stated here so the seam is buildable.

- **What a body writes.** At the end of a turn that did something (a request, a decision, a task made or moved), a body
  writes a digest through its bridges piece: conversation (agent · who · venue), people (slugs), projects (zero or more
  names), summary (≤ 600), asks, decisions, task refs, and `needs_owner` (a one-line reason, or nothing). There is one
  digest per conversation per day. A later write that day replaces it: current state, like a card.
- **Which project.** The body decides. It has two hints: the card's `links.venues`, which the bridges piece can read
  with `loom project list --json`, and the person cards' `where.<field>` fields. A digest with no project is still kept.
- **Its feed.** `sections.project` with `unfiled: true`.
  - Each group is a day, titled with the date, newest first.
  - Each item is one conversation: the venue as `title`, people as `who` and `person`, the summary and asks as
    `body`, the task refs as `ref`, and `status` "needs you" when `needs_owner` is set.
  - `--unfiled` returns the digests with no project, in the same shape.
- **Who gets pinged.** A digest with `needs_owner` is listed in the bridges piece's manifest `asks` (extensions.md:
  "things only the owner can decide"), which is where loom shows owner decisions. A digest without it reaches the
  owner only through the project page. A bridge configuration that pinged the owner on every request drops that in
  favour of this.
- **Tasks.** The tasks piece's feed returns the epic's tree in four groups: waiting on the owner, ready, blocked, and
  done since `since`. It also matches tasks outside the tree that name the project in their text, and marks those in
  `status`. A task made from a conversation cites the digest in its description, so the sections cross-reference.

## Surfaces

**Write**: `project_write`, `project_verify` (stamps `where` fields, as person cards' `person_verify`),
`project_archive`/`project_restore` (`reason` required), `project_history`, `project_revision_restore`.

**Read**:
- `project({slug, include_archived?})`: the card, its render, `archived`, `updated` and `synthesized_at`, as `person`.
  A slug that is an *alias* resolves to its project, with `resolved_from: "<alias>"`.
- `project_list({status?, include_archived?})`: per project, slug, name, status, activity, stale and unverified
  counts, and `memories_since_synthesis`. That's the memories tagged with any of its names created after
  `synthesized_at` (all of them while it's null), which is how a consolidation lane finds summaries that have fallen
  behind. Without `status`, every non-archived project is listed.
- `project_hub`: as above.
- `project_orphans()`: memory tags that are no project's name, with counts, most first. That's where a lane finds
  projects that ought to have a card.
- CLI: `loom project show|list|hub|orphans [<slug>] [--json]`. Exit codes: 0 found (for `hub`, even with failed
  sections; the failures are in the output), 3 no such project, 4 archived without `--include-archived`.

**Identity**: `identity({..., project: "<name>"})` adds a `# This project` block with the rendered card. It goes after
the tape and before Top of Mind, and before `# In the room` when that is present too. It is capped at 2,000 chars,
best-effort as person cards: a missing, archived or unreadable card gives a placeholder line, never a failure. A body
working in a project's repo or conversation passes it, the way a bridge passes `people`.

**loom's page** (its own PR, after the store and tools):
- **A Projects tab.** Active projects come first, by activity. Each row has the name, status, the `where.now` line
  with its marker, and the count of `new` items per section.
- **A project page** shows the card, then the sections.
- **An "Unfiled" list on Home** comes from every feed that declares `unfiled`.

## Storage

The `projects`, `project_revisions` and `project_names` tables live in the memory database, next to `people`, added by
a new migration entry. A project, like a person, is about the agent's work, so it sits on memory's side of the
memory/knowledge line.

`project_names` has `name` (PK), `slug` and `kind` (`slug` or `alias`). It holds every active project's slug and
aliases, so "every project name is unique" is a primary-key constraint, not a check. A write updates `projects` and
`project_names` in one transaction. Archiving deletes the project's rows from `project_names`; restoring re-inserts
them or rolls back. Cards belong to the database, as people do.

## Edits this forces elsewhere

- **extensions.md:** the core line becomes "identity, memory, knowledge, person cards, project cards". It gains a
  "Sections" subsection pointing here.
- **pieces-install.md:** the `loom` block schema gains `sections`.
- **CONTEXT.md:** the vocabulary above.

## Acceptance criteria (loom vitest)

1. `project_write` creates, merges and replaces by the rules above. A test passes `links.epic` alone and keeps
   `links.aliases`, removes a key with `null`, and rejects each schema violation naming its field.
2. Name uniqueness: a second project claiming a slug or alias is rejected naming the holder. Archiving frees the
   names. A restore whose names are taken is rejected whole and changes nothing.
3. No-op detection, revisions, archive/restore and revision restore behave as person cards.
4. The worst-case render is ≤ 2,000 chars; a write over it is rejected.
5. Staleness markers on `where`, as person cards.
6. `memories`: tagged with the slug or any alias, archived and expired excluded, newest 20 ∪ salient 10 deduplicated,
   `new` against `since`.
7. `notes`: under each prefix, the slug by default, `new` against `since`.
8. `people`: a person card with `where.on_pond` appears in the hub of a project aliased `on-pond`. A card with
   `where.pond` appears in project `pond`'s hub. An archived card does not.
9. Recall scoped to `pond` returns a project-scoped memory tagged `on-pond` when `on-pond` is an alias of `pond`, and
   doesn't when it isn't.
10. Feeds:
    - A managed piece with `sections.project` is run with exactly the documented arguments, in its environment.
    - Its output is validated by every rule above, each tested.
    - Invalid output, a timeout over 3 s, or a non-zero exit gives `{key: "piece:<name>", error}`, and the other
      sections still return.
11. A piece without `sections.project`, or one found only on `PATH`, is never run. An `argv[0]` that isn't one of the
    piece's bins is rejected at install.
12. `project_hub` on a missing project gives `{found: false}`; on an archived one without `include_archived`, gives
    `{found: true, archived: true}` and runs no feed.
13. `identity({project})` puts the block after the tape and before Top of Mind, before `# In the room` when both are
    present, within its cap, and never fails identity.
14. `project` resolves an alias with `resolved_from`. `project_orphans` lists the tags of no project with counts.
15. The CLI's four verbs with `--json` and the exit codes above.

## First slice

1. The store, tools, CLI, recall resolution and identity block: criteria 1–9 and 12–15.
2. The section seam (10–11), with the tasks piece's `project-feed` as the pilot.
3. The bridges piece's digests and feed (its own PR in that piece), and the agent's bridge briefs replace
   per-request flags with digests.
4. The Projects tab and Home's Unfiled list.

**Done**, outside loom's tests:
- an owner opens a seeded project and sees what's queued (the tasks feed), the week's conversations with their
  digests (the bridges feed), and the person cards' fields for it;
- a bridge request without `needs_owner` no longer reaches the owner anywhere but that page.

## Decided, not open

- **Core, not a piece.** By extensions.md's test, a project manages the agent's continuity and knowledge: memories
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
