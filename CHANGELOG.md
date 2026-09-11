# Changelog

All notable changes to loom are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/).

> **Publish status:** `@jbarket/loomai@0.5.0` is the first version published to
> npm. `0.4.1` and everything before it exists only as a git tag — those versions
> were never on the registry, so the four months of work between `0.4.1`
> (2026-04-23) and this release ship together as `0.5.0`.

## [Unreleased]

### Fixed

- **`--context-dir` (and the other global flags) now work in front of the
  subcommand, as the help text has always claimed.** `loom --context-dir DIR
  knowledge write …` used to route to the stdio MCP server instead of the CLI:
  the entry point dispatched on `argv[2]`, which was `--context-dir`, not a known
  verb. The server read an empty stdin and exited 0, so a *write* verb reported
  success having never entered the write path — and never even reached argument
  validation, exiting 0 on an invocation that the working flag order rejects with
  exit 1. Measured against a disposable context dir: no `knowledge.db` was created
  and no row was written. Both entry points now resolve the subcommand past any
  leading global flags, skipping flag values in pairs so `--context-dir recall`
  still names a directory rather than invoking `recall`. Bare
  `loom --context-dir DIR` with no subcommand remains the MCP path. (t-665)

## [0.5.0] - 2026-09-04

### Changed

- **npm package renamed `loomai` → `@jbarket/loomai`.** The registry refused the
  unscoped name on publish: `403 Forbidden — Package name too similar to existing
  package loom-ai`. `loom-ai` is an unrelated, apparently abandoned package
  (0.1.1, 2026-06-03), and npm's similarity check is mechanical and applies only
  to unscoped names — so there is no appeal and no unscoped name in this family
  that is safe from it. Scoping settles it permanently. Nothing else moves: the
  brand is still `loom`, the CLI is still `loom`, the MCP server is still `loom`,
  the repo is still `sleepunit-agents/loom`. Only the install word changes:
  `npx loomai install` → `npx @jbarket/loomai install`. No version has ever been
  published under either name, so no installed tree anywhere needs migrating.

### Security

- **The `fastembed` dependency is gone; its ONNX runtime is vendored.** Six
  open Dependabot alerts (one critical, `GHSA-23hp-3jrh-7fpw`) all came from a
  single path: `fastembed@2.1.0` pins `tar: ^6.2.0`, and the 6.x line carries
  twelve unpatched advisories. `Anush008/fastembed-js` was archived on GitHub
  on 2025-12-15, so no upstream fix is coming, and an `overrides` bump to
  tar 7 does not work — fastembed does `import tar from "tar"`, which tar 7
  (no default export) turns into a `SyntaxError` at import, killing loom
  before it starts. The ~200 lines loom actually used now live in
  `src/backends/embedding-runtime.ts`, depending directly on
  `onnxruntime-node`, `@anush008/tokenizers` and `tar@^7.5.22`. `npm audit`
  is clean and the dependency tree loses `progress` and `@huggingface/hub`
  (both only reachable from the unused sparse-embedding path).

  Embedding output is **bit-for-bit identical** to `fastembed@2.1.0` — vectors
  already stored in a `memories.db` stay comparable to new ones. Two upstream
  quirks are preserved deliberately and marked in the source: vectors stay
  `Float32Array` through normalisation (so rounding matches), and `queryEmbed`
  keeps its E5-style `query: ` prefix even though BGE does not use one.
  `src/backends/embedding-runtime.parity.test.ts` asserts this against golden
  vectors captured from the upstream package before it was removed.

### Fixed

- **A failed model download poisoned the cache directory permanently.** The
  vendored downloader checks the HTTP status and deletes the partial file on
  failure. Previously a 403 or 404 from the model bucket was written into
  `<model>.tar.gz` as if it were the archive; the next run saw the file
  existed, skipped the download, and failed in `tar` — forever, until someone
  cleared the cache by hand. The error now names the URL, the status, and the
  new `LOOM_MODEL_BASE_URL` override.

- **The test suite was counting three abandoned worktrees.** `vitest` collected
  `.claude/worktrees/**`, so stale copies of the repo ran against current
  `node_modules` and inflated the reported total from 950 tests to ~2600.
  Excluded in `vitest.config.ts`.

- **The npm release path could never have worked, and the docs said it had.**
  Three separate blockers, none of which had ever been exercised because no
  `v*` tag has ever been pushed and `release.yml` has zero runs:
  1. `package.json` still declared `repository.url`, `homepage` and `bugs` as
     `jbarket/loom`, but the repo moved to `sleepunit-agents/loom`. With
     `publishConfig.provenance: true`, npm validates the manifest repository
     against the building repository and refuses to publish on a mismatch —
     so the very first tagged release would have failed at the publish step
     after a full build and test run.
  2. There were no publish credentials of any kind — no `NPM_TOKEN` repository
     or organization secret — so `npm publish` would have failed with
     `ENEEDAUTH`. Rather than add a 90-day token to rotate forever,
     `release.yml` now publishes with **npm trusted publishing** (OIDC): the
     workflow authenticates as `sleepunit-agents/loom` + `release.yml`, there
     is no secret to store or expire, and provenance is attested from the run
     itself. This requires npm >= 11.5.1, which Node 22.x does not ship, so
     the workflow upgrades npm before installing. See `docs/releasing.md` —
     trusted publishing cannot perform a package's *first* publish
     ([npm/cli#8544](https://github.com/npm/cli/issues/8544)), so the first
     release has to go up by hand once.
  3. The README advertised **Node.js ≥ 20 ("tested on 20 and 22")** while
     `engines` requires `>= 22` and CI only tests 22 and 24. A reader on
     Node 20 following the README would have hit `EBADENGINE`.
- Stale `jbarket/loom` links across `README.md`, `CHANGELOG.md` and
  `docs/privacy.md` now point at `sleepunit-agents/loom`, including the
  `gh attestation verify --owner` example (which named the wrong owner and
  a version that was never published).
- The README install section now states plainly that `loomai` is not on npm
  and gives the working `npx github:sleepunit-agents/loom` form. Remove that
  note in the commit that cuts the first real tag.

- **Every packaged install of loom was a silent no-op.** The entry-point guard
  in `src/index.ts` compared `process.argv[1]` against `import.meta.url` as raw
  strings. `npm i -g`, `npm link` and `npx` all install the bin as a *symlink*
  into a bin directory, so `argv[1]` was the symlink path while
  `import.meta.url` resolved to the real file — never equal, so `main()` never
  ran. `loom --version` exited 0 printing nothing, and `loom serve` started no
  server. Only `node dist/index.js` worked, which is exactly what every test
  and every dev checkout does, so nothing caught it. Both sides are now
  resolved with `realpathSync` before comparing, and
  `src/entry.integration.test.ts` invokes the built bin through a symlink so
  the packaged shape is exercised in CI.

### Added

- **The onboarding interview is four questions, and `bootstrap` writes a real
  identity.** The interview now asks for the *user's* name as well as the
  agent's name, purpose line and voice line — and nothing else. In exchange,
  `bootstrap` no longer emits a six-line IDENTITY.md: it writes the full
  scaffold underneath the four answers (what a persistent agent is and where
  its continuity lives, the three memory tiers, the reflection loop, honesty
  about what it knows, delegation, and a "Working with <user>" floor).
  `preferences.md` is seeded with the user's name. New optional `user` param
  on the `bootstrap` tool and `loom bootstrap --user`; the loom-setup skill
  shows an example answer *before* each question. Rationale: the structural
  half of an identity is the same for every loom agent, so asking for it wastes
  the interview — handing over the architecture is a hypothesis the agent can
  falsify, handing over a personality would be a verdict. (Art, 2026-09-04)

- **MMR diversity re-ranking on `recall`** — after the vector search, the
  candidate pool (`max(limit*3, 12)`) is re-ranked with Maximal Marginal
  Relevance (`λ·relevance − (1−λ)·max cosine sim to already-picked`,
  λ = 0.7) so near-duplicate memories on a well-covered topic stop crowding
  out different ones. The top result is unchanged; with ≤ `limit`
  candidates nothing moves. New optional `diversity` (0..1, default 0.3 =
  1−λ) on the `recall` tool and `loom recall --diversity`; `0` reproduces
  the old ranking exactly. Idea from xai-org/grok-build's memory search
  (Apache-2.0; idea only, no code). (Art, 2026-08-28)

- **Recall observation log** — every `recall` appends one JSON line to
  `<context>/telemetry/recall.jsonl` (query ≤120 chars, filters, pool
  size, returned, topScore, MMR drops, latency, hit). Local-only, never
  throws, `LOOM_RECALL_LOG=0` disables. `loom memory recall-stats
  [--since 7d] [--json]` reads it back: counts, hit rate, median latency
  and topScore, the 10 most recent misses. (Art, 2026-08-28)

- **Episode tier** — `episode` memory category (48h TTL by default), the
  `episodes` MCP tool and `loom memory tape [--hours N]` CLI, and a
  "Last 24h across bodies" block in `identity` (after preferences, before
  Top of Mind). Short-term cross-body memory: what other sleeves did in the
  last day, time-ordered and unconditional. Episodes are excluded from the
  salience digest (they would always be hottest). (Art t-142, 2026-08-25)

- **Soft-archive tier** (`memory_archive` / `memory_restore` MCP tools;
  `loom memory archive` / `loom memory restore` CLI subcommands). Memories
  can now be soft-retired with a tombstone (note + `archived_at` timestamp)
  instead of hard-deleted. Archived memories are excluded from `recall`,
  `memory_list`, `memory_prune`, `find_similar`, and `memory_audit` but
  remain fully recoverable. The original body is preserved in the row;
  `memory_restore` returns a memory to the active set and wipes the tombstone.
  Existing databases are migrated automatically on first open (`ALTER TABLE`
  guards against re-running on already-migrated schemas).

## [0.4.1] - 2026-04-23

Stabilization release consolidating v0.4.0-alpha.1 through alpha.7.
This is the first externally-promoted release: `npx loomai install` is
the canonical Quick Start path.

### Added

- **`loom install`** — writes the bundled `loom-setup` skill into a
  target harness's skills directory. Flag-driven (`--harness <key>`) or
  interactive single-select TUI. Targets: `claude-code`, `codex`,
  `gemini-cli`, `opencode`, `other`.
- **`loom doctor`** — read-only probe reporting node version, stack
  version compatibility, context dir resolution, and per-agent git
  fields.
- **`loom inject`** — writes a marker-bounded managed section into
  harness dotfiles (`~/.claude/CLAUDE.md`, `~/.codex/AGENTS.md`,
  `~/.gemini/GEMINI.md`) telling the agent to load identity via loom.
  Idempotent; re-running is safe.
- **`loom procedures list|show|adopt`** — CLI for procedural-identity
  seed templates (stack spec v1 §4.9). Ships 6 seed templates:
  `verify-before-completion`, `cold-testing`,
  `reflection-at-end-of-unit`, `handoff-to-unpushable-repo`,
  `confidence-calibration`, `RLHF-resistance`.
- **`loom harness init <name>`** — scaffolds a harness manifest from
  the template (stack spec v1 §4.7).
- **Full CLI surface** — every MCP tool has a `loom <subcommand>` shell
  equivalent: `wake`, `recall`, `remember`, `update`, `forget`,
  `memory list`, `memory prune`, `pursuits`, `update-identity`,
  `bootstrap`, `serve`. Write commands take body via stdin or
  `$VISUAL`/`$EDITOR`. `--json` on any command emits structured output.
- **MCP tools** for procedures and harness init:
  `mcp__loom__procedure_list`, `procedure_show`, `procedure_adopt`,
  `harness_init`.
- **Harness manifest block** (`harnesses/<client>.md`) and **model
  manifest block** (`models/<model>.md`) — loaded by `identity()` when
  `LOOM_CLIENT` / `LOOM_MODEL` resolve. Missing-manifest nudges emitted
  when set but absent.
- **Procedures block** (`procedures/*.md`) with seed nudge — emitted by
  `identity()` whenever `procedures/` is missing or empty.
- `LOOM_STACK_VERSION` file auto-stamped on server boot; startup
  refuses stacks ahead of what this loom understands.
- `LOOM_MODEL` env var + optional `model` param on the `identity` tool.
- Reusable `src/cli/tui/multi-select.ts` keyboard-nav checkbox
  primitive with `single: boolean` option.
- `src/install/names.ts` — canonical agent-name validation and
  reserved-names list.
- `assets/skill/SKILL.md` — bundled first-run setup skill.
- `.github/workflows/release.yml` — tag-triggered publish pipeline.
  Push a `v*` tag → `npm ci`, `npm test`, `npm run build`,
  `npm publish --provenance`, GitHub release with auto-generated notes.
  Pre-release tags flagged as prereleases. Requires `NPM_TOKEN` secret.
- `docs/privacy.md` — trust doc covering data locality (everything
  local, only outbound call is the first-run fastembed model
  download), the no-opt-out-telemetry policy, and a walkthrough for
  verifying release provenance via `npm audit signatures` and
  `gh attestation verify`. Linked from README and CONTRIBUTING.
- Stack spec §11 (Injection), §13 (Multi-agent layout), §14
  (Git-backed agent dirs).

### Changed

- **npm package renamed `loom` → `loomai`.** Brand (`loom`), CLI
  binary (`loom`), MCP server key (`loom`), and tool prefix
  (`mcp__loom__*`) are unchanged — only the `npx` install surface
  moves: `npx loom install` → `npx loomai install`.
- **License: MIT → AGPL-3.0-or-later.** Forks that modify loom and
  expose it over a network must offer source. Pre-alpha-1 releases
  remain MIT.
- `package.json` adds `publishConfig: { access: public, provenance: true }`
  and a `files` array so `assets/` ships in the published tarball.
- `loom bootstrap --name` validates against canonical name rules.
- `assertStackVersionCompatible()` called at MCP startup and every CLI
  command.
- README Quick Start rewritten around `npx loomai install` +
  `/loom-setup`.
- **`release.yml` switches to npm Trusted Publishing (OIDC).** Removes
  `NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}` from the publish step.
  Auth is handled by the OIDC token exchange between GitHub Actions and
  npm — no long-lived secret required. Requires a one-time bootstrap
  publish and Trusted Publisher configuration on npmjs.com.

## [0.4.0-alpha.7] - 2026-04-22

### Changed

- **npm package renamed `loom` → `loomai`.** The unscoped `loom`
  name is taken by an unrelated package. Brand (`loom`), CLI binary
  (`loom`), MCP server key (`loom`), and tool prefix
  (`mcp__loom__*`) are unchanged — only the `npx` install surface
  moves: `npx loom install` → `npx loomai install`. alpha.6 was
  never published to npm; alpha.7 is the first release tag.
- `package.json` adds `publishConfig: { access: public, provenance:
  true }` so tagged releases publish with Sigstore provenance.
- README Quick Start + CLI examples updated to `npx loomai`.

### Added

- `.github/workflows/release.yml` — tag-triggered publish pipeline.
  Push a `v*` tag → runs `npm ci`, `npm test`, `npm run build`,
  `npm publish --provenance`, then creates a GitHub release with
  auto-generated notes. Pre-release tags (`-alpha`, `-beta`, `-rc`)
  are flagged as prereleases on GitHub. Requires `NPM_TOKEN`
  repository secret.

## [0.4.0-alpha.6] - 2026-04-21

### Added

- `loom install` — CLI that writes the bundled `loom-setup` skill
  into a target harness's skills directory. Flag-driven
  (`--harness <key>`) or single-select TUI on a TTY. Targets:
  `claude-code`, `codex`, `gemini-cli`, `opencode`, `other`. `--to`
  overrides destination; `--force` overwrites; `--dry-run` /
  `--json` for scripting. The "other" target writes
  `./loom-setup-skill.md` in the current directory.
- `loom doctor` — read-only CLI probe reporting node version, stack
  version compatibility, context dir resolution, and enumerating
  existing agents under `~/.config/loom/*` with forward-looking
  `git: { initialized, hasRemote, dirty, gitignorePresent }` fields
  per agent. `--json` for scripting.
- `assets/skill/SKILL.md` — bundled skill that drives first-run
  setup inside the target harness: probe → interview → bootstrap →
  procedures adopt → harness init → MCP config edit
  (verify-before-write) → inject → wake verify. Never clobbers
  existing agent dirs; never proposes `--force`.
- `src/install/names.ts` — canonical agent-name validation plus
  reserved-names list (`current`, `default`, `config`, `backups`,
  `cache`, `tmp`, `shared`).
- Stack spec §13 (Multi-agent layout) and §14 (Git-backed agent
  dirs).

### Changed

- `loom bootstrap --name` now validates against the canonical name
  rules. Invalid or reserved names exit with code 2 and a specific
  error.
- `src/cli/tui/multi-select.ts` gains a `single: boolean` option
  (reducer + TTY adapter). Existing multi-select consumers are
  unchanged — the option defaults to `false`.
- `package.json` adds a `files` array so `assets/` ships in the
  published tarball alongside `dist/`.
- README Quick Start rewritten around `npx loom install` +
  `/loom-setup`. Per-command reference sections unchanged.

## [0.4.0-alpha.5] - 2026-04-21

### Added

- `loom procedures list|show|adopt` — CLI for procedural-identity seed
  templates (stack spec v1 §4.9). `adopt` supports positional keys,
  `--all`, `--force` overwrite, and an interactive multi-select picker
  (reuses the `src/cli/tui/multi-select.ts` primitive from alpha.4) on
  TTY. Idempotent by default.
- `loom harness init <name>` — CLI that scaffolds a harness manifest
  (stack spec v1 §4.7) from the template. Falls back to `--client` /
  `$LOOM_CLIENT` when no name is given. `--force` overwrites.
- `mcp__loom__procedure_list`, `procedure_show`, `procedure_adopt`,
  `harness_init` — MCP tools mirroring the CLI. Thin wrappers over the
  same shared core; first-class way for an agent to respond to the
  procedures seed nudge or a missing-manifest warning in the identity
  payload without needing harness-native filesystem tools.
- Stack spec §11 lists Procedures + Manifests as a new adapter.

### Changed

- `src/blocks/procedures.ts` gains `adoptProcedures`, `listProcedures`,
  `showProcedure`, and `UnknownProcedureError` (additive — existing
  exports untouched).
- `src/blocks/harness.ts` gains `initHarness` (additive).

## [0.4.0-alpha.4] - 2026-04-20

### Added

- `loom inject` — CLI command that writes a marker-bounded managed
  section into harness dotfiles (`~/.claude/CLAUDE.md`,
  `~/.codex/AGENTS.md`, `~/.gemini/GEMINI.md`). The managed section
  tells the agent how to load identity via loom — prefer MCP
  (`mcp__loom__identity`), fall back to the CLI (`loom wake`).
  Content outside the `<!-- loom:start / loom:end -->` markers is
  preserved; re-running is idempotent.
- `--all`, `--harness <keys>`, `--to <path>`, `--dry-run`, `--json`
  flags for non-interactive use. Interactive keyboard-nav wizard
  when stdin is a TTY and no harness flags are given.
- Reusable `src/cli/tui/multi-select.ts` — stdlib keyboard-nav
  checkbox primitive with a pure reducer. Future consumers: bootstrap
  procedure adoption, harness-manifest selection.
- Stack spec §11 lists Injection as a new adapter.

### Changed

- No existing MCP tool surfaces or CLI commands altered. `loom inject`
  is purely additive.

## [0.4.0-alpha.3] - 2026-04-20

### Added

- Full CLI surface — every MCP tool has a `loom <subcommand>` shell
  equivalent: `wake`, `recall`, `remember`, `update`, `forget`,
  `memory list`, `memory prune`, `pursuits`, `update-identity`,
  `bootstrap`, plus an explicit `serve` alias. Write commands take
  body text via stdin (when piped) or `$VISUAL`/`$EDITOR` (when
  interactive). `--json` on any command emits the tool's structured
  return value for scripting.
- `assertStackVersionCompatible()` helper consolidates the
  stack-version gate; both MCP startup and every CLI command call it.

### Changed

- `node dist/index.js` with no subcommand still launches MCP (backward
  compatible with every existing `.mcp.json`). A known-subcommand
  argv[2] routes to the CLI instead.

## [0.4.0-alpha.2] - 2026-04-20

### Added

- Procedures seed content — 6 recommended seed templates (stack spec
  v1 §4.9) exposed as `SEED_PROCEDURES` in `src/blocks/procedures.ts`:
  `verify-before-completion`, `cold-testing`,
  `reflection-at-end-of-unit`, `handoff-to-unpushable-repo`,
  `confidence-calibration`, `RLHF-resistance`. Each template ships a
  prescriptive Rule sentence plus agent-authored slots for Why and
  How to apply, fenced by a ⚠ ownership-ritual notice the agent
  deletes on adoption.
- `seedNudge()` — renders an empty-directory onboarding message
  containing all 6 templates. Emitted by `identity()` whenever
  `procedures/` is missing or empty; suppressed as soon as any
  procedure file exists.

### Changed

- Documentation reshuffle: v0.4 arc docs moved out of the repo. The
  roadmap now lives in the
  [v0.4 discussion](https://github.com/sleepunit-agents/loom/discussions/10) and
  the [project board](https://github.com/users/jbarket/projects/1/views/1).
  Per-feature specs and plans moved from `docs/superpowers/{specs,plans}/`
  to `docs/{specs,plans}/` — tool-neutral paths, same content.

## [0.4.0-alpha.1] - 2026-04-19

### Added

- Harness manifest block (`harnesses/<client>.md`) — per-harness
  descriptor (tool prefixes, delegation primitive, scheduling,
  session search, gotchas). Loaded by `identity()` when
  `LOOM_CLIENT` resolves. Matches stack spec v1 §4.7.
- Model manifest block (`models/<model>.md`) — per-model-family
  descriptor (capability notes, workarounds, when-to-use /
  when-not-to-use). Loaded by `identity()` when `LOOM_MODEL`
  resolves. Matches stack spec v1 §4.8.
- Procedures block (`procedures/*.md`) — procedural-identity docs
  with a hard cap of ~10 files. Reader ships; populated content
  lands in a later alpha. Matches stack spec v1 §4.9.
- `LOOM_MODEL` environment variable + optional `model` param on the
  `identity` tool.
- `LOOM_STACK_VERSION` file at the context-dir root, auto-stamped
  with `1` on server boot. `createLoomServer` refuses to start
  against a stack version ahead of what this loom understands.
- Missing-manifest nudges: when `LOOM_CLIENT` or `LOOM_MODEL` is set
  but no corresponding manifest exists, `identity()` emits a
  template-filled section telling the agent exactly what to write.

### Changed

- License: MIT → **AGPL-3.0-or-later**. Forks that modify loom and
  expose it over a network must offer source to their users. Bundling
  loom into a larger product is still fine; closing the loom-derived
  code and reselling it is not. Pre-alpha-1 releases remain available
  under MIT.

## [0.3.1] - 2026-04-19

Initial public release.

### Added

- `SqliteVecBackend` — single-file memory store using
  [`better-sqlite3`](https://github.com/WiseLibs/better-sqlite3) plus
  the [`sqlite-vec`](https://github.com/asg017/sqlite-vec) vec0 virtual
  table. One `memories.db` per agent. Real cosine similarity.
- `FastEmbedProvider` — embeddings via
  [`fastembed`](https://github.com/Anush008/fastembed-js) with
  BGE-small-en-v1.5 (384-dim, ~33MB ONNX, CPU-only). First run
  downloads the model to `~/.cache/loom/fastembed/`. No GPU, no
  Docker, no daemon.
- Stack specification — [`docs/archive/loom-stack-v1.md`](docs/archive/loom-stack-v1.md)
  defines the directory layout, block types, memory schema, wake
  sequence, and adapter contract that v0.4 work builds on.

### Changed

- Memory backend is now a single opinionated stack (sqlite-vec +
  fastembed). The env-driven backend selector is gone.

### Removed

- Qdrant backend, Ollama embedding provider, OpenAI embedding
  provider, filesystem backend. None were load-bearing for the new
  stack and all added external-service dependencies or operational
  overhead.

[Unreleased]: https://github.com/sleepunit-agents/loom/compare/v0.5.0...HEAD
[0.5.0]: https://github.com/sleepunit-agents/loom/compare/v0.4.1...v0.5.0
[0.4.1]: https://github.com/sleepunit-agents/loom/compare/v0.3.1...v0.4.1
[0.4.0-alpha.7]: https://github.com/sleepunit-agents/loom/compare/v0.4.0-alpha.6...v0.4.0-alpha.7
[0.4.0-alpha.6]: https://github.com/sleepunit-agents/loom/compare/v0.4.0-alpha.5...v0.4.0-alpha.6
[0.4.0-alpha.5]: https://github.com/sleepunit-agents/loom/compare/v0.4.0-alpha.4...v0.4.0-alpha.5
[0.4.0-alpha.4]: https://github.com/sleepunit-agents/loom/compare/v0.4.0-alpha.3...v0.4.0-alpha.4
[0.4.0-alpha.3]: https://github.com/sleepunit-agents/loom/compare/v0.4.0-alpha.2...v0.4.0-alpha.3
[0.4.0-alpha.2]: https://github.com/sleepunit-agents/loom/compare/v0.4.0-alpha.1...v0.4.0-alpha.2
[0.4.0-alpha.1]: https://github.com/sleepunit-agents/loom/compare/v0.3.1...v0.4.0-alpha.1
[0.3.1]: https://github.com/sleepunit-agents/loom/releases/tag/v0.3.1
