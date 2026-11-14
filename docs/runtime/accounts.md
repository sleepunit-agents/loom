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
