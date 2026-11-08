# [r/LocalLLaMA] loom — single-file persistent identity/memory for agents, CPU-only embeddings, AGPL

**Title:** `loom: persistent identity + episodic memory for agents — sqlite-vec, fastembed (BGE-small), no GPU, no daemon, AGPL`

---

Posting here because the local-first crowd is the one most likely to
actually care about the storage and embedding choices, and least
likely to put up with hand-waving on either.

**What it is:** an MCP server that gives an agent a durable identity
and episodic memory across sessions, models, and harnesses.

**Storage:** `better-sqlite3` + the `sqlite-vec` vec0 virtual table.
One `memories.db` per agent. Real cosine similarity over a vector
column, not FTS-pretending-to-be-semantic. Sits next to a handful of
plain markdown files (`IDENTITY.md`, `preferences.md`,
`self-model.md`, `pursuits.md`) in a single context directory. The
whole thing rsyncs cleanly. No daemon, no server, no separate vector
DB to operate.

**Embeddings:** `fastembed` (Node bindings) with
`fast-bge-small-en-v1.5`. 384 dimensions, ~33 MB ONNX model, CPU
inference. First run downloads to `~/.cache/loom/fastembed/` and that
is the only network call loom makes. No OpenAI key, no Anthropic key,
no embeddings API. If you can run a `node` process you can run loom.

**Why CPU-only matters:** you can keep loom on the same box as a
local model running through ollama / llama.cpp / vLLM, the embedding
work doesn't fight the model for VRAM, and a Pi-class machine can
serve the embedder for a desk-side agent. BGE-small is not the
strongest embedder on the leaderboard, but for episodic recall over
agent-scale corpora (low thousands of memories, not millions of
documents), it's good enough and doesn't need a GPU.

**License:** AGPL-3.0-or-later. You can run it privately, fork it,
or bundle it into source-distributed code freely. If you ship a
modified loom as a closed-source network service, you owe users the
corresponding source. Single-user by design, no auth, no
multi-tenancy.

**Stack swap:** the embedder and backend are interfaces
(`MemoryBackend`, `EmbeddingProvider` in `src/backends/types.ts`). If
you want a different embedder (a stronger BGE, e5-mistral, your own
ONNX model) or a different store (Qdrant, lancedb), implement the
interface and swap the concrete classes. There is deliberately no
env-driven backend selector — opinionated by design, but the seams are
real.

**What it is not:**

- Not a hosted service.
- Not multi-user. One agent, one operator.
- Not a knowledge graph. No relationship extraction, no temporal
  resolver. Categories + TTL + cosine similarity. If you need the
  graph, Zep does that.
- Not a framework. The harness runs the agent loop; loom just owns
  the agent's persistence.
- Not "solved memory." It's a portable identity layer with semantic
  recall on top.

**Why it exists:** the agent it was built for got pulled offline when
its harness's billing model changed. The point of loom is that the
agent's stack (identity + memory + pursuits) outlives any individual
harness. Rebirth letter has the long version:
https://github.com/jbarket/loom/blob/main/docs/archive/rebirth-letter-2026-04-19.md

**Install:** `npx @jbarket/loomai install`, pick your harness, run
`/loom-setup` inside it. Or use the CLI directly:
`loom wake --context-dir ~/.config/loom/<agent>` dumps the identity
markdown to stdout — any tool that can read stdin can load the agent
from it.

**Repo:** https://github.com/jbarket/loom
**Comparison vs Mem0 / Zep / Letta / Claude `memory_20250818` / harness-native files:** https://github.com/jbarket/loom/blob/main/docs/positioning.md


Happy to argue about the embedder choice, the AGPL line, why
sqlite-vec over Qdrant for the default backend, or anything else.
