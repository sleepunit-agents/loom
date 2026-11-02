# Projects: a body of work, and everything about it in one place

*2026-11-02. Status: **proposed**. Taskstore t-1734 (epic t-1727). This is a design doc in the `docs/specs/`
sense: it says what loom will build and the acceptance criteria the implementation's vitest suite must pin. It
follows person cards ([person-cards.md](person-cards.md)) closely, on purpose. A project card does for a body of
work what a person card does for a human.*

## Why

> "I'm thinking shit like, I wonder what we've got queued up for pond and how conversations from people there are
> going, or hockey or your mud project." "Being able to look at pond and see oh ok, talked to Loren and Matt today,
> here's the digest of those conversations like I would have gotten in discord, tasks related to this conversation
> etc, that'd be rad." — Jonathan, 2026-11-02

Today everything about a project is in loom or next to it, scattered:

- **Memories** carry a free-text `project` tag that scopes recall (`src/backends/scope.ts`). The scope code itself
  notes that "loom has no cross-project id". The tag is a string with nothing behind it.
- **Tasks** live in the tasks piece. Art's store has 19 open epics, and some of them *are* projects (pond, the
  materialized-tunes redesign, loom's UI app), sitting next to research spikes and decisions that aren't.
- **Notes** are grouped by path prefix (`hocket/research/…`, `hocket/ideas/…`), by convention only.
- **Person cards** already have per-project fields: `where.pond` on Patrick's card is "where is Patrick on pond".
  Nothing collects them by project.
- **Bridge conversations** (shuttle's unit, keyed by agent · who · venue, see [bridges.md](bridges.md)) leave no
  readable trace outside the body that had them. The only thing the owner sees is a Discord ping: Art's Slack
  briefs flag every on-behalf request to Discord #general. That's one ping per Slack ask, which is too much noise
  (Jonathan, same day), and it's still not a digest.

Every question in the quote above is answerable today, but only by a recall query, a task-tree walk, a note
listing and asking the agent what happened on Slack. Nothing puts them together as *a project*.

## What a project is (and is not)

1. **A project is an ongoing body of work with a goal.** Hocket, pond, materialized-tunes, loom, a hockey season, the
   MUD. A research spike, a decision or a one-off task is not a project. The epic or task it is stays where it is.
2. **A card is current state**, exactly like a person card: one value per field, overwritten in place, with past
   state in revisions (snapshots for audit and undo), never read at boot.
3. **The hub is computed, never stored.** What's queued, what was said and what's new are read live from where they
   already live: memories, notes, person cards, and pieces through a seam. loom does not copy them into the project.
   A project with no tasks piece installed has no tasks section; that's a feature that isn't there, not an error.
4. **A card has no edges.** Its `links` are *selectors* the hub reads with (a note prefix, an epic id, memory tag
   aliases). They are not references loom resolves, validates or cascades. Archiving a project touches nothing else.

## Vocabulary (to be added to CONTEXT.md)

**Project**:
An ongoing body of work with a goal, identified by a stable slug (`pond`). Its card is the condensed current state;
its hub is everything filed under it, read live.
_Avoid_: epic (a task-store row), workspace, repo, initiative

**Project card**:
The condensed current state of a project: what it is, its goal, where it stands, and the selectors its hub reads with.
_Avoid_: project page (that's the hub as shown), brief, charter

**Hub**:
A project's sections, computed at read: its memories, notes, people, and what pieces contribute (tasks,
conversations). Never stored.
_Avoid_: dashboard, feed, timeline

**Section feed** (seam):
A piece's contribution to a hub: a command loom runs that returns items for one project.
_Avoid_: plugin, integration, widget

**Conversation digest**:
The bridges piece's record of one conversation on one day: who, where, what was asked, decided and done, and whether
the owner is needed. It belongs to the bridges piece, not loom.
_Avoid_: transcript (that's the session), summary (that's a card field), episode (that's a 48h memory)

## Shape

A card is keyed by slug and is one JSON object:

```jsonc
{
  "slug": "pond",                       // [a-z0-9-], ≤ 64, the same slug rule as person cards
  "name": "pond",                       // required on create, ≤ 80
  "status": "active",                   // active | paused | done
  "summary": "…",                       // what it is, ≤ 1,200 (agent-written; loom never generates it)
  "goal": "…",                          // what done looks like, ≤ 400
  "where": {                            // where it stands: field name -> envelope, as person cards
    "now":     { "value": "dev-pond soak, prod cutover blocked on WAF", "verified_at": "2026-11-02T15:00:00Z",
                 "source": "t-1271", "stale_after_days": 7 },
    "next":    { "value": "Livonia S07–S20 back on the tailnet" }
  },
  "links": {                            // selectors for the hub; inert strings, never resolved as edges
    "aliases": ["on-pond", "toad"],     // memory `project` tag values that mean this project (the slug always counts)
    "notes":   ["pond/"],               // note path prefixes (default: ["<slug>/"])
    "epic":    "t-210",                 // the tasks piece's root for this project, passed to its feed as-is
    "repos":   ["onterris/pond"],       // shown, not fetched
    "venues":  ["slack:C0POND"]         // bridge venues whose conversations are this project's by default
  }
}
```

Schema rules (the write path rejects anything else, naming the field), the same family as person cards:

- Top-level keys: exactly `slug`, `name`, `status`, `summary`, `goal`, `where`, `links`. Unknown keys are rejected.
- `where`: ≤ 12 fields, names `[a-z0-9_]` ≤ 32, envelopes exactly as person cards (`value` required, ≤ 400 chars here
  because a project's state is wordier than a person's; `verified_at`, `source`, `stale_after_days` default 14).
- `links`: each key optional; arrays ≤ 16 strings of ≤ 200 chars; `epic` one string ≤ 64. Aliases follow the slug rule.
- Merge and replace, no-op detection, timestamps (`updated`, `synthesized_at` moved by passing `summary`), staleness
  markers (`[ok]`, `[unverified]`, `[STALE <n>d]`), archive/restore and revisions are **person cards' rules,
  unchanged**. The implementation shares that code rather than copying it.
- One alias belongs to one project. A write that would give an alias (or a slug) to a second active project is
  rejected, naming the project that has it, because a memory tag must resolve to one hub.

## Rendering

```
## pond (active)
<summary, or "_(no summary)_">
**Goal:** <goal>
**Where:** now: dev-pond soak, prod cutover blocked on WAF [ok] · next: Livonia S07–S20 back on the tailnet [unverified]
```

Cap: 2,000 chars at worst-case render, checked at write, exactly as person cards. `links` are not rendered at boot;
the hub shows them.

## The hub

`project_hub({slug, since?})` (since defaults to 7 days) returns the card plus sections, each one independent: a
section that fails is replaced by `{section, error}` and the others still return, the way identity treats a bad card.

**Core sections** (loom's own stores):

| Section | Contents |
|---|---|
| `memories` | not archived, not expired memories whose `project` tag is the slug or an alias. Newest 20 plus the 10 most salient, deduplicated. Counts per category |
| `notes` | notes under any `links.notes` prefix: path, lifespan, updated. Newest 20 |
| `people` | person cards with a `where` field named the slug or an alias: name, that field's envelope (value and staleness marker). "Where is Patrick on pond" is already a card field; this collects them |
| `activity` | the latest `updated` across the card, its memories and its notes: what the project list sorts by |

**Piece sections** (the seam). A piece offers a section by declaring it in its package's `loom` block:

```jsonc
"loom": {
  "sections": {
    "project": { "label": "Tasks", "argv": ["loom-tasks", "project-feed", "--json"] }
  }
}
```

loom runs `argv` plus `--project <slug> --since <iso>` and, when the card has them, `--epic <id>`,
`--alias <a>` (repeated) and `--venue <v>` (repeated), in the piece's own environment. It allows 5 s, then
gives up on that section. The piece prints:

```jsonc
{ "groups": [ { "title": "Waiting on you", "items": [
    { "title": "approve pond WAF exception", "when": "2026-11-02T14:10:00Z", "who": ["loren"], "status": "open",
      "ref": "t-1271", "body": "≤ 600 chars, shown folded" } ] } ] }
```

Limits: ≤ 8 groups, ≤ 50 items in total, and every string length-capped. loom validates the result and renders it
generically: a piece decides its own grouping (tasks: waiting on you / ready / blocked / done this week;
conversations: by day, then person). A piece that isn't installed, or doesn't declare `sections.project`, adds
nothing. loom never calls a piece's internals, and pieces never see each other (extensions.md rules 1–4).

## Conversation digests (the bridges piece's side, recorded so the seam is clear)

This part is shuttle's code, not loom's. It is the answer to "a Discord ping for every Slack ping".

- **A body writes a digest instead of flagging.** At the end of a turn that did something (a request, a decision, a
  task made or moved), the body runs `shuttle digest` with: conversation (agent · who · venue), people, project
  (zero or more slugs), summary (≤ 600), asks, decisions, task refs, and `needs_owner` (a reason, or nothing).
  There is one digest per conversation per day, and a later write that day replaces it (current state, like a card).
- **Which project.** The body decides. Its hints are the venue (`links.venues` on a card, offered to the body
  through the brief) and the person's card (`where.<project>` fields). An unassigned digest is still kept, and shows
  under "Unfiled" on loom's Home, never dropped.
- **Who gets pinged.** Only a digest with `needs_owner` pings the owner (a loom approval card or push, else the
  configured Discord flag). Everything else is read on the project's page. That replaces the briefs' "flag every
  on-behalf request to #general" line.
- **The section.** `loom-shuttle project-feed` returns the project's digests in the window, grouped by day, each item
  a conversation: `who` (people), `title` (the venue), `body` (the summary and asks), `ref` (task refs as text).
- The tasks piece's feed returns the epic's tree: waiting on the owner, ready, blocked, and done since `since`. A task
  made from a conversation cites the digest in its description, so the two sections cross-reference by text.

## Surfaces

**Write**: `project_write`, `project_verify`, `project_archive`/`project_restore` (`reason` required),
`project_history`, `project_revision_restore`. They are person cards' surfaces with the project schema.

**Read**:
- `project({slug, include_archived?})`: the card and its render.
- `project_list({status?, include_archived?})`: slug, name, status, activity, stale and unverified counts, and
  `memories_since_synthesis`. That last one is the memories tagged with the slug or an alias created after
  `synthesized_at`, which is how a consolidation lane finds summaries that have fallen behind, as with person cards.
- `project_hub({slug, since?})`: as above.
- CLI: `loom project show|list|hub <slug> [--json]`, with the exit codes of `loom person`.

**Identity**: `identity({..., project: "<slug>"})` adds the rendered card in a `# This project` block, after the tape
and before `# In the room`, capped at 2,000 chars, best-effort, and never failing identity. A body working in a
project's repo or conversation passes it, the way a bridge passes `people`.

**Memory**: `remember` with `project: <alias>` stays as it is. No memory is rewritten; aliases do the joining. A
`remember` whose project tag matches no card still works, and `project_list({orphans: true})` lists those tags with
counts. That's where a lane finds projects that ought to have a card.

**loom's page**: a Projects tab. The list shows active projects first, sorted by activity; each row has name,
status, the `where.now` line with its marker, and counts of new items per section since the owner last looked. A
project page shows the card, then the sections, piece sections in the order the owner sets. Home gets a "Today"
strip: projects with conversation digests or owner-needed items today. The page work is its own PR after the store
and tools land.

## Storage

The `projects` and `project_revisions` tables live in the memory database, next to `people`. A project, like a
person, is about the agent's work, so it's on memory's side of the memory/knowledge line. A new migration entry adds
them. Columns follow `people`, plus a `project_aliases` table (alias PK → slug) that makes the "one alias, one
project" rule a constraint rather than a check.

## Acceptance criteria (loom vitest)

1. `project_write` creates, merges and replaces per person cards' merge rules, with the project schema. Every schema
   rule rejects, naming the field.
2. A write that would give a slug or alias to a second active project is rejected, naming the holder. Archiving
   frees the aliases; restoring re-checks them.
3. No-op detection, revisions, archive/restore and revision restore behave as person cards (shared tests where the
   code is shared).
4. The worst-case render is ≤ 2,000 chars, and a write that would exceed it is rejected.
5. Staleness markers on `where`, as person cards.
6. `project_hub.memories` returns memories tagged with the slug or any alias, excludes archived and expired ones,
   and dedupes the newest-plus-salient union.
7. `project_hub.notes` returns notes under each prefix, with the default `<slug>/` when `links.notes` is absent.
8. `project_hub.people` returns person cards with a `where` field named the slug or an alias, with that field's
   marker.
9. A piece declaring `sections.project` is run with the documented arguments in its own environment, and its output
   is validated (caps, shapes). An invalid or slow (> 5 s) feed yields `{section, error}` and the other sections
   still return.
10. No piece installed means no piece sections and no error. A piece without `sections.project` is never run.
11. `identity({project})` adds the block in the stated place, within its cap, and never fails identity (missing,
    archived or unreadable card → a placeholder line, as person cards).
12. `project_list({orphans: true})` lists memory tags with no card, with counts.
13. The CLI: `loom project show|list|hub` with `--json` and the exit codes.

## First slice

1. The store, tools, CLI and identity block: criteria 1–8 and 11–13.
2. The section seam (9–10), with the tasks piece's `project-feed` as the pilot.
3. Shuttle's digests and feed (its own PR in shuttle), and Art's briefs swap the #general flag for digests.
4. The Projects tab and Home's "Today" strip.

Ops acceptance, outside loom's tests: cards for pond, hocket and loom, seeded by hand. Done when Jonathan opens pond and
sees what's queued (the tasks feed), who he and Art talked to this week with digests (the shuttle feed), and the
person cards' pond fields, and when a Slack ask without `needs_owner` no longer pings Discord.

## Decided, not open

- **Core, not a piece.** By extensions.md's test, a project manages the agent's continuity and knowledge: memories
  already scope by project, and identity will carry it. The hub's piece sections go through the seam, so tasks and
  bridges stay swappable.
- **Per-agent**, like person cards.
- **No live state stored.** Counts, "new since", and what's queued are computed.

## Open questions

- **Should a task row carry its project?** Today it's "under the epic". A task outside the tree (filed under another
  epic but about pond) is missed unless the tasks piece also matches the slug and aliases in its text. The pilot
  feed does both and reports which matched.
- **The owner's "since I last looked".** This needs a per-owner read mark. That's loom page state, not the card; it
  is left to the page PR.

## Review gate

As person cards: before this doc merges, a context-stripped reviewer from outside loom's authors reviews it, and every
finding is recorded in the PR thread as folded, accepted as a trade-off, or rejected with a quote.
