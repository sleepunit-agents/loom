# Store convergence — where knowledge is going, and how memory catches up

*2026-06-10. Written alongside the memory-wing retrofit (branch
`knowledge-tiered-recall-write-semantics`). Companion to the SLE-79
hardened design (pinned in Linear + loom memory) and
`docs/specs/loom-stack-v2.md`.*

## Context

The knowledge wing was built second and got the mature patterns:
close-in-finally, confirm gates on destruction, archive-first,
path/name validation, hard size caps, the epistemic gate. The 2026-06-10
review found the memory wing predates all of them. This retrofit ports
the patterns back — but it must also not paint us into a corner for
where knowledge goes next. This doc records both directions.

## Where knowledge is going (Phase-4, deferred by SLE-79)

The hardened design defers a signal-driven maintenance engine:

- **Expansion engine** — hot-but-thin pages get proactively deepened.
  Signal: `hit_count` / `last_accessed`. The 2026-06-10 tiered-recall
  change makes this signal honest for the first time: index listings no
  longer stamp access, so `hit_count` now means *read*, not *appeared in
  a listing*. Any future surface that lists pages without rendering
  bodies must preserve this invariant.
- **Vector layer** — deferred, not rejected. Pre-commitments recorded
  here so the retrofit aligns with it:
  1. **Embed title + synopsis only, never page bodies.** BGE-small
     truncates at 512 tokens; whole-page embedding is wrong by
     construction, and section-chunking is the RAG model the design
     rejects. A title+synopsis embedding fits the budget and serves the
     actual need (semantic *discovery* — find the page; the page itself
     is the synthesis unit you then read).
  2. **Sidecar index, separate file.** The crash-isolation invariant
     (no sqlite-vec loaded in the knowledge wing) holds by putting the
     vec index in its own rebuildable `knowledge-index.db` opened by a
     separate backend. `knowledge.db` remains the sole source of truth;
     the index can be dropped and rebuilt from pages at any time.
  3. **Shared embedder.** The vector layer reuses the process-wide
     embedding provider this retrofit introduces (see Lifecycle below) —
     one ONNX model in memory serving both wings.
- **Volatility taxonomy** — per-citation re-verification cadence.
- **`knowledge_wander`** — undirected traversal for consolidation.
- **Link graph (new candidate, 2026-06-10):** page bodies already carry
  `[slug]`-style cross-references that nothing resolves. A cheap
  write-time parse into a `links(from_slug, to_slug)` table would give
  backlinks and related-pages without touching retrieval. Candidate for
  the same phase as the vector layer; both are discovery surfaces.

## Convergence principles (what the retrofit establishes)

1. **One lifecycle.** Backends are process-lifetime, cached per resolved
   db path; the embedding provider is a process singleton. Tools do not
   open/close stores per call. The knowledge backend stays cheap-open /
   close-in-finally for now (no ONNX, no benefit), but may join the
   registry when the vector layer lands. `close()` on a cached backend
   evicts it from the registry — explicit close stays correct.
2. **One guard grammar.** Destructive scope operations require
   `confirm: true` in both wings (`forget` by category/project mirrors
   `knowledge_purge`). Soft-retire (archive + tombstone) is the default
   retirement path everywhere; hard delete is the exception that demands
   ceremony.
3. **One boundary discipline.** Numeric tool params validate
   (`.int().positive()`); category vocabulary is a single shared
   constant across MCP schemas and CLI; any param that becomes a file
   path segment (role, client, model, project) validates non-empty and
   separator-free at every reader, not just some writers.
4. **Atomic identity writes.** Anything under the identity tier
   (IDENTITY.md, preferences.md, self-model.md) writes via
   tmp+rename with a `.bak` of the prior version. A crash mid-write must
   never truncate the creed.
5. **Honest usage signals.** Listing is not reading, in either wing.
   Memory currently has no access stamping; if it ever grows one (e.g.
   for a memory-side expansion/consolidation engine), it inherits the
   index-vs-full distinction from day one.

## Consciously deferred

- Knowledge embeddings & link graph — Phase-4, shaped above.
- Wiring `append-maintenance-log` (implemented + tested, registered
  nowhere) — decide whether it ships or dies; its read-modify-write
  append also needs a lock or atomic pattern if two maintenance agents
  can ever overlap.
- Old archived memories whose vectors predate delete-on-archive keep
  their embeddings until touched; the growing-k recall loop makes this
  harmless. A one-time sweep can ride along with any future migration.
