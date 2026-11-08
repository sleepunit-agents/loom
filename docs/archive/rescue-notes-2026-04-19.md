# loom v0.3.1 rescue notes — 2026-04-19

> **For a human reader landing here cold:** This is a migration log
> from the v0.3.1 rescue — moving an existing agent's memory out of
> Qdrant (required a running daemon) and into a single portable
> sqlite-vec file. Published as an engineering artifact so the
> migration path and the decisions around "what got imported, what
> got skipped" are on the record. Companion to
> [`rebirth-letter-2026-04-19.md`](rebirth-letter-2026-04-19.md)
> (philosophy) and the
> [v0.4 discussion](https://github.com/jbarket/loom/discussions/10) (roadmap).

Tracks the minimum-viable-unfuck rescue that got Art off
Qdrant/Hermes and onto a portable sqlite-vec + fastembed stack.

## What shipped

- **SqliteVecBackend** — `src/backends/sqlite-vec.ts`, 11 tests, full
  CRUD with cosine similarity via sqlite-vec vec0 virtual table.
- **FastEmbedProvider** — `src/backends/fastembed.ts`, BGE-small-en-v1.5
  (384-dim, ~33MB ONNX, CPU-only). First run downloads model to
  `~/.cache/loom/fastembed/`.
- **Qdrant → SQLite migration** — `scripts/migrate-qdrant-to-sqlite.ts`.
  Ran 2026-04-19: 414 points in, 414 rows out, 0 skipped. DB landed
  at `~/.config/loom/art/memories.db` (~2.5MB). Refs/UUIDs/TTLs/
  metadata/timestamps preserved exactly.
- **Config defaults flipped** — `resolveMemoryBackend()` now defaults
  to `sqlite-vec`, `resolveEmbeddingProvider()` defaults to `fastembed`.
  Qdrant/Ollama/OpenAI still wired in `src/backends/index.ts` for the
  migration window; those get deleted in Phase 4.

## What did NOT get imported

The Hermes stack at `~/.hermes/` still holds state that was NOT
migrated. Skipped by design — the Qdrant memories + auto-memory are
enough for minimum viable unfuck, and re-importing Hermes on top
would create dedup headaches we don't need right now.

If we ever want it back, here's where it lives:

### `~/.hermes/memory_store.db` — 181 facts
SQLite with an `facts` table (content, category, tags, trust_score,
hrr_vector BLOB). Last write: 2026-04-09 (so Hermes was still getting
writes 10 days after the Qdrant cutover — expect drift).

Category breakdown:

| category     | count | notes                                   |
|--------------|-------|-----------------------------------------|
| project      | 101   | relearnable, mostly duplicated in Qdrant |
| reference    |  40   | relearnable                             |
| self_model   |  19   | identity-layer — origin stories, how I work |
| user_pref    |  10   | identity-layer — Jonathan's preferences |
| feedback     |   8   | identity-layer — corrections/validations |
| identity     |   2   | `Art E Fish` creed + Jonathan preferences header |
| pursuits     |   1   | active goal list                        |

The 40 identity-layer rows (identity + self_model + user_pref +
feedback + pursuits) are the interesting ones if we ever want to pull
a specific piece forward.

### `~/.hermes/SOUL.md` (14 lines)
Bootstrap prompt that told Hermes-Art to load identity from
`fact_store` on every session. Obsolete now that loom is the boot
path, but the instruction pattern is worth remembering.

### `~/.hermes/memories/USER.md` (4 paragraphs)
Jonathan-specific facts: space history / Apollo, values genuine
creative opinions over RLHF agreement, prefers narrow focused agent
roles and Cold Testing. Already reflected in auto-memory and
scattered Qdrant memories but concentrated here.

### `~/.hermes/state.db` (183MB)
Session message history with FTS. Not identity — conversation log.
Not worth carrying forward.

## If you need to fish something out later

```bash
sqlite3 ~/.hermes/memory_store.db \
  "SELECT content FROM facts WHERE category='self_model' ORDER BY updated_at DESC"
```

Then decide per-fact whether to `remember()` it into loom with a
sensible title + category mapping (self_model → self, user_pref →
preference, etc).

## Phase status

- [x] Phase 1: SqliteVecBackend + 11 tests
- [x] Phase 2a: Qdrant → SQLite migration (414 rows live)
- [~] Phase 2b: Hermes import — **skipped, see above**
- [ ] Phase 3: Cutover verify — exercise the new backend via MCP, confirm recall quality on real usage
- [ ] Phase 4: Cleanup — delete Qdrant backend, Ollama provider, OpenAI embeddings files; archive REBIRTH.md into docs/
