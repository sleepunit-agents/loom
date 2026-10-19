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
2. **Prior state lives only in revisions.** Same mechanism and retention as
   `memory_revisions` / page revisions: a write snapshots what it displaces.
   Revisions are for audit and undo, never read at boot.
3. **A card is not a knowledge page.** Knowledge is "true independent of the
   human"; a person's card is contextual to the agent's work with them. The
   existing rule (no knowledge pages for people) stands; today it is a
   convention only, and criterion 7 gives it a check. A card is a third kind of record.
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

A card is keyed by person slug and holds:

| Section | Purpose | Examples | Carries `verified_at`? |
|---|---|---|---|
| `summary` | 3–8 sentences: who they are to the agent's work, synthesized from their memories | "Field lead at ET Livonia…" | no (has `synthesized_at`) |
| `where` | Where the person is: accounts and roles on systems | `slack`, `discord`, `github`, `pond: {account, role}`, `sms_alerts`, `dust` | **yes, per field** |
| `how` | How they want to be dealt with | `tz: America/New_York`, `mode: terse`, `loop_in: [phil-baker]` | no |
| `may` | What the agent believes it is permitted to do for them — descriptive | "may draft field-setup changes for ET Livonia" | no, but each entry carries `source` |
| `live` | Not stored. Computed at read time by the caller if wanted (open tasks, last conversation) | — | — |

Fields are an open map within each section (like memory categories are open):
loom validates the section names, value size, and the `verified_at` / `source`
envelopes, not the field names. A card has hard size caps (summary ≤ 1,200
chars, whole rendered card ≤ 2,000 chars) because it rides along with identity
on every turn the person is in the room.

### `verified_at` on `where`

Each `where` field is `{value, verified_at, source}`. Reading a card renders a
field whose `verified_at` is older than its staleness threshold (default 14
days; per-field override) as **stale**, visibly, in the card text:

```
pond: field / et-livonia  (checked 2026-09-28 — STALE, 21d; re-check before relying on it)
```

This is c-0109 caught by structure: the body does not have to remember to
doubt itself; the card says so. A `where` field written without `verified_at`
renders as *unverified*, never as fresh.

### `may` is descriptive, not a grant

**The card is not an authorization surface.** The agent writes its own cards.
An agent that can write "may approve purchases for Patrick" into a record that
something then *enforces* has granted itself authority. So:

- Trust tiers and scopes that gate actions (`tier`, `field`, `projects` in
  today's `people.json`) **stay in the harness**, in a file the agent's tool
  layer does not write. loom never reads them for gating and never exports
  them as if they were gates.
- `may` entries are memory-of-what-was-said, each with a `source`
  ("Jonathan, Discord #art 2026-10-16"). They inform judgment; they don't
  replace a harness check.
- A card write that tries to set a key named `tier` (or under `where`/`how`
  any key the harness declares reserved) is rejected.

## Surfaces

**Write**
- `person_write({slug, name?, summary?, where?, how?, may?, merge?: true})` —
  default is merge (field-level overwrite of what is passed, keep the rest);
  `merge: false` replaces the card. Every write snapshots the displaced card
  into `person_revisions`. Same one-writer rule as memory: worker bodies do
  not write cards.
- `person_verify({slug, fields: [...], verified_at?, source})` — restamps
  `where` fields without changing values (mirrors `knowledge_verify`).
- `person_archive` / `person_restore` — same soft-retire grammar as pages and
  memories. No hard delete without `confirm`.

**Read**
- `person({slug})` — the rendered card (text, the same block identity
  injects) plus the raw JSON.
- `person_list()` — slugs, names, stale-field counts, `synthesized_at`. For a
  maintenance lane looking for cards to refresh.
- `person_history({slug})` / `person_revision_restore` — revisions.
- **`identity({..., people: [slug, ...]})`** — appends a `# In the room`
  block containing each listed person's rendered card, after the tape and
  before the digest. Unknown slugs render one line ("no card for `x`"),
  never an error: identity must not fail because a person is new.
- CLI: `loom person show <slug> [--json]`, `loom person list`. The bridge
  calls `loom person show` and splices the card into the turn prompt itself,
  so the card arrives even if a body forgets to pass `people`.

**Synthesis**
- `summary` is written by the agent (a consolidation pass), not generated
  inside loom — loom stays "assembled from authored atoms, never generated".
  `person_list` exposes `synthesized_at` and the count of person-tagged
  memories written since, so a lane can tell which summaries are behind.

## Storage

`people` and `person_revisions` tables in **`memories.db`** (a card is about a
human, so it sits on memory's side of the memory/knowledge line), added by a
new entry in `src/backends/migrations.ts`. Card body is one JSON column plus
denormalized `slug`, `name`, `archived`, `updated`, `synthesized_at`.
Revisions: newest 10 per person, as with pages.

## The harness side (Art's bridge — not loom's code, recorded so the seam is clear)

- `people.json` shrinks to identity resolution and gating only:
  platform ids → slug, `tier`, and the field/project scopes. Its `why` prose
  moves into card summaries and is deleted.
- Per turn, the bridge resolves the speakers to slugs and fetches their cards
  (`loom person show`). Cards are only included for people at tier ≥ 2;
  a tier-1 stranger gets no card even if one exists.

## Acceptance criteria (each becomes a vitest case)

1. **Overwrite, not accumulate.** Writing `how.mode = "terse"` then
   `how.mode = "shakespearean"` leaves one value, `"shakespearean"`; the
   card has no reference to `"terse"`; `person_history` has exactly one
   revision containing it.
2. **Merge default.** A write passing only `how.tz` leaves `summary`, `where`,
   `may`, and other `how` fields untouched.
3. **Staleness renders.** A `where` field with `verified_at` 21 days ago
   renders with `STALE`; one with no `verified_at` renders `unverified`;
   `person_verify` makes it fresh without changing its value.
4. **Identity splice.** `identity({people:["patrick-kells"]})` contains a
   `# In the room` block with the card, placed after the tape and before
   Top of Mind. `identity({people:["nobody"]})` succeeds and says there is no
   card. `identity({})` has no such block (no change for existing callers).
5. **Not a gate.** A write setting `tier` (anywhere in the card) is rejected
   with an error naming the reason; `may` entries without `source` are
   rejected.
6. **Size caps.** Summary over 1,200 chars or a rendered card over 2,000 is
   rejected at write, not truncated at read.
7. **Boundary.** `knowledge_maintain` reports an active knowledge page whose
   slug equals a person-card slug as a misfile. (Today's misfile audit keys on
   sourcing and citations only, so a well-cited page about a person passes;
   this closes that.)
8. **Path safety.** Slugs validate as path segments like every other param
   (`pathSegmentError`), even though they are not currently used as paths.
9. **One writer.** The dossier text tells worker bodies they do not write
   cards, as it already does for memory. (One-writer is a convention in loom
   today, not an enforced permission; this doc does not change that.)

## First slice

Ship criteria 1–6 and 8, the CLI read, and the identity param. Seed exactly
one card by hand — `patrick-kells` with `how.tz = America/New_York`,
`how.mode = terse`, and a summary condensed from his memories — and wire the
bridge to splice it whenever Patrick is the speaker. Done when a Slack turn
from Patrick shows the card in the body's prompt and the answer uses Eastern
time without being told.

Then: cards for the other tier-2 people, the `why` migration out of
`people.json`, and a consolidation-lane step that refreshes stale summaries.

## Open questions

- **Staleness default.** 14 days for every `where` field, or per-system
  (Slack membership rarely changes; pond roles change weekly)?
- **Multiple agents.** Mark and Gabe also talk to these people. Is a card
  per-agent (this context dir only, today's model) or something shared later?
  This doc assumes per-agent; sharing is out of scope.
- **The creed's own human.** Does Jonathan get a card, or do `preferences.md`
  and the creed stay his card? This doc says: no card for now. Preferences
  already are that, and two sources for one person is the drift the whole
  feature exists to stop.

## Review gate

Before this doc merges, a **bare Codex body on Fable** (no loom identity, no
tape, no Art or Mark context; only this repo and this PR) reviews it for holes
that Art and Mark both miss because they live inside loom (Jonathan, 2026-10-19).
Its findings are reconciled in the PR thread before merge.
