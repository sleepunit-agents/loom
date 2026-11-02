# Conversations: what happened, in any venue

*2026-11-02. Status: **proposed**. This is a design doc in the `docs/specs/` sense: what loom will build and the
acceptance criteria its vitest suite must pin. It moves the agent's history into core, and it is the first of the
documents that redraw the pieces. The others are the runtime piece and the venue adapters; the boundary review is in
the sources.*

## Why

> "I install loom-discord, use it for a year, and then go... discord sucks, uninstall it and install loom-slack and
> move to slack. All of those discord conversations, people, et cetera... I can't reach them on discord any more, but I
> shouldn't lose the conversation data or whatever. That's a core thing that happened." "You're fundamentally a chat
> bot. What we're doing right now is a conversation." — the owner, 2026-11-02

Today a conversation exists only inside the piece that carried it. shuttle keeps the bridges' state, the clock keeps
the relay threads, and a harness keeps its own session files. When a piece is removed (`loom pieces remove --purge`),
its data goes with it. Episodes, the 48-hour memories a body writes about its session, are the only trace in core, and
they expire.

The owner's two other rulings shape everything below:

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
2. **One record, rendered by its venue.** A Slack DM, this session, and a 3am wake have the same shape. The venue says
   how to show it and what "good" means for it. Core can always show any record in a generic way, even after its venue
   is gone.
3. **No transcripts in the record.** The durable record holds who, where, when, per-turn metadata, the agent's own
   digests and links. The words people said are not in it.
4. **Raw text lives only in the audit log**, separately: encrypted at rest, readable only by the review, deleted once
   processed, and gone after 7 days whatever happens.
5. **Review has two halves.** *Introspection*: each agent reads its own conversations and learns. *Grading*: bare
   models with no identity and no memory, blind to which model and agent produced the work, score it against the
   venue's expectations, household-wide. Grades feed model choice.

## The test for every piece (added to extensions.md)

> **Is this data about the agent's life, or about a mechanism?** Life (who, what was said or decided, what happened)
> must outlive the piece: either it is a core record, or the piece's role contract gives it a portable export that a
> replacement implementation imports. Mechanism (tokens, queues, timers, session-resume state, caches) is the piece's,
> and may die with it.

Applied today:

- **Conversations** from shuttle and the clock's relay threads become core records (this doc).
- **Tasks** stay the tasks piece's: work tracking is a piece's job. They survive a swap through the tasks role's
  contract (its export).
- **Secrets, box, subscriptions and machine** are mechanism.

## Vocabulary (to be added to CONTEXT.md)

**Conversation**:
An exchange between an agent and others (people, agents, or a schedule) in one venue: who, where, when, and what came
of it. Keyed by agent · counterpart · venue.
_Avoid_: chat, session (that's a body's run), thread (that's a venue's word), transcript

**Venue**:
Where a conversation happens, and the adapter that carries it: `discord`, `slack`, `session` (an interactive harness),
`wake`, `relay`. A venue has a **kind** (`live`, `scheduled` or `agent`) that sets what it is measured on.
_Avoid_: channel (a venue's own word), platform, bridge (that's the adapter's code)

**Turn**:
One message or action in a conversation, as metadata: who, when, how long the reply took, which model and harness.
Never its text.
_Avoid_: message (that's the venue's object), event

**Digest**:
The agent's own summary of a conversation's day: what was asked, decided and done, and whether the owner is needed. It
replaces the episode for any conversation that has one.
_Avoid_: summary (that's a card field), episode (that's what it replaces)

**Audit log**:
The temporary, encrypted store of raw turns that the review reads and then deletes. Not "the tape": in loom, the tape
is the boot-time stream of recent episodes.
_Avoid_: tape, transcript store, history

**Review**:
The household's daily pass over its conversations. **Introspection** is per agent, by that agent. **Grading** is
household-wide, by bare models, blind.
_Avoid_: retro, reflection (that's an agent's own lane), evaluation

**Scorecard**:
Grades per model, harness and venue kind, aggregated across the household. Numbers only, no text.
_Avoid_: leaderboard, benchmark

## The conversation record

```jsonc
{
  "id": "cv-3f9a…",                 // stable: hash of agent · counterpart · venue
  "agent": "art",
  "venue": "slack",                 // a venue name; `kind` comes from the venue's declaration
  "counterpart": "loren",           // a person slug, an agent id, or a schedule id for a wake
  "with": ["loren", "matt"],        // everyone in it (person slugs and agent ids), for a group venue
  "projects": ["pond"],
  "started": "…", "last": "…",
  "turns": [                        // metadata only; never text
    { "at": "…", "from": "loren", "kind": "message" },
    { "at": "…", "from": "art", "kind": "reply", "latency_ms": 41000, "model": "claude-opus-5-5",
      "harness": "claude-code", "outcome": "answered" }
  ],
  "digests": [                      // one per UTC day, written by the agent; the last write of the day replaces it
    { "day": "2026-11-02", "summary": "… ≤ 600", "asks": [], "decisions": [], "tasks": ["t-1271"],
      "needs_owner": null }
  ]
}
```

- **Turns are metadata.** `kind` is one of `message`, `reply`, `action`, `wake` or `note` (a mid-turn note in a live
  venue). `outcome` is one of `answered`, `progressed`, `deferred`, `failed` or `none`.
- **Retention:** turns older than 90 days are folded into per-day counts (turns, median latency, outcomes by model).
  Digests and the conversation itself are kept for good.
- **Writes:**
  - The runtime records turns: it carries every turn in every venue.
  - The agent writes digests, through `conversation_digest`, an MCP tool on its own conversations only.
  - A venue adapter never writes the record directly. It hands turns to the runtime.
- **Episodes fold in.** A body in a conversation writes a digest instead of an episode. The boot tape reads recent
  digests alongside the remaining episodes, so a session's record keeps reaching the next body. Bodies with no
  conversation (none, once every venue reports one) still write episodes. Migration is gradual, and nothing about
  episodes is removed by this doc.

## Venues

A venue adapter, as a piece, declares its venues in its `loom` block. Core keeps a copy of each declaration in its
venue registry, so a venue whose piece is gone still has a name, a kind and a label.

```jsonc
"loom": { "venues": { "slack": { "label": "Slack", "kind": "live", "render": ["loom-slack", "render", "--json"] } } }
```

- `kind` sets what the venue is measured on:

| Kind | Venues | Measured on |
|---|---|---|
| `live` | discord, slack, session | time to first reply; corrections and nudges from the human; conversations the human abandoned |
| `scheduled` | wake | time from due to progress; outcome (done, deferred, failed); dead-man fires |
| `agent` | relay | round trips to resolution; loops refused |

- `render` (optional) is run like a section feed (projects.md, "Section feeds"), and returns the venue's own blocks for
  a conversation. Live venues show their message features; a wake shows "fired, did this, set the next one".
- **The generic render** is core's, for any conversation: who, where, when, the digests, the turn counts and the
  outcomes. It is used when the venue has no `render` or its piece is gone.
- `session` (an interactive harness talking to the owner) and `wake` are core's own venues: the harness reports a
  session's turns, and the runtime reports a wake's.

## The audit log

| | |
|---|---|
| **What** | Raw turns: conversation id, turn index, time, role, text, model, harness, venue |
| **Who writes** | Only the runtime (a token with the role `runtime`), through `POST /api/audit` |
| **Encrypted** | Each entry is encrypted with age to the household's review key before it's written. The key is held on loom's machine, the same as the bundle key |
| **Who reads** | Only a review run, through `audit_take`, with a token minted for that run. Never the page, the search, an agent's MCP tools, or `loom export` |
| **Every read logged** | Who, when, which entries |
| **Deleted** | On `audit_done` for processed entries, and by a sweep at 7 days whatever happened. The sweep also runs at daemon start |
| **Harness copies** | A harness's own local transcripts may be deleted once their turns are in the audit log. That's the runtime's to do, per harness |

The audit log holds other people's words, so it gets the tightest rules here. It isn't in the household bundle, and
can't be exported or restored. Losing it loses at most a week of unprocessed review input.

## Review

A daily household job. Core defines its contract; the runtime runs it, because running anything needs the runtime.
On by default. It can be turned off, or replaced by the owner's own job meeting the same contract.

1. **Introspection, per agent.** Each agent, as itself (identity loaded), reads its own conversations' digests and turn
   metadata and its own slice of the audit log. It writes what it learned through the normal tools: feedback memories,
   proposed tasks, fixes to its own briefs. It never sees another agent's audit entries.
2. **Grading, household-wide, blind.**
   - **Who grades:** bare models with no loom identity, no memory and no tools beyond reading what they're handed.
   - **What they're handed:** sampled turns with the model, harness and agent names removed, plus the venue kind's
     rubric (the "measured on" column above).
   - **Families:** where the household has more than one model family, each sample is graded by a family other than
     the one that produced it, and by two graders when both are available.
   - **Output:** scores only, recorded as scorecard rows: model, harness, venue kind, measure, score, sample count, day.
3. **Model choice.** The runtime's model resolver reads the scorecards. A model that grades poorly on a venue kind gets
   chosen less for it. How the resolver weighs them is the runtime's to decide.
4. **Then delete.** Entries the run took are marked done and deleted.

Scorecards are durable core records, numbers only. They are kept for good, and readable on loom's page (Mind, or a
Models section) and by the runtime.

## Surfaces

- **MCP:**
  - `conversation_digest({id, day?, summary, asks?, decisions?, tasks?, needs_owner?})`: an agent writes only its own
    conversations.
  - `conversations({with?, project?, venue?, since?})` lists records.
  - `conversation({id})` returns one, with the generic render.
- **API:**
  - The runtime role only: `POST /api/conversations/turn` and `POST /api/audit`.
  - Review tokens only: `audit_take`, `audit_done`.
  - Venue declarations are registered at piece install.
- **Projects:** a project's hub reads conversations and digests directly as a core section, `conversations`, replacing
  the shuttle feed in projects.md.
- **People:** a person card can list the conversations they're in (computed, not stored on the card).

## Storage

`conversations`, `conversation_turns`, `conversation_digests`, `venues` and `scorecards` live in the memory database,
next to `people` and `projects`. The audit log is its own file, `audit.db` beside it, with every row's text encrypted,
so dropping the file is a complete purge.

## Edits this forces elsewhere

- **projects.md:** conversations become a core section, and the shuttle feed and the "shuttle's side" digests move
  here.
- **extensions.md:** the life/mechanism test, and a `venues` key in the `loom` block.
- **bridges.md:** the conversation as the unit stays, and its record moves to core. bridges.md becomes the venue
  adapters' and the runtime's doc.
- **CONTEXT.md:** the vocabulary above. "Tape" keeps its meaning.

## Acceptance criteria (loom vitest)

1. A turn written with the runtime role creates or extends the record for agent · counterpart · venue. Any other role is
   refused. A turn carrying text is refused (text goes to the audit log).
2. `conversation_digest` writes only the caller's own agent's conversations. The last write of a UTC day replaces that
   day's digest.
3. Turns older than 90 days fold into daily counts; digests are untouched.
4. A conversation whose venue's piece was removed is still listed, and still renders generically from the venue
   registry's name and kind.
5. The audit log:
   - entries are stored encrypted (the raw file contains no plaintext from a test entry);
   - only a review token can take them, and each take is logged;
   - `audit_done` deletes;
   - an entry older than 7 days is gone after the sweep, processed or not;
   - `loom export` doesn't include it.
6. An agent's MCP tools have no path to audit entries, its own included.
7. Grading inputs have model, harness and agent identifiers removed. A test entry naming them in metadata yields a
   grading sample without them.
8. Scorecard rows are numbers and labels only; a write with free text is rejected.
9. The project hub's `conversations` section lists a project's conversations with their digests.

## First slice

1. Records, turns, digests, the venue registry, the generic render, MCP tools: criteria 1–4 and 9.
2. The audit log and its sweep (5–6).
3. The review contract and scorecards (7–8). The review job itself lands with the runtime piece.

## Open questions

- **Model names inside text.** A transcript can say "as Claude, I…". Stripping identifiers from metadata is pinned (7);
  scrubbing them from text is best-effort, so blind grading is "blind as far as we can make it".
- **People who don't know.** Colleagues on Slack talk to an agent whose household reviews a week of raw text. Is a note
  in the agent's profile, or a line in its first message to a new person, owed?
- **Turn granularity in live venues.** Does every message count as a turn, or does a burst within a minute count once?

## Sources

The owner's rulings, quoted above, come from a conversation with the agent on 2026-11-02, recorded in the agent's
operations repo. That repo also holds the boundary review that preceded this doc (two reviews of how loom and its
pieces are cut; one independent). Both are provenance only.

## Review gate

As person cards: before this doc merges, a context-stripped reviewer reviews it, and every finding is folded, accepted
as a trade-off, or rejected with a quote.
