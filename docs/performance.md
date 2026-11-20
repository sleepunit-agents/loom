# Next-mode performance

The new daemon uses in-process roles on one synchronous database. A background
sweep must not dispatch one operation for every row it inspects.

| Previous behavior | Replacement |
| --- | --- |
| Attention daemon calls checkWait per ask, then Tasks show once or twice per task wait | One direct attention.sweepWaits transaction and one Tasks readMany call for all eligible task waits |
| Tasks collection visibility reloads household sharing per task | One sharing snapshot per collection read |
| Retention dispatches fold per conversation | One retention transaction, policy check per conversation, shared fold implementation |

The single checkWait and fold operations remain available. Daemon sweeps no
longer create per-row retry receipts: the sweep owns one receipt, transaction
and live publication. The empty follow-up scheduled by live changes still stops
inventory work when no waits remain.

Tasks readMany is a direct read role, not a CLI command. It returns only id,
status and comments for requested tasks visible to the exact original viewer.
Services also require the explicit operation grant. Attention uses comments only
to match the configured owner's attributed answer to the question and timestamp;
reply words never enter Attention rows or sweep receipts. A failed or unavailable
read holds the wait. Private and source-managed asks are excluded from unattended
resolution. Permission changes are checked anew on every sweep; no task facts or
household policy are cached across operations.

Tests exercise 10 and 1,000 terminal task waits and assert a fixed operation call
sequence, and 10 and 1,000 retained conversations with exactly one operation call.
All fixtures are synthetic. Use node --cpu-prof for comparisons, never a real-data
import or the running home. This change needs no migration or cutover step beyond
shipping the normal build at the final web move.

## Remaining measurement work

Task t-2234 also calls for shared statement caching/timing, yielding sweep slices,
request/operation timings, event-loop delay and memory. The proposed smallest
monitor is a bounded in-memory history exposed to an owner-only page in loom,
with an authenticated metrics read. That uses the existing application and costs
nothing; it needs no scraper, Prometheus or separate dashboard service. It must
exclude record contents, inputs and outputs, and name operations in slow-request
logs. Those surfaces are not implemented by this batching change.
