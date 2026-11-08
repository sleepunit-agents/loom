# Security policy

## Reporting a vulnerability

Open a private security advisory at
https://github.com/jbarket/loom/security/advisories/new. Do not open
a public issue for security matters.

Expect an initial response within a week. For coordinated disclosure
timelines, include a proposed timeline in your report.

## Scope

- The loom MCP server and client adapters in this repo.
- The stack schema (`docs/archive/loom-stack-v1.md`).

## Not in scope

- Vulnerabilities in `better-sqlite3`, `sqlite-vec`, or `fastembed`.
  Report those upstream; we'll track the downstream fix.
- Social-engineering attacks that require the user to run arbitrary
  code as the loom process.

## The "no secrets in the stack" invariant

loom refuses to store secrets in the stack. If you find an adapter
that silently accepts secrets, that is a security bug — report it.

## Known transitive advisories we accept

### `tar@6.2.1` via `fastembed@2.x` (GHSA-8qq5-rm4j-mr97, -r6q2-hw4h-h46w, -34x7-hfp2-rc4v, -83g3-92jg-28cx, -qffp-2rhf-9h96, -9ppj-qmqm-q256)

**Status:** accepted risk. Not exploitable in loom's runtime path.

`fastembed` extracts the BGE-small ONNX tarball from Hugging Face on
first run, and that is the only call site that feeds data to `tar`.
loom never passes untrusted archives to `tar` itself. The six
advisories require an attacker-controlled tarball — a threat that
would imply the fastembed download host is already compromised, at
which point tar extraction is not the primary problem.

We can't override to `tar@^7.5.11` cleanly: `fastembed@2.1.0` (current
latest) does `import tar from 'tar'`, and `tar@7` is named-exports
only, so the override breaks module load. We'll pick up the fix when
fastembed republishes against `tar@7`, or earlier if we swap the
embedder.

If you find a path in loom that feeds attacker-controlled archives to
`tar`, report it — that would change this disposition.
