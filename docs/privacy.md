# Privacy & data locality

loom is a local-only identity and memory layer. Nothing in the stack
is designed to leave your machine, and there is no cloud account
behind it. This doc explains exactly what lives where, what goes over
the network, and how to verify what you install.

## Where your data lives

Everything loom writes is on your disk, under paths you control.

| What | Where | Notes |
|---|---|---|
| Identity markdown (`IDENTITY.md`, `preferences.md`, `self-model.md`, `pursuits.md`) | `$LOOM_CONTEXT_DIR/` | Plain text. Yours to read, edit, back up, or delete. |
| Memory store | `$LOOM_CONTEXT_DIR/memories.db` | Single SQLite file with a `sqlite-vec` vector index. |
| Per-project / per-harness / per-model / procedure manifests | `$LOOM_CONTEXT_DIR/{projects,harnesses,models,procedures}/*.md` | Plain text, optional. |
| Schema-version stamp | `$LOOM_CONTEXT_DIR/LOOM_STACK_VERSION` | Auto-written so tools know the layout version. |
| Embedding model cache | `$LOOM_FASTEMBED_CACHE_DIR` (default `~/.cache/loom/fastembed/`) | One ~33 MB ONNX file after first run. |

`$LOOM_CONTEXT_DIR` defaults to `~/.config/loom/<agent>/`. Override
with `LOOM_CONTEXT_DIR` or `--context-dir`.

There is no daemon, no background service, no server process outside
the MCP stdio connection your harness starts on demand. When the
harness exits, loom exits.

## What crosses the network

**Exactly one thing:** on first run, loom downloads the
BGE-small-en-v1.5 ONNX model (~33 MB) into the cache dir above, over
HTTPS, from
`https://storage.googleapis.com/qdrant-fastembed/fast-bge-small-en-v1.5.tar.gz`
— a Google Cloud Storage bucket published by Qdrant. (Earlier versions
of this page said Hugging Face. That was wrong; the host has always
been the GCS bucket.) Set `LOOM_MODEL_BASE_URL` to fetch from
somewhere else. After that download, every embedding — for `remember`,
`recall`, and anywhere else semantic similarity is used — is computed
entirely in-process on CPU. No further traffic leaves loom.

If you want to pre-seed the cache on an air-gapped machine, copy the
cache directory from a machine that has run loom once.

### What does *not* cross the network

- No analytics, crash reporting, or usage telemetry leaves the machine —
  there is no phone-home code in loom and no dependency that adds it.
  The one observation log loom keeps is local: `recall` appends a line
  per search to `<context>/telemetry/recall.jsonl` (query, hit/miss,
  latency, scores) so `loom memory recall-stats` can tell you whether
  recall is working. It is a plain file in the agent's own context dir;
  `LOOM_RECALL_LOG=0` turns it off.
- No cloud account, no login, no API key, no remote vector database.
- No outbound call on session start, memory write, memory read,
  pursuits update, or identity update.
- No secrets. The stack contract forbids storing secrets in identity
  or memory, and adapters that accept secrets are a
  [security bug](../SECURITY.md#the-no-secrets-in-the-stack-invariant).

## Telemetry policy

loom will not add anonymous telemetry, usage pings, or any
"phone-home" behavior without **explicit opt-in**. Opt-in means:

- Off by default in every release.
- A clear, single-place toggle (env var or CLI flag).
- Documentation of exactly what is sent and where.

Opt-out designs — where the default is "send data unless the user
finds the flag" — are out of scope for this project. A PR that adds
opt-out telemetry will be closed.

## Verifying what you install

loom's tagged npm releases (`@jbarket/loomai` on npm) are published with
[Sigstore provenance](https://docs.npmjs.com/generating-provenance-statements)
from the [release workflow](../.github/workflows/release.yml). The
workflow runs on GitHub Actions with `id-token: write`, and
`package.json` sets `publishConfig.provenance: true`, so `npm
publish` signs a provenance attestation tying the tarball back to
the commit and workflow run that produced it.

You can verify that before (or after) installing.

### Verify an installed tree

After `npm install @jbarket/loomai` or `npx @jbarket/loomai …`, run inside the
project where loom is installed:

```bash
npm audit signatures
```

Expected output includes a line like:

```
audited N packages in Xs
N packages have verified registry signatures
1 package has a verified attestation
```

The "verified attestation" is loom's provenance. If that count is
zero, or if `npm audit signatures` reports a mismatch, stop and
report it — either npm's registry state is stale or something is
wrong with the release.

> `npm audit signatures` checks **every** package in the tree, not
> just loom. Other packages in your project may not emit provenance
> yet; that's fine. What you're confirming is that `@jbarket/loomai` itself
> has a verified attestation.

> **`0.5.0` is the exception.** npm's trusted publishing cannot perform a
> package's first publish, so `0.5.0` went up by hand with
> `--provenance=false` and has no attestation. Every version after it is
> published by `release.yml` and does.

### Inspect the attestation directly

To see what was signed without installing:

```bash
# Fetch the attestation for a specific version
npm view @jbarket/loomai@latest --json \
  | jq '.dist.attestations'
```

The `attestations.url` field points at the Sigstore bundle. You can
download it and inspect it with
[`cosign`](https://docs.sigstore.dev/cosign/overview/) or
[`gh attestation verify`](https://docs.github.com/en/actions/security-guides/using-artifact-attestations-to-establish-provenance-for-builds):

```bash
# With the GitHub CLI:
npm pack @jbarket/loomai@latest
gh attestation verify jbarket-loomai-<version>.tgz \
  --owner sleepunit-agents
```

A successful verification confirms the tarball was built by the
`sleepunit-agents/loom` release workflow on a tagged commit, and matches the
SHA-256 hash the registry serves.

### What provenance does not tell you

Provenance says *"this tarball came from that workflow run against
that commit."* It does not say the commit is safe, the maintainer
hasn't been compromised, or the dependencies downstream are
trustworthy. Pair it with:

- Reading the CHANGELOG and the tagged commit.
- `npm audit` for known CVEs in dependencies.
- Your own threat model. If you run loom on a machine with secrets
  accessible to the Node process, treat loom the way you treat any
  other local dev tool.

## Reporting concerns

If you find loom doing something this doc doesn't describe — an
unexpected network call, a file written outside `$LOOM_CONTEXT_DIR`
and the cache dir, a secret persisted to the stack — that's a
security issue. See [`SECURITY.md`](../SECURITY.md) for how to
report privately.
