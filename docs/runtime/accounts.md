# Shared account usage

A trusted provider adapter returns the complete set of active subscription limits
as `QuotaWindow[]`. `refreshAccountWindows(db, account, provider, now)` invokes it
outside the database transaction. This module supplies no provider credentials,
HTTP client or provider-specific parser; composition supplies the adapter.

Successful refresh writes the existing `model_account_windows` rows and
`model_accounts` summary atomically. A changed account or concurrently completed
refresh discards the pending result. A failed or malformed provider result closes
admission but preserves the observations; only a successful refresh opens it again.
Direct ingestion uses `recordAccountWindows` and rejects older retained readings.

Placement evaluates the persisted windows at its current time, so an expired or
aging reading cannot keep granting stale headroom. Missing, malformed, unknown or
future observations close admission. It never fabricates a fresh allowance when a
reset passes. Limits belong to the account and are shared by all its agents.

Choices where the site is silent: provider responses replace the complete set of
limits, window names must be unique, and overlapping asynchronous refreshes use
the first committed result. The summary uses maximum projected usage (capped at
one), the oldest complete reading and earliest known reset; if any reset is
unknown the summary reset is unknown. A reserve of one is valid, matching the
shared schema, and can still be lent near reset when the forecast is safe.

This service is trusted internal code. Public account field visibility remains the
query door's responsibility. No decrypted credentials are stored here.

## Model-account reads

The shared GraphQL query root exposes `modelAccounts`. It never exposes the raw
account tables or accepts caller identity, private-column filtering or ordering.
Rows are ordered by the public label.

```graphql
{
  modelAccounts {
    ... on RuntimeAccount { label level }
    ... on RuntimeAccountDetail {
      id owner provider usage usageReadAt resetsAt hasRoom
      signedInOn { id name }
    }
  }
}
```

A member who owns the account, or whose current household role is `owner`, gets
`RuntimeAccountDetail`. Every other caller gets `RuntimeAccountSummary`, which
contains only label and level. An agent does not inherit the privileges of the
member who owns it. The existing outside door refuses service and runner general
queries. Both concrete views implement the common `RuntimeAccount` interface.

Level is exactly `plenty`, `getting full` or `almost full`, based on the current
shared quota windows. Unavailable capacity is conservatively `almost full`.
Private usage and timestamps remain the stored provider observation; an expired
window does not manufacture a new reading. `hasRoom` reflects current admission
capacity, including stale observations or a failed-reader latch.

A private selection records only its account identifiers against the authenticated
Viewer object. The same door's `auth.valid()` rechecks current account ownership
and household role before buffered HTTP delivery and socket refresh/delivery.
Losing authority while an async sibling is pending refuses that response; a new
request can receive the coarse view. A live connection whose private selection
loses authority closes with the normal authentication-ended code. No credentials, usage/provider/location values or caller-supplied identities
enter this witness. The witness is weakly keyed and belongs to one shared-data root.

### Reporting a worker observation

The local `--account-usage` configuration may include
`"report":{"url":"https://loom.example","tokenFile":"/private/worker-token"}`.
After the private reader returns a valid complete window set, the worker sends it
once to the ordinary `runtime.accountUsage` operation before printing its local
success. The token authenticates the machine; a caller cannot supply a machine
identity. Loom accepts reports only for an account already signed in on that
live machine, with the current account owner and provider. Reports cannot enroll
accounts or change membership. Account/window writes and the acknowledgement
receipt commit together. Older observations cannot replace newer windows.

Without `report`, the command keeps its existing local-output behavior and reads
no Loom token. With reporting configured, the worker obtains an opaque observation witness
before invoking the provider. Both successful and failed reports carry that witness; only a completion whose
witness still describes the current quota can change admission. A failed read
closes admission without letting an older success reopen it. It preserves usage timestamps and windows; a
newer successful reading, including identical values, invalidates older failures.
The witness is a concurrency check, not authority: both requests still require
current bearer-machine proof, account membership, owner and provider. Receipt
replays are not fresh provider completions. Restart discards witnesses; an old
failure then makes no change and needs a new read attempt. Normal-worker refreshes are configured below.
An uncertain report is not retried automatically, and no remote diagnostics are
printed. Neither the report nor its response contains provider credentials.

### Normal worker refreshes

The normal `loom-worker` configuration can include `accountUsage`:

```json
{"accountUsage":{"intervalMs":60000,"readers":[{"account":{"account":"subscription","owner":"member","provider":"provider"},"command":{"command":"/private/quota-reader","args":[],"cwd":"/private","env":{}},"timeoutMs":30000}]}}
```

These are machine-local private commands using the same structured quota reader
protocol as `--account-usage`. The existing worker token reports to the worker's
configured Loom origin. No extra token file or provider credential goes to Loom.
Each configured account is refreshed before the first job claim, then scans run
alongside the worker slot, one reader at a time, with no overlapping scans. The
interval starts after a scan finishes (default one minute; configurable from one
second to one hour). Configuration accepts 1–32 readers with distinct account
identifiers. Reader deadlines retain the same one-shot limits.

Failed provider reads report unavailable through the same observation witness;
transport failures leave the existing observation untouched. Either failure emits
only a fixed diagnostic and permits the next account and later scheduled scan.
There is no retry of an uncertain report. Stopping the worker aborts pending
reads/requests and joins the refresh loop before removing signal handlers. A late
reader result cannot report or start another job. Without `accountUsage`, the
normal worker starts no quota reader or refresh timer.

Before the initial normal-worker quota scan, the worker reports machine health
through `runtime.health`. It continues serial health reports every 15 seconds
while that scan is pending, without claiming a job. This keeps a long private
reader from making an always-on machine appear quiet. Health reports include
configured machine facts when present, but never change quota. A failed health
report cancels startup; an in-flight report is joined before claims or shutdown.
After the initial scan the ordinary idle polls and job heartbeats maintain health.

## Configured model roles

The server entry can parse a JSON array with modelCatalogJson from
src/runtime/model-catalog.ts, then supply the resulting snapshot through
sharedRoot's modelRoles callback. Each record explicitly names model, provider,
harness and series; none is derived from another field. A model appears once.
For example:

    [{"model":"chosen-model","provider":"actual-provider","harness":"claude","series":"model-family"}]

Identifiers must be nonempty, trimmed, single-line strings of at most 200
characters. Unknown fields, missing dimensions and duplicate model mappings
are refused with a fixed diagnostic; an empty catalog leaves work queued.
The returned catalog and records are immutable snapshots. The Root validates
startup configuration before opening services and validates each later callback
result before using it. Invalid current configuration rolls back a claim; fixing
the callback permits the queued work to be claimed normally.

File access and loading/reloading policy belong to the server entry. This
parser does not add another credential source or infer a provider from a model
name. Account ownership, sign-in locations and current quota still constrain
placement in the ordinary runtime.

## Agent model preferences

`POST /api/runtime/agentModelsSet` uses the ordinary `{id,input}` command envelope
with `input: {agent, models}`. The current agent owner supplies one to 64 distinct
configured model IDs in order; the first is the primary conversational model.
The existing agent setup permission rule applies, including current ownership on
receipt replay. Runner, agent and service principals cannot change these settings.

Replacement and receipt commit together. Invalid or unknown choices preserve the
previous order. A committed change wakes settled mail held for missing setup;
queued work uses the latest preferences when claimed. A body already claimed keeps
its requested model. The operation neither signs in nor calls a model provider.

## Account metadata commands

The shared operation door offers runtime.accountCreate ({provider,label}),
runtime.accountRename ({account,label}), runtime.accountSignedIn ({account,box})
and runtime.accountSignedOut ({account,box}). Each write uses the ordinary stable
operation ID and receipt. Creation returns the new account ID; other commands
acknowledge saved:true.

Creation derives ownership from the authenticated member and accepts a provider
already present in the configured model catalog. New accounts have no quota
observation and cannot admit work until a worker reports fresh usage. Provider
and ownership are fixed for this account; renaming changes its public label.

Account owners and household owners may rename an account or remove its recorded
sign-in location. Recording a sign-in also requires access to the live box as
its owner or a household owner. Agents, runners and services cannot administer
these records, and a token label is never ownership.

### Signing in from anywhere

`runtime.accountSignIn {account, box}` asks the worker on that machine to run
the provider's sign-in program (`accountSignIn.programs` in the worker's config,
one per provider). This is the one way a worker signs an account in. The program is started in a private directory and talks to
the worker through files there: it writes `link` (the page to open) and, for a
device flow, `user-code`; for a paste-code flow the worker writes `code`. Exit 0
means the provider's own program says the account is signed in.

On failure the program writes one reason word in `why`. Loom shows its own
sentence for the word and never the program's text, because what a provider's
program prints could repeat a code or a token:

| Word | Shown as |
|---|---|
| `refused` | The provider refused the sign-in |
| `wrong-code` | The provider did not accept the code |
| `expired` | The page or the code ran out before the sign-in finished |
| `unreachable` | The provider could not be reached from this machine |
| `not-installed` | The provider's program is not installed on this machine |

Anything else, or nothing, is shown as "The provider's program says the account
is not signed in". The worker has a few words of its own for how the relay went
(`no-page`, `no-program`, `cannot-run`, `ended`, `timed-out`, `stopped`). The
whole list is in `src/runtime/account-signin-reasons.ts`. Loom keeps the rule
itself: `runtime.signInDone` stores its own sentence for a word in the list and
"The sign-in did not finish" for any other text a worker sends.

A pasted code is handed over once. The worker of that machine takes it
(`runtime.signInTake`), which blanks it in the database and keeps it in the
program's memory under that take; only the same take can read it
(`runtime.signInCode`), again if a reply was lost. No second take and no other
reader gets it. If loom restarts between the take and the read the code is
gone: the sign-in fails and is asked for again. The code is forgotten when the
sign-in ends, however it ends. A request nobody finishes ends after 20 minutes;
the program's periodic sweep closes it even when no worker is polling. The
worker gives up first, after 15 minutes (`RELAY_MS`; `accountSignIn.timeoutMs`
can shorten it, not lengthen it), so loom is told why.

There was a second way, `loom-worker --account-signin <file>`, which ran a
program of a different protocol (the account's identity on stdin,
`{"signedIn":true}` on stdout) at the machine and told loom nothing. It is
removed: the worker now refuses that argument with exit code 51 and a line
naming this section. A program written for it has to be rewritten to the
files above. Someone at the machine who wants no request through loom runs the
provider's own sign-in by hand and then records it with
`runtime.accountSignedIn {account, box}`.

The separate private program performs the actual provider sign-in/out. These
commands record its result, without accepting credentials or invoking it inside
Loom. A fresh sign-in or removed association invalidates pending usage reports
only after the complete write and receipt commit. Replaying a receipt does not
invalidate a newer observation; remove/re-add cannot revive an older read.
