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
this view. The adapter/form must report its own errors and pending state.

On connection/access loss set status to loading, unavailable or denied, even if
the client still holds cached arrays. The view then hides all tasks, detail,
comments, project folders and write actions, and disables Create. Do not combine
rows from different authorization snapshots. The view intentionally remains
unmounted until root composition supplies the generated reads and write forms;
the existing registration remains in place until that replacement is complete.
