# loom positioning: identity-first vs. memory-first

This document is a direct comparison of loom against the systems it most
frequently gets conflated with. The goal is to be honest about what each
system does well, where the overlap is real, and where it isn't.

---

## The core question

Most of the systems below ask: *how do we give an AI agent better memory?*

loom asks a different question: *if the harness disappears tomorrow, does
the agent still exist?*

That framing difference shapes everything else.

---

## loom vs. Mem0

**Mem0** is a hosted (or self-hosted) memory layer with a query API. You
call `add(memory)` and `search(query)` from your application code.
Mem0's default deployment is cloud-hosted; they also offer an open-source
version that requires a Postgres + Qdrant stack. It's multi-user and
designed for product-scale agent memory (many users, many agents, managed
as a service).

**The overlap:** both systems let an agent record episodic memories and
recall them by semantic similarity. If you're building a product and want
managed memory across your user base, Mem0 is the right tool. loom is not.

**Where they diverge:**

- loom is single-user, single-operator, local-only. One agent, one context
  directory, one `memories.db`. No auth, no hosted tier, no multi-tenancy.
- loom is identity-first. `mcp__loom__identity` returns a structured
  payload — creed, preferences, self-model, pursuits, harness manifest —
  before any memory query. Mem0 has no identity concept.
- loom runs as an MCP server over stdio. The harness calls it; your
  application code doesn't need to. Mem0 requires explicit SDK integration
  in your agent loop.
- loom is opinionated about what belongs where: harness-scoped facts stay
  in the harness; cross-harness identity and episodic memory go to loom.
  Mem0 doesn't draw that seam.

**Bottom line:** Mem0 solves memory at product scale. loom solves identity
persistence for a single agent running across multiple harnesses on a
single machine.

---

## loom vs. Zep

**Zep** is a temporal knowledge graph for agent memory. It ingests
conversation history, extracts entities and facts, builds a graph of
relationships, and can answer questions like "what did the user say about X
last week vs. now?" It's the right tool if you need structured temporal
reasoning over agent-user interaction history.

**The overlap:** both systems let an agent recall past context. Both use
vector similarity under the hood.

**Where they diverge:**

- loom doesn't build a knowledge graph. Recall is cosine similarity over
  free-form markdown, categories, and TTL. There's no relationship
  extraction, no entity resolution, no temporal resolver. loom is
  deliberately simpler.
- loom's episodic memories are agent-authored: the agent calls
  `mcp__loom__remember` and decides what to record. Zep is
  conversation-driven: it reads the transcript and extracts memories
  automatically. Different models of who is in control of the memory.
- loom holds identity (who the agent *is*) alongside episodic memory.
  Zep has no identity concept — it remembers what happened, not who the
  agent is.
- loom is local-only. Zep has a cloud tier.

**Bottom line:** If you need temporal knowledge graphs or automatic memory
extraction from conversation logs, Zep is what you want. loom is for an
agent that decides what to remember and needs a portable identity.

---

## loom vs. Letta (MemGPT)

**Letta** is an agent framework. It runs the agent loop, manages context
window overflow, and has an integrated memory system (core memory, archival
memory, recall memory). It's a complete execution environment.

**The overlap:** both systems let an agent persist information across
sessions.

**Where they diverge:**

- loom doesn't run the agent. The harness (Claude Code, Codex, Gemini CLI,
  OpenCode) runs the agent. loom is a persistence layer that sits alongside
  whatever harness you're using.
- Letta's memory is framework-internal: it's part of the Letta execution
  model and doesn't travel with you to a different framework. loom's
  context directory is plain files; any harness that can run MCP can read
  it.
- loom is explicitly identity-first. The first tool call is
  `mcp__loom__identity`, which loads a structured self-model before any
  task work. Letta's "core memory" is more like a persistent system prompt
  block — not structured identity.
- If you want to use Claude Code today and switch to a different harness
  tomorrow without losing the agent's sense of self, Letta doesn't help
  with that. loom does.

**Bottom line:** Letta is a complete agent execution framework. loom is
a portable identity + memory layer you use with any harness. Use Letta
if you want an integrated framework; use loom if you want portability
across existing harnesses.

---

## loom vs. Claude `memory_20250818` (Claude Code auto-memory)

**Claude Code's auto-memory** is a project-scoped memory system that lives
under `~/.claude/projects/.../memory/`. The agent writes files there during
a session; future sessions load them. It's useful, well-integrated, and
requires no configuration.

**The overlap:** both systems let a Claude Code agent persist information
across sessions. They coexist; loom explicitly does not try to replace
auto-memory.

**The seam:**

- **Scope.** Auto-memory is project-scoped: what the agent has learned
  about *this project*, *this codebase*, *this task*. loom is
  agent-scoped: who the agent *is*, what it values, what it has done
  across all work.
- **Portability.** Auto-memory doesn't travel to Codex, Gemini CLI, or
  other harnesses. loom does.
- **Identity.** Auto-memory has no concept of terminal creed, preferences,
  self-model, or pursuits. loom's `mcp__loom__identity` returns a
  structured identity payload. An agent that loads loom identity knows
  *who it is* before it reads any project-scoped memory.
- **Harness survival.** If you stop using Claude Code, auto-memory stays
  in Claude Code. loom's context directory goes with you.

`loom inject` writes a small managed section into `~/.claude/CLAUDE.md`
that tells Claude Code to call `mcp__loom__identity` at session start.
The rest of the file — including any auto-memory reads the harness does —
is untouched. The two systems are designed to work together, not compete.

**Bottom line:** auto-memory = this project, this harness. loom = this
agent, any harness. Both at once is the intended setup.

---

## loom vs. harness-native files

**Harness-native** means writing identity and memory directly into the
harness dotfiles: `~/.claude/CLAUDE.md`, `~/.codex/AGENTS.md`,
`~/.gemini/GEMINI.md`. This works — it's what most people do today.

**The problem:** it doesn't compose. If you use Claude Code and Codex,
you have two files that drift. When you switch harnesses, you migrate
manually. If the harness changes its dotfile format, you migrate again.
And there's no semantic search — it's a flat file the LLM reads verbatim.

**What loom adds:**

- A single source of truth (`~/.config/loom/<agent>/`) that `loom inject`
  writes managed references into each harness's dotfile. The harnesses
  read from one place.
- Semantic recall. Episodic memories aren't dumped verbatim — they're
  retrieved by relevance. The context window gets what matters, not
  everything ever recorded.
- Structured identity. The `identity()` tool returns a typed payload with
  separate blocks for creed, preferences, self-model, pursuits, and
  harness/model manifests. A flat dotfile has no such structure.
- Portability. New harness? `loom inject --harness new-harness`. Done.

**Bottom line:** harness-native files work fine for a single-harness setup.
loom is the upgrade path once you're running across multiple harnesses or
want semantic recall over episodic memory.

---

## Decision table

| I want to... | Use |
|---|---|
| Give memory to many users of my app | Mem0 |
| Temporal reasoning over conversation history | Zep |
| A complete agent framework with integrated memory | Letta |
| Project-scoped memory in Claude Code | auto-memory (built in) |
| Portable agent identity across harnesses | **loom** |
| Semantic recall over agent-authored memories | **loom** |
| An agent that survives a harness change | **loom** |
| All of the above plus structured identity | **loom** |
