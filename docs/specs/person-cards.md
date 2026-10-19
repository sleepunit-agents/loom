# Person cards — the condensed current state of a person

*2026-10-19. Status: **proposed**. Taskstore t-1376 (parent t-179, the people
model). Design doc in the `docs/specs/` sense: it says what loom will build and
the acceptance criteria the implementation's vitest suite must pin. Per
`docs/archive/felag-specs/README.md`, loom's contract is `npm test`; this doc
is the agreement that precedes those tests, not a substitute for them.*

## Why

The agent talks to more than one human. Today what it knows about each of them
is a pile: `user` memories tagged `metadata.person=<slug>` (Patrick 120, Daniel
70, Allison 64 on Art's store as of today), plus a hand-kept `people.json` in
the Discord/Slack bridge whose header calls itself a *cache* of those memories,
plus one prose `why` paragraph per person that everything else gets dumped
into.

So "what time zone is Patrick in" or "where is Patrick on pond" is answered by
a recall query plus the agent's judgment, every turn, and it goes wrong:

- **c-0102, c-0111, c-0122** — Patrick is on Eastern time. The fact is in
  memory. Three separate conversations answered him in Central anyway, because
  nothing put it in front of the body that was talking to him.
- **c-0109** — the agent stated a person's access confidently from notes that
  were weeks stale. Nothing marked the note as old.

Both failures are the same shape: loom holds the facts, but holds them as
loose atoms, not as *a person*.

## What a card is (and is not)

> "your card for a person is a condensed version of all of those memories and
> such for them. things aren't an infinite growing branching tree like a
> knowledge graph. its just, the condensed version of what currently makes
> sense. patrick might like condensed today and tomorrow want you to talk like
> a fucking shakespearian actor. there's no logical connection between these,
> only the current state of his card." — Jonathan, Discord #art, 2026-10-19

That is the design rule, and everything below follows from it:

1. **A card is current state.** One value per field. When something changes,
   the value is overwritten. There are no edges to other records and no
   history modelled as structure.
2. **Prior state lives only in revisions.** A write snapshots the card it
   displaces (see Revisions). Revisions are for audit and undo, never read at
   boot.
3. **A card is not a knowledge page.** Knowledge is "true independent of the
   human"; a person's card is contextual to the agent's work with them. The
   existing rule (no knowledge pages for people) stands. Today it is a
   convention only. Criterion 7 adds a heuristic report for it, not
   enforcement (see the trade-off there). A card is a third kind of record.
4. **A card is not the memories.** The tagged memories stay where they are,
   remain the evidence, and remain the thing `recall` searches. The card
   *condenses* them; it does not replace or own them.

## Vocabulary (to be added to CONTEXT.md)

**Person**:
A human the agent works with, identified by a stable slug
(`patrick-kells`). Not a user account, not a
platform identity.
_Avoid_: user (that is a memory category), contact, profile, member

**Person card** (card):
The condensed current state of what the agent knows about one person:
structured fields plus a short synthesized summary. Overwritten in place;
revisions keep the past.
_Avoid_: profile, dossier (that is the worker brief), person page, record

**Card field**:
One named value on a card, optionally carrying `verified_at`.
_Avoid_: attribute, property, fact

**Room**:
The set of people a turn is addressed by. The harness (bridge, lane, voice)
knows who is in it; loom does not guess.
_Avoid_: audience, channel (a room is people, not a venue)

## Shape

A card is keyed by person slug and is one JSON object:

```jsonc
{
  "slug": "patrick-kells",            // path-segment-safe, lowercase [a-z0-9-], ≤ 64 chars
  "name": "Patrick Kells",            // required on create, ≤ 80 chars
  "summary": "…",                     // optional, ≤ 1,200 chars
  "where": {                          // field name -> envelope
    "pond": { "value": "field / et-livonia", "verified_at": "2026-09-28T14:00:00Z",
              "source": "pond /api/tadpoles", "stale_after_days": 7 }
  },
  "how": { "tz": "America/New_York", "mode": "terse", "loop_in": ["phil-baker"] },
  "may": [ { "text": "may draft field-setup changes for ET Livonia",
             "source": "Jonathan, Discord #art 2026-10-16" } ]
}
```

Schema rules (the write path rejects anything else, with an error naming the
field):

- Top-level keys: exactly `slug`, `name`, `summary`, `where`, `how`, `may`.
  Unknown keys are rejected.
- Field names inside `where` and `how`: `[a-z0-9_]`, ≤ 32 chars, ≤ 12 fields
  per section. The names themselves are open, like memory categories.
- A value (`how.*`, `where.*.value`) is a string (≤ 200 chars), a number, a
  boolean, or an array of ≤ 8 such strings.
- `where` envelope: `value` required; `verified_at` optional ISO-8601 UTC, not
  in the future (1 minute of clock-skew grace); `source` optional string ≤ 200;
  `stale_after_days` optional integer 1–365, default 14.
- `may`: an array of ≤ 8 `{text, source}`; both are required, and each is ≤ 200
  chars.
- `how.loop_in` and any other value that looks like a slug are **inert
  strings**. loom never resolves, validates or cascades them. A card has no
  edges (rule 1).
- Reserved key names: `tier`, `field`, `projects`, `scope`, `trust`. A
  reserved key may not appear as a field name in `where` or `how`, and may not
  be a key inside any value. These are the harness's gating names (see
  "`may` is descriptive"). The list is fixed in loom's code, not configured.

There is no `live` section. Things like open tasks or the last conversation are
for the caller to compute; loom does not store them.

### Merge and replace

- `person_write` with `merge` true (the default): each section passed is
  merged **one level deep**. A field passed in `where` or `how` replaces that
  field's whole envelope or value. A field passed as `null` is removed.
  `summary` and `name` replace. `may`, when passed, replaces the whole array.
  Sections not passed are untouched.
- `merge: false`: the card becomes exactly what was passed. Omitted sections
  become empty, and `name` is still required.
- Writing a slug that does not exist creates the card, and `name` is
  required.
- A write whose merged result equals the current card is a no-op. It is not
  stored, it does not snapshot, and it returns `unchanged: true`.

### Timestamps

- `updated`: set on every stored write, verify, archive, restore and revision
  restore.
- `synthesized_at`: set **only** when a write passes `summary` (including on
  create). Nothing else moves it. A card that has never had a summary has
  `synthesized_at: null`.

### Staleness on `where`

A `where` field is **stale** when `now − verified_at > stale_after_days × 86,400 s`
(strictly greater). It is **unverified** when it has no `verified_at`. It is
never shown as fresh in that case.

## Rendering

The rendered card is the text that identity and `person` return. The grammar
is fixed so that size is testable, and lengths are JS string `.length`:

```
## Patrick Kells (patrick-kells)
<summary, or "_(no summary)_">
**Where:** pond: field / et-livonia [STALE 21d] · slack: U0… [ok] · github: pk [unverified]
**How:** tz: America/New_York · mode: terse · loop_in: phil-baker
**May (descriptive, not a grant):** may draft field-setup changes for ET Livonia — Jonathan, Discord #art 2026-10-16
```

- Fields are listed in name order. Arrays are joined with `, `.
- The marker is one of `[ok]`, `[unverified]`, `[STALE <n>d]`. `<n>` is
  capped at `999+`, so the marker is at most 13 characters wide.
- A line whose section is empty is left out.

**Size cap (2,000 chars).** It is checked at write time against the
**worst-case render**: every `where` marker counted at its widest form
(`[STALE 999+d]`). Time passing therefore can never push a stored card over
the cap, and reads never truncate.

## Archive

`person_archive({slug, reason})` soft-retires a card. It stores a tombstone
(who, when, why) on the row, using the same grammar as memory and page archive.
An archived card:

- is left out of identity's room block. In its place there is the line
  `_(card for <slug> is archived)_`.
- is returned by `person` only with `include_archived: true`, and is marked
  archived.
- is left out of `person_list` unless `include_archived: true`.
- rejects `person_write`, `person_verify` and `person_revision_restore`.
  Restore it first. `person_restore` reactivates it and keeps its fields.

There is **no hard-delete surface** in this doc. If one is ever added, it
follows purge's rule: archived first, then `confirm: true`, and its revisions
are removed with it.

## Revisions

`person_revisions(id, slug, snapshot_json, op, replaced_at)`. `op` is one of
`write | verify | archive | restore | revision_restore`. Every stored change
inserts a snapshot of the **whole previous row** (card JSON, archive state and
timestamps) before it applies. No-ops insert nothing. The newest 10 are kept
per slug, and older ones are pruned in the same transaction.

`person_revision_restore({slug, revision_id})` rejects a revision belonging to
another slug. It validates the snapshot against the current schema and rejects
it if that fails. It snapshots the card it displaces (op `revision_restore`)
and does not change archive state.

## Atomicity

Each mutating call (write, verify, archive, restore, revision restore) runs as
**one SQLite transaction opened with `BEGIN IMMEDIATE`**: read current row,
merge, validate, snapshot, write, prune revisions. That is the same pattern as
the knowledge page write in `src/backends/sqlite-knowledge.ts`. loom's
one-writer rule is a convention about *who* writes. It does not serialize
concurrent calls from several bodies, so the transaction is what does that.

## `may` is descriptive, not a grant

**The card is not an authorization surface.** The agent writes its own cards.
An agent that can write "may approve purchases for Patrick" into a record that
something then *enforces* has granted itself authority. So:

- Trust tiers and scopes that gate actions stay in the harness, in a file the
  agent's tool layer does not write. Today that means `tier`, `field` and
  `projects` in Art's bridge `people.json`. loom never reads them for gating.
  The reserved key names above keep them from being copied onto a card, where
  they would look like gates.
- `may` entries are a record of what was said, and each has a `source`. They
  inform judgment and never replace a harness check.

## Surfaces

**Write**
- `person_write({slug, name?, summary?, where?, how?, may?, merge?})` follows
  Shape and Merge and replace above. It returns the stored card, `unchanged`,
  and the new revision id (if any).
- `person_verify({slug, fields: [name, ...], verified_at?, source?})` stamps
  the listed `where` fields. `verified_at` defaults to now. `source` is
  replaced only if one is passed. Values are not changed. It is
  all-or-nothing: an empty list, an unknown field or a missing card rejects
  the whole call. It deliberately has no outcomes and no audit table, unlike
  `knowledge_verify`. A failed check is recorded by not stamping. It snapshots
  (op `verify`).
- `person_archive` / `person_restore` work as in Archive.

**Read**
- `person({slug, include_archived?})` returns `{rendered, card, archived,
  updated, synthesized_at}`. A missing card returns `{found: false}`, which is
  not an error.
- `person_list({include_archived?})` returns, per card: slug, name, archived,
  updated, synthesized_at, stale and unverified field counts, and
  `memories_since_synthesis`. That last one is the count of memories with
  `category = 'user'`, `metadata.person = <slug>`, not archived, not expired,
  and `created > synthesized_at` (all of them when `synthesized_at` is null).
  "Created" is the creation time. An edit to an old memory does not count.
  That is a known blind spot, kept because counting updates would also count
  metadata-only changes.
- `person_history({slug})` lists revision ids, ops and times, newest first.
  `person_revision_restore` works as in Revisions.
- CLI: `loom person show <slug> [--json]` prints `rendered`, or with `--json`
  the `person` result. `loom person list [--json]` does the same for the list.
  Exit 0 when found, and 3 when there is no such card.

**Identity: `identity({..., people: [slug, ...]})`**
- It adds a `# In the room` block **after the tape and before Top of Mind**.
- Slugs are deduplicated in first-seen order. An empty list or no `people`
  gives no block, so existing callers see no change.
- **Room budget:** at most 4 cards and 6,000 chars of card text. Cards are
  added in list order until the next one would go over. The slugs left out are
  named on one closing line: `_(cards omitted for budget: a, b)_`.
- Each slug gets one of: the rendered card, `_(no card for <slug>)_`,
  `_(card for <slug> is archived)_`, or `_(invalid slug: <slug>)_` for a slug
  that fails path-segment validation. None of these fail identity.
- **Best-effort, like the tape:** if the store cannot be opened, the people
  table is missing (not migrated yet), or a row's JSON does not parse, the
  affected cards (or the whole block) are left out. The error is logged and
  passed to `recordFailure`. Identity never fails because of cards.

**Synthesis**
- The agent writes `summary`, normally in a consolidation pass. loom does not
  generate it. loom stays "assembled from authored atoms, never generated".
  `person_list`'s `synthesized_at` and `memories_since_synthesis` are how a
  lane finds summaries that have fallen behind.

## Storage

The `people` and `person_revisions` tables live in **the memory database**,
at the path `resolveSqliteDbPath(contextDir)` returns (so `LOOM_SQLITE_DB_PATH`
is honoured). That is the same database the evidence memories live in. A card
is about a human, so it belongs on memory's side of the memory/knowledge line.
The tables are added by a new entry in `src/backends/migrations.ts`, and
identity and the CLI open the store through the same resolver. `people`
columns: `slug` (PK), `name`, `card_json`, `archived_at`, `archived_by`,
`archive_reason`, `updated`, `synthesized_at`.

Cards are per context directory, the same as memory. An agent's cards are its
own.

## The harness side (Art's bridge: not loom's code, recorded so the seam is clear)

- `people.json` shrinks to identity resolution and gating: platform ids → slug,
  `tier`, and the field/project scopes. Its `why` prose moves into card
  summaries and is deleted.
- Each turn, the bridge resolves the speakers to slugs and passes them (tier
  ≥ 2 only) as `people`. A tier-1 stranger gets no card even if one exists. The
  bridge may also splice `loom person show` output into the prompt itself, so
  the card arrives even when a body forgets to pass `people`.

## Acceptance criteria (loom vitest)

1. **Overwrite, not accumulate.** Write `how.mode = "terse"`, then
   `how.mode = "shakespearean"`. The card holds `"shakespearean"` only, and
   `person_history` has exactly one `write` revision whose snapshot holds
   `"terse"`.
2. **Merge.** A write passing only `how.tz` leaves `summary`, `where`, `may`
   and the other `how` fields unchanged. `how.tz: null` removes `tz`.
   `merge: false` with only `name` empties every section. A repeated
   identical write returns `unchanged: true` and adds no revision.
3. **Staleness.** With a fixed clock: a `where` field verified
   `14d + 1s` ago (default threshold) renders `[STALE 14d]`. One verified
   exactly 14d ago renders `[ok]`. One with no `verified_at` renders
   `[unverified]`. `stale_after_days: 7` makes an 8-day-old field stale.
   After `person_verify` the same field renders `[ok]` and its value is
   unchanged.
4. **Identity splice.** `identity({people:["patrick-kells"]})` puts
   `# In the room` with the rendered card between the tape block and Top of
   Mind. `people:["nobody"]` gives `_(no card for nobody)_`. `people:["../x"]`
   gives the invalid-slug line. `identity({})` and `people:[]` give no block.
   With a store that has not been migrated, identity still returns and has no
   block.
5. **Room budget.** Six valid slugs (with duplicates) give at most 4 cards, at
   most 6,000 chars of card text, duplicates collapsed, and an omitted-for-budget
   line naming the rest.
6. **Not a gate.** A write with `where.tier`, `how.projects`, or a value object
   containing a `tier` key is rejected, and the error names the reserved key.
   A `may` entry without `source` is rejected. An unknown top-level key is
   rejected.
7. **Size caps.** A summary over 1,200 chars is rejected. A card whose
   worst-case render is over 2,000 is rejected. A card accepted at 1,990
   worst-case chars still renders at ≤ 2,000 after the clock moves 1,000 days.
8. **Archive.** An archived card is replaced in identity by the archived line,
   is missing from `person_list` by default, and rejects write, verify and
   revision restore. `person_restore` brings it back with its fields intact.
9. **Revisions.** `person_revision_restore` with another slug's revision id
   is rejected. A successful restore adds a `revision_restore` snapshot. The
   number of revisions kept is capped at 10.
10. **Atomicity.** Two `person_write` calls on separate connections to the
    same db file, setting different `how` fields, both survive. (This is
    serialized through `BEGIN IMMEDIATE`, and the test interleaves them through
    `busy_timeout`.)
11. **Path safety.** Slugs validate with `pathSegmentError` and the slug
    regex at every surface.
12. **One writer, stated.** The dossier text says worker bodies must not
    write cards. (Today's dossier says nothing about memory writes either. This
    adds the sentence for cards and does not claim more.)
13. **Misfile heuristic.** `knowledge_maintain` reports an active page whose
    slug or title contains a person card's slug or exact `name` as a possible
    person-page misfile. *Trade-off, stated:* this is a report, not
    enforcement. A page about someone who has no card, or a page that names
    them some other way, still passes. It reads the cards of the same context
    directory. If the memory store cannot be opened it skips the check and
    says so. It inherits the existing 1,000-page scan limit.

## First slice

Ship criteria 1–8, 11 and 12, the CLI read, and the identity `people` param.

The ops acceptance below is outside loom's tests: it is checked in Art's
bridge, not in this repo. Seed one card by hand, `patrick-kells`, with
`how.tz = America/New_York`, `how.mode = terse`, and a summary condensed from
his memories, and have the bridge pass `people: ["patrick-kells"]` when Patrick
speaks. Done when a captured bridge prompt for a Patrick turn contains his
rendered card, and a test question "what time is it for me?" is answered in
Eastern time without being told.

Next: cards for the other tier-2 people, moving the `why` text out of
`people.json`, and a consolidation-lane step that refreshes summaries with a
high `memories_since_synthesis`. Criteria 9, 10 and 13 land then, if they did
not land in the first slice.

## Decided, not open

- **The creed's own human gets no card.** This is a seeding policy, not
  validation. `preferences.md` and the creed already describe Jonathan, and two
  sources for one person is the drift this feature exists to stop. loom does
  not block such a write. Art's seeding lane simply never makes one.
- **Per-agent.** Mark and Gabe talk to the same people from their own context
  directories. Sharing cards across agents is out of scope.

## Open questions

- **Staleness default.** 14 days is the default for every field until real
  use argues for per-system defaults. Any field can already override it with
  `stale_after_days`.

## Sources

The conversation IDs (c-0102 and so on) and person counts come from Art's ops
repo (`sleepunit-agents/art`): retro grading notes and the bridge's
conversation log. The t-ids are rows in Art's taskstore. They are cited as
provenance and are not needed to implement this doc.

## Review gate

Before this doc merges, a context-stripped reviewer from outside loom's
authors reviews it for holes that Art and Mark miss because they live inside
loom (Jonathan, 2026-10-19). It gets this repo and this PR, and no loom
identity or agent context. The PR is not merged until each finding has been
recorded in the PR thread as folded, accepted as a trade-off, or rejected with
a quote.
