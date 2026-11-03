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
   rule Art has followed until now (no knowledge pages for people, in its
   bridge's `people.json` header) stands, and this doc makes it loom's policy
   for **contextual** person records. That is narrower than it sounds: loom's
   CONTEXT.md line ("knowledge is about the world") still allows a page about
   a public figure's published work. Today it is a
   convention only. Criterion 13 adds a heuristic report for it, not
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
  become empty, and `name` is still required. Omitting `summary` here removes
  the summary (see Timestamps).
- **Where `null` is allowed.** Only as the value of a named field directly
  under `where` or `how`, in a merge write: that is the delete. Everywhere else
  it is rejected with an error naming the path: any `null` under
  `merge: false`, `name`/`summary`/`where`/`how`/`may` themselves as `null`,
  `null` inside a `where` envelope (`value`, `verified_at`, …), inside an
  array value, or as a `may` entry or its `text`/`source`. To clear a whole
  section, use `merge: false`.
- Writing a slug that does not exist creates the card, and `name` is
  required.
- A write whose merged result equals the current card (compared as
  canonical JSON with sorted keys) and that does not pass `summary` is a
  no-op. It is not stored, it does not snapshot, and it returns
  `unchanged: true`. Validation runs before the comparison, so an invalid
  request is rejected even when it would change nothing. Removing a field that
  is not there (`null`) is allowed and changes nothing.

### Timestamps

- `updated`: set on every stored write, verify, archive, restore and revision
  restore.
- `synthesized_at`: set when a write passes `summary` (including on create),
  **even if the summary text is unchanged**. Passing `summary` is how the
  agent says "I re-read the evidence and this is still right". So a write that
  passes `summary` is never a no-op: it stores, snapshots, and moves
  `synthesized_at`. No other write moves it. A revision restore sets it to
  the restored snapshot's value, because an old summary is exactly as fresh as
  when it was written. A card with no summary has `synthesized_at: null`.
- A `merge: false` write that omits `summary` removes the summary **and resets
  `synthesized_at` to `null`**. Keeping the old timestamp would date a summary
  that no longer exists: `memories_since_synthesis` would count only memories
  newer than it, could read zero, and the consolidation step would never
  resynthesize the card.

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
`write | verify | archive | restore | revision_restore | merge | merged_from`
(the last two are person_merge's, see Merge). Every stored change
inserts a snapshot of the **whole previous row** (card JSON, archive state and
timestamps) before it applies. No-ops insert nothing. The newest 10 are kept
per slug, and older ones are pruned in the same transaction.

`person_revision_restore({slug, revision_id})` rejects a revision belonging to
another slug. It validates the snapshot's card **structurally** (keys, types,
lengths and the worst-case render cap) and rejects it if that fails. Time
checks (future `verified_at`) are not re-applied, because the snapshot was
valid when it was written. It snapshots the card it displaces (op `revision_restore`)
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
  `knowledge_verify`. A failed check is recorded by not stamping. `verified_at`
  and `source` get the same validation as on write. A verify that changes
  nothing is a no-op, like any other. Otherwise it snapshots (op `verify`).
- `person_archive({slug, reason})` / `person_restore({slug})` work as in
  Archive. `reason` is required (≤ 200 chars). The actor is the calling
  agent's name, which is the same value `knowledge_write` uses for `author`.
  Archiving an archived card, or restoring an active one, is a no-op and
  returns `unchanged: true`. Either call on a missing card is rejected.

**Ensure** (2026-11-02: a person is one card, however they were added)

Adding a person anywhere outside an agent's own tools (a piece letting someone into
an agent's gates, the runtime's gates, the owner by hand) makes sure they have a card,
so the People page and every agent see them once. Agents keep writing cards with
`person_write`; this is the one seam for everyone else.

- `POST /api/loom/people/ensure` with `{slug, name, role?, source, where?, agent?,
  dry_run?}`, where `where` maps a field to `{value, label?, source?}` and `value` is a
  string or up to 8. On loom's machine: `loom person ensure` with the same body on stdin,
  or `loom person ensure <slug> --name <n> [--role <r>] [--source <s>]
  [--where <field>=<value>]... [--agent <a>] [--dry-run]`.
- **No card:** a minimal one is made: the name, the summary `<role>. From <source>.`
  (`From <source>.` without a role), and the `where` values, each with the call's
  `source` unless it has its own. In a household the name and handles go to the
  directory and the summary to `agent`'s relationship (the household's default agent
  when none is named), the same split `person_write` makes.
- **A card:** only the `where` values it lacks are added, beside the ones there, as
  `loom person reach` adds an id: a value whose id (its first word) is already in the
  field, however it was written, counts as there. The field's label and source are set
  only when it has none. Name, summary, how and may are never touched, and an existing
  card gets no relationship it didn't have. A call that adds nothing is a no-op.
- **One person, one card:** a value already on another card (by id, in the same field)
  refuses the whole call (409), naming that card. An archived card refuses too (409):
  restore it first.
- **Refused like a write:** a bad slug, a reserved key (as a field or inside one), an
  unknown key, empty or over-long text (400). Nothing is written.
- **Who may call it:** a household owner (their token); the runtime (its token: its
  gates name a card, agent-runtime.md section 6); and a piece's process in an owner's
  action, which carries the grant loom minted for that action (`LOOM_STORE_GRANT`,
  piece-storage.md): `loom person ensure` reads it from the environment, and the route
  takes the piece's own credential with the grant in `X-Loom-Store-Grant`. Either way
  loom checks it as `loom store` does (signed by loom, unexpired, that piece's) and
  that it is an owner's. A piece's own process, or one serving an agent, is refused
  (exit 5, 403), and so are agent, agent-owner, peer and review tokens. `person ensure`
  never runs over `POST /cli`. The revision records who: the owner, `<who> via <piece>`,
  or `runtime:<piece>`.
- `dry_run: true` answers what would change and writes nothing (it opens the stores
  read-only), so on loom's machine any process may ask one (a piece's backfill
  report); the route still takes only the callers above. The CLI takes several bodies,
  one per line, so the owner can pipe a piece's list in (`loom shuttle cards-backfill
  --bodies | loom person ensure`); each is answered on its own line. The answer is `{slug, created, added: {field: [values]}, unchanged,
  dry_run, card}`.
- Like `reach`, it reads the card and then writes it: two calls racing on one card can
  each add their own id, and the later write keeps both only if each read the other's.
  It's for the rare moment a person is added, not a hot path.

**Merge** (2026-11-02: two cards that turn out to be one person become one)

Two agents each talked to the same human and each made a card; then they find it's one
person. `person_merge({from, into, dry_run?})` makes the two one, and afterwards nothing in
loom points at `from`.

- **Surfaces.** The MCP tool, for an agent: in a household its household holds both cards
  (the shared directory), outside one its own store does; the revision names the agent.
  `loom person merge <from> <into> [--dry-run] [--json]` for the owner on loom's machine (a
  piece's process is refused, exit 5; exit 3 for a missing card, 1 for any other refusal;
  never over `POST /cli`). `POST /api/loom/people/merge {from, into, dry_run?}` for a
  household owner (an agent owner, an agent, a piece, a peer or a review token is 403) and
  for the runtime; 404 for a missing card, 409 for a refusal, 400 for a bad request.
- **The card.** `where` is the union of both cards' values per field, by id (a value whose
  id is already in the field counts as there, as ensure and reach count it). A field only
  `from` has comes whole, with its own `verified_at`, `source`, `label`. A field both have
  keeps one envelope, because the schema has one per field: checked at the older of the
  two times (unverified if either side is), both sources joined, both labels joined, the
  shorter `stale_after_days`. `from`'s own envelopes stay in its archived row and in
  `into`'s history. `how` and `may` are the union, `into` winning a key (`may` entries are
  the same when text and source are). Name and summary are `into`'s (an agent's copy that
  has no `into` summary takes `from`'s), and the summary gains one line,
  `Merged <from> (<from's name>) <YYYY-MM-DD>`. The merged card must pass the usual
  schema, or the merge is refused naming why, and nothing is written.
- **Every copy.** In a household that's done to the directory entry (name, `where`, facts)
  and to every agent's own copy (summary, the rest of `how`, `may`): an agent that had
  both merges them, one that had only `from`'s now has it as `into`'s, one that had only
  `into`'s gets the line. Where a copy took `from`'s content or memories were re-tagged,
  its `synthesized_at` resets to null, so `memories_since_synthesis` counts every tagged
  memory and the consolidation lane re-reads them.
- **Re-tags,** in every agent's store the household owner can reach (outside a household,
  the one store): memories with `metadata.person = from` or `from` in `metadata.people`
  (archived ones too) and memory proposals the same, without touching `updated`;
  `conversations.people_json`; every `conversation_turns.from_json` from the person.
  `how.via` and `how.loop_in` naming `from` on any card, directory or relationship, are
  pointed at `into` (inert strings everywhere else, rule 1; these two are slugs by
  design). household.db holds no person slug (`conversation_strangers` is keyed by
  conversation, and is left as is). A project card holds none either: a hub's people are
  the person cards with a `where` field named for the project, so they follow the merged
  `where` (the dry run names the hubs that list `from` today).
- **The redirect.** `from` is archived (`archive_reason: merged into <into>`, the merger
  as `archived_by`) and `person_merges(from_slug, into_slug, merged_at, merged_by,
  counts_json)` records it, in the directory and in every agent's store the merge
  touched. Reading `from` returns `into`'s card with `merged: {from, into, at}` and a last
  rendered line `_(<from> was merged into <into> <date>: this is <into>'s card)_`; the
  room block reads it as `into`, once however it's named; the People page opens `into`.
  A later `person_write`, `person_verify`, ensure or `loom person reach` to `from` lands
  on `into` and says `redirected_from`. Ensure doesn't count `from`'s archived values as
  another card's. `person_restore` of `from` is refused. `person_list({include_archived:
  true})` marks it `merged_into`. Redirects are followed when `into` is merged on later.
  The redirect lasts until it's purged by hand (there is no purge surface).
- **Refused:** either card missing (404); either archived (restore it first; an `into` that
  is itself a redirect names its own `into`); `from` equal to `into`; `from` already merged
  elsewhere; `from` one of the household's agents, or a household member (their tokens and
  sign-ins name them: merge the other way); an agent's entry merged with a person's.
- **History.** `into` gets a `merge` revision (the card it was) and a `merged_from` one
  (`from`'s card as it was, its summary with it, under `into`'s slug: listed by
  `person_history`, never restorable onto `into`); `from` gets a `merge` revision before
  it's archived. Every revision names the merger. `person_merges.counts_json` holds what
  was re-tagged, per agent (`memories`, `proposals`, `conversations`, `turns`, the cards
  relinked) and the directory's relinked cards.
- **Order and crashes.** One SQLite transaction per database. In a household: the
  directory first (its card, `from`'s archive and the redirect together), then each
  agent's store (its copy, its redirect, its re-tags), then the counts. A crash between
  them leaves at worst a redirect with some stores not yet re-tagged: running the same
  merge again sees the redirect (`resumed: true`) and finishes them. Outside a household
  it's one transaction.
- **`dry_run: true`** opens every store read-only and answers what would change:
  `where_added` (by field), `how_added`, `may_added`, the merged card, per agent the card
  step and the memories, proposals, conversations and turns it would re-tag, the cards it
  would relink, and the project hubs that list `from`.

**What a card merge doesn't do.** It doesn't rename the slug in any agent's gates: those
are the harness's (today shuttle's per-agent gate lists, which have their own people-merge
owner action, shuttle#51, `shuttle/gates_page.py` `_merge`, one agent's list at a time).
After a card merge, rename `from` to `into` in every agent's gates; the answer's `not_done`
says so (t-1746 carries it into the runtime). It doesn't rewrite text: memory bodies,
notes, knowledge pages and conversation digests that write the old slug in prose keep it.
A piece that stores person slugs in its own store renames them itself. The audit log's
redaction still knows `from`'s name and slug, because its archived card stays.

**Read**
- `person({slug, include_archived?})` returns `{found: true, rendered, card,
  archived, updated, synthesized_at}`. A missing card returns `{found: false}`,
  which is not an error. An archived card read without `include_archived`
  returns `{found: true, archived: true}` and nothing else, and the CLI exits
  4 for it.
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
- **Room budget:** the whole block, placeholders included, is at most 6,500
  chars, and `people` is truncated to its first 8 distinct slugs before
  anything else happens. Slugs are processed in list order. Each rendered card
  uses one of 4 card slots and its length counts against 6,000 chars.
  Placeholder lines use no card slot, but their length counts. The first card
  that would go over a limit is skipped and processing continues, so a smaller
  card later in the list can still fit. Any slug longer than 64 chars is
  replaced by `_(invalid slug)_` and never echoed. 400 chars of the 6,500 are
  reserved for the closing line: `_(N cards omitted for budget: a, b, …)_`,
  which lists the omitted slugs (skipped ones first, then truncated ones)
  until the next would overflow, and then ends in `…`. The count N is always
  the full number omitted.
- Each slug gets one of: the rendered card, `_(no card for <slug>)_`,
  `_(card for <slug> is archived)_`, `_(card for <slug> is unreadable)_`, or
  `_(invalid slug: <slug>)_` for a slug that fails `pathSegmentError` **or**
  the slug regex (`Patrick` is invalid). None of these fail identity.
- **Best-effort, like the tape:** if the store cannot be opened or the
  people table is missing (not migrated yet), the whole block is left out. If
  one row's JSON does not parse, fails the stored-card schema, or throws
  while rendering, only that slug is affected: it renders
  `_(card for <slug> is unreadable)_` and the other cards still render. Each
  failure is logged and passed to `recordFailure`. Identity never fails because
  of cards.

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

Cards belong to **the database**, the same as memories. Two context
directories that point `LOOM_SQLITE_DB_PATH` at one file share their memories
today, and they share cards the same way. This doc does not change that.

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
   `merge: false` with only `name` empties every section. Repeating an
   identical write that **omits `summary`** returns `unchanged: true` and adds
   no revision. `null` is rejected, with the path named, for `summary: null`,
   `how: null`, `where.x.verified_at: null`, a `null` inside an array value,
   and any `null` under `merge: false`.
   `merge: false` without `summary` on a card that had one leaves `summary`
   empty and `synthesized_at: null`, and `person_list` counts every tagged
   memory in `memories_since_synthesis`.
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
   is rejected. A successful restore adds a `revision_restore` snapshot.
   Restoring the revision from before a summary-removing `merge: false` write
   brings back both the summary and that snapshot's `synthesized_at`;
   restoring the one after it gives no summary and `synthesized_at: null`. The
   number of revisions kept is capped at 10.
10. **Atomicity.** This mirrors `src/backends/sqlite-knowledge-write-race.test.ts`.
    A test hook fires right after `person_write` reads the existing row, and
    in it a second connection tries to write a different `how` field. Pass
    condition: the competing write cannot land inside that window (it gets
    `SQLITE_BUSY`, then retries after the first commits), and the final card
    holds **both** fields. An implementation that reads outside the
    transaction fails, because the hook's write lands and is then
    overwritten.
11. **Path safety.** Slugs validate with `pathSegmentError` and the slug
    regex at every surface.
12. **One writer, stated.** The dossier text says worker bodies must not
    write cards. (Today's dossier says nothing about memory writes either. This
    adds the sentence for cards and does not claim more.)
13. **Misfile heuristic.** `knowledge_maintain` reports an active page whose
    slug or title contains a person card's slug or exact `name` as a possible
    person-page misfile. *Trade-off, stated:* this is a report, not
    enforcement. A page about someone who has no card, or a page that names
    them some other way, still passes. Matching is case-insensitive on whole
    hyphen- or space-delimited words, uses only active cards, and skips pages
    that are already exempt from the misfile audit (`ours/` with internal
    sourcing). **Only the full loom server and CLI run this check.** The
    knowledge-only server (`src/transport/knowledge-server.ts`) serves other
    identities and never opens the memory database. There, `knowledge_maintain`
    leaves the check out and says so, so cards never leak through a shared
    surface. It inherits the existing 1,000-page scan limit.

## First slice

Ship **all of criteria 1–12**, the CLI read, and the identity `people` param.
Revisions and atomicity are behaviour every write depends on, so they are not
deferred. Only criterion 13 (the misfile heuristic) may land later.

The ops acceptance below is outside loom's tests: it is checked in Art's
bridge, not in this repo. Seed one card by hand, `patrick-kells`, with
`how.tz = America/New_York`, `how.mode = terse`, and a summary condensed from
his memories, and have the bridge pass `people: ["patrick-kells"]` when Patrick
speaks. Done when a captured bridge prompt for a Patrick turn contains his
rendered card, and a test question "what time is it for me?" is answered in
Eastern time without being told.

Next: cards for the other tier-2 people, moving the `why` text out of
`people.json`, and a consolidation-lane step that refreshes summaries with a
`memories_since_synthesis` ≥ 5. Criterion 13 lands then if it did not land in
the first slice.

## Left to the implementation PR, deliberately

Some details are pinned by the implementation's vitest suite rather than
written out here: escaping inside rendered values (newlines become spaces,
Markdown is passed through as-is), how multiple `may` entries are separated
(` · `), the exact slug regex (`^[a-z0-9]+(-[a-z0-9]+)*$`), the text format of
`loom person list`, and the tombstone column names. Each of those is a choice
a reviewer can check in the implementation PR's diff and tests. None of them
changes what the agent or a harness sees in a way this doc relies on.

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
