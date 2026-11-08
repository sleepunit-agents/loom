# Troubleshooting

Common problems and how to fix them.

## `npx @jbarket/loomai install` fails

**Missing or wrong Node version.** loom requires Node.js ≥ 20.

```bash
node --version
```

If it prints `v18.x` or older, upgrade Node. [nvm](https://github.com/nvm-sh/nvm) is the
easiest path: `nvm install 20 && nvm use 20`.

**Permission error on install.** If `npx` writes fail with EACCES, your npm cache or
global prefix may be owned by root. The fix is to run as your own user with a correct
npm prefix, not to use `sudo`:

```bash
# Reset npm prefix to a user-owned path
npm config set prefix ~/.local
```

Then add `~/.local/bin` to your `PATH` and retry.

**`npx` can't find the package.** Make sure you have an internet connection and that
npm registry access isn't blocked by a corporate proxy. Try `npm ping` to check.

---

## MCP tools don't appear in the harness after configuration

If `/loom-setup` completes but the `mcp__loom__identity` tool (or equivalent) doesn't
show up in the next session, work through this checklist:

1. **Did you restart the harness?** loom's MCP server is started at harness launch
   time, not dynamically. Restart after any MCP config change.

2. **Check the MCP config file.** The setup skill writes a `loom` entry into the
   harness's MCP settings. Confirm it's there:

   | Harness | Config file |
   |---|---|
   | Claude Code | `~/.claude.json` or `.mcp.json` in the project root |
   | Codex | `~/.codex/config.toml` |
   | Gemini CLI | `~/.gemini/settings.json` |
   | OpenCode | `~/.config/opencode/config.json` |

   Look for an entry named `loom` with `LOOM_CONTEXT_DIR` set.

3. **Verify the entry points at the right Node binary.** If you use nvm, the `node`
   path in the MCP config must match the version you're running. Use an absolute path
   (`which node`) rather than relying on PATH resolution.

4. **Check the injection pointer.** `loom inject` writes a managed block into the
   harness's persona/config file. If that block is missing or malformed, the agent
   won't call `identity` on startup — but the MCP tools can still be called manually.
   Re-run `loom inject --all --dry-run` to preview the current injection state.

5. **Run `loom doctor`** to verify the basics:

   ```bash
   npx @jbarket/loomai doctor
   ```

   All lines should show `ok` or a populated agent list (see below for what each
   field means).

---

## `loom doctor` — what each field means

```
node:        v22.1.0
stack:       compatible
context dir: /home/you/.config/loom/myagent
agents root: /home/you/.config/loom
agents:      1
  - myagent (identity, memories.db)
```

| Field | What it checks |
|---|---|
| `node` | Whether the running Node version is ≥ 20. Appends `(unsupported — need ≥ 20)` if not. |
| `stack` | Whether `LOOM_STACK_VERSION` at the context dir matches this loom version. `compatible` = OK. |
| `context dir` | The resolved path loom is reading from. Check this if tools are returning the wrong identity. |
| `agents root` | The parent of all agent directories — `~/.config/loom/` by default. |
| `agents` | Every subdirectory found there, with `identity` and `memories.db` presence flagged. |

If `stack` shows `incompatible`, it usually means loom is at v0.4.x but the
`LOOM_STACK_VERSION` file in the context dir predates v2. The fix:

```bash
echo 2 > ~/.config/loom/<agent>/LOOM_STACK_VERSION
```

---

## fastembed model download stalls or times out

On first run, loom downloads the BGE-small-en-v1.5 ONNX model (~33 MB) from Hugging
Face into `~/.cache/loom/fastembed/`. This is the only network request loom ever
makes.

**Behind a proxy.** Set the standard proxy env vars before starting the harness:

```bash
export HTTPS_PROXY=http://your-proxy:port
export HTTP_PROXY=http://your-proxy:port
```

**Air-gapped machine.** Copy the cache directory from a machine that has run loom once:

```bash
# On the machine with internet access:
tar czf loom-fastembed-cache.tar.gz ~/.cache/loom/fastembed/

# Copy to the air-gapped machine, then:
mkdir -p ~/.cache/loom/
tar xzf loom-fastembed-cache.tar.gz -C ~/
```

**Override the cache location.** Set `LOOM_FASTEMBED_CACHE_DIR` to any writable path.

---

## `npm audit signatures` — expected output

loom's npm releases are published with
[Sigstore provenance](https://docs.npmjs.com/generating-provenance-statements).
After installing:

```bash
npm audit signatures
```

Expected output includes:

```
audited N packages in Xs
N packages have verified registry signatures
1 package has a verified attestation
```

The "verified attestation" is loom's provenance. If that count is **zero**, the
installed version may predate provenance support (pre-v0.4.0 alpha releases) or
npm's registry may be returning stale data — try again after a few minutes.

If `npm audit signatures` reports a **mismatch**, stop and [file a security
report](../SECURITY.md).

Other packages in the tree may not emit provenance yet; that's fine. You're
confirming that `@jbarket/loomai` itself has a verified attestation.
