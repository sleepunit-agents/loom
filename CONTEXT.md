# loom

Persistent identity and memory for one agent, portable across harnesses.
Glossary only — the words the code, the docs, and the specs are held to.
General programming concepts are deliberately absent. (Format: Pocock
`domain-modeling`; adopted 2026-08-26.)

## The agent

**Agent**:
The one persistent entity loom serves. Its self is the context directory,
not any running process.
_Avoid_: assistant, bot, model, persona

**Context directory**:
The on-disk home of one agent (`~/.config/loom/<name>/`): creed, preferences,
self-model, manifests, and the SQLite stores. Portable — move it and the
agent moves.
_Avoid_: profile, workspace, config dir, data dir

**Terminal creed**:
The free-form markdown that defines who the agent is: values, voice, purpose.
Immutable through the tool layer; edited only by a human.
_Avoid_: system prompt, identity file (it is one part of identity), constitution

**Identity**:
What a session loads first: creed + preferences + self-model + the harness
and model manifests + the boot digest. The `identity` tool's payload.
_Avoid_: bootstrap (that's creating an agent), context, prompt

**Preferences**:
What the agent has learned about how its human wants to work. Section-edited
via `update_identity`.
_Avoid_: settings, config, user profile

**Self-model**:
The agent's running self-knowledge: strengths, learning, current focus.
Section-edited via `update_identity`.
_Avoid_: personality, traits, capabilities list

**Harness**:
The MCP-capable runtime the agent runs in (Claude Code, Codex, Gemini CLI…).
loom does not run the loop; the harness does.
_Avoid_: client (the MCP peer), framework, platform, IDE

**Harness manifest / model manifest**:
Per-harness and per-model markdown in the context directory describing tool
prefixes, delegation primitives, gotchas, capability notes. Injected as part
of identity. A harness may only describe itself (`harness_describe`).
_Avoid_: adapter (see client adapter), plugin, driver

**Client adapter**:
The harness-specific tail of the identity payload, keyed to the connecting
MCP `clientInfo.name`.
_Avoid_: manifest, shim

**Managed block**:
The pointer `loom inject` writes into a harness's dotfile (CLAUDE.md,
AGENTS.md…) so the harness loads identity from one context directory instead
of a copied prompt.
_Avoid_: snippet, header, boilerplate

**Dossier**:
The brief a worker body loads instead of identity: preferences and self-model
in the third person plus a push-back mandate, and no creed.
_Avoid_: identity-lite, worker prompt, persona

**Worker body**:
A session that serves the agent but is not the agent — executes a brief,
reads a dossier, never writes memory as the agent.
_Avoid_: subagent, worker, helper

## Memory

**Memory**:
An authored entry the agent chose to record — about its human, its work, or
itself — with a category, an embedding, optional TTL and metadata. Never
auto-extracted.
_Avoid_: fact (see knowledge page), note, log entry, record

**Category**:
An open vocabulary tag on a memory. Common: `user`, `project`, `self`,
`feedback`, `reference`, `pursuit`, `episode`. Writing a new one creates it.
_Avoid_: type, tag, label, kind

**Recall**:
Semantic (vector) retrieval of memories by a query, optionally filtered by
category. Distinct from `knowledge_recall`, which is text search over pages.
_Avoid_: search, query, lookup, fetch

**Salience**:
A memory's computed importance from its timestamps and access pattern; what
the boot digest ranks by. Recomputed by the consolidation lane.
_Avoid_: score, relevance, weight, priority

**Boot digest / Top of Mind**:
The salience-ranked view of memories assembled at identity load — what
matters, not what's recent.
_Avoid_: summary, recent memories, context window

**Episode**:
A memory with `category: episode` — where a body was, what was said or
decided, what shipped, what's open — written before a session ends. Short TTL
(48h default). A body in a conversation writes a digest instead; bodies
without one still write episodes.
_Avoid_: session summary, handoff, checkpoint, log

**Tape**:
The last N hours of episodes and conversation digests, interleaved by time and
never ranked, injected at boot after preferences. The cross-body short-term
tier. A digest on the tape is still not a memory: recall doesn't find it.
_Avoid_: short-term memory, activity log, feed, timeline

**Archive / tombstone**:
Soft retirement of a memory or page: hidden from recall and audit, original
body preserved under a tombstone (who / when / why), recoverable by restore.
_Avoid_: delete (that's `forget` / `purge`), hide, disable, soft-delete (say archive)

**Proposal**:
A drafted memory in a staging queue, invisible to recall and the digest until
the agent ratifies it through the normal validated write path or rejects it.
Keeps loom one-writer while allowing auto-capture ergonomics.
_Avoid_: pending memory, draft, suggestion, auto-memory

**Consolidation**:
The maintenance pass that dedupes near-duplicates, recomputes salience, and
audits staleness (`find_similar`, `memory_audit`, `memory_prune`).
_Avoid_: cleanup, compaction, GC, tending (the agent's nightly promotion pass
— a caller, not loom's term)

## People

**Person**:
A human the agent works with, identified by a stable slug
(`patrick-kells`). Not a user account, not a platform identity.
_Avoid_: user (that is a memory category), contact, profile, member

**Person card** (card):
The condensed current state of what the agent knows about one person:
structured fields plus a short synthesized summary. Overwritten in place;
revisions keep the past. Not a knowledge page and not the memories it
condenses. Descriptive, never an authorization surface.
_Avoid_: profile, dossier (that is the worker brief), person page, record

**Card field**:
One named value on a card, optionally carrying `verified_at`.
_Avoid_: attribute, property, fact

**Room**:
The set of people a turn is addressed by. The harness (bridge, lane, voice)
knows who is in it and passes it as identity's `people`; loom does not guess.
_Avoid_: audience, channel (a room is people, not a venue)

## Conversations

(docs/specs/conversations.md)

**Conversation**:
An exchange between an agent and others (people, agents, or a schedule) in one
place in one venue: who, where, when, and what came of it. Keyed by agent ·
venue · place. A core record: it outlives the piece that carried it.
_Avoid_: chat, session (that's a body's run), thread (that's a venue's word), transcript

**Comms**:
loom's app for talking with your own agents (docs/specs/comms.md): a list of threads, and one thread at a time. Only
an agent's owners use it; everyone else reaches agents through the bridges.
_Avoid_: chat app, messenger, console

**Thread** (in Comms):
One Comms conversation: a place in core's venue `loom`, with an agent, a title and the member who opened it.
_Avoid_: chat, channel, session (that's a body's run)

**Message** (in Comms):
One entry in a thread, numbered by `seq`: the member's words, the agent's reply, an activity card, an ask or an error
line.
_Avoid_: turn (that's the conversation record's metadata entry), post

**Activity**:
What a body is doing in a thread's turn, as plain one-line cards ("Ran the tests"): a summary, never a tool's output.
_Avoid_: log, trace, transcript

**Venue**:
Where conversations happen, and the adapter that carries them: `discord`,
`slack`, `session` (an interactive harness), `wake`, `relay`. A venue has a
**kind** (`live`, `scheduled` or `agent`) that sets what it is measured on.
_Avoid_: channel (that's a place), platform, bridge (that's the adapter's code)

**Place**:
The venue's own address for one conversation: a DM with someone, a channel, a
schedule, an agent pair. The venue defines its places; core treats a place as
an opaque string.
_Avoid_: room (that's the people a turn is addressed by), channel

**Turn**:
One message or action in a conversation, as metadata: who, when, how long the
reply took, which model and harness. Never its text.
_Avoid_: message (that's the venue's object), event

**Digest**:
A body's own summary of its run in a conversation: what was asked, decided and
done, and whether the owner is needed. One per body run. Not a memory: recall
doesn't search it, and `conversations` reads it.
_Avoid_: summary (that's a field), episode (a digest replaces one where a conversation exists)

**Audit log**:
The temporary, encrypted store of raw turn text that grading reads and then
deletes. Not "the tape": the tape is the boot-time stream above.
_Avoid_: tape, transcript store, history

**Review**:
The household's daily pass. **Grading** is household-wide, by bare models,
blind. **Introspection** is per agent, by that agent, without raw text.
_Avoid_: retro, reflection (that's an agent's own lane), evaluation

**Finding**:
A grader's note on one turn: one line of at most 200 printable characters, at
most one per conversation per UTC day. A meaningful quote is fine; bulk quoting
isn't, and the cap is what stops it (nothing machine-checks the words). Kept on
the turn's agent's side.
_Avoid_: comment, feedback (that's a memory category)

**Scorecard**:
Grades per model, family, harness and venue kind, aggregated across the
household. Numbers and fixed labels only.
_Avoid_: leaderboard, benchmark
## Projects

**Project**:
An ongoing body of work with a goal, identified by a stable slug (`pond`). Its card is the condensed current state;
its hub is everything filed under it, read live.
_Avoid_: epic (a task-store row), workspace, repo, initiative

**Project card**:
The condensed current state of a project: what it is, its goal, where it stands, and the selectors its hub reads with.
_Avoid_: project page (that's the hub as shown), brief, charter

**Hub**:
A project's sections, computed at read: its memories, notes, people and conversations, and what pieces contribute.
_Avoid_: dashboard, feed, timeline

**Project name**:
A slug or an alias. Every project name resolves to exactly one live project. **Live** means not archived, whatever its
`status`: a paused or done project keeps its names.
_Avoid_: tag (that's the memory field a name matches), key

**Section feed** (seam):
A managed piece's contribution to a hub: a command loom runs that returns grouped items for one project.
_Avoid_: plugin, integration, widget

**Repo selector**:
A project card's `links.repos` entry, `<forge>:<locator>` (`github:acme/app`; a bare `acme/app` is GitHub's). Core
checks its syntax and passes it to feeds as `--repo`; a piece reads the repo (docs/specs/changes.md).
_Avoid_: repo link, remote

**Change**:
A proposed change to one repo, open for review, on whatever forge hosts it (a pull or merge request). The Changes
piece lists them; a standing rule in the approvals piece says whether an agent asks before merging one.
_Avoid_: PR (that's GitHub's word), patch

**Conversation digest**:
A body run's own summary of its conversation, a core record: see **Digest** under Conversations.
_Avoid_: transcript (that's the session), summary (that's a card field), episode (that's a 48h memory)

## Knowledge

**Knowledge page**:
An entity page about the world — truth independent of the human — keyed by
slug, filed under a domain, carrying citations. Lives in `knowledge.db`,
separate from memory.
_Avoid_: memory, note, article, doc, wiki page

**Slug**:
A page's stable identifier. Re-keyed only by `knowledge_move`; a collision
is a merge, not a move.
_Avoid_: id, key, name, path

**Domain**:
The page's dotted or slashed place in the knowledge tree
(`music/gear/elektron`). Subtrees move atomically.
_Avoid_: category (memory's word), folder, namespace, tag

**Citation**:
A claim + source pair attached to a page. Sources are specs, URLs, files, or
conversation; duplicates by claim+source collapse.
_Avoid_: reference, link, footnote, evidence

**Epistemic gate / provisional**:
A page whose only citations are conversation is stored `provisional` — held,
not believed — until a non-conversational source lands.
_Avoid_: draft, unverified (see verification), pending, low-confidence

**Verification / freshness anchor**:
Stamping a page as "claims still hold" (`verified_at`) without touching its
body; the freshness anchor is the external date the claims are pinned to.
_Avoid_: update, refresh, rewrite, re-check (fine as a verb for the lane)

**Supersede**:
Retire a page in favour of a canonical one: archive the loser with a pointer
to the winner and record the relationship. The dedup primitive.
_Avoid_: replace, overwrite, merge (merge consolidates bodies too), redirect

**Merge**:
Consolidate two or more pages into one canonical page — citations
re-parented, `verified_at` maxed, losers superseded.
_Avoid_: combine, dedupe (the goal, not the operation), supersede

**Purge**:
Hard-delete of already-archived pages with citation cascade; requires
`confirm`. Supersession pointers survive.
_Avoid_: delete, remove, clean, forget (memory's word)

**Revision**:
A snapshot of a page body displaced by a replace-write (newest 10 kept).
Restoring one snapshots the body it displaces first.
_Avoid_: version, backup, history entry, diff

**Misfile**:
A knowledge page that is really a memory (about the human or the work), or
vice versa; `knowledge_maintain` reports them.
_Avoid_: miscategorized, wrong bucket, drift

## The desktop

**Tile**:
One app on a big screen, sharing the screen with others by the tiling rule (docs/specs/desk-tiling.md). It has its own
page, its own history and its own frame.
_Avoid_: window (the old single big frame, gone 2026-11-06), pane, panel

**Widget**:
A small tile: one of Home's cards (an agent's card, Needs you, Vitals, Backup) or the ticker. It is live, never gets a
split of its own, and opens its app beside it.
_Avoid_: gadget, applet

**Fit**:
What an app declares about the room it can use: a minimum, an ideal and a maximum width, a minimum height, and whether
it wants the big slot.
_Avoid_: size hint, constraints

**The big slot**:
The first app tile, the large one on the left once there are three or more apps.

**The rail**:
The column the widgets stack in, on the right, while apps are open. **The strip** is the rail folded to one 64 px key
per widget.

## Relationships

- Identity is read at boot; memory and knowledge are read on demand; the
  digest and the tape are the two slices of memory that ride along with
  identity.
- Memory is about the human, the work, or the agent; knowledge is about the
  world. The misfile audit polices the line.
- One writer: only the agent writes memory. Proposals stage; ratification
  writes. Worker bodies read a dossier and write nothing.
- Archive → restore is reversible; purge is not and requires archive first.
- Supersede is archive + pointer; merge is supersede + body/citation
  consolidation.

## Distinctions worth stating

- **Category vs domain.** Memory uses *category* (flat, open); knowledge uses
  *domain* (tree). Never swap them.
- **Recall.** `recall` is vector search over memory; `knowledge_recall` is
  LIKE search over pages. Both are called "recall" in prose — say which.
- **Forget vs archive vs purge.** `forget` hard-deletes a memory; `archive`
  soft-retires either kind; `purge` hard-deletes archived pages. Prose often
  says "delete" for all three.
- **Salience vs recency.** The digest ranks; the tape orders. Calling either
  "recent memories" is wrong for one of them.
- **Harness vs client.** Harness is the runtime; client is what MCP calls the
  connecting peer. The manifests are keyed by client name but describe the
  harness.
