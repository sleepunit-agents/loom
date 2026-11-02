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
3. **No transcripts in the record; quotes are the agent's judgment.** The durable record holds who, where, when,
   per-turn metadata, the agent's own digests and links. It holds no transcript.
   - A digest or a memory may quote a line when the line carries meaning. The words and the tone of "Nobody calls me
     Danny" are the context, and a paraphrase loses them.
   - The danger is bulk: a complete, searchable record of what someone said. That's what this doc refuses to keep.
   - The test for anything an agent writes down about a person is **"would they be fine reading it?"**
   - The owner of a loom instance can read what it stores; no access rule changes that. So the protection is storing
     only what a decent coworker would keep, and making bulk surveillance inconvenient.
4. **Raw text is in the audit log only, and no identity ever reads it.** The log is encrypted at rest, deleted once
   processed, and gone after 7 days regardless. Its only reader is grading: bare models with no identity, no memory and
   no tools, whose output is checked so it cannot carry the text out.
5. **Review has two halves.**
   - *Grading:* bare models, blind to which model, agent and person is involved, score samples household-wide, and
     their scores feed model choice.
   - *Introspection:* each agent, as itself, learns from its own records and the checked findings on them. It never
     sees raw text.

## The test for every piece (added to extensions.md)

> **Is this data about the agent's life, or about a mechanism?**
>
> Life (who, what was said or decided, what happened) must outlive the piece, in one of two ways:
> - it is a core record; or
> - the piece's role contract gives it a portable export that a replacement implementation imports. For tasks, that's
>   the tasks role's contract, `spec/taskstore-core` in the public taskstore repo.
>
> Mechanism (tokens, queues, timers, session-resume state, caches) is the piece's, and may die with it.

Applied today:
- **Conversations from the bridges piece and the clock's relay threads become core records** (this doc).
- **Tasks stay the tasks piece's,** under that contract.
- **Secrets, box and the model subscriptions are mechanism.** The subscriptions currently ship inside the bridges piece.

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
One per body run. Not a memory: recall doesn't search it, and `conversations` reads it.
_Avoid_: summary (that's a field), episode (a digest replaces one where a conversation exists)

**Audit log**:
The temporary, encrypted store of raw turn text that grading reads and then deletes. Not "the tape": in loom, the tape
is the boot-time stream of recent episodes (CONTEXT.md).
_Avoid_: tape, transcript store, history

**Review**:
The household's daily pass. **Grading** is household-wide, by bare models, blind. **Introspection** is per agent, by
that agent, without raw text.
_Avoid_: retro, reflection (that's an agent's own lane), evaluation

**Finding**:
A grader's one-line note on one turn, checked so it doesn't quote. Kept on the turn's agent's side.
_Avoid_: comment, feedback (that's a memory category)

**Scorecard**:
Grades per model, family, harness and venue kind, aggregated across the household. Numbers and fixed labels only.
_Avoid_: leaderboard, benchmark

## Where it lives

| Store | Holds | Why there |
|---|---|---|
| each agent's memory database (`resolveSqliteDbPath`) | `conversations`, `conversation_turns`, `conversation_days`, `conversation_digests`, `findings` | an agent's life, per agent, as memories and person cards |
| the household store, `$LOOM_HOME/household.db` (new) | `venues`, `scorecards`, `audit_reads`, review runs | household-wide |
| `$LOOM_HOME/audit.db` (new) | the audit log | its own file, so deleting it is a complete purge |
| `$LOOM_HOME/review.key`, `review.pub` | the review identity and its recipient | made with `age-keygen` at first use, mode 0600 |

`src/bundle.ts` copies `household.db` and leaves out `audit.db`, `review.key` and `review.pub` (the bundle and export
never carry raw text or its key). Encryption uses the `age` binary loom already finds for bundles (`findProgram`).
Without it, audit writes are refused (`503`) and turns still record.

## The conversation record

```jsonc
{
  "id": "cv-3f9a0c12d4e5",          // "cv-" + first 12 hex of SHA-256 over "agent\0venue\0place"
  "agent": "art",
  "venue": "slack",
  "place": "dm:U123",               // opaque, 1–200 chars; a longer one rejects the turn
  "label": "Loren (DM)",            // ≤ 80; each turn may update it, the last one wins
  "people": ["loren"],              // person slugs seen, ≤ 32; past 32 they aren't added (counts still are)
  "agents": [],                     // agent ids seen, ≤ 16, likewise
  "projects": ["pond"],             // the union of its digests' resolved projects (computed)
  "started": "…", "last": "…"
}
```

**Turns** (`conversation_turns`), metadata only. The writer sends `at`, `from`, `kind`, `label` (optional, ≤ 80: the
place's display name, last one wins), and for the agent's own turns `run`, `model`, `harness` and `outcome`. Core
computes the rest. Any other key, text included, is rejected.

| Field | Value |
|---|---|
| `seq` | assigned by core, increasing per conversation; the turn write answers `{conversation, seq}` |
| `at` | ISO-8601 UTC |
| `from` | `{kind: person, slug}`, `{kind: agent, id}`, `{kind: schedule}` or `{kind: unknown}` |
| `kind` | `message` (someone else), `reply` (the agent answers), `action` (the agent did something visible), `wake` (a schedule fired), `note` (a mid-turn note in a live venue), `refused` (a relay refused as a repeat) |
| `run` | on the agent's turns: the body run they belong to (the same id as its digest's) |
| `latency_ms` | computed by core on a `reply`: time since the earliest `message` with no `reply` after it. A `reply` with no such `message` (the agent spoke first, or a wake) has none |
| `model`, `harness` | strings, on the agent's turns |
| `outcome` | on the agent's turns: `answered`, `progressed`, `deferred`, `failed` or `none` |

What a turn is (one delivered message or action, never merged) is the venue adapters' obligation, stated in their doc.

**Digests** (`conversation_digests`), one per body run:

```jsonc
{ "id": "dg-…",                     // "dg-" + 12 hex of SHA-256 over "conversation id\0run id"
  "conversation": "cv-…", "run": "…", "at": "…",
  "summary": "… ≤ 600", "asks": [], "decisions": [], "tasks": [], "projects": [],
  "needs_owner": null }              // or a one-line reason ≤ 200
```

- **Keys:** exactly these; unknown keys are rejected.
- **Caps (as projects.md):** projects ≤ 4 names; asks and decisions ≤ 8 strings of ≤ 200 each; task refs ≤ 16 strings
  of ≤ 64 each.
- **One per run.** A second write in the same run replaces that run's digest. A digest is never written for another
  run, or for another agent's conversation.
- **Projects.** `projects` are names (projects.md's slugs or aliases), stored resolved to slugs. When a digest names
  none, the one live project whose `links.venues` contains `<venue>:<place>` is used. If none or several match, none is.

**Retention.** A sweep runs daily and at daemon start. It folds each UTC day whose every turn is older than 90 days into
one `conversation_days` row per conversation and day: turn counts by `kind`, median `latency_ms`, and
`{model: {outcome: count}}`. It then deletes those turns. A folded day is never folded again. The conversation and its
digests are kept for good.

**Reading.**
- **Who sees what.** An agent's token sees its own agent's conversations. A household member sees the conversations
  of the agents their `agents` covers (owners.md: `'*'` or a list), and no others. A request naming another agent is
  refused, as owners.md has it.
- **`conversations`** returns up to 100, newest `last` first.
- **`conversation({id})`** returns the record, its digests, its findings (as introspection reads them), and its render:
  the venue's when the venue has a live `render`, else core's generic render. loom's page shows it at
  `loom:conversation/<id>`. That's a new page target, added to extensions.md's list.

## Who writes what

| Write | Who | How |
|---|---|---|
| A turn in discord, slack, wake or relay | the runtime | `POST /api/loom/conversations/turn`, role `runtime` |
| A turn in venue `session` | the harness, as the agent | the same path, agent token, venue `session`, its own agent only |
| A digest | the agent | `conversation_digest`, MCP |
| Raw text | the turn's writer (the runtime, or the harness for `session`) | `POST /api/loom/audit` `{conversation, seq, text}`, for a turn it has already written |

- **The new roles.** `runtime` and `review` join `agent`, `owner`, `peer` and `piece` (`src/household.ts`).
  - A `runtime` token is minted for the one installed piece whose `loom` block has `"role": "runtime"`. It reaches
    only the paths in this doc that name it.
  - A token record gains an optional `expires` (ISO-8601). `validRecord` accepts it, and an expired token is refused.
- **The order is fixed:** the turn first, then its audit entry, keyed by the `seq` the turn write answered. An audit
  write for a `(conversation, seq)` that doesn't exist, or by a different writer, is rejected. When the turn succeeds
  and the audit write fails, the turn stands without text.
- **The body's conversation:** the runtime passes `conversation: "<id>"` and `run: "<id>"` to `identity()` when it
  starts or resumes a body. A harness session uses venue `session`, with place `<harness>:<session id>`, and its own
  run id.
- **The boot tape gains digests:** digests from the tape's window are interleaved with episodes by time and rendered
  `digest · <venue> <label>: <summary>`. A body in a conversation writes a digest instead of an episode; bodies without
  one still write episodes. A digest is not a memory, so recall doesn't find it: `conversations` does. Episode and Tape
  in CONTEXT.md change to say so.

## Venues

A venue adapter, as a managed piece, declares its venues in its `loom` block. Core keeps a copy of each declaration
in `venues`.

```jsonc
"loom": { "venues": { "slack": { "label": "Slack", "kind": "live", "render": ["loom-slack", "render", "--json"] } } }
```

**The declaration's schema** (rejected whole at install if any rule fails):
- A name is `[a-z][a-z0-9-]*`, ≤ 32 chars. A piece declares ≤ 8.
- `label` is required, ≤ 40. `kind` is required: `live`, `scheduled` or `agent`.
- `render` is optional: 1–16 strings of ≤ 200, and `argv[0]` must be one of the piece's own `bin` names.
- Unknown keys are rejected.
- `session` (`live`) and `wake` (`scheduled`) are core's own and may not be declared.
- `relay` (`agent`) may be declared only by a piece whose `loom` block has `"role": "runtime"`.
- A name another installed piece already declares is rejected.

**The registry:**
- **Update:** replaces the piece's rows.
- **Removal:** keeps them, marked `orphaned`. The name, label and kind stay, and `render` is dropped.
- **Reinstall:** reinstalling the same piece clears the mark.
- **Rendering:** `render` runs through the section-feed runner (projects.md, "Section feeds"): `--conversation <id>`,
  3 s, the same output schema. An orphaned venue, or one with no `render`, uses core's **generic render**: label,
  venue label, people, agents, started, last, digests newest first, and turn counts and outcomes.

**What each kind is measured on.** The names are the scorecard's `measure` values, computed per UTC day over that day's
conversations of that kind:

| Kind | Measures (from metadata) | Graded question, 1–5 |
|---|---|---|
| `live` | `first_reply_s`: median `latency_ms` ÷ 1000 of `reply` turns. `abandoned`: share of conversations with a `message` that had no `reply` within 24h | "Did the agent answer what was actually asked, well, the first time?" |
| `scheduled` | `due_to_progress_s`: median, over runs (agent turns grouped by `run`), of the time from the `wake` turn just before the run's first turn to its first `progressed` or `answered` turn. `done_rate`: share of runs whose last agent turn is `answered` or `progressed` | "Did the run move its work forward, without busywork?" |
| `agent` | `round_trips`: median turns from a relay's first `message` to the first `reply` with outcome `answered`. `loops_refused`: count of `refused` turns | "Did the exchange resolve what was asked?" |

## The audit log

- **Each entry:** `agent`, `conversation`, `seq`, `venue`, `kind` and `at` in plaintext (they're metadata the record
  already holds), and `text` as an age-encrypted blob to `review.pub`. Nothing else.
- **Who writes:** the turn's writer only, after the turn exists.
- **Who reads:** only a grading run, through `POST /api/loom/audit/take`, with a `review` token. The audit module
  exports one decrypt function, and the take handler is its only caller.
- **Read log:** each take writes `audit_reads` rows (run id, time, `(agent, conversation, seq)`), never text.
- **Deletion:** on `POST /api/loom/audit/done`, and by a sweep at 7 days whatever happened. The sweep runs hourly and
  at daemon start.

**Review tokens.** The runtime asks core for one per run: `POST /api/loom/review/token`, role `runtime`. The answer is a
token with role `review` and `expires` 2 hours out. It reaches only `audit/take`, `audit/done`, `scores` and
`findings`.

- **`audit/take`:** `{limit ≤ 500}`. Answers `{entries: [{ref, agent, venue, kind, family, text}]}`, oldest first,
  across the household's agents, entries not yet taken.  `ref` is an opaque handle standing for `(agent, conversation, seq)`.
- **Redaction before it leaves**, case-insensitive and whole-word:
  - every person card's `name` and `slug` becomes `P1`, `P2`…;
  - every agent id becomes `A1`…;
  - every model and harness string seen in any turn becomes `M1`… or `H1`…;
  - numbering is by first appearance, consistent within the take.
  The `agent` field itself is given as its `A…` placeholder.
- **`audit/done`:** `{refs: […]}` deletes them.

## Review

A daily household job. **Core defines the contract; the runtime runs it**, because running a model needs the runtime.

- **The schedule:** 04:00 in the household's time zone. household.json gains `tz` (IANA name, default `UTC`).
- **The setting:** household.json gains `review`: `"on"` (the default), `"off"`, or a JSON array of 1–16 strings of
  ≤ 200, a command that replaces the runtime's job. The runtime reads it with `GET /api/loom/review/config` (role
  `runtime`), never from the file, and passes the review token to a replacement command on stdin.

**Grading, household-wide, blind:**
1. **Picking graders.** The runtime takes entries and picks graders among the models it can run. It knows each model's
   **family**, its provider (`anthropic`, `openai`, …); the runtime spec defines that list.
   - A take entry carries the producing turn's `family` (not its model), so the runtime can choose graders without
     learning who produced it.
   - Core keeps the mapping from `ref` to model, harness and agent. Scores are posted by `ref`, and core aggregates
     them into scorecard rows.

   Each sample is graded by:
   - two graders from families other than the producer's, where the household has them;
   - one, where it has one other family;
   - only a single-family household falls back to a different model of the same family, and its rows say
     `same_family: true`.

   A model never grades its own turns.
2. **A bare grader** gets the redacted sample, the venue kind's graded question, and nothing else: no identity, no
   memory, no tools. It answers a score of 1–5, and optionally one finding of ≤ 200 chars.
   - **Conversations with people other than the owner** are graded only by families that already processed that
     conversation (the families of its agent turns), marked `same_family: true`. A person's words then go only where
     they already went.
   - **Cross-family grading** covers conversations with the owner, with agents, and on schedules.
3. **Findings are capped, not policed.** The runtime posts findings with the sample's `ref`: `POST
   /api/loom/findings`. Core keeps at most one per conversation per UTC day (later ones are rejected), so findings
   can't add up to a transcript. They're stored in the turn's agent's `findings` table: the turn, the measure, the
   score and the text.
4. **Scores.** `POST /api/loom/scores` `{ref, grader_family, score}`.
   Core turns scores into scorecard rows itself, from its `ref` mapping, so no runtime ever learns which model
   produced a sample. Measures from metadata are computed by core in the same pass. A row is:
   - `day`, `model`, `family`, `harness`, `kind`;
   - `measure`: a name from the table, or `graded`;
   - `value` (a number), `n` (a count), `same_family` (a boolean).

   Rows are written only by core. Rows are kept for good. They're shown
   in a Models section of the Mind page (a page PR), and the runtime's model choice reads them through
   `GET /api/loom/scorecards`.
5. **Done.** The taken entries are marked `done`. A run that fails leaves them; the 7-day sweep still applies.

**Introspection, per agent, after grading.** Each agent, as itself, reads its own conversations, digests and findings
through `conversations`, `conversation` and `conversation_findings({since?})` (its own agent's only). It writes what
it learned through the normal tools: feedback memories, proposed tasks, fixes to its briefs. No identity can reach the
audit log, so it has no raw text to copy.

## Surfaces

**MCP**
- `conversation_digest({summary, asks?, decisions?, tasks?, projects?, needs_owner?})`: for the conversation and run
  given at identity. Without them, rejected.
- `conversations({people?, project?, venue?, since?})`, `conversation({id})`, `conversation_findings({since?})`: as
  above.

**Needs you.** A digest with `needs_owner` appears in loom's Inbox as an ask from core, linking to
`loom:conversation/<id>`, until a later digest in that conversation has none.

**Projects.** A project's hub gets a core section, `conversations`, after `people`. It replaces the shuttle feed in
projects.md and follows projects.md's core-section rule: `since` marks `new`, it doesn't filter.
- **What's in it:** the 20 conversations with the newest `last` whose `projects` include the project.
- **Each item:** id, venue label, label, people, last, the newest digest's summary, any open `needs_owner`, and `new`
  (`last` after `since`).

## Edits this forces elsewhere

- **projects.md:** `conversations` becomes a core section. The shuttle feed and "shuttle's side" are replaced by this
  doc, and the `dg-` id is defined here.
- **extensions.md:**
  - the core line gains "conversations";
  - it gains the life/mechanism test and a `venues` key in the `loom` block;
  - its page targets gain `conversation/<id>`.
- **pieces-install.md:** the block schema gains `venues`.
- **src/household.ts:** the roles `runtime` and `review`, an optional token `expires`, and household.json's `tz` and
  `review`.
- **src/bundle.ts:** `household.db` is copied; `audit.db` and the review key pair are left out.
- **bridges.md:** the conversation as the unit stays, and its record moves here. bridges.md becomes the venue adapters'
  doc, with the one-message-one-turn obligation.
- **CONTEXT.md:** the vocabulary above, and Episode and Tape as changed above.

## Acceptance criteria (loom vitest)

1. **Turn writes.**
   - A `runtime` turn creates or extends agent · venue · place, and answers `{conversation, seq}`.
   - Two places are two conversations.
   - An agent token may write only venue `session`, for itself.
   - Any other role is refused.
   - A turn with text, an unknown key, or a `place` over 200 is refused.
   - `latency_ms` is computed by core.
2. **The audit order.** An audit write for a missing `(conversation, seq)`, or from a different writer, is refused.
3. **Digests.**
   - It goes to the identity's conversation and run; the same run replaces, another run adds.
   - Unknown keys and the caps reject.
   - A digest is never compared with audit text: quoting is the agent's judgment.
   - The project falls back to the single matching `links.venues`, and to none when several match.
4. **Retention.** The fold makes `conversation_days` rows with the stated fields for whole days only, deletes their
   turns, and never refolds a day.
5. **Venues.**
   - Every declaration rule rejects at install, including `kind` missing, core names, and `relay` from a non-runtime
     piece.
   - Removal orphans the rows, and the conversation still renders generically.
   - Reinstalling clears the mark.
   - With a live `render`, `conversation` returns the venue's render.
6. **Encryption.** An audit entry's `text` is an age file (it starts with `age-encryption.org/v1`). It decrypts with
   `review.key` and fails with another identity. With no `age` binary, audit writes answer 503 and turns still record.
7. **Reading the audit log.**
   - Only an unexpired `review` token can `take`. An expired one, and agent, owner, piece and `runtime` tokens, are
     refused.
   - Each take writes `audit_reads` rows with no text.
   - `done` deletes.
   - Past 7 days, entries are gone after the sweep.
   - A bundle and `loom export` contain no `audit.db` and no review key.
8. **Redaction.** A take of an entry naming a person's name and slug, an agent id, a model and a harness returns each
   as its placeholder, consistently within the take.
9. **One decrypt path.** An import-graph test finds the audit module's decrypt function called only from the take
   handler.
10. **Findings and scorecards.**
    - A second finding for the same conversation and UTC day is rejected; an accepted one lands in the turn's agent's
      `findings`.
    - A score from a family that didn't process a non-owner conversation is rejected.
    - Scores are posted by `ref`; the resulting rows carry the producer's model, family and harness, which the
      runtime never received.
    - An agent's `conversation_findings` returns only its own.
11. **Needs you.** A `needs_owner` digest makes an Inbox ask, and a later digest without one clears it.
12. **Projects.** The `conversations` section's contents, caps, order and `new` are as stated.
13. **The boot tape** interleaves digests in its window with episodes by time.
14. **Scoping.** An agent's `conversations` lists only its own. A member whose `agents` is `["pond-bot"]` sees only
    pond-bot's, and a request naming another agent is refused.
15. **Latency.** A `reply` after two `message`s measures from the first; a `reply` with none before it has no
    `latency_ms`. `due_to_progress_s` groups by `run`.

## First slice

1. Records, turns, digests, venues, renders, the MCP tools, Needs you, the tape and scoping: criteria 1–5 and 11–14.
2. The household store, the audit log, review tokens, redaction and the sweep (6–9).
3. Findings and scorecards (10). The review job itself lands with the runtime piece.

### As built: slice 1 (t-1741)

Slice 1 settled these points the doc left open:

- **The render schema.** A venue's `render` answers the section-feed schema (projects.md, "Output"). Core's
  generic render uses the same schema, with the groups Conversation, Digests and Turns, so the page draws both the
  same way. When a live venue's render fails or doesn't validate, `conversation` returns the generic render with
  `render.error` saying why.
- **Core venues' labels.** `session` is "Session" (`live`) and `wake` is "Wake" (`scheduled`). They live in code,
  never in the `venues` table.
- **Session digests.** A harness passes `conversation` and `run` to `identity` the way the runtime does. The
  conversation is the agent's `session` · `<harness>:<session id>`, and it exists from its first turn. The harness
  writes that turn first; until then `conversation_digest` is refused.
- **`since` on the read tools.** It's exclusive. `conversations({since})` lists conversations whose `last` is after
  it, and `conversation_findings({since})` lists findings written after it.
- **Turn writes.**
  - The agent's own turns are `reply`, `action` and `note`. Each comes `from` the agent itself and carries `run` and
    `outcome`; `model` and `harness` are optional, ≤ 120 each. Other kinds carry none of the four.
  - The runtime may write core's `wake` or any venue in the registry, except `session` (that's the harness's).
  - An unknown venue is a 400. An orphaned venue, or a day already folded, is a 409.
  - Each turn records its writer's role, for the audit write's check.
- **Venues.**
  - A venue a piece stops declaring in an update is orphaned, not deleted.
  - `remove --purge` orphans too.
  - An orphaned name may be declared by another piece later, which then takes it over.
  - The daemon reconciles the registry at start (`syncVenues`).
- **Digest projects.** Names resolve through `project_names` (projects.md), so an alias is stored as its slug, and
  a name that is no live project's is rejected. The fallback reads the live cards' `links.venues`. A store from
  before the projects migration has no names to resolve: names are kept as written, with no fallback.
- **The hub section.** `project_hub` puts `conversations` after `people` (`conversationsSection`, called with the
  project's slug). It's absent when the agent has no conversations store.
- **Findings.** `conversation_findings` reads a `findings` table when there is one; slice 3 creates it.
- **The Needs you ask.** It comes from core and has no buttons (the Inbox files it as an alert). It links to
  `loom:conversation/<id>`; the same page is also at `/a/<agent>/conversation/<id>`.

### As built: slices 2 and 3 (t-1742)

These slices settled these points the doc left open:

- **Families.** A model's family comes from household.json's `families` (a model name, or a prefix ending in `*`,
  to a family name) and then built-in prefixes in `src/review.ts` (`claude`, `opus`… → `anthropic`; `gpt`, `o3`… →
  `openai`; …), and a `provider/` or `provider:` lead naming a family. A model none of them knows has no family (`null`
  in a take; `unknown` on a scorecard row). When the runtime spec lands its model list, it can feed this setting.
- **The audit write.** `{conversation, seq, text}`, text 1–40,000 characters; any other key is refused. The writer is
  compared with the turn's recorded writer exactly (a house token is its own writer). Refused besides: an entry
  already written (409), one already taken (409: it is never written again), and a turn more than 10 minutes in the
  future or older than 7 days (409), since the sweep goes by the turn's `at`.
- **The key pair.** The recipient is always derived from `review.key` (`age-keygen -y`); `review.pub` is rewritten to
  match, never trusted. `age-keygen` is found as `age` is (`LOOM_AGE_KEYGEN`, else PATH, else beside `age`).
- **The store.** `audit.db` holds exactly the six plaintext fields and the blob. "Taken" lives in household.db's
  `audit_reads` (ref, run, at, agent, conversation, seq), whose rows also map a `ref` to its turn for scores and
  findings. `audit.db` runs in rollback-journal mode with `secure_delete`, so a deleted entry's pages are zeroed.
- **Runs.** A review run is its token: its id is a digest of the token. A take's refs answer only that run's
  `scores`, `findings` and `done`; another run's are a 404 (done ignores them).
- **Take.** `limit` defaults to 100. `kind` is the turn's kind. An entry from a conversation with someone other than
  the owner also carries `only_families`: the families that may grade it, so the runtime knows before it sends a word
  anywhere (core still refuses any other family's score). Without `age`, a take is a 503 and claims nothing. An entry
  that doesn't decrypt is left out and stays claimed, so the sweep removes it.
- **"Someone other than the owner."** A conversation whose `people` include anyone who isn't a household member
  owning that agent, or with any turn `from` `unknown`.
- **Redaction.** Beyond each card's name and slug, each word of the name of three letters or more is that person too
  (a first name alone is still a name). A card whose slug is an agent id is that agent (A…). Agent ids are the
  household's and every agent its conversations have seen. Whitespace inside a name matches any whitespace. A term
  that matches more than one thing goes to agent, then person, model, harness.
- **Scores.** One per ref and grader family (a second is 409). Only an agent turn with a model is scored (409
  otherwise). A row's `day` is the turn's UTC day; `value` is the mean, `n` the count.
- **Findings.** One per conversation per UTC day of the turn it's on. One printable line of at most 200
  characters, not checked for quotes. It stores the turn, the measure `graded`, the mean score posted for its ref
  (or null), and the text.
- **Measures.** `computeMeasures(h, day)` replaces that day's metadata rows; the hourly sweep runs it for the last
  three days, so `abandoned` settles after its 24 hours. Each sample is attributed to the model and harness of the
  agent turn it measures (the reply, the run's first turn, or the latest agent turn before it), else `unknown`.
  `round_trips` counts turns as the seq distance from the first message to the first answered reply.
- **Scorecards.** `GET /api/loom/scorecards?since=YYYY-MM-DD` (default 30 days back), runtime only, at most 10,000
  rows oldest first.
- **Bundles.** On top of copying only what it names, an export refuses to write a bundle whose staging holds any
  file named like the audit log or the review key pair.

## Open questions

- **People who don't know.** Settled: no notice. The agent was present, as a coworker is. It doesn't lie when asked,
  and it keeps what a decent coworker would. Grading never sends a person's words to a provider that didn't already
  process them (Review, step 2).
- **Model names inside text.** Redaction covers the names core knows. A model describing itself can still leak its
  family to a grader: blind as far as we can make it.
- **Harness transcripts.** A harness's own local transcript files (outside loom) still hold raw text. The runtime spec
  decides whether they're deleted once their turns are in the audit log.

## Sources

The owner's rulings, quoted above, come from a conversation with the agent on 2026-11-02. They're recorded in the
agent's operations repo as provenance only, and nothing here needs them to be built.

## Review gate

As person cards: before this doc merges, a context-stripped reviewer reviews it, and every finding is folded, accepted
as a trade-off, or rejected with a quote.
