# Approvals in the foundation (implementation in progress)

This is built beside the old approvals program for `loom serve --next`. It does
not import real data or change the old request path. Until the coordinated move,
the old command, page and installed piece remain authoritative.

Upstream contract audited: sleepunit-agents/loom-approvals at
`588b3f7c22f86068063153676de159597348216a`, `bin/approvals` and
`test/test_approvals.py`. Its domain cases are being ported to in-process
`startLoom` tests. The old Python is not a runtime dependency.

## Old to new surface

| Old command, route or action | New operation or app path |
| --- | --- |
| `request` | `approvals.request` |
| `check ID`, `check ID --json` | `approvals.check` |
| `use ID --kind K --target T` | `approvals.use` |
| `withdraw ID` | `approvals.withdraw` |
| `rule merge/host TARGET… [--json]` | `approvals.rule`; owner-only `--for AGENT` uses owner rules and includes visible `asked_for` cards |
| `tell` | `approvals.tell`, `approvals.notices` |
| `list` | `approvals.list`, `approvals.history` |
| `grant --kind merge --for AGENT [--person P] [--deny]` | owner `approvals.grant` |
| Piece-local `--as` calls | direct-only `approvalsRole`, explicit service grants in central Sharing |
| `standing --check` or match | direct-only `approvals.standing` |
| `api run {argv}` | `approvals.command`, same registry domain operations |
| `api state {ids}` | `approvals.state`, filtered by central policy |
| `ui --json` manifest, `ui page` | approval and approval-rule records; Approvals app at `/p/approvals-preview` |
| `ui act allow/deny` | `approvals.open` immediately before `approvals.answer` |
| `ui act rule/rule-add/host-rule-add` | `approvals.set-rule` |
| `ui act grant/grant-add` (standing per-person rules) | `approvals.set-rule` with `person` |
| `ui act always` | `approvals.always` |
| `ui act every-time` | `approvals.every-time` |
| `ui act standing-off` | `approvals.standing-off` |
| Expiry and bounded history rendering | fake-clock live deadlines; complete persisted history |
| JSON/lock, subprocess principal verification and project listing | removed in new side; database and injected in-process roles |

The old install manifest and its `settings.json` are intentionally absent from
the new path. `APPROVALS_DIR` and `LOOM_PIECE_HOME` do not select daemon storage;
the foundation home owns the database, and old JSON files are importer input only.
`APPROVALS_LOCAL_AGENT` becomes the injected `localAgent` option.
`APPROVALS_PRINCIPAL` and `APPROVALS_LOCAL_PRINCIPAL` become the trusted caller
resolver; there is no implicit local-owner default. `APPROVALS_PROJECTS` becomes
the injected project repository, with unreadable project metadata asking safely.
`APPROVALS_SEED_RULES` is replaced by explicit import or owner rule edits; startup
does not seed authority from environment JSON. `APPROVALS_KINDS` custom labels are
not carried forward: the new app uses its built-in kind words and generic fallback.
The old executable/UI manifest is replaced by registry operations and the kit app;
its files and settings remain untouched until the coordinated retirement.

Imported allowed wake-vouch receipts are tested against newer denials covering
either end of their wake set, across principals. A refused service spend preserves
both decisions and appends `refused-use` with `denied_by`, without a use event.
Malformed imported tiers, scopes, host verbs and owner fields refuse the whole
import, leave no checksum marker or rules, and retain the default asking behavior.

No independent background poller exists in the old program; expiry was evaluated
on read. New live records refresh at receipt expiry and leave the live set one
week after the last receipt change. Pending receipts remain live indefinitely.

The owner rule view retains the old pending-first, newest-first list of named
principals, one card per person. Central household authority and record visibility
apply to this view; being a signed-in member alone grants no owner access. The
independent frozen CLI oracle covers 62 cases (including missing arguments, unknown flags and commands, and invalid boolean values), including empty and populated owner
views, named and unknown principals with exact people sets, principal-mismatch
refusal wording, JSON rule output without duplicate stderr warnings, equals-form
flags, repeated values and flags before positional arguments. Expected results
come from the pinned old Python program; the test suite reads frozen JSON only.

## Data and authority

`approvals_approvals`, `approvals_rules`, `approvals_notices`, `approvals_audit`
and `approvals_meta` are owned by this piece. Receipts and audit are retained;
old trimming must never erase a durable denial. Standing rules, per-person
rules and standing local jobs share the rule table with distinct ids.

Central `src/policy.ts` handles visibility, creation, household rules and person
answers. An approval carries the asker agent and the trusted caller project's
scope. The injected runtime resolver must derive the caller's principal,
service house, proven conversation and project from authenticated state; without
it a caller is unknown with no conversation. Body arguments do not assert an
agent, principal or `--as` authority. Pieces use a direct-only role, with an
explicitly granted service viewer, for their authenticated caller context.

Spending remains exact-kind, exact raw target, same agent, service constraint,
same principal/unknown people set, before expiry, once. New denials revoke
older unspent allows, including overlaps for wake vouches. The registry's retry
receipt makes retries of the same spend return its prior result. A pregrant never
answers an existing conversation card. An already allowed pregrant can satisfy a
later identical request for its same authenticated principal; its provenance is
kept, rather than rewritten to claim it was asked in that conversation.

## Import and final move

`loom migrate approvals --home <stopped-next-home> --from <old-directory>`
reads `approvals.json`, optional `rules.json`, and optional `audit.jsonl` only
inside the importer. An optional `--projects` JSON object explicitly maps
approval ids or proven conversation ids to household project slugs. No guessing
from titles; source-provided project fields do not establish destination scope and are discarded unless the explicit map supplies scope. The source and mapping checksum, import and comparison of all
records happen in one destination transaction; interrupted runs roll back,
identical repeated input is a no-op, different input is refused. Explicit null rule collections and malformed audit envelopes are refused. Import tests preserve every collection, exercise both mapping keys and map checksum changes, and force schema/content rollback on interruption or comparison failure.

Only at the final move, with the owner present: stop writers, back up source
and destination, import a stopped source copy, verify ids/counts/content,
start next mode and point the existing launcher at `loom-approvals-client`
using `LOOM_URL` and `LOOM_TOKEN_FILE`. The compatibility client is transport
only and never opens old state. LOOM_URL is an HTTP(S) origin without URL credentials, path, query or fragment; redirects are refused. The client validates daemon output and preserves one operation id across at most four attempts. Returning to the old side restarts it on its
untouched stores until the owner retires those stores.

## Shipped and remaining integration

- The piece, importer, API client and kit app shipped in #856; #869 fixes mobile wrapping. CI verified the two-window answer/stale guard, Rules and history, with six inspected screenshots at 390, 1280 and 1920 in Neon Noir and Daylight. Evidence: loom notes `loom/2026-11-12-approvals-ci-evidence` and `loom/2026-11-12-approvals-mobile-evidence`. No local browser suite was run.
- Next mode now registers approvals on the same database, operations and Live instance as Sharing and Tasks, without requiring a fixture installer. The existing app registry supplies `/p/approvals-preview`. HTTP coverage verifies request, open, restricted answer, exact spend/retry, persisted history across restart and rollback when an application role is absent. Poisoned old JSON stores are ignored.
- The independent frozen CLI corpus covers 62 old-program cases; broader parser abbreviations, complex quoting and combinations of errors are not exhaustive.
- Next composition reads project repository metadata from household rows on every operation; malformed metadata keeps the safe asking fallback. Owner previews resolve project rules, and repository changes take effect on the next lookup. Supply trusted new-runtime caller resolution and proven conversation membership. Until then callers remain unknown, body-supplied principal/project/conversation fields confer no authority, and no conversation is attached.
- Supply real runtime/clock application roles in next composition. `ApprovalOptions.applications` routes wake vouches to clock and grants, conversation resets and box write-offs to runtime. Roles must be synchronous and use the same foundation database; external work must be an outbox entry. Missing/failed roles roll back the answer; successful roles spend the receipt in the same transaction. Rollback and retry tests cover the seam; actual owning roles still need integration.
- Complete actual owner-application integration cases. Direct standing jobs, malformed receipt/standing imports, interrupted imports and socket expiry/access changes have tests.
- Security/spend review stopped at the three-round bound: final BLOCKING, one CRITICAL and one MAJOR, both folded with regression tests; final folds have no further review and no CLEAR is claimed. The separate persistence/importer/client review also stopped at three rounds: final BLOCKING with two CRITICAL findings, both folded with regression tests (command stderr credential redaction and map-only project scope). No fourth read and no CLEAR claimed; final folds are unreviewed. Full ledger: loom note loom/2026-11-12-approvals-importer-client-review.
