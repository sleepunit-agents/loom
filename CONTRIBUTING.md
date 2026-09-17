# Contributing to loom

## Before you start

- loom is AGPL-3.0-or-later. By contributing, you agree your commits
  are licensed under the same terms.
- Every commit must include a DCO sign-off line (`Signed-off-by: Name
  <email>`). Use `git commit -s`. The DCO is the Developer Certificate
  of Origin 1.1 — you're asserting you have the right to submit the
  change, nothing more. See https://developercertificate.org.
  This includes merge commits you make (`git pull`, `git merge`); the
  only exemption is a merge GitHub itself commits ("Update branch", or
  resolving conflicts in the web editor). CI fails a PR with any commit
  missing the line (`scripts/check-signoff.sh`).
  To catch it before you push, enable the local hook once per clone:
  `git config core.hooksPath .githooks` (this replaces any hooks you keep
  in `.git/hooks`).
- No CLA. No copyright assignment. You keep your copyright; you license
  it to the project under AGPL.

## What belongs in loom

loom is opinionated. Read [`docs/archive/loom-stack-v1.md`](docs/archive/loom-stack-v1.md)
— the v1 stack contract (archived; v2 is in progress) — before opening a PR
that touches the core. For the
current roadmap, see the
[v0.4 discussion](https://github.com/jbarket/loom/discussions/10) and the
[project board](https://github.com/users/jbarket/projects/1/views/1).

### Always welcome

- New adapters (harness manifests, runtime transports, filesystem
  projectors, CLI bindings).
- Bug fixes, test coverage, and docs.
- Spec-first proposals for changes to the stack schema. Open an issue
  first, agree on the shape, then code.

### Case-by-case (PRs welcome but bring justification)

Alternate memory backends or embedders. loom ships one opinionated
stack — sqlite-vec + a vendored ONNX embedding runtime — because it
travels with a single `npm install`, needs no daemon, no GPU, no cloud
account. A replacement or addition needs to be **at least as portable**
and needs to expand what loom can do or who can run it: larger corpora,
less RAM, multi-modal embeddings, runs on a platform the current stack
can't.
"I already run pgvector at work" is not that. Fork instead — the
`MemoryBackend` / `EmbeddingProvider` interfaces exist for exactly
this case.

### Not welcome

- Env-driven backend selection. One opinionated stack, inside the stack.
- Voice-bound content in example manifests, defaults, or seeds. Stack
  content is voice-neutral — an agent's voice belongs in its identity files,
  not in loom's templates.
- Multi-agent orchestration. loom is identity + memory per agent.
  Orchestration belongs upstream.
- Features that require an external service, daemon, cloud account, or
  GPU to run loom itself.
- Any loosening of the "no secrets in the stack" invariant.
- Opt-out telemetry, usage pings, or analytics. loom's
  [privacy posture](docs/privacy.md#telemetry-policy) is local-only;
  any future telemetry must be opt-in, off by default, and explicit
  about what it sends.

## Workflow

1. Open an issue for anything non-trivial so we can scope before you
   write code. Small fixes can skip straight to a PR.
2. Branch from `main`. Keep PRs focused; one concern per PR.
3. Add or update tests. Target: all tests green before review
   (`npx vitest run`).
4. Sign off each commit (`git commit -s`).
5. Fill out the PR template. The test plan section is not optional.

## Code style

- TypeScript strict. No `any` without a comment explaining why.
- No new external dependencies without a prior issue — loom's
  portability is load-bearing.
- Tests sit alongside source as `*.test.ts` (Vitest).
- Commit messages: imperative mood, one-line subject, optional body
  explaining "why" not "what".

## License, relitigated

The license is AGPL-3.0-or-later. It is not expected to change. If
circumstances ever make a migration necessary (e.g. a new class of
license-loophole rugpull AGPL doesn't cover), relicensing would require
community consensus — because DCO preserves your copyright, your
consent would be needed. That's the intended shape.
