# Shared Tasks view

`web/src/pieces/tasks/shared-view.tsx` exports `SharedTasks`. It consumes field
projections directly from the shared Tasks tables; it has no record-feed adapter,
transport, endpoint, registration or authorization implementation.

The root composition supplies one authorized snapshot: tasks, task links, comments
and ready task IDs. Request the ready list from the service/query predicate; do not
infer readiness from a visibility-filtered set of tasks or links. Supply all fields
in `SharedTask`, `SharedTaskLink` and `SharedTaskComment`. Drizzle row assignability
is checked in the view's test. Sort order is priority, position, then ID, matching
the service. The closed folder shows closed rows supplied by the query; query
paging/retention belongs to the client composition.

`selected` and `select(id?)` belong to the shell router. `questionFor` identifies
the member whose outstanding questions have a folder. `conversation(id)` opens
provenance. Missing linked task rows show only the known ID, without guessing a
title or fetching outside the shared client.

`act(action, task?)` opens the corresponding form in composition. Create has no
task; the other actions pass the selected row. Submit through the authenticated
Tasks operation adapter, which supplies the actor and checks current access. A
click is not an authorization or an operation receipt. No write is performed by
this view.

`shared-form.tsx` exports `SharedTaskForm` and `TaskCommand`. Mount the form for
the selected action and row, using the same snapshot status. Supply authorized
people, projects and task choices, the current conversation ID if creating from
a thread, and `submit(command): Promise<void>`, `done()` and `cancel()`. There is
no actor field: the authenticated adapter supplies it. Commands map to the
trusted TaskService methods (`edit` also handles Priority and Project); link
commands retain the explicit relationship type and direction. Changing a parent
uses removal followed by adding the new relation, respecting the service's
single-parent constraint. Creation defaults to household ownership and P2.

The form locks duplicate submissions, displays operation errors without losing
the draft, and calls `done` only after successful completion while still mounted.
Cancel closes the form; it does not cancel a write already accepted by the root.
Snapshot loss discards the draft, and late completion never calls a stale form's
`done`. Changing the task, action or source conversation starts a fresh draft.
Root must recheck current access and validate every command at the outside door;
form choices and hidden controls confer no authority. Writes still require the
existing operation/retry mechanism; these forms add no transport or registration.

On connection/access loss set status to loading, unavailable or denied, even if
the client still holds cached arrays. The view then hides all tasks, detail,
comments, project folders and write actions, and disables Create. Do not combine
rows from different authorization snapshots. The registered Tasks screen now supplies the generated query snapshot through
`useDataQuery`. The selection includes SQL `isReady` (all unfinished blockers,
including hidden ones) and joined links/comments. It makes no legacy record
subscription or detail/list request. The root supplies `submit`, authorized
people/project choices, `questionFor`, and conversation navigation to TasksApp.
Until the shared authenticated command adapter is bound, Create is disabled and
row write controls are absent; no command is sent to a legacy operation.
The websocket still needs mounting by root composition for the screen to receive
its initial snapshot and changes.

The trusted server seam is `dispatchTaskCommand(service, command, actor)` in
`src/apps/task-command.ts`. It dispatches form intent to the shared service and
returns a task row for row operations, or void for comments/relations. Errors
propagate. This is an internal function, not an HTTP endpoint or a successful
receipt. Root must validate the incoming envelope and current access (including
related task, project, owner, recipient and source references), supply its
resolved actor, persist the receipt with the write, then notify readers after
commit. The browser's submit promise resolves only when that root receipt says
the write succeeded. No browser transport has been chosen by this seam.
