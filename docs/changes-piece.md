# Changes in loom

Changes stores pull requests in the new home's `loom.db`, publishes viewer-scoped
live records, and serves the kit app at `/p/changes-preview`. GitHub is read-only:
an owner's merge answer delegates to Approvals; the agent still performs the merge.
No operation writes to the forge. Existing Changes programs and live homes are
untouched by this branch.

## Old-to-new map

| Old surface | Replacement | Behavior or deliberate change |
| --- | --- | --- |
| `loom-changes list` | `loom changes list` / generated `loom-changes list` → `changes.list` | Open-only text output; direct operation readers receive rich records. |
| `refresh` / refresh marker file | `changes.refresh` and durable `changes_jobs` row | Same acknowledgement, owner policy, operation-id retry; wakes the daemon job. |
| `sync --once` | Root-owned job's `run()` | Internal lifecycle operation, not an agent command that discovers credentials. |
| `sync` service / separate timer | `installChangesDaemon` → durable job | One process and clock; due time and pending refresh survive restart. |
| `cited-by t-N [--json]` | `changes.cited-by` | Compact id/title/short/page/words records; citations come from Tasks and PR text. |
| `project-feed` | `changes.project-feed` | Household project scope, compact groups, bounded output; caller repo/name/venue flags cannot widen scope. |
| `thread-feed --conversation cv-… [--ref …]` | `changes.thread-feed` | Made-first ordering, canonical dedupe, explicit untracked links; hidden known records cannot fall back to links. |
| `ui --json` / `ui page` | Registered kit app | Shared Split/List/Row/Reader primitives and live records replace subprocess page JSON. |
| `ui act` yes / not-yet / always | `changes.confirm` then `changes.answer` | Owner-only exact-head rule/person recheck in the write transaction; Approvals owns the actual decision. |
| `collections query --json` | Live `change` and `change-sync` types | Central policy per viewer; task/approval/rule changes invalidate projections; one-week list expiry. |
| `api` refusal | Registered scoped read operations | New API supports reads and owner refresh/answers; still no forge mutation API. |
| Snapshot JSON and owner settings | Explicit offline importer plus injected roles | No runtime legacy reads, token discovery, executable adapter, or settings fallback. |

The package supplies `loom-changes` as an API client. It uses `LOOM_URL` and
`LOOM_TOKEN_FILE`, shares command metadata with operation registration, and retries
writes using the same operation id. It does not wrap the Taskstore formatter.
`loom changes ...` calls that same generated client directly. This built-in path
wins over an installed legacy `loom-changes` program and never calls the old
`/api/changes/run` adapter. The HTTP local-CLI endpoint refuses this command rather
than forwarding a request through a second connection.

## Boundaries and choices

Projects come only from destination household repository mappings, refreshed when
the job runs. Ambiguous repository ownership is refused. Attribution is explicit:
GitHub logins and branch prefixes map to known household agents; no title guessing.
Tasks remain in Tasks and are read through its role with the same viewer. Known
private records are suppressed before feed construction.

Secrets are injected as `resolveGitHub(owner)` and `withValue(reference, use)`.
The reader uses a fixed GitHub GraphQL URL and read-only query with pagination.
Credentials and upstream error text are redacted; persistent errors are generic.
A failed repository keeps its last successful snapshot. Staging holds external
reads. The root must authorize the job viewer centrally and call the job's
`close()` before closing the foundation; a late response cannot commit afterward.

Approval rules and answers use the injected synchronous Approvals role. Changes
never manufactures a trusted principal or grants itself service access. A visible
confirmation is not authority: answering rechecks current head, rule, person,
project and viewer. The app does not perform a GitHub merge.

Closed and merged rows leave lists/live subscriptions exactly one week after
closure. Stored detail remains available through `changes.show`. The app currently
reads live rows, so an expired selected row becomes unavailable in its reader.
The older collection subprocess, sync executable, marker files, private snapshot
store and Python UI protocol are intentionally dropped.

## Offline import and cutover

`loom migrate changes --from snapshot.json --attribution map.json --home stopped-home`
imports into an already imported household. The destination daemon must be stopped;
the importer holds the same home lock until its database closes. It validates the
whole snapshot and explicit attribution before a transaction commits, remaps
projects from destination household rows, refuses unknown household identities,
and records a repeat-import marker. Repeating the same import is a no-op.
The marker identifies snapshot bytes; later household or attribution edits do
not rewrite or reject an already imported source. Different source bytes are
refused. Content comparison uses the same binary identifier order as SQLite.

The attribution document has `agents` (agent id → `{logins: [], branches: []}`),
`ownerLogins` (array), and optional `taskOwner` (known agent or member). Source
project labels never override the destination household. Import refusals are
generic and never echo source contents. This command does not import credentials.
Argument parsing also uses fixed errors, so accidental positional credentials
and unknown option text cannot be reflected. Importer tests cover malformed
versions/identities, duplicates, ambiguous destination mappings, nonempty homes,
forged source caches and lock ownership through database close and failure.

Cutover requires the next-mode composition root, a centrally authorized job
viewer, the real Approvals adapter, and an injected Secrets role (fake secrets
until that piece lands). Those integrations remain open. No production import,
deployment, old-service shutdown or live-home modification is part of this branch.

## Evidence

Focused tests cover GitHub pagination/redaction, role policy, exact-head answers,
HTTP client retries/feed output, importer rollback and real lock/restart, durable
refresh/restart, staging/shutdown, and two real WebSocket subscribers receiving
citations, rule updates and exact expiry.

`src/ui/changes-piece.integration.test.ts` is separate from the legacy
`changes-app` suite. The Changes piece evidence CI job builds the app, runs only
that browser proof, and uploads six screenshots under `artifacts/changes-piece`
(390, 1280 and 1920; Neon Noir and Daylight). It checks two windows, live checks,
citations and answers, viewer project scope, navigation/reload and merged expiry.
Browser execution belongs in CI. Artifact links and the mandatory cold credential,
permission and importer review will be recorded in the PR before it is ready.
