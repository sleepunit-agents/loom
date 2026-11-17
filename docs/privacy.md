# Privacy & data locality

loom runs on your own machine: one program (`loom serve`) and the data
folder it owns. There is no cloud account behind it. This doc explains
what lives where, what goes over the network, and how to verify what
you install. For how the program is put together, see
[`architecture.md`](architecture.md).

## Where your data lives

Everything loom writes is on your disk, in one home folder
(`~/.config/loom` unless `--home` or `LOOM_HOME` says otherwise).

| What | Where | Notes |
|---|---|---|
| The household database | `loom.db` | Members, agents, projects, conversations, tasks, approvals and the rest. One SQLite file. |
| Each agent's identity pages | `agents/<agent>/` | `IDENTITY.md`, `preferences.md`, `self-model.md` and the pages beside them. Plain text. |
| Each agent's memories and cards | `agents/<agent>/memories.db` | SQLite with a `sqlite-vec` vector index. |
| Each agent's notes | `agents/<agent>/notes.db` and `agents/<agent>/note-files/` | Notes and the files attached to them. |
| Knowledge and the people directory | `commons/knowledge.db`, `commons/people.db` | Shared by every agent of the household. |
| Secret values | `secret-holder/` | Encrypted, and held by a separate process. Nowhere else. |
| Where the stores are | `program.json` | Written at first install. |
| Embedding model cache | `$LOOM_FASTEMBED_CACHE_DIR` (default `~/.cache/loom/fastembed/`) | One ~33 MB ONNX file after first run. |

The words of a Comms thread are encrypted in `loom.db` with a key kept
in the home folder.

## What crosses the network

**With nothing else set up, one thing:** on first use of memory, loom
downloads the BGE-small-en-v1.5 ONNX model (~33 MB) into the cache dir
above, over HTTPS, from
`https://storage.googleapis.com/qdrant-fastembed/fast-bge-small-en-v1.5.tar.gz`,
a Google Cloud Storage bucket published by Qdrant. Set
`LOOM_MODEL_BASE_URL` to fetch from somewhere else. After that
download, every embedding is computed in-process on CPU.

If you want to pre-seed the cache on an air-gapped machine, copy the
cache directory from a machine that has run loom once.

**What a household turns on makes its own connections,** each to the
service it names and with the credential the household gave it:

- Your browser, the command-line clients, and any worker machine you
  enroll talk to `loom serve` over HTTP at the address you serve it on.
- A Discord or Slack connection talks to Discord's or Slack's API.
- Changes reads pull requests from GitHub's API.
- An agent's run is a harness (Claude Code, Codex and others) started
  on a worker machine. The harness talks to its model provider under
  its own account; what it sends is that harness's business, and the
  agent's instructions and the conversation are in it.
- A browser that has allowed notifications is reached through its
  vendor's push service. The notification carries no message words.

### What does *not* cross the network

- No analytics, crash reporting, or usage telemetry leaves the machine.
  There is no phone-home code in loom and no dependency that adds it.
  Measuring (timing roll-ups) is off by default and stays in `loom.db`.
- No cloud account, no login to a loom service, no remote vector
  database.
- No secret values. They stay in the holder process's store and are
  handed only to the run that was granted them.

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
unexpected network call, a file written outside the home folder
and the cache dir, a secret value stored outside the holder — that's a
security issue. See [`SECURITY.md`](../SECURITY.md) for how to
report privately.
