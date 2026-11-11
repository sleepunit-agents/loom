# Salience timestamp hardening

Malformed and future timestamps read as cold, while valid timestamps retain the
existing category half-lives and rank-weighted recall policy. Consolidation's CLI
and MCP response report malformed and future timestamp field counts across active
rows (including fields not currently selected as the heat anchor). Optional null
fields are absent, not invalid. No timestamp or authored memory is repaired.
Equal heat is ordered by category, title, content and sourcing using code-unit
comparison, independent of query order and locale.

## Remaining scope

Metadata-only updates still reheat memories. `updated` is both an audit timestamp
and the authored heat anchor; update, archive, restore and repeat remember all
write it. Keeping audit behavior while distinguishing authored edits requires a
separate authored-write anchor and a legacy initialization policy. Existing rows
cannot tell whether their last update was metadata or content. This PR deliberately
adds no migration and does not guess that history or alter the established policy
that authored edits and repeated remember reheat. The pending regression in
salience.test.ts names the intended metadata-only behavior; it is not a passing
claim. Task t-2120 remains open until that distinction is implemented and tested.
