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
no Loom token. Failed provider reads do not send a successful observation; remote
failure latching and periodic refresh scheduling remain separate integration work.
An uncertain report is not retried automatically, and no remote diagnostics are
printed. Neither the report nor its response contains provider credentials.
