# Salience timestamp hardening

Malformed and future timestamps read as cold, while valid timestamps retain the
existing category half-lives and rank-weighted recall policy. Consolidation's CLI
and MCP response report malformed and future timestamp field counts across active
rows (including fields not currently selected as the heat anchor). Optional null
fields are absent, not invalid. No timestamp or authored memory is repaired.
Equal heat is ordered by category, title, content and sourcing using code-unit
comparison, independent of query order and locale.

## Authored heat and audit time

`authored_at` is the authored-write heat anchor. New remember, repeated remember,
a changed content body (including revision restore and merge with appended bodies)
stamp it. An identical-body update, metadata update, confidence observation,
archive, restore, or merge that only combines counters/history does not. `updated`
continues to record audit changes; changing it alone cannot reheat a memory.
Recall retains its separate rank-weighted heat and decay clock.

## Legacy initialization policy

The additive migration introduces a nullable `authored_at` without backfilling
any rows. A missing or null anchor reads from `created`, never `updated`: historical
updates cannot distinguish authorship from maintenance. This deliberately cools
legacy memories whose latest real edit cannot be proven, rather than promoting a
bulk audit stamp. A subsequent authored edit or repeated remember establishes a
known anchor. Malformed or future non-null anchors read cold and do not fall back
to creation. Read-only older schemas use the same creation fallback; they need no
migration to render a digest. Timestamp counts include the new anchor as well as
creation, audit update, and recall timestamps.

This is source behavior for the next normal migration/connect, not authorization
to deploy, restart, migrate a live store or rewrite live memory. Rolling back code
can ignore the additive column, but reintroduces the old audit-based heat policy.
