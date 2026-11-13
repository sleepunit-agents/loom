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
| `rule merge/host TARGET… [--json]` | `approvals.rule` |
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

No independent background poller exists in the old program; expiry was evaluated
on read. New live records refresh at receipt expiry and leave the live set one
week after the last receipt change. Pending receipts remain live indefinitely.

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
from titles. The source and mapping checksum, import and comparison of all
records happen in one destination transaction; interrupted runs roll back,
identical repeated input is a no-op, different input is refused. Explicit null rule collections and malformed audit envelopes are refused. Import tests preserve every collection, exercise both mapping keys and map checksum changes, and force schema/content rollback on interruption or comparison failure.

Only at the final move, with the owner present: stop writers, back up source
and destination, import a stopped source copy, verify ids/counts/content,
start next mode and point the existing launcher at `loom-approvals-client`
using `LOOM_URL` and `LOOM_TOKEN_FILE`. The compatibility client is transport
only and never opens old state. LOOM_URL is an HTTP(S) origin without URL credentials, path, query or fragment; redirects are refused. The client validates daemon output and preserves one operation id across at most four attempts. Returning to the old side restarts it on its
untouched stores until the owner retires those stores.

## Remaining before merge

- Finish browser verification of the kit app, open confirmation guard, Rules and history.
- Register in the new next-mode composition when that root lands (fixture, standalone startLoom and app registry are wired).
- Complete old contract cases and independent CLI output/exit oracle fixtures.
- Supply real runtime/clock application roles in next composition. `ApprovalOptions.applications` routes wake vouches to clock and grants, conversation resets and box write-offs to runtime. Roles must be synchronous and use the same foundation database; external work must be an outbox entry. Missing/failed roles roll back the answer; successful roles spend the receipt in the same transaction. Rollback and retry tests cover the seam; actual owning roles still need integration.
- Complete overlap denial and owner-application routing cases and HTTP coverage. Direct standing jobs, malformed receipt/standing imports, interrupted imports and socket expiry/access changes now have tests.
- Security/spend review stopped at the three-round bound: final BLOCKING, one CRITICAL and one MAJOR, both folded with regression tests; final folds have no further review and no CLEAR is claimed. Persistence/importer/client review remains to run (at most three rounds for that separate unit).
- One two-window app test; screenshots at 390, 1280, 1920 in Neon Noir and
  Daylight as CI artifacts; no browser suite on loom's machine.
