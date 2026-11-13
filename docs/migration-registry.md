# Offline importer registration

`src/cli/migration-registry.ts` is the extension point for `loom migrate all`.
The registry and [plan preparation](migration-plan.md) are available;
the all/verify commands follow in t-2213. Existing individual commands are unchanged. No daemon path loads it.

An importer declares a unique lowercase `name`, `dependencies` (registration
names), `reads` (a human-readable snapshot input inventory), `sourceReads`
(machine-readable file globs relative to the old home), and an in-process
`run(context, input)`, returning a value or promise. The coordinator awaits each
importer before publishing completion or starting its dependents, and keeps the
destination database and stopped-home lock open through settlement. An importer
must await all its work before returning. Register it in `createMigrationRegistry`; never spawn a
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

Snapshot collection uses `sourceReads` for every registered importer. `*` matches
one path segment and `**` matches zero or more segments. External taskstore is
selected only by `--tasks`, not a home glob. Add a source rule whenever an importer
starts reading another file, and test snapshot → plan → all on that layout.
Program/run pruning and key inclusion are central rules; an importer must never
read installed program trees.

Comms key prerequisite: `publishMigrationCommsKey(snapshotKey, home)` is an
internal offline helper, not a registered importer. Its caller must manifest-verify
the snapshot, resolve its input with `snapshotPath`, and hold the destination's
stopped-daemon gate, and run migration-all's receipt-bound publication-pair
recovery before calling the helper on a resumed destination. The helper itself
refuses every hard-linked key; it does not authorize standalone crash-pair
recovery without a matching migration receipt. It preserves the snapshot key bytes, accepts an identical
existing private regular key and refuses a different one; it never generates one.
It fsyncs a private exclusive temporary file before linking the final name and
fsyncing the directory. Retry also fsyncs the directory when the final file exists.
The all coordinator recovers only root `comms.key` / UUID publication-temp pairs
that have exactly two links, source-identical bytes and the matching plan receipt,
just as for `ui-cookie.key`. External aliases and unrelated pairs remain refused.
This prerequisite does not add Comms discovery, registration or independent
verification; all three remain required before Comms is covered by migrate-all.

Independent verification's `verifyMigration` and CLI `migrateVerify` return
Promises. The read-only destination and stopped-daemon gate remain held until
every source projection settles, including rejection; callers must await the
result. `migration-projection.ts` builds source-only physical rows separately
from destination comparison. Existing six projections retain their synchronous
source readers. This async prerequisite does not register or verify Comms.
