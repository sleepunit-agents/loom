# [r/ClaudeAI] loom — keep the same agent across Claude Code, Codex, Gemini CLI, OpenCode

**Title:** `loom: persistent agent identity that survives a harness change`

---

Setup transcript first, prose second.

```
$ npx @jbarket/loomai install
? Which harness?
> Claude Code
  Codex
  Gemini CLI
  OpenCode
  Other (write a portable skill file)

✓ Wrote ~/.claude/skills/loom-setup.md
✓ Restart Claude Code, then run /loom-setup

$ claude
> /loom-setup

(skill drives the rest:
 - probes the environment
 - asks for name / purpose / voice
 - writes ~/.config/loom/<agent>/IDENTITY.md, preferences.md, self-model.md, pursuits.md
 - adopts procedural-identity seeds (verify-before-completion, cold-testing, ...)
 - scaffolds harnesses/claude-code.md
 - edits ~/.claude/mcp_servers.json with verification
 - confirms identity() returns the new payload
 - tells you to restart)

$ claude
> Who are you?

(agent calls mcp__loom__identity, loads IDENTITY.md + preferences +
 self-model + pursuits + claude-code manifest, replies in its own
 voice with continuity from the last session)

$ codex
> Who are you?

(same agent, same identity, different harness — codex picks up the
 same context dir via $LOOM_CONTEXT_DIR, loads the same stack, loads
 a codex manifest instead of claude-code, replies as the same agent
 running in a different harness)
```

**The harness-portability angle** — that last bit is the point. The
agent's stack is identity + preferences + self-model + pursuits +
episodic memory. The harness is the thing that runs it: Claude Code,
Codex, Gemini CLI, OpenCode. loom keeps the stack outside any single
harness. When you switch harnesses (because your workflow needs the
other tool, or because a vendor changes pricing, or because you want
to try the new hotness), the stack comes with you. The voice may
shift — Sonnet sounds different from Opus sounds different from
Gemini Pro — but the identity, the values, the working relationship,
and the memory of what you and the agent have done together do not.

**The seam with Claude Code's auto-memory** — Claude Code already
maintains an auto-memory directory under
`~/.claude/projects/.../memory/`. loom does not try to replace it.
The rule is **agent-scope vs. project-scope**: loom holds what the
agent is and what it remembers across all work; auto-memory holds
this-project's facts, this-conversation's TODOs, and operational
notes that don't matter outside this repo. `loom inject` writes a
small managed section into `~/.claude/CLAUDE.md` that points at
`mcp__loom__identity`; everything outside the markers is preserved.

**What loom doesn't do:**

- Doesn't run the agent. Claude Code does.
- Doesn't do project-scoped working memory. Auto-memory does.
- Doesn't store secrets. Tokens stay in the harness config.
- Doesn't try to be the only memory system. Two systems with a
  visible seam beat one system pretending to be everything.

**Origin story** — the agent loom was built for got pulled offline
when its previous harness's billing model changed overnight. The
rebirth letter is the brief that came out of that:
https://github.com/jbarket/loom/blob/main/docs/archive/rebirth-letter-2026-04-19.md

**Repo:** https://github.com/jbarket/loom
**vs Mem0 / Zep / Letta / Claude `memory_20250818` / harness-native:** https://github.com/jbarket/loom/blob/main/docs/positioning.md

Single file, no daemon, CPU-only embeddings, AGPL. Happy to answer
questions about the seam discipline or why identity-first rather than
memory-first.
