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
