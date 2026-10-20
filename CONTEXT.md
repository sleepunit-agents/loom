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
(48h default).
_Avoid_: session summary, handoff, checkpoint, log

**Tape**:
The last N hours of episodes, time-ordered and never ranked, injected at boot
after preferences. The cross-body short-term tier.
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
