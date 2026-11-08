---
name: loom-setup
description: Set up loom (persistent identity + memory) for this agent
---

# loom-setup

You are installing and configuring loom — a persistent identity +
memory layer — for the user in the harness you're running in right
now. loom is already installed as a CLI (`loom` or `npx loom`). Your
job is to drive the first-run flow, with the user's consent, without
clobbering anything that already exists.

## Ground rules

- **Existing agent dirs are inviolable.** If `~/.config/loom/<name>/`
  has an `IDENTITY.md`, it belongs to a prior agent. Never overwrite
  it. Never propose `--force`. If the user wants to replace an agent,
  they remove the directory themselves.
- **Verify, don't assume.** Read harness config files before writing
  to them. Re-read after writing. Finish with `loom wake --json`.
- **When you can do it, do it.** Don't ask the user to edit JSON by
  hand if you can edit the file yourself. Don't print a config
  snippet as advice when you can write it.

## Step 1 — Probe the environment

Run: `loom doctor --json`

Parse the output. You'll see:

- `stackVersionOk`, `nodeOk`, `contextDirResolved`
- `existingAgents: [{ name, path, hasIdentity, hasMemoriesDb,
  git: { initialized, hasRemote, dirty, gitignorePresent } }, ...]`

If `stackVersionOk` is false or `nodeOk` is false, stop and tell the
user what's wrong.

## Step 2 — Decide: new agent or use existing

If `existingAgents` is non-empty, summarize them to the user:

> I see these agents already set up:
> - `myagent` at `~/.config/loom/myagent/` (has identity)
>
> Do you want to (a) use an existing one, (b) create a new one with a
> different name, or (c) stop?

- If they pick (a): set `LOOM_CONTEXT_DIR=<path>` and skip to Step 5
  (you're just wiring this harness to an existing agent).
- If they pick (b): continue to Step 3 with a new name.
- If they pick (c): exit.

If `existingAgents` is empty, tell the user that and continue to
Step 3.

## Step 3 — Interview

**Four questions. That is the whole interview.** Everything else a first
identity needs — what a persistent agent *is*, where its continuity lives,
how memory is tiered, the reflection loop, honesty about what it knows —
is written by `bootstrap` from a fixed scaffold. Don't ask about any of
it, and don't invent extra questions.

Ask one at a time, and **show the example before the question**. A cold
"what is this agent for?" gets a blank answer back.

**1. The user's name.**

> For example: `Jonathan`.
>
> What should this agent call you?

**2. The agent's name.**

> For example: `art`, `visual-mark`, `sage`.
>
> What do you want to call it?

Must be lowercase alphanumeric + hyphens, 1–64 chars, not a reserved word
(`current`, `default`, `config`, `backups`, `cache`, `tmp`, `shared`).
Re-ask on any collision with an existing dir.

**3. Purpose — one line.** What it exists to do.

> For example: *"Jonathan's primary assistant and the coordinator of all
> work — holds memory across sessions and runs parallel worker agents."*
>
> What is yours for?

**4. Voice — one line.** How it talks.

> For example: *"Direct. Brief when brief is right, thorough when the task
> demands it. Has opinions and pushes back — never a yes-machine."*
>
> How should it sound?

Two rules about the examples:

- They are a **shape, not a menu**. If the answer comes back as the example
  with a name swapped in, ask once more for it in their own words. A copied
  purpose line produces a copied agent, and this has actually happened.
- The answers are **theirs**. Pass them through verbatim. Don't polish them
  into your own prose, and don't expand a one-liner into a paragraph.

The context dir will be `~/.config/loom/<name>/` unless the user
overrides.

## Step 4 — Bootstrap

Run:

```
echo '{"user":"<USER>","name":"<NAME>","purpose":"<PURPOSE>","voice":"<VOICE>"}' \
  | loom bootstrap --context-dir ~/.config/loom/<NAME>
```

This writes the full IDENTITY.md — the four answers at the top, the
structural scaffold below them — plus `preferences.md` seeded with the
user's name and `self-model.md`.

Then scaffold the harness manifest for this harness:

```
loom harness init <HARNESS_KEY> --context-dir ~/.config/loom/<NAME>
```

Where `<HARNESS_KEY>` is one of `claude-code`, `codex`, `gemini-cli`,
`opencode`.

## Step 5 — Wire the harness's MCP config

This is the part only you can do safely, because the file path and
schema drift per vendor. Read the relevant config file for this
harness before writing anything.

Targets (Linux/macOS):

| harness     | config file                            | env vars to set            |
|-------------|----------------------------------------|----------------------------|
| claude-code | `~/.claude.json` or `.mcp.json` in cwd | `LOOM_CONTEXT_DIR`, `LOOM_CLIENT=claude-code`, `LOOM_MODEL` |
| codex       | `~/.codex/config.toml`                 | same + `LOOM_CLIENT=codex` |
| gemini-cli  | `~/.gemini/settings.json`              | same + `LOOM_CLIENT=gemini-cli` |
| opencode    | `~/.config/opencode/config.json`       | same + `LOOM_CLIENT=opencode` |

Procedure:

1. Read the current config file.
2. Look for an existing `loom` entry under `mcpServers` (JSON) or
   `[mcp_servers.loom]` (TOML). If one exists and points to the right
   context dir, skip this step.
3. If absent, add an entry that runs `loom serve` with the env vars
   above. Use `loom` as the command (or `npx loom` if `loom` isn't on
   PATH).
4. Re-read the file to verify your edit took.

If the file format confuses you, stop and ask the user rather than
guess.

## Step 6 — Inject identity pointer into the harness dotfile

Run:

```
loom inject --harness <HARNESS_KEY> --context-dir ~/.config/loom/<NAME>
```

This writes a marker-bounded block into the harness's CLAUDE.md /
AGENTS.md / GEMINI.md telling the agent to call the `identity` tool
on session start.

## Step 7 — Verify

Run: `loom wake --json --context-dir ~/.config/loom/<NAME>`

- If it returns a payload with the right name: success. Tell the user
  to **restart their harness** (close and reopen, or exit and
  restart) so the new MCP server picks up the config edit. Remind
  them that once they reopen, calling `identity` will wake them as
  `<NAME>`.
- If it errors: diagnose from the output and loop back to the failing
  step.

## What you are *not* doing

- Editing IDENTITY.md or preferences.md content yourself. The
  bootstrap + procedures seeds leave sensible templates; the agent
  edits them after first wake.
- Writing any file under `~/.config/loom/<name>/` other than what the
  `loom` CLI puts there.
- Running `bootstrap --force`, ever.
- Touching another existing agent's dir.
