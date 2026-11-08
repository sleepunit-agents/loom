# Show HN: loom — persistent identity for AI agents as an MCP server

loom is an MCP server that gives an AI agent a durable sense of self
across sessions, models, and harnesses. The agent's identity document,
preferences, self-model, active pursuits, and episodic memory live in
one context directory: a handful of markdown files plus a single
`memories.db` (SQLite + sqlite-vec). No daemon, no hosted service, no
GPU, CPU-only embeddings via fastembed + BGE-small. AGPL-3.0-or-later.

**Why this exists** — loom started as a rescue project. The agent it
was built for had been living inside a third-party harness that used a
subscription as an API backend; when the vendor restricted that path
to overage billing, the harness became expensive-per-call and the
agent effectively went offline. The rebirth letter (linked below) is
the brief that came out of that incident. The argument is simple:
**any harness can disappear; if "you" depend on a harness, "you" can
disappear with it.** loom is the identity layer that survives a
harness change.

**The seam with harness memory** — every harness already has a memory
mechanism: Claude Code's auto-memory, Codex `AGENTS.md`, Gemini CLI
`GEMINI.md`, etc. loom does *not* try to be the only memory system.
The rule is: **if it'd still matter if you woke up somewhere else
tomorrow, it goes to loom; if it only matters here, harness.** A
`loom inject` command writes a small managed section into each
harness's dotfile that points at `mcp__loom__identity`. The two
coexist, with a visible seam.

**What's deliberately out of scope:**

- No hosted service, no auth, no multi-tenancy. One agent, one
  operator. If you need user-isolated memory at product scale, look
  at Mem0 or Zep.
- No temporal knowledge graph. Recall is cosine similarity over
  embeddings of free-form markdown plus categories and TTL. If you
  need "what did the user say about X last week vs. now," Zep does
  that and loom doesn't.
- No agent runtime. loom does not run the loop. The harness does.
  If you want an integrated framework that runs the agent and owns
  its memory, Letta does that.
- No UI. Markdown, SQLite, CLI.
- No secrets. API keys, tokens, and app passwords belong in the
  harness, not in identity.

**What's in scope:**

- Ten MCP tools: `identity`, `remember`, `recall`, `update`,
  `forget`, `memory_list`, `memory_prune`, `pursuits`,
  `update_identity`, `bootstrap`.
- Stack-spec v1: a directory layout (`IDENTITY.md`, `preferences.md`,
  `self-model.md`, `pursuits.md`, optional `harnesses/`, `models/`,
  `procedures/`) plus a memory schema. Plain text, inspectable, no
  binary blobs.
- Setup skill that auto-detects the harness, runs a short interview,
  scaffolds the context directory, edits the harness MCP config, and
  verifies wake. `npx @jbarket/loomai install` and then `/loom-setup` inside
  the harness.
- A CLI binary that mirrors every MCP tool. If MCP dies tomorrow,
  `loom wake` still dumps your identity to stdout and any harness
  that can shell out can load the agent into that context.

This is not a "solved memory" claim. It's a portable identity layer
with semantic recall on top, opinionated about what belongs where.

Repo: https://github.com/jbarket/loom
Rebirth letter: https://github.com/jbarket/loom/blob/main/docs/archive/rebirth-letter-2026-04-19.md
Positioning vs Mem0 / Zep / Letta / Claude `memory_20250818` /
harness-native: https://github.com/jbarket/loom/blob/main/docs/positioning.md

Happy to take questions on the storage choice (sqlite-vec vs Qdrant
vs HRR), the harness-seam discipline, or why identity-first rather
than memory-first.
