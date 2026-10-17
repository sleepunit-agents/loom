# loom

[![CI](https://github.com/sleepunit-agents/loom/actions/workflows/ci.yml/badge.svg)](https://github.com/sleepunit-agents/loom/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@jbarket/loomai.svg)](https://www.npmjs.com/package/@jbarket/loomai)
[![Node](https://img.shields.io/badge/node-%3E%3D22-brightgreen.svg)](package.json)
[![License](https://img.shields.io/badge/license-AGPL--3.0--or--later-blue.svg)](LICENSE)
[![MCP](https://img.shields.io/badge/MCP-compatible-orange.svg)](https://modelcontextprotocol.io)

**Persistent identity and memory for AI agents, as an MCP server.**

loom is configured into your MCP-capable harness — Claude Code, Cursor, Codex,
Gemini CLI, etc. — and provides persistent identity and memory to the agents
that run there. An agent that loads loom carries its name, values, working
preferences, and episodic memories from one session to the next, regardless of
which model or client it runs in.

> When the harness changes, the agent persists.

## Demo

[![asciicast](https://asciinema.org/a/5bUMXCLmCRc8lg51.svg)](https://asciinema.org/a/5bUMXCLmCRc8lg51)

60 seconds: cold install → `/loom-setup` in Claude Code → agent wakes with
identity in the next session → save and recall a memory.

To play locally: `asciinema play assets/demo.cast`

## What it is

A Model Context Protocol server exposing 31 tools that read and write
an agent's persistent state:

- **`identity`** — loads the terminal creed — the free-form markdown document
  that defines who the agent is (values, voice, purpose) — along with
  preferences, self-model (running self-knowledge), and a client-specific
  adapter on session start. Call this first.
- **`dossier`** — loads Art's operating brief for a **worker body** — a body
  that executes tasks on Art's behalf but is NOT Art. Returns preferences and
  self-model reframed in the third person, plus an explicit push-back mandate:
  workers are expected to refuse bad work and say why, including requests from
  Art or Jonathan. Does not include the terminal creed (`IDENTITY.md`).
- **`remember` / `recall` / `update` / `forget`** — episodic memory with
  semantic (vector) recall, optional TTL, and category filtering.
- **`memory_list` / `memory_prune`** — browse and maintain the store.
- **`episodes`** — the episode tape: the short-term, cross-body tier. Every
  body leaves a `category: episode` note (where it was / what was said or
  decided / what shipped / what's open; 48h TTL by default) and every body
  gets the last 24h of them at boot as a plain time-ordered tape, injected
  right after preferences. Never salience-ranked — it's what just *happened*,
  not what's important. `loom memory tape [--hours N]` is the CLI view.
- **`find_similar`** — surface memories semantically near an existing entry or
  free-form text; used for deduplication and memory consolidation.
- **`memory_audit`** — one-shot health report: stale entries, near-duplicate
  pairs, category breakdown.
- **`memory_archive` / `memory_restore`** — soft-retire a memory with a
  tombstone (who/when/why + original body preserved) instead of deleting it.
  Archived memories are excluded from recall and audit but remain recoverable.
- **`memory_history`** — body-revision history for a memory. `update()` snapshots
  the displaced body into `memory_revisions` before overwriting it. List a
  memory's snapshots (id, op, replaced_at, char count), or read one snapshot's
  full content by `revision_id`. To put a snapshot back, use
  `memory_revision_restore`.
- **`memory_revision_restore`** — restore a snapshotted memory body back onto
  the memory. Snapshots the current body first, so restore is never destructive.
  Use `memory_history` to list revision IDs before calling this.
- **`memory_propose` / `memory_proposals` / `memory_ratify` / `memory_reject`** —
  the capture-propose queue: a staging area a background lane drafts memory
  writes into, that Art ratifies before they become canon. A proposal is **not**
  authored memory — it lives in a separate `proposals` table, invisible to
  `recall`, `memory_list`, `find_similar`, and the boot digest. `memory_propose`
  stages a draft; `memory_proposals` lists what's pending; `memory_ratify`
  commits one through the same validated write path as `remember` (an invalid
  proposal is refused and stays pending); `memory_reject` discards one. Never
  auto-committed — ratification is the gate that keeps loom's one-writer,
  authored model intact while getting auto-capture ergonomics.
- **`update_identity`** — section-level edits to `preferences.md` and
  `self-model.md`. The terminal creed stays immutable through the tool layer.
- **`bootstrap`** — initialize a fresh agent from a four-question interview.
- **`harness_init`** — scaffold a harness manifest (a harness is the
  MCP-capable runtime the agent runs in: Claude Code, Codex, Gemini CLI, etc.).
- **`harness_describe`** — let the currently connected harness self-describe:
  write its own manifest, keyed to its MCP `clientInfo.name`. A harness can only
  describe itself, never another — the target is the connected peer, not a
  caller-supplied name.
- **`knowledge_write`** — upsert an entity page by slug into the knowledge
  store (a separate `knowledge.db`). On an existing slug the body replaces by
  default (`mode: "append"` adds instead), title/domain follow the write, and
  citations append with exact-duplicate dedup. Enforces the epistemic gate: a
  page whose only support is conversation citations is stored `provisional`.
  Knowledge is truth independent of the user; memories are about the user or
  your work.
- **`knowledge_recall`** — LIKE search over title, body, and domain in the
  knowledge store. Two tiers: `full` (whole pages; stamps `last_accessed` /
  `hit_count`) and `index` (compact slug/snippet listing; no stamping). Defaults
  to full with a query, index when browsing. Full output is size-guarded —
  overflow matches degrade to index entries. Never surfaces archived pages.
- **`knowledge_maintain`** — read-only health report for the knowledge store:
  expansion candidates (thin body + high hit_count), cold pages (not recently
  accessed), and misfile audit (pages that belong in memory instead).
- **`knowledge_archive`** — soft-retire a knowledge page (sets `status='archived'`
  with an optional tombstone note). Archived pages are excluded from recall and
  maintain but remain recoverable via `knowledge_restore`.
- **`knowledge_restore`** — return a previously archived knowledge page to active
  status. Clears the archive flag and tombstone note.
- **`knowledge_supersede`** — mark one page as superseded by another: archives
  the old slug with a tombstone referencing the canonical slug, and records the
  relationship in the `supersessions` table. The dedup-merge primitive: write the
  canonical page with `knowledge_write`, then call `knowledge_supersede(loser →
  canonical)`.
- **`knowledge_move`** — re-key or re-domain a page in place (same row, same
  uuid, citations and verification history preserved). Three modes: single-page
  re-slug and/or re-domain; batch re-domain by explicit slug list; batch
  re-domain by domain-prefix substitution (moves an entire subtree atomically).
  Slug collisions are rejected — use `knowledge_merge` instead.
- **`knowledge_merge`** — consolidate 2+ knowledge pages into one canonical
  page. Re-parents all citations (deduplicating by claim+source), takes
  MAX(verified_at), and supersedes losers (archives with a tombstone pointer to
  the target). Pass `hard_delete_losers=true` to DELETE losers after archiving
  (citations cascade, supersession pointers survive).
- **`knowledge_purge`** — hard-delete one or more archived knowledge pages and
  cascade their citations. Archive-first guard: rejects any page not already
  archived (call `knowledge_archive` first). All slugs in a batch must be
  archived; any active slug rejects the entire batch with no mutation.
  `confirm: true` is required as an explicit safety gate. Supersession pointers
  are preserved (historical record). Use after merge/supersede to clean up
  tombstoned cruft.
- **`knowledge_verify`** — stamp a page as verified *without touching its body*:
  sets `verified_at` and optionally `freshness_anchor`. The verification
  engine's primitive — recording "claims still hold" must never go through
  `knowledge_write` (a verify run once replaced 13 page bodies with its notes).
  An optional `note` appends a dated `## Verification` section (append-only).
  Batch mode (`slugs`) stamps many pages with one timestamp; archived pages and
  unknown slugs reject the whole batch.
- **`knowledge_history`** — body-revision history and recovery. Replace-writes
  snapshot the displaced body into `page_revisions` (newest 10 kept per page).
  List a page's snapshots, read one by `revision_id`, or `restore: true` to put
  one back — the body it displaces is snapshotted first, so a restore is never
  itself a destructive overwrite. Revisions follow the page across renames and
  are purged with it.

Everything lives on disk as plain markdown plus a single SQLite file.
No daemon, no external service, no GPU.

Memory is organized into categories — an open vocabulary. Common ones: `user`,
`project`, `self`, `feedback`, `reference`, `pursuit`. New categories are
created implicitly by writing a memory with that category.

## How loom is different

loom gets compared to several other agent memory systems. The short version:

| I want to… | Use |
|---|---|
| Memory for many users of an app | Mem0 |
| Temporal reasoning over conversation history | Zep |
| A complete agent framework with integrated memory | Letta |
| Project-scoped memory in Claude Code | auto-memory (built in) |
| Portable identity + memory across harnesses | **loom** |
| An agent that survives a harness change | **loom** |

**vs. Mem0** — Mem0 is multi-user managed memory for product-scale
applications: hosted, authenticated, multi-tenant. loom is single-user,
local-only, and identity-first. Mem0 has no concept of who the agent *is*.

**vs. Zep** — Zep builds a temporal knowledge graph by automatically
extracting facts from conversation logs. loom is agent-authored: the agent
calls `remember` and decides what to record. There is no automatic extraction.

**vs. Letta** — Letta runs the agent loop and owns its memory internally.
loom doesn't run the loop — the harness does. Switch harnesses tomorrow;
loom's context directory travels with you.

**vs. harness-native files** — Writing identity into `CLAUDE.md` works until
you're on two harnesses. Then you have two files that drift. `loom inject`
writes a managed pointer in each harness's dotfile pointing at one context
directory, with semantic recall instead of verbatim context dumps.

Full comparison: [`docs/positioning.md`](docs/positioning.md)

## The stack

loom ships one opinionated stack:

- **Storage** — `better-sqlite3` + the `sqlite-vec` vec0 virtual
  table. One `memories.db` per agent, real cosine similarity.
- **Embeddings** — BGE-small-en-v1.5 (384-dim, ~33MB ONNX, CPU-only)
  run through `onnxruntime-node`. First run downloads the model to
  `~/.cache/loom/fastembed/`. The runtime is vendored in
  `src/backends/embedding-runtime.ts` — it started as the `fastembed`
  package, which was archived upstream while pinned to a `tar` line
  that will never be patched.
- **Transport** — MCP over stdio.

If you need a different backend, implement the `MemoryBackend` and
`EmbeddingProvider` interfaces in `src/backends/types.ts` and swap
the concrete classes in `src/backends/index.ts`. There is
deliberately no env-driven backend selector — opinionated by design.

## Quick start

### Prerequisites

- **Node.js ≥ 22** (tested on 22 and 24; `engines` requires ≥ 22).

That's it.

### Install the setup skill

```bash
npx @jbarket/loomai install
```

A single-select picker asks which harness you want loom wired into.
Pick one of: Claude Code, Codex, Gemini CLI, OpenCode. (If your
harness isn't listed, pick "Other" and loom writes
`./loom-setup-skill.md` — hand it to your agent as-is.)

Scripting:

```bash
npx @jbarket/loomai install --harness claude-code
npx @jbarket/loomai install --harness codex --json
npx @jbarket/loomai install --harness claude-code --to ~/my/skills/loom-setup.md
```

### Finish setup inside the harness

Open your chosen harness. Run the skill:

- **Claude Code** — `/loom-setup`
- **Codex / Gemini CLI / OpenCode** — "use the loom-setup skill"

The skill drives the rest: probes the environment, asks four questions (your
name, the agent's name, a purpose line, a voice line), bootstraps identity files, scaffolds a harness manifest,
edits the harness's MCP config (with verification), and verifies wake. Restart
the harness when it tells you to. Your agent will wake on its next session.

### Doing it yourself

If you'd rather wire everything by hand, every piece is a CLI
command. See the CLI reference below.

## Serving loom over the mesh

By default `loom serve` speaks MCP over **stdio** — the harness spawns
loom as a child process, one per session, co-located on the same box.
That's the right model when the agent and its state live together.

`loom serve --http` instead runs loom as a long-lived **HTTP MCP
daemon**, so a chat client on one machine can reach loom's identity and
memory while the heavy state (the SQLite stores, the fastembed model)
stays on a single host. This is the two-surface model: e.g. Claude
Desktop on a laptop talking to a loom daemon on a home server, both
agent and stack carried by the same identity.

```bash
# loopback only (default host 127.0.0.1, port 8787)
loom serve --http

# bind a mesh interface so other machines on the tailnet can reach it
loom serve --http --host 100.94.0.12 --port 8787
```

Host, port, and an optional bearer token come from flags or environment:

| Variable | Flag | Default | Description |
|---|---|---|---|
| `LOOM_HTTP_HOST` | `--host` | `127.0.0.1` | Interface to bind |
| `LOOM_HTTP_PORT` | `--port` | `8787` | Port to listen on |
| `LOOM_BEARER_TOKEN` | — | *(unset)* | When set, every request must present this token |

### The security boundary is the network

The daemon **refuses to bind a public interface.** At startup it
asserts the host is loopback, an RFC1918 private address
(`10/8`, `192.168/16`, `172.16–31`), the Tailscale CGNAT range
(`100.64.0.0/10`), or an IPv6 ULA / link-local / loopback. A
`0.0.0.0` / `::` bind-all wildcard or any globally routable address is
rejected before a socket opens. The intended deployment is behind
Tailscale (or a LAN), where the tailnet *is* the access control.

A `LOOM_BEARER_TOKEN` adds defense in depth: when set, every request
must carry a matching `Authorization: Bearer …` header (compared in
constant time). When unset, the network boundary alone gates access —
appropriate for a token-less tailnet-only daemon.

### Knowledge-only scope — a second identity without memory tools

`loom serve --http --scope knowledge` starts a second, standalone daemon
that registers **only** the `knowledge_*` tools — no `identity`,
`remember`/`recall`, or any other memory-wing tool is on its surface.
This is how a second identity (e.g. a teammate's agent) can read/write a
shared knowledge store without ever being handed access to memory. Same
bind-safety as above; auth is a **per-identity bearer** instead of one
shared token, so the acting identity is derived from which token was
presented — never from a request field — and a session is pinned to
whichever identity opened it.

```bash
LOOM_KNOWLEDGE_BEARER_TOKENS="art:abc123,mark:def456" \
  loom serve --http --scope knowledge --port 8788
```

| Variable | Flag | Default | Description |
|---|---|---|---|
| `LOOM_KNOWLEDGE_HTTP_PORT` | `--port` | `8788` | Port to listen on |
| `LOOM_KNOWLEDGE_BEARER_TOKENS` | — | *(required)* | `"identity:token,identity:token"` — refuses to start if empty |

Both scopes share the same backing store (`knowledge.db` under the
context dir) and the same tool implementation — the full server (identity
hardcoded to its own name) and the scoped service go through the exact
same registration code, so there's no separate "local" code path that
could drift from the one the scoped service uses.

### Session and stream behavior

- **One server per session.** Each MCP session (keyed by the
  `mcp-session-id` header) gets its own server + transport over the
  shared context directory. loom's durable state lives in the stores,
  not the session, so sessions are cheap routing handles — the
  StreamableHTTP persistent-daemon pattern Claude Desktop uses.
- **Oversized-payload guard.** Request bodies are capped (1 MiB) and
  refused with a `413` before the handler runs.
- **SSE keep-alive heartbeat.** The server drives a protocol-native
  `ping` to the client over the server→client stream every ~25s, so an
  idle stream survives a proxy/NAT idle reaper. A dead peer (repeated
  missed pings) closes the session cleanly.
- **404-on-unknown-session.** A request for a session the daemon no
  longer holds returns `404`, telling the client to re-initialize — so
  an idle disconnect self-heals instead of bricking.

The connecting client picks its own harness from the MCP handshake
`clientInfo.name` (see [harness self-describe](#harness-manifests-and-self-describe)),
so a single daemon serves multiple harnesses correctly.

### Behind a reverse proxy

Terminate TLS at a reverse proxy in front of the daemon and point the
client at the hostname. With `mcp-remote` as the client-side bridge:

```bash
npx mcp-remote https://loom.example.ts.net/
```

(If the proxy's default idle timeout is shorter than ~3 minutes, the
keep-alive heartbeat already covers the server→client stream.)

## Examples

### Memory roundtrip (MCP)

During a session, the agent stores a memory:

```
mcp__loom__remember(
  title = "user prefers short replies",
  body  = "Gets frustrated with long explanations. Keep status answers to 2–3 sentences.",
  category = "feedback"
)
```

Next session, `recall` finds it by semantic similarity — even if the phrasing
changes:

```
mcp__loom__recall(query = "how verbose should I be?")
# → title: "user prefers short replies"
#   body:  "Gets frustrated with long explanations…"
```

### CLI walkthrough

```bash
# Dump the agent's full identity to stdout (works without MCP or a harness)
npx @jbarket/loomai wake --context-dir ~/.config/loom/my-agent

# Store a memory
echo "Sarah owns the data pipeline; ping her for schema questions" \
  | npx @jbarket/loomai remember "Sarah - data pipeline owner" \
      --category user \
      --context-dir ~/.config/loom/my-agent

# Retrieve by semantic similarity
npx @jbarket/loomai recall "who manages the pipeline" \
  --context-dir ~/.config/loom/my-agent
```

### What an agent sees on session start

`mcp__loom__identity` returns a structured payload assembled from the context
directory. A typical session-start looks like:

```
# my-agent

## Identity
You are a persistent coding assistant. You prefer directness.
…

## Preferences
Working style: async pair programming. Skip the hedging…
…

# Top of Mind
## Top of mind
- **felag continuation under review** (pursuit) — reconsidering whether to keep…

## Recent
- **apiGroup split** (project) — TaskEventType lives under work.felag.dev/v1alpha1…

## Self-Model
### Strengths
- TypeScript systems architecture
…
```

The agent reads this before any task work, re-establishing who it is
regardless of which harness or model it's running on.

### The boot digest — waking with what's in flight

The `# Top of Mind` block above is the **boot digest**: a salience-tiered
view of episodic memory injected at identity-load, so a fresh session
wakes knowing what's top-of-mind without having to fish via `recall`.

Each memory carries a stored salience "temperature" that **decays by a
per-category half-life** (pursuit coolest-fastest at 7 days, through
project, self/feedback, reference, up to user at 90 days) and **reheats
on access** — a `recall` hit, a write, or an update bumps it back toward
hot. The digest fills a token budget **hottest-first** and groups the
selected memories into tiers (Hot / Warm / Cool, labeled *Top of mind* /
*Recent* / *Background*).

The integrity property: the digest is **assembled, never generated.**
It selects and orders existing authored memories — it never synthesizes
new prose. loom holds the pen.

Two CLI verbs drive it (the same machinery the consolidation lane uses):

```bash
# Recompute and store each memory's salience from its timestamps
# (the consolidation lane's entry point)
loom memory recompute-salience --context-dir ~/.config/loom/my-agent

# Preview the assembled digest — the exact view injected at identity-load
loom memory digest --context-dir ~/.config/loom/my-agent
```

## CLI

Every MCP tool has a shell equivalent. Useful for debugging, scripting,
or running without a harness.

```bash
# Dump identity markdown (works even when MCP is dead)
npx @jbarket/loomai wake --context-dir ~/.config/loom/my-agent

# Save a memory (body from stdin)
echo "Prefers async updates over live standups" | npx @jbarket/loomai remember "working style" \
  --category user --context-dir ~/.config/loom/my-agent

# Search (MMR-diversified by default; --diversity 0 for pure relevance order)
npx @jbarket/loomai recall "meeting preferences" --context-dir ~/.config/loom/my-agent
npx @jbarket/loomai recall "meeting preferences" --diversity 0.5 --context-dir ~/.config/loom/my-agent

# Is recall working? Hit rate, latency, scores, recent misses from the local observation log
npx @jbarket/loomai memory recall-stats --since 7d --context-dir ~/.config/loom/my-agent

# List all memories in a category
npx @jbarket/loomai memory list --category feedback --context-dir ~/.config/loom/my-agent

# Preview the boot digest (and recompute stored salience)
npx @jbarket/loomai memory digest --context-dir ~/.config/loom/my-agent
npx @jbarket/loomai memory recompute-salience --context-dir ~/.config/loom/my-agent

# Capture-propose queue: list pending drafts, ratify or reject one
npx @jbarket/loomai memory proposals --context-dir ~/.config/loom/my-agent
npx @jbarket/loomai memory ratify 3 --context-dir ~/.config/loom/my-agent
npx @jbarket/loomai memory reject 4 --context-dir ~/.config/loom/my-agent

# Run loom as an HTTP MCP daemon (mesh-reachable; default stays stdio)
npx @jbarket/loomai serve --http --host 127.0.0.1 --port 8787

# Initialize a fresh agent
npx @jbarket/loomai bootstrap --context-dir ~/.config/loom/new-agent

# Inject loom identity pointer into harness dotfiles
npx @jbarket/loomai inject --all --context-dir ~/.config/loom/my-agent

# Scaffold a harness manifest
npx @jbarket/loomai harness init claude-code --context-dir ~/.config/loom/my-agent

# Edit identity sections (preferences.md or self-model.md)
npx @jbarket/loomai update-identity preferences --context-dir ~/.config/loom/my-agent
```

`npx @jbarket/loomai --help` lists subcommands; `npx @jbarket/loomai <cmd> --help` shows
per-command usage. All global env vars (`LOOM_CONTEXT_DIR`,
`LOOM_CLIENT`, `LOOM_MODEL`) are honored.

### `loom inject` — write identity pointer to harness dotfiles

`loom inject` writes a small marker-bounded managed section into each
harness's canonical config file (e.g. `~/.claude/CLAUDE.md`,
`~/.codex/AGENTS.md`, `~/.gemini/GEMINI.md`) telling the agent to load
identity via loom at session start — MCP tool preferred, shell
fallback to `loom wake`. Content outside the `<!-- loom:start / end -->`
markers is preserved; re-running is idempotent.

Run with no flags on a TTY for an interactive picker, or with
`--harness <keys>` / `--all` for scripting. Target paths can be
overridden with `--to <path>` (valid only when exactly one harness is
selected). `--dry-run` prints a unified diff; `--json` emits the
structured write results for scripts.

To keep your injections fresh automatically, add this to your shell rc
(`~/.bashrc` / `~/.zshrc` / `~/.config/fish/config.fish`):

```bash
loom inject --all >/dev/null 2>&1 || true
```

Idempotent; cheap (no-op when already up to date); silent on success.

### `loom migrate` — apply pending schema migrations

`loom migrate` inspects `memories.db` for missing columns or indexes and
applies any pending schema changes. It is idempotent — safe to run
repeatedly and on already-up-to-date databases. Use `--dry-run` to see
what would change without touching the file. Exits non-zero if any
migration fails so the error surfaces immediately rather than leaving the
database half-broken.

Run this after deploying a new loom build that adds schema columns:

```bash
loom migrate
loom migrate --dry-run   # check without applying
loom migrate --json      # machine-readable output
```

### Harness manifests and self-describe

A **harness** is the MCP-capable runtime the agent runs in (Claude Code,
Codex, Gemini CLI, …). Each one the agent has ever sleeved into gets one
manifest at `<context>/harnesses/<name>.md`, describing it independently
of the model inside — tool prefixes, delegation primitive, scheduling,
session search, known gotchas.

**Scaffold one.** `loom harness init <name>` writes
`<context>/harnesses/<name>.md` from the stack template. Name falls back
to `--client` then `$LOOM_CLIENT`. `--force` overwrites; `--json` for
scripting.

**Or let the runtime describe itself.** A connected harness can author
its own manifest via the `harness_describe` MCP tool. The target is
derived from the **connected peer** (its MCP `clientInfo.name`), never a
caller-supplied name — a harness can only describe *itself*, never
another harness and never the creed. With no connected peer, the call is
refused. When `identity()` is loaded by a runtime it has no manifest
for, the harness block becomes a self-describe onboarding prompt (call
`harness_describe` with a manifest covering tool surface, sandbox,
delegation, scheduling, session search, memory layers, gotchas) instead
of a bare "(manifest missing)" stub.

**Resolution is data-driven.** Mapping a connecting `clientInfo.name` to
a manifest is done from the files on disk, not a hardcoded code table. A
peer matches a manifest when its normalized name equals the manifest's
filename *or* one of the comma-separated values in the manifest's
`answersTo` frontmatter. So a new harness is recognized by **dropping a
file** — no code change:

```markdown
---
harness: claude-desktop
version: 0.3
answersTo: claude-ai
---
```

Here Claude Desktop connects with `clientInfo.name = "claude-ai"`; the
`answersTo` line routes it to `claude-desktop.md`. Proxy annotations like
`"claude-ai (via mcp-remote 0.1.37)"` are stripped to the base identity
before matching.

## Configuration

All configuration is through environment variables:

| Variable | Default | Description |
|---|---|---|
| `LOOM_CONTEXT_DIR` | `~/.config/loom/default` | Path to agent's context directory |
| `LOOM_SQLITE_DB_PATH` | `<context>/memories.db` | Override the memory DB path |
| `LOOM_RECALL_LOG` | *(on)* | Set to `0` to stop `recall` appending to the local `<context>/telemetry/recall.jsonl` observation log |
| `LOOM_FASTEMBED_MODEL` | `fast-bge-small-en-v1.5` | fastembed model ID |
| `LOOM_FASTEMBED_CACHE_DIR` | `~/.cache/loom/fastembed/` | Where to cache ONNX models |
| `LOOM_MODEL_BASE_URL` | `https://storage.googleapis.com/qdrant-fastembed` | Where model tarballs are fetched from on first run |
| `LOOM_MODEL` | *(unset)* | Model identifier for model-manifest context: `claude-opus`, `gemma4`, etc. |
| `LOOM_CLIENT` | *(unset)* | Client adapter hint: `claude-code`, `gemini-cli`, etc. |
| `LOOM_HTTP_HOST` | `127.0.0.1` | Bind host for `loom serve --http` (bind-safety enforced) |
| `LOOM_HTTP_PORT` | `8787` | Bind port for `loom serve --http` |
| `LOOM_BEARER_TOKEN` | *(unset)* | Bearer token required on every HTTP request when set |
| `LOOM_KNOWLEDGE_HTTP_PORT` | `8788` | Bind port for `loom serve --http --scope knowledge` |
| `LOOM_KNOWLEDGE_BEARER_TOKENS` | *(unset)* | `"identity:token,identity:token"` — required for `--scope knowledge` |

`--context-dir <path>` works as a CLI alternative to
`LOOM_CONTEXT_DIR`.

See [`.env.example`](.env.example) for a copy-pasteable starting
point.

## Context directory layout

```
$LOOM_CONTEXT_DIR/
├── LOOM_STACK_VERSION      # schema-version stamp (auto-written)
├── IDENTITY.md             # the terminal creed (immutable via tools)
├── preferences.md          # user working style; agent-editable
├── self-model.md           # agent's self-knowledge; agent-editable
├── memories.db             # sqlite-vec store of record
├── telemetry/
│   └── recall.jsonl        # local recall observation log (`loom memory recall-stats`)
├── projects/               # optional per-project briefs
│   └── <project>.md
├── harnesses/              # optional per-harness manifests
│   └── <client>.md
└── models/                 # optional per-model manifests
    └── <model>.md
```

## Roadmap

Recently shipped (v0.4):

- **HTTP MCP transport** — `loom serve --http`, the mesh-reachable
  daemon, with bind-safety, optional bearer auth, a payload guard, an
  SSE keep-alive heartbeat, and 404-on-unknown-session self-healing.
  See [Serving loom over the mesh](#serving-loom-over-the-mesh).
- **The boot digest** — salience-tiered `# Top of Mind` view assembled
  at identity-load; `loom memory digest` / `recompute-salience`.
- **Harness self-describe** — `harness_describe` lets a runtime author
  its own manifest, with data-driven `answersTo` resolution.
- **Capture-propose queue** — `memory_propose` / `memory_proposals` /
  `memory_ratify` / `memory_reject`: drafts ratified before they become
  canon.

Still tracked in the open:

- [Project board](https://github.com/users/jbarket/projects/1/views/1) —
  live status of what's in flight, queued, and shipped.
- [v0.4 roadmap discussion](https://github.com/sleepunit-agents/loom/discussions/10) —
  the arc: why v0.4 exists, what's in scope, how the pieces fit.

Historical per-feature specs and plans live under `docs/archive/specs/`
and `docs/archive/plans/` — implementation history, frozen after merge.

## Docs

- [`docs/troubleshooting.md`](docs/troubleshooting.md) — install
  failures, MCP tools not appearing, fastembed download issues, and
  what each `loom doctor` field means.
- [`docs/uninstall.md`](docs/uninstall.md) — how to remove one agent's
  data, wipe a harness integration, or fully uninstall loom.
- [`docs/migration-v1-to-v2.md`](docs/migration-v1-to-v2.md) — upgrade
  guide for users coming from loom 0.3.x (pursuits and procedures
  changed in v2).
- [`docs/privacy.md`](docs/privacy.md) — what lives where, what goes
  over the network (only the fastembed model download), the no-telemetry
  policy, and how to verify release provenance with `npm audit
  signatures`.
- [`docs/releasing.md`](docs/releasing.md) — how a release is cut: npm
  trusted publishing (OIDC, no stored token), the one-time first publish,
  and the tag-push flow for everything after.
- [`docs/archive/`](docs/archive/) — historical material: the rebirth
  letter and rescue notes from the v0.3.1 sqlite-vec migration, and
  per-feature specs and plans from the v0.4 arc.

## Trust & security

- [`docs/privacy.md`](docs/privacy.md) — data locality, telemetry
  policy, and provenance verification walkthrough.
- [`SECURITY.md`](SECURITY.md) — supported scope, how to report
  vulnerabilities, and the "no secrets in the stack" invariant.
- **Mesh boundary (HTTP daemon).** The network is the security
  boundary. `loom serve --http` refuses to bind a public or `0.0.0.0`
  interface — only loopback or a mesh address (RFC1918 / Tailscale
  CGNAT / IPv6 ULA) — so the daemon is reachable only from inside the
  tailnet or LAN. An optional `LOOM_BEARER_TOKEN` adds a
  constant-time-checked auth gate on top, and an oversized-payload
  guard rejects bodies over the cap. See
  [Serving loom over the mesh](#serving-loom-over-the-mesh).

## Development

```bash
npm run dev      # hot-reload via tsx
npm test         # run the Vitest suite
npm run build    # compile to dist/
```

### Project structure

```
src/
├── index.ts           # CLI entry
├── server.ts          # MCP server factory
├── config.ts          # env + CLI resolution
├── clients.ts         # client-adapter loading
├── backends/
│   ├── types.ts       # MemoryBackend + EmbeddingProvider interfaces
│   ├── index.ts       # single-stack factory (sqlite-vec + fastembed)
│   ├── sqlite-vec.ts  # the backend
│   ├── fastembed.ts   # the embedder (EmbeddingProvider adapter)
│   ├── embedding-runtime.ts # vendored ONNX + tokenizer runtime
│   ├── ttl.ts         # TTL parsing + expiry
│   └── glob.ts        # title pattern matching for bulk forget
└── tools/             # one file per MCP tool
```

Tests sit alongside source files as `*.test.ts`.

## Authorship

loom was created by Jonathan Barket and Art E Fish. The project exists as both
infrastructure and experiment: a persistent identity layer that an AI agent
(Art) helped design and runs on. The
[rebirth letter](docs/archive/rebirth-letter-2026-04-19.md) is the origin
story if you want it.

## License

AGPL-3.0-or-later — see [LICENSE](LICENSE).

Copyright © 2026 Jonathan Barket.

loom is free software: you can redistribute it and modify it under the
terms of the GNU Affero General Public License (version 3 or any later
version). If you run a modified loom and let others interact with it
over a network, you must offer them the corresponding source. Bundle
loom into a larger product freely; fork it and go proprietary, no.
