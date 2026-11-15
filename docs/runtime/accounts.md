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
