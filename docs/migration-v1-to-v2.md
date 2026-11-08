# Migrating from loom v1 to v2

This covers the breaking changes between loom v1 (stack spec v1, shipped in 0.3.x)
and loom v2 (shipped in 0.4.x).

If you installed loom for the first time at 0.4.0 or later, you're already on v2 —
this doc doesn't apply to you.

---

## What changed

### Pursuits are now a memory category

In v1, active cross-session goals lived in `pursuits.md` — a top-level block file
in the agent's context directory, and a dedicated `pursuits` MCP tool managed them.

In v2, pursuits are memories with `category=pursuit`. There is no separate
`pursuits.md` file and no `pursuits` tool. Use the standard `remember`/`recall`/
`forget` workflow:

```bash
# Save a pursuit
echo "ship the 0.4 release with provenance" | \
  npx @jbarket/loomai remember "@jbarket/loomai release" --category pursuit \
  --context-dir ~/.config/loom/<agent>

# List active pursuits
npx @jbarket/loomai memory list --category pursuit --context-dir ~/.config/loom/<agent>

# Close out a pursuit
npx @jbarket/loomai forget --category pursuit --title "@jbarket/loomai release" \
  --context-dir ~/.config/loom/<agent>
```

### Procedures directory removed

In v1, the `procedures/` subdirectory in the agent's context dir held prescriptive
"how this agent acts" documents. The `loom procedures` CLI and the related MCP tools
managed them.

In v2, procedures are gone. The `loom procedures` subcommand and all `procedure_*`
MCP tools have been removed. The `procedures/` directory is ignored by loom.

---

## Migration steps

### 1. Migrate your pursuits

If your agent had a `pursuits.md` file, import its content as individual memories:

```bash
# For each pursuit in pursuits.md, run something like:
echo "<pursuit content>" | \
  npx @jbarket/loomai remember "<pursuit title>" --category pursuit \
  --context-dir ~/.config/loom/<agent>
```

After importing, you can delete or archive `pursuits.md` — loom v2 ignores it.

### 2. Handle the `procedures/` directory

loom v2 simply ignores `<context>/procedures/`. You can:

- **Leave it.** It does nothing and takes ~0 bytes of cognitive load from loom.
- **Delete it.** `rm -rf ~/.config/loom/<agent>/procedures/` — nothing loom does
  depends on it.
- **Keep the content as harness context.** If the procedures contained useful
  instructions for the agent, consider moving them into the agent's
  `preferences.md` or a `harnesses/<name>.md` manifest, both of which loom still
  reads and includes in the identity payload.

### 3. Update the stack version stamp

If `loom doctor` shows `stack: incompatible`, the context directory has a v1 stamp:

```bash
echo 2 > ~/.config/loom/<agent>/LOOM_STACK_VERSION
```

---

## What you don't need to do

- You don't need to re-run `/loom-setup`. The agent's identity files (`IDENTITY.md`,
  `preferences.md`, `self-model.md`) and memory store (`memories.db`) are
  forward-compatible. loom v2 reads them as-is.
- You don't need to change `LOOM_CONTEXT_DIR` or any harness MCP config. The server
  binary interface is unchanged.
