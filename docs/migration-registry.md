# Offline importer registration

`src/cli/migration-registry.ts` is the extension point for `loom migrate all`.
This slice supplies the registry; the all/verify commands and editable plan follow
in t-2213. Existing individual commands are unchanged. No daemon path loads it.

An importer declares a unique lowercase `name`, `dependencies` (registration
names), `reads` (a human-readable snapshot input inventory), and an in-process
`run(context, input)`. Register it in `createMigrationRegistry`; never spawn a
piece program. The context supplies the open destination database, destination
home, one timestamp and the validated snapshot root/manifest. The input supplies
snapshot-relative paths and typed options. Use `snapshotPath` for every path;
it rejects missing inputs and paths escaping the snapshot root, and recursively
rejects child symlinks and special files inside directory inputs.
The coordinator must validate the snapshot manifest before constructing context,
reject overlapping source/destination homes, hold the destination's stopped-home
lock and validate all editable plan options before calling any importer.

The importer owns one transaction and its comparison of ids, counts and content.
It must leave the old input unchanged, roll back an interruption, no-op on the
same source and refuse a different source. A future verify hook must compare
expected source content to actual destination content independently; calling
an importer's checksum-only repeat path is insufficient.

`order()` visits dependencies once, rejects cycles and reports unregistered
names as `missing`. Dependents of a missing registration are `blocked` and are
excluded from the runnable list. Missing pieces are reported, not import errors
or successful imports. Registration order breaks ties deterministically.

Current entries: household first; tasks, attention, clock, approvals and Changes
all depend on household. Household takes copied `home/`; tasks takes the optional
`tasks/store.db`; attention takes one or more copied memories databases plus
`ImportScopes`; clock takes copied WAKE_DATA; approvals takes its copied old
directory and project map; Changes takes copied snapshot JSON and import settings.
The Changes adapter accepts the importer's existing settings interface; the all
command must derive its projects from the destination household and validate
attribution against that household, as the individual Changes command does.
Callbacks and interruption hooks are internal TypeScript APIs, never JSON plan data.

Comms, secrets, bridges and runtime can add their registrations here when their
importers land. Declare all required predecessors explicitly and add fixture
coverage for registration, transaction rollback and comparison. Don't change
another piece's tables or read live paths. Source discovery and editable-plan
derivation belong to the all command, not to a registration.
