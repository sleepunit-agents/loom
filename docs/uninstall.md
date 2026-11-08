# Uninstalling loom

How to partially or fully remove loom from your system.

## Where your data lives

Everything loom writes is under two top-level paths:

| What | Default path | Notes |
|---|---|---|
| Agent context (identity, memories) | `~/.config/loom/<agent>/` | One directory per agent |
| Embedding model cache | `~/.cache/loom/fastembed/` | ~33 MB ONNX file; safe to delete |

`$LOOM_CONTEXT_DIR` defaults to `~/.config/loom/default`. If you set it to a custom
path, your data is wherever that variable points.

---

## Remove one agent's memories (keep identity)

To delete all memories in a specific category:

```bash
npx @jbarket/loomai forget --category user --context-dir ~/.config/loom/<agent>
npx @jbarket/loomai forget --category project --context-dir ~/.config/loom/<agent>
# repeat for each category
```

To wipe the entire memory store in one step, delete the database file directly:

```bash
rm ~/.config/loom/<agent>/memories.db
```

loom will create a fresh empty store on next run.

---

## Remove one agent entirely

```bash
rm -rf ~/.config/loom/<agent>/
```

This deletes the identity files (`IDENTITY.md`, `preferences.md`, `self-model.md`),
the memory store, and all manifests. **This cannot be undone.**

---

## Remove loom from a harness

loom integrates with a harness in two places: the MCP config (so the server starts)
and the persona/dotfile injection (so the agent calls `identity` at session start).
Both need to be removed.

### 1. Remove the MCP server entry

Edit the harness's MCP config and delete the `loom` block:

| Harness | Config file |
|---|---|
| Claude Code | `~/.claude.json` (global) or `.mcp.json` in the project root |
| Codex | `~/.codex/config.toml` |
| Gemini CLI | `~/.gemini/settings.json` |
| OpenCode | `~/.config/opencode/config.json` |

The loom entry looks something like:

```json
"loom": {
  "command": "node",
  "args": ["..."],
  "env": { "LOOM_CONTEXT_DIR": "..." }
}
```

Delete the entire block. Restart the harness for the change to take effect.

### 2. Remove the injection pointer

`loom inject` writes a marker-bounded managed section into the harness's dotfile.
To remove it, delete the block between the markers:

```
<!-- loom:start -->
...everything here...
<!-- loom:end -->
```

| Harness | Dotfile |
|---|---|
| Claude Code | `~/.claude/CLAUDE.md` |
| Codex | `~/.codex/AGENTS.md` |
| Gemini CLI | `~/.gemini/GEMINI.md` |

### 3. Remove the setup skill

The skill file is used only during initial setup. Once removed it won't affect a
running agent, but it's tidy to clean up:

| Harness | Skill file |
|---|---|
| Claude Code | `~/.claude/skills/loom-setup.md` |
| Codex / Gemini CLI / OpenCode | `~/.agents/skills/loom-setup.md` |

---

## Full wipe

Remove everything loom has ever written:

```bash
# All agent data
rm -rf ~/.config/loom/

# Embedding model cache
rm -rf ~/.cache/loom/

# Skill files
rm -f ~/.claude/skills/loom-setup.md
rm -f ~/.agents/skills/loom-setup.md
```

Then edit the harness MCP config files (listed above) to remove the `loom` server
entry, and remove the `<!-- loom:start / end -->` blocks from the dotfiles.

After restarting your harness, loom is gone.
