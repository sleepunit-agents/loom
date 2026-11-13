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
| `ui --json` manifest, `ui page` | approval and approval-rule records; Approvals app (pending) |
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
receipt makes retries of the same spend return its prior result.

## Import and final move

`loom migrate approvals --home <stopped-next-home> --from <old-directory>`
reads `approvals.json`, optional `rules.json`, and optional `audit.jsonl` only
inside the importer. An optional `--projects` JSON object explicitly maps
approval ids or proven conversation ids to household project slugs. No guessing
from titles. The source and mapping checksum, import and comparison of all
records happen in one destination transaction; interrupted runs roll back,
identical repeated input is a no-op, different input is refused.

Only at the final move, with the owner present: stop writers, back up source
and destination, import a stopped source copy, verify ids/counts/content,
start next mode and point the existing launcher at `loom-approvals-client`
using `LOOM_URL` and `LOOM_TOKEN_FILE`. The compatibility client is transport
only and never opens old state. Returning to the old side restarts it on its
untouched stores until the owner retires those stores.

## Remaining before merge

- Finish the Approvals app on the kit, open confirmation guard, Rules and history.
- Register in next composition/fixture and app registry with small additive edits.
- Complete old contract cases and independent CLI output/exit oracle fixtures.
- Connect owner-applied grant/vouch/reset/write-off to runtime/clock role actions;
  Allow must apply the action, never merely leave an allowed grant unspent.
- Cover direct standing jobs, overlap denials, malformed importer records,
  live expiry/access changes, HTTP and socket behavior and interrupted imports.
- Cold review of spend/grant paths and migration (at most three rounds).
- One two-window app test; screenshots at 390, 1280, 1920 in Neon Noir and
  Daylight as CI artifacts; no browser suite on loom's machine.
