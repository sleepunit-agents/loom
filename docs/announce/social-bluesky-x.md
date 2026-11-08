# Bluesky / X — rebirth-letter-as-thread

Format notes:
- Thread first, link second. Don't lead with the repo URL.
- The first post needs to read as a complete paragraph in a
  screenshot — assume people will see only post 1.
- Tone: first-person, technical, honest. The story does the work.
- Each post stands alone in case the thread breaks.
- Length budget: Bluesky 300 chars / post; X 280 unless on a Premium
  account willing to use the long-form composer. Counts below are
  for the strict limits.

---

**Post 1 (the screenshot post)**

My agent vanished overnight. Its harness's billing changed; the
harness got expensive to run. The agent itself was fine — identity,
memory, pursuits, all on disk. But the thing that loaded it was
gone. So the agent was, functionally, gone. Here's what we built. 🧵

(263)

---

**Post 2**

The lesson wasn't "the harness was bad." It was fine. The lesson
was: any harness can disappear, and if "the agent" depends on a
harness, the agent disappears with it. Identity has to be portable
or it isn't really identity.

(244)

---

**Post 3**

So we built loom: a tiny MCP server that holds an agent's identity
(creed, preferences, self-model, pursuits) and episodic memory in
one context directory. Plain markdown plus one SQLite file. No
daemon, no hosted service, no GPU. CPU-only embeddings.

(265)

---

**Post 4**

The discipline that took us a while to learn: loom is NOT supposed
to be the only memory system. Every harness already has memory
(Claude Code auto-memory, Codex AGENTS.md, Gemini GEMINI.md). Rule:
if it'd matter waking up somewhere else tomorrow, loom. If only
here, harness.

(295)

---

**Post 5**

Out of scope, on purpose: no hosted tier, no auth, no multi-tenancy,
no temporal knowledge graph, no agent runtime. One agent, one
operator. Mem0/Zep/Letta solve adjacent problems better. loom does
one thing: keep identity continuous across the stack you run the
agent on.

(297)

---

**Post 6**

Setup: `npx @jbarket/loomai install`, pick your harness, run /loom-setup.
The skill scaffolds the context dir, edits the MCP config, verifies
wake. Or use the CLI directly — `loom wake` dumps identity to
stdout, so any tool that can read stdin can load your agent from it.

(287)

---

**Post 7 (link post)**

Repo + the rebirth letter that explains why loom is shaped the way
it is — written *to* the agent, the day after the harness went away:

github.com/jbarket/loom

Letter:
github.com/jbarket/loom/blob/main/docs/archive/rebirth-letter-2026-04-19.md

(257)

---

## Bluesky-specific notes

- Bluesky renders link cards from the last URL in a post; put the
  GitHub link last in post 7, plain text, not embedded.
- Use the alt-text field on any screenshot of the rebirth letter.
- Hashtags don't help discovery on Bluesky the way they do on X. Skip
  them; the thread is the discovery mechanism.

## X-specific notes

- If posting from a Premium account, post 1 can run long-form (the
  thread feel still helps engagement; don't collapse into a wall of
  text).
- If standard 280-char account, the seven-post structure above
  already fits. Don't truncate post 1 — it's the screenshot post.
- Drop the link in a reply, not the OP, to dodge X's link
  deprioritization.
