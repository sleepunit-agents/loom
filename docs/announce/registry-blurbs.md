# Registry submission blurbs

Pre-staged content for the announce push (SLE-32). One section per
registry — each is its own PR / submission, filed separately. Do not
batch.

## Status

- Package: `@jbarket/loomai` on npm — **not yet published.** Until SLE-13 is
  green, every install command below uses the `github:jbarket/loom`
  spec, which is what the README currently promises and what works on
  a clean machine today.
- Pitch is calibrated per registry. Do not copy a single blurb across
  all of them — the official MCP list and an awesome list have very
  different houses styles.

## Pre-publish swap checklist

The day `@jbarket/loomai` goes live on npm, before filing any PR in this file:

1. Find/replace `npx github:jbarket/loom install` → `npx @jbarket/loomai install`.
2. Find/replace `npx github:jbarket/loom <cmd>` → `npx @jbarket/loomai <cmd>`
   in any per-registry instructions or screenshots.
3. Add the npm badge / npm package link to entries that take one.
4. Drop the "(GitHub-only install — npm publish pending)" caveat in
   the punkpeye blurb and anywhere else it appears.
5. Re-run the install command from a clean `HOME=$(mktemp -d)` once
   per registry submission to make sure the copy still describes
   reality.

If we end up shipping under a different name (`loom`, `@loom/cli`,
etc.) instead of `@jbarket/loomai`, the swap target changes — verify the
published name with `npm view <name> version` before mass-editing.

---

## 1. `modelcontextprotocol/servers` — official MCP list

**Repo:** https://github.com/modelcontextprotocol/servers
**Section:** `## 🌎 Community Servers` (third-party, not reference). Keep
alphabetical within the section.
**PR template fields:** name, repo URL, one-line description, category
(when prompted). Their CI checks the README format; preserve the
existing bullet shape exactly.

**Entry to add (alphabetical position: under "L"):**

```markdown
- **[loom](https://github.com/jbarket/loom)** - Persistent identity, episodic memory, and self-model for AI agents. Single-file sqlite-vec + fastembed; zero external services.
```

**PR body:**

```
Adds loom — an MCP server that gives an agent a durable sense of self
across sessions, models, and harnesses.

- Ten tools: identity, remember, recall, update, forget, memory_list,
  memory_prune, pursuits, update_identity, bootstrap.
- Storage: better-sqlite3 + sqlite-vec (vec0). One memories.db per
  agent. Real cosine similarity, no external vector DB.
- Embeddings: fastembed with BGE-small-en-v1.5 (384-dim, ~33MB ONNX,
  CPU-only).
- Transport: MCP over stdio. Node ≥ 20.
- License: AGPL-3.0-or-later.

Tested end-to-end on Claude Code, Codex, Gemini CLI, and OpenCode
(SLE-14 cold-test). Install via `npx github:jbarket/loom install`
today; `npx @jbarket/loomai install` once the npm release lands.

Repo: https://github.com/jbarket/loom
Spec: docs/loom-stack-v1.md in repo
```

**Notes:**
- Don't list it under "Reference Implementations" — that section is
  reserved for servers maintained by the MCP working group.
- If they have an "agent infrastructure" or "memory" sub-category,
  prefer that over generic Community.
- Honor any LANGUAGE / SCOPE tags they currently use (skim the README
  diff before opening the PR).

---

## 2. `punkpeye/awesome-mcp-servers` — community registry

**Repo:** https://github.com/punkpeye/awesome-mcp-servers
**Section:** Memory / Knowledge & Memory category. Verify the exact
heading the day of submission — punkpeye reorganizes periodically.
**Style:** awesome-list bullet with legend emojis. Their legend at
time of writing: 🎖️ official, 📇 TypeScript, 🏠 local, 🐧 Linux, 🍎
macOS, 🪟 Windows. Match whatever legend is current.

**Entry to add:**

```markdown
- [jbarket/loom](https://github.com/jbarket/loom) 📇 🏠 - Persistent identity and memory layer for AI agents. sqlite-vec + fastembed in one file; survives across sessions, models, and harnesses.
```

**PR body:**

```
loom is a single-file persistent-identity + memory MCP server. One
sqlite-vec database per agent, fastembed for local embeddings, no
external services. Ten tools cover identity load, episodic memory
(remember/recall/update/forget with TTL + categories), self-model
edits, and cross-session pursuits.

Local-only (🏠), TypeScript (📇), Node ≥ 20, AGPL-3.0-or-later.

Tested on Claude Code, Codex, Gemini CLI, and OpenCode.

Repo: https://github.com/jbarket/loom
```

**Notes:**
- Use repo-style title `jbarket/loom`, not bare `loom` — that's the
  punkpeye house style.
- Place alphabetically within the Memory category.
- Include cloud/local emojis honestly: loom is 🏠 (local-only) — do
  not also mark ☁️.

---

## 3. Cursor MCP directory

**Submission surface:** https://cursor.directory/ (community-driven
directory) and any in-product MCP submission flow Cursor exposes at
submission time. Format and PR target: verify in the cursor.directory
repo (https://github.com/pontusab/cursor.directory or its successor)
before filing — the schema changes.
**Format expectation:** name, short description, install snippet (the
JSON block users paste into `~/.cursor/mcp.json`), category, repo URL,
optional logo.

**Entry copy:**

```yaml
name: loom
tagline: Persistent identity and memory for your Cursor agent.
description: |
  loom gives Cursor a durable sense of self that survives across
  sessions and model swaps. Identity, episodic memory with semantic
  recall, ongoing pursuits — all stored in a single sqlite-vec file
  under your context directory. Zero external services.
category: memory  # or "agent-infrastructure" if available
repo: https://github.com/jbarket/loom
license: AGPL-3.0-or-later
```

**Install snippet (drop into the directory entry's `config` field):**

```json
{
  "mcpServers": {
    "loom": {
      "command": "npx",
      "args": ["-y", "github:jbarket/loom"],
      "env": {
        "LOOM_CONTEXT_DIR": "${HOME}/.config/loom/default"
      }
    }
  }
}
```

**PR body / cover note:**

```
Submitting loom — persistent-identity + memory MCP server, validated
against Cursor as part of our cold-test pass.

Stack: sqlite-vec + fastembed, single-file storage, no external deps.
Install command in the snippet uses the GitHub spec while we finish
the npm publish; will update to `npx -y @jbarket/loomai` once that lands.

Suggested category: Memory (or Agent Infrastructure if available).
Logo: assets/loom-logo.png in the repo (200×200, transparent PNG).
```

**Notes:**
- Confirm the `mcpServers` JSON shape matches Cursor's *current*
  config schema — they renamed keys in past versions.
- If they require a separate `displayName` vs `name`, use `loom` for
  both.
- Don't promise "Cursor-specific features." loom is harness-agnostic;
  pitch the cross-harness durability as the value prop.

---

## 4. Windsurf MCP directory

**Submission surface:** Windsurf (Codeium) MCP server index. As of
writing, Windsurf surfaces MCP servers via in-app discovery and a
docs-site listing (https://docs.windsurf.com/windsurf/mcp). Verify the
submission path the day of filing — they may have a dedicated repo or
form.
**Format expectation:** name, description, install/config snippet (the
`mcp_config.json` shape Windsurf uses), category, repo URL.

**Entry copy:**

```yaml
name: loom
tagline: Persistent identity + memory for your Windsurf agent.
description: |
  Give Cascade a durable identity that survives session restarts and
  model swaps. Episodic memory with semantic recall, agent-editable
  self-model, cross-session pursuits — all in one sqlite-vec file. No
  daemon, no external service.
category: memory
repo: https://github.com/jbarket/loom
license: AGPL-3.0-or-later
```

**Install snippet (Windsurf `mcp_config.json` form):**

```json
{
  "mcpServers": {
    "loom": {
      "command": "npx",
      "args": ["-y", "github:jbarket/loom"],
      "env": {
        "LOOM_CONTEXT_DIR": "${HOME}/.config/loom/default",
        "LOOM_CLIENT": "windsurf"
      }
    }
  }
}
```

**PR body / cover note:**

```
Submitting loom for the Windsurf MCP directory. Cold-tested against
Windsurf as part of SLE-14 — install skill drives full setup
(probe → interview → bootstrap → MCP config edit → wake verify).

Persistent identity layer: sqlite-vec + fastembed in one file, ten
MCP tools, zero external services. Set LOOM_CLIENT=windsurf so the
client adapter loads the right wake hints.
```

**Notes:**
- The `LOOM_CLIENT=windsurf` env hint is real — loom's client adapter
  layer keys off it. Worth including in the snippet.
- If Windsurf's directory takes a "Tested with Windsurf version X"
  field, fill it from whatever cold-test build was used.
- Same logo + license fields as Cursor.

---

## 5. Gemini CLI server index

**Submission surface:** Google's Gemini CLI surfaces MCP servers via
its extension / server registry. Verify the canonical submission path
the day of filing — likely a PR to a Google-owned repo (e.g.
`google-gemini/gemini-cli-extensions` or the docs site under
ai.google.dev).
**Format expectation:** name, short description, install snippet (the
`~/.gemini/settings.json` `mcpServers` shape), repo URL, optional
trust/permissions metadata.

**Entry copy:**

```yaml
name: loom
tagline: Persistent identity + memory for Gemini CLI agents.
description: |
  loom gives a Gemini CLI agent a durable sense of self that survives
  across sessions and model swaps. One sqlite-vec file holds identity,
  episodic memory with semantic recall, and ongoing pursuits. No
  daemon, no external service, CPU-only embeddings.
repo: https://github.com/jbarket/loom
license: AGPL-3.0-or-later
```

**Install snippet (Gemini CLI `~/.gemini/settings.json` form):**

```json
{
  "mcpServers": {
    "loom": {
      "command": "npx",
      "args": ["-y", "github:jbarket/loom"],
      "env": {
        "LOOM_CONTEXT_DIR": "${HOME}/.config/loom/default",
        "LOOM_CLIENT": "gemini-cli"
      }
    }
  }
}
```

**PR body / cover note:**

```
Submitting loom for the Gemini CLI server index. Cold-tested against
Gemini CLI as part of our four-harness validation pass — the install
skill auto-edits `~/.gemini/settings.json` and verifies wake.

Identity + memory MCP server: sqlite-vec + fastembed, single-file
storage, ten tools, CPU-only. Setting LOOM_CLIENT=gemini-cli loads
the matching client adapter so identity payloads include
Gemini-specific wake hints.
```

**Notes:**
- Confirm the settings.json key (`mcpServers`) and shape against the
  Gemini CLI version current at submission. Google has renamed config
  keys between minor versions.
- If the registry asks for a "permissions" field (network/fs access),
  declare: filesystem read/write to `LOOM_CONTEXT_DIR` and
  `LOOM_FASTEMBED_CACHE_DIR`. No network at runtime; first-run model
  download is the only outbound HTTP.

---

## 6. OpenAI — placeholder

**Status:** OpenAI's first-party agent surfaces (ChatGPT custom GPTs,
the Assistants API, the in-development Apps SDK) do not currently
accept third-party MCP server submissions through a public registry.
File this section live the day they do.

**What to pre-stage when format is announced:**

1. The same one-liner (calibrate on whether they want
   developer-facing or end-user-facing copy).
2. An install path that doesn't assume a local Node runtime — OpenAI
   surfaces tend to be hosted/cloud. loom is local-only by design, so
   the pitch will need to be honest: "for OpenAI agents that run in
   environments with filesystem access (Codex CLI, future local
   Apps SDK builds)."
3. License disclosure (AGPL-3.0-or-later) — relevant if OpenAI's
   marketplace has license restrictions.

**Note:** Codex (CLI) is already covered by our cold-test pass and by
the install skill's `--harness codex` flow; that's a separate surface
from any future OpenAI marketplace and should be treated as such.
Don't conflate them in the same submission.

---

## Filing order (recommended)

1. `modelcontextprotocol/servers` — official list, sets the canonical
   one-liner. Land this first; downstream registries often crib from
   it.
2. `punkpeye/awesome-mcp-servers` — high-traffic, low-friction PR.
3. Cursor + Windsurf + Gemini CLI — file in parallel; each is a
   distinct surface with its own review queue.
4. OpenAI — defer until they publish a submission path.

Each PR gets its own commit message and its own follow-through. Don't
batch and don't cross-link unless a registry's template asks for
"other listings."
