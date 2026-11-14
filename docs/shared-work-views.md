# Shared Approvals and Changes views

The registered Approvals and Changes tiles load `web/src/data/work-views.tsx`.
Their selections in `work-query.ts` use the generated shared schema through
`useDataQuery`, sharing the browser's Graphcache and `/graphql` socket. They
do not subscribe to the replaced approval/change record feeds.

`ApprovalsApp` and `LiveApprovalCard` bind the same snapshot and validated
`renderMeasuringChange` callback. `ChangesApp` and `LiveChangeCard` read the
same current change rows. On loading, disconnect or access loss, the snapshot
projection discards every row, including rules, notices, record, related tasks
and sync metadata, even if the input retains earlier data.

Changes select linked tasks through `changeTasks.taskRow`. A missing endpoint
produces no task reference in the snapshot. Tasks are deduplicated by id.

The outside composition must authenticate each viewer and expose explicit
tables with current SQL visibility. Approvals require `approvals`,
`approvalRules`, `approvalNotices`, `approvalRecord`; Changes require
`changes`, `changeChecks`, `changePeople`, `changeTasks`, `changeSync`, `tasks`.
Use the reviewed `workVisibility` and `taskVisibility` policies on every table
and connected read. Never expose whole tables to make these selections work.
Global rules/sync may be owner-only under those policies.

Commands remain optional injected `ApprovalActions` / `ChangeActions` and must
recheck current authority and the exact request or change head at execution.
The default registered tiles show no answer controls until root composition
supplies those callbacks. There is no optimistic answer or legacy-operation
fallback. Root also mounts the live cards inside conversations and supplies
household timezone where available (otherwise the browser timezone is used).

The replaced Changes tile is removed. Its legacy model still serves older
Tasks/desk consumers, and the old approval reader still serves Clock's local
scheduling flow; remove those only when their remaining callers are replaced.

Verification covers both generated SQL selections, current shared updates,
the actual lazy registrations, tile/card consistency, Measuring rendering,
exact request/head callbacks, fail-closed snapshots, and shipped reachability.
These focused checks do not establish running root/socket/command integration.
