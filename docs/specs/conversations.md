# Conversations: what happened, in any venue

*2026-11-02. Status: **proposed**. This is a design doc in the `docs/specs/` sense: what loom will build and the
acceptance criteria its vitest suite must pin. It moves the agent's history into core, and it is the first of the
documents that redraw the pieces. The others are the runtime piece and the venue adapters.*

## Why

> "I install loom-discord, use it for a year, and then go... discord sucks, uninstall it and install loom-slack and
> move to slack. All of those discord conversations, people, et cetera... I can't reach them on discord any more, but I
> shouldn't lose the conversation data or whatever. That's a core thing that happened." "You're fundamentally a chat
> bot. What we're doing right now is a conversation." — the owner, 2026-11-02

Today a conversation exists only inside the piece that carried it. The bridges piece keeps the bridges' state, the
clock keeps the relay threads, and a harness keeps its own session files. When a piece is removed
(`loom pieces remove --purge`), its data goes with it. Episodes (CONTEXT.md: 48-hour memories a body writes about its
session) are the only trace in core, and they expire.

The owner's other rulings shape everything below:

> "On how much it stores, I don't think we want to store the transcript, at least not permanently as part of this
> feature. Anything that makes it easier for people to snoop, track other people's private conversations, et cetera I'm
> out." "Keep it, but as something separate from what we're talking about here. Like an audit log almost. And as soon
> as we've processed it, we want to toss it." "I'm not against the idea of encrypting it at rest either."

> "The actual grading portion should be household wide, including bare-assed models, so we avoid the self grading
> problem. You know too much about the why and how of your own work to give a truly unbiased opinion."

## The rules

1. **The agent's life outlives the pieces that carried it.** Who it talked to, where, when, and what came of it are
   core records. A venue (Discord, Slack, an interactive session, a wake, an agent's relay) is an adapter that delivers
   into and out of them. Removing a venue removes the ability to talk there, never the history.
2. **One record, rendered by its venue.** A Slack DM, an interactive session and a 3am wake have the same shape. The
   venue says how to show it and what "good" means for it. Core can always show any record generically, even after
   its venue is gone.
3. **No transcripts in the record.** The durable record holds who, where, when, per-turn metadata, the agent's own
   digests and links. The words people said are not in it.
4. **Raw text is in the audit log only, and no identity ever reads it.** The log is encrypted at rest, deleted once
   processed, and gone after 7 days regardless. Its only reader is grading: bare models with no identity, no memory and
   no tools, whose output is checked so it cannot carry the text out.
5. **Review has two halves.** *Grading*: bare models, blind to which model, agent and person is involved, score
   samples household-wide, and their scores feed model choice. *Introspection*: each agent, as itself, learns from its
   own records and its grades. It never sees raw text.

## The test for every piece (added to extensions.md)

> **Is this data about the agent's life, or about a mechanism?**
>
> Life (who, what was said or decided, what happened) must outlive the piece, in one of two ways:
> - it is a core record; or
> - the piece's role contract gives it a portable export that a replacement implementation imports.
>
> Mechanism (tokens, queues, timers, session-resume state, caches) is the piece's, and may die with it.

Applied today:
- **Conversations from the bridges piece and the clock's relay threads become core records** (this doc).
- **Tasks stay the tasks piece's.** Work tracking is a piece's job, and tasks survive a swap through the tasks role's
  contract (its export).
- **Secrets, box, subscriptions and machine are mechanism.**

## Vocabulary (to be added to CONTEXT.md)

**Conversation**:
An exchange between an agent and others (people, agents, or a schedule) in one place in one venue: who, where, when,
and what came of it. Keyed by agent · venue · place.
_Avoid_: chat, session (that's a body's run), thread (that's a venue's word), transcript

**Venue**:
Where conversations happen, and the adapter that carries them: `discord`, `slack`, `session` (an interactive harness),
`wake`, `relay`. A venue has a **kind** (`live`, `scheduled` or `agent`) that sets what it is measured on.
_Avoid_: channel (that's a place), platform, bridge (that's the adapter's code)

**Place**:
The venue's own address for one conversation: a DM with someone, a channel, a schedule, an agent pair. The venue
defines its places; core treats a place as an opaque string.
_Avoid_: room (person-cards.md uses it for the people a turn is addressed by), channel

**Turn**:
One message or action in a conversation, as metadata: who, when, how long the reply took, which model and harness.
Never its text.
_Avoid_: message (that's the venue's object), event

**Digest**:
A body's own summary of its run in a conversation: what was asked, decided and done, and whether the owner is needed.
One per body run.
_Avoid_: summary (that's a field), episode (a digest replaces one where a conversation exists)

**Audit log**:
The temporary, encrypted store of raw turn text that grading reads and then deletes. Not "the tape": in loom, the tape
is the boot-time stream of recent episodes (CONTEXT.md).
_Avoid_: tape, transcript store, history

**Review**:
The household's daily pass. **Grading** is household-wide, by bare models, blind. **Introspection** is per agent, by
that agent, without raw text.
_Avoid_: retro, reflection (that's an agent's own lane), evaluation

**Scorecard**:
Grades per model, harness and venue kind, aggregated across the household. Numbers and fixed labels only.
_Avoid_: leaderboard, benchmark

## The conversation record

```jsonc
{
  "id": "cv-3f9a0c12d4e5",          // "cv-" + first 12 hex of SHA-256 over "agent\0venue\0place"
  "agent": "art",
  "venue": "slack",
  "place": "dm:U123",               // the venue's address; opaque to core, ≤ 200 chars
  "label": "Loren (DM)",            // the venue's display name for the place, ≤ 80; may change
  "with": ["loren"],                // person slugs and agent ids seen in it, ≤ 32; grows as turns arrive
  "projects": ["pond"],             // the union of its digests' projects (computed)
  "started": "…", "last": "…"
}
```

**Turns** (`conversation_turns`), metadata only:

| Field | Value |
|---|---|
| `seq` | assigned by core on write, increasing per conversation: the turn's index everywhere |
| `at` | ISO-8601 UTC |
| `from` | a person slug, an agent id, `schedule`, or `unknown` |
| `kind` | `message` (someone else), `reply` (the agent answers), `action` (the agent did something visible), `wake` (a schedule fired), `note` (a mid-turn note in a live venue) |
| `latency_ms` | on a `reply`: time since the earliest `message` after the agent's previous `reply` |
| `model`, `harness` | on the agent's turns |
| `outcome` | on the agent's turns: `answered`, `progressed`, `deferred`, `failed` or `none` |

A turn is one delivered message or action; a venue never merges messages into one turn. A turn write carrying any
other key, text included, is rejected.

**Digests** (`conversation_digests`), one per body run:

```jsonc
{ "id": "dg-…",                     // "dg-" + 12 hex of SHA-256 over "conversation id\0run id"
  "conversation": "cv-…", "run": "…",  // the body run's id, given by the runtime
  "at": "…", "summary": "… ≤ 600", "asks": [], "decisions": [], "tasks": [], "projects": [],
  "needs_owner": null }              // or a one-line reason ≤ 200
```

- **Caps (as projects.md):** projects ≤ 4 names; asks and decisions ≤ 8 strings of ≤ 200 each; task refs ≤ 16 strings
  of ≤ 64 each.
- **One digest per run.** A second write in the same run replaces that run's digest. A digest is never written for
  another run, or for another agent's conversation.
- **`projects`** are names (projects.md's slugs or aliases), stored resolved to slugs. When a digest names no project,
  a project whose `links.venues` contains `<venue>:<place>` is used.

**Retention:** a sweep runs daily and at daemon start. It folds turns older than 90 days into `conversation_days` (per
conversation per UTC day: turn counts by kind, median `latency_ms`, outcomes by model) and deletes them. The
conversation itself and its digests are kept for good.

## Who writes what

| Write | Who | How |
|---|---|---|
| A turn in a venue the runtime carries (discord, slack, wake, relay) | the runtime | `POST /api/loom/conversations/turn`, role `runtime` |
| A turn in venue `session` | the harness, as the agent | the same path, agent role, venue `session` only, its own agent only |
| A digest | the agent | `conversation_digest`, MCP |
| Raw text | the runtime | `POST /api/loom/audit`, role `runtime`, for a turn it has already written |

- **The `runtime` role is new:** a fifth token role beside `agent`, `owner`, `peer` and `piece` (`src/household.ts`).
  It is minted for the runtime piece and reaches only the paths in this doc that name it.
- **The order is fixed:** the turn first, then its audit entry, keyed by the turn's `seq`. An audit write for a
  `(conversation, seq)` that doesn't exist is rejected. When the turn succeeds and the audit write fails, the turn
  stands without text: the review has less input, and nothing is misattributed.
- **The body's conversation:** the runtime passes `conversation: "<id>"` and `run: "<id>"` to `identity()` when it
  starts or resumes a body. That gives the body the ids `conversation_digest` takes. A harness session uses venue
  `session`, with place `<harness>:<session id>`.
- **The boot tape gains digests:** digests from the tape's window (CONTEXT.md, Tape) are interleaved with episodes by
  time and rendered `digest · <venue> <label>: <summary>`. A body in a conversation writes a digest instead of an
  episode. Bodies without one still write episodes. "Tape" now means "recent episodes and digests".

## Venues

A venue adapter, as a managed piece, declares its venues in its `loom` block. Core keeps a copy of each declaration
in its `venues` table.

```jsonc
"loom": { "venues": { "slack": { "label": "Slack", "kind": "live", "render": ["loom-slack", "render", "--json"] } } }
```

**The declaration's schema** (rejected whole at install if any rule fails, as projects.md's `sections`):
- A venue name is `[a-z][a-z0-9-]*`, ≤ 32 chars. A piece declares ≤ 8 of them.
- `label` is required, ≤ 40.
- `kind` is `live`, `scheduled` or `agent`.
- `render` is optional: 1–16 strings of ≤ 200, and `argv[0]` must be one of the piece's own `bin` names.
- Unknown keys are rejected.
- `session` and `wake` are core's own names. `relay` belongs to the runtime.
- A name another installed piece already declares is rejected.

**The registry:**
- **Update:** replaces the piece's rows.
- **Removal:** keeps them, marked `orphaned`. The name, label and kind stay for display, and `render` is dropped.
  Reinstalling the same piece clears the mark.
- **Rendering:** `render` runs through the section-feed runner (projects.md, "Section feeds"): `--conversation <id>`,
  3 s, the same output schema. An orphaned venue, or a venue with no `render`, uses core's **generic render**: label,
  venue label, with, started, last, the digests newest first, and turn counts and outcomes.

**What each kind is measured on.** The metric names here are the scorecard's `measure` values:

| Kind | Measures from metadata | Graded question (1–5) |
|---|---|---|
| `live` | `first_reply_s` (median `latency_ms` of replies ÷ 1000), `abandoned` (conversations with a `message` left unanswered 24h) | "Did the agent answer what was actually asked, well, the first time?" |
| `scheduled` | `due_to_progress_s` (from the `wake` turn to the first `progressed` outcome), `done_rate` (share of runs ending `answered` or `progressed`) | "Did the run move its work forward, without busywork?" |
| `agent` | `round_trips` (turns to a resolved reply), `loops_refused` | "Did the exchange resolve what was asked?" |

## The audit log

| | |
|---|---|
| **What** | `(conversation, seq)`, venue, and the turn's text: one age-encrypted blob per entry, nothing else in plaintext |
| **Key** | Encrypted with age to the household's **review recipient**. Its identity (private key) is held on loom's machine at `$LOOM_HOME/review.key`, mode 0600, made at first use. It is never in the bundle, an export or an API answer |
| **Who writes** | Only the `runtime` role, after the turn exists |
| **Who reads** | Only a grading run, through `POST /api/loom/audit/take`, with a `review` token (below). Never the page, the search, an agent's MCP tools, an introspection session, or `loom export` |
| **Read log** | Each take is recorded in `audit_reads` in the memory database: run id, time, the `(conversation, seq)` pairs. Never text. It outlives the log, so who read what survives a purge |
| **Deleted** | On `POST /api/loom/audit/done` for taken entries, and by a sweep at 7 days whatever happened. The sweep runs hourly and at daemon start |
| **File** | `audit.db` beside the memory database. Deleting the file is a complete purge of its text |

**Review tokens.** The runtime asks core for one per grading run: `POST /api/loom/review/token`, role `runtime`. Core
mints a token with role `review`, valid for 2 hours. It reaches only `audit/take`, `audit/done` and `scorecards`.

- **`audit/take`:** `{limit ≤ 500}`. Answers `{entries: [{conversation, seq, venue, kind, text}]}`, decrypted by core,
  oldest first, entries not yet taken. Text is redacted before it leaves: every person slug, person name, agent id,
  model and harness name core knows is replaced by `P1…`, `A1…`, `M1…`, `H1…`, consistently within one take.
- **`audit/done`:** `{pairs: [[conversation, seq], …]}` deletes them.

## Review

A daily household job. **Core defines the contract; the runtime runs it**, because running a model needs the runtime.
It's on by default. The owner sets `review: on | off | <argv>` in household.json (`<argv>` replaces the runtime's job
with their own command, given the same token). It runs at 04:00 in the household's time zone.

**Grading, household-wide, blind:**
1. **Families.** The runtime takes entries with `audit/take`. For each sample, it picks graders from the household's
   model accounts, never another service. A **model family** is a provider (`anthropic`, `openai`, …) in the runtime's
   model list. Each sample is graded by:
   - two graders from families other than the producer's, where the household has them;
   - one, where it has one other family;
   - only a single-family household falls back to a different model of the same family, and its scorecard rows say
     `same_family: true`.

   A model never grades its own turns.
2. **A bare grader** gets the redacted sample, the venue kind's graded question, and nothing else: no identity, no
   memory, no tools. It answers a score of 1–5, and optionally one finding of ≤ 200 chars.
3. **Checked before kept.** A finding that shares any 8 consecutive words with the sample it graded is dropped. That's
   how raw text is kept from leaving through a finding.
4. **Scorecards.** The runtime writes the scores and the metadata measures as scorecard rows: `POST
   /api/loom/scorecards` with the review token. The audit entries are then `done`.

**Introspection, per agent, after grading:** each agent, as itself, reads its own conversations' metadata, its
digests, and the findings on its own turns (never text). It writes what it learned through the normal tools: feedback
memories, proposed tasks, fixes to its briefs. An identity session can't reach the audit log, so it has nothing raw to
copy.

**A scorecard row** has:
- `day`, `model`, `harness`, `kind` (the venue kind);
- `measure`: one of the names in the measures table, or `graded`;
- `value` (a number), `n` (the sample count), `same_family` (a boolean);
- `findings`: ≤ 20 strings of ≤ 200, the checked findings on the `graded` row.

Any other key, or a `value` that isn't a number, is rejected. Rows are kept for good. They're shown on loom's page
under Mind, Models. The runtime's model resolver reads them; how it weighs them is the runtime spec's.

**Failure.** A run that fails leaves its taken entries un-done. The 7-day sweep still applies, so a broken review loses
input instead of keeping text.

## Surfaces

**MCP**
- `conversation_digest({summary, asks?, decisions?, tasks?, projects?, needs_owner?})`: for the conversation and run
  given at identity. Without them, rejected.
- `conversations({with?, project?, venue?, since?})` lists records, newest `last` first.
- `conversation({id})` returns one, with the generic render.

**Needs you.** A digest with `needs_owner` appears in loom's Inbox as an ask from core, linking to the conversation,
until a later digest in that conversation clears it.

**Projects.** A project's hub gets a core section, `conversations`, which replaces the shuttle feed in projects.md:
- **What's in it:** conversations whose `projects` include the project, with a digest after `since`. Up to 20, newest
  `last` first.
- **Each item:** id, venue label, label, with, last, the newest digest's summary, any open `needs_owner`, and `new`.

**People.** A person card can list the conversations they're `with` in. That's computed, not stored on the card.

## Storage

The memory database gets `conversations`, `conversation_turns`, `conversation_days`, `conversation_digests`, `venues`,
`scorecards` and `audit_reads`. The audit log is its own file, `audit.db`.

## Edits this forces elsewhere

- **projects.md:** `conversations` becomes a core section. The shuttle feed and "shuttle's side" are replaced by this
  doc, and the `dg-` id is defined here.
- **extensions.md:** the core line gains "conversations". It also gains the life/mechanism test, and a `venues` key in
  the `loom` block.
- **pieces-install.md:** the block schema gains `venues`.
- **src/household.ts:** the role set gains `runtime` and `review`.
- **bridges.md:** the conversation as the unit stays, and its record moves here. bridges.md becomes the venue adapters'
  and the runtime's doc.
- **CONTEXT.md:** the vocabulary above, and Tape's definition includes digests.

## Acceptance criteria (loom vitest)

1. **Turn writes.** A turn with the `runtime` role creates or extends the record for agent · venue · place. Each key
   is pinned:
   - two places in one venue are two conversations;
   - an agent token may write only venue `session`, and only for itself;
   - any other role is refused;
   - a turn with a text key or an unknown key is refused.
2. **`seq` and the audit order.** `seq` is assigned by core and increases. An audit write for a missing
   `(conversation, seq)` is refused.
3. **Digests.**
   - The digest is written to the identity's conversation and run.
   - A second write in the same run replaces it; another run adds one.
   - The caps reject.
   - A digest naming no project takes the project whose `links.venues` has `<venue>:<place>`.
4. **Retention.** The sweep folds turns older than 90 days into `conversation_days` with the stated counts. Digests are
   untouched.
5. **Venues.**
   - Every declaration rule rejects at install.
   - A name collision rejects.
   - Removing the piece orphans its rows, and the conversation still lists and renders generically.
   - Reinstalling clears the mark.
6. **The audit log is encrypted.** An entry in `audit.db` starts with the age header. Decrypting it with a different
   identity fails, and with `review.key` it gives the text back.
7. **Reading the audit log.**
   - Only a `review` token can `take`. An agent, owner, piece or `runtime` token is refused.
   - A `review` token expires after 2 hours.
   - Each take writes `audit_reads` rows with no text.
   - `done` deletes.
   - An entry older than 7 days is gone after the sweep, taken or not.
   - `loom export` contains neither `audit.db` nor `review.key`.
8. **Redaction.** A taken entry naming a person slug, a person's name, an agent id, a model and a harness comes back
   with each replaced by its placeholder, consistently within the take.
9. **No identity reads raw text.** No MCP tool, and nothing reachable with an agent or owner token, answers with audit
   text.
10. **Scorecard rows.** Unknown keys, non-numeric values and an unknown `measure` are rejected. A finding sharing 8
    consecutive words with its taken entry is rejected.
11. **Needs you.** A digest with `needs_owner` makes an Inbox ask; a later digest without one in the same conversation
    clears it.
12. **Projects.** The project hub's `conversations` section returns the stated items, caps and order.
13. **The boot tape** interleaves digests in its window with episodes by time.

## First slice

1. Records, turns, digests, venues, the generic render, the MCP tools, Needs you, the tape: criteria 1–5 and 11–13.
2. The audit log, review tokens, redaction and the sweep (6–9).
3. Scorecards and the review contract (10). The review job itself lands with the runtime piece.

## Open questions

- **People who don't know.** Colleagues on a venue talk to an agent whose household grades a week of their raw words,
  redacted and by machines. Is a line owed in the agent's profile, or in its first message to someone new?
- **Model names inside text.** Redaction covers the names core knows. A model describing itself ("as an AI from…") can
  still leak its family to a grader: blind as far as we can make it.
- **Harness transcripts.** A harness's own local transcript files (outside loom) still hold raw text. The runtime spec
  decides whether the runtime deletes them once their turns are in the audit log.

## Sources

The owner's rulings, quoted above, come from a conversation with the agent on 2026-11-02. They and a review of how loom
and its pieces are cut are recorded in the agent's operations repo. They're provenance only, and nothing here needs
them to be built.

## Review gate

As person cards: before this doc merges, a context-stripped reviewer reviews it, and every finding is folded, accepted
as a trade-off, or rejected with a quote.
