# Offline migration plan preparation

`loom migrate plan --snapshot DIR` prints a raw JSON plan for editing. Save it
outside the snapshot and destination, then validate it with
`loom migrate plan --snapshot DIR --plan FILE`. Ambiguous source layouts require
an explicit plan as described below. Plan preparation opens no destination.

`loom migrate all --snapshot DIR --home NEW [--plan FILE]` runs registered
importers directly in dependency order under the destination's stopped-daemon
lock. Use a fresh home, then keep that home stopped through import and independent
verification. Exit 0 means every planned piece completed; exit 3 and an
`incomplete` report mean missing or blocked registrations, never success. Exit 1
means refusal/failure, and 2 means invalid arguments. Output is one report without
source values or importer error text. This command does not start any daemon.

The home stores a private `.migration-all.json` receipt containing the full plan,
its checksum, stable import time and per-piece completion. A different snapshot
or any changed plan is refused, even when an individual importer's checksum does
not cover its attribution. Interrupted importers roll back their own transaction;
if an importer committed before the coordinator saved completion, its own receipt
makes retry safe. The coordinator publishes each receipt by fsync and rename.
A leftover `.migration-all.pending` file never counts as completion. Completed
pieces are skipped on repeat, but newly available supported registrations still
run; unknown registrations without matching discovery and schema stay missing.
Repeat is not independent verification of destination contents.

Before any writable destination open, the coordinator rejects overlapping
canonical ancestors, inode aliases, hard links, symlinks or special entries and
nonempty homes without the matching receipt. Only leftover lock files and an
unpublished pending receipt are tolerated in an otherwise fresh home. All
snapshot hashes and inventory are revalidated on every invocation. SQLite imports
read private deserialized backup buffers, preserving snapshot bytes and directory
entries. Individual live-source commands retain their existing SQLite readers.
Changes projects come from imported household sharing records, never plan JSON.

`prepareMigrationPlan(snapshot, supplied?)` in `src/cli/migration-plan.ts` is also
the preparation API for the runner and the upcoming independent `verify` command.

The result contains the canonical snapshot root, validated manifest, editable
JSON `plan`, and `missing`/`blocked` registrations. A plan has this shape:

```json
{
  "version": 1,
  "snapshot": "<SHA-256 of the complete canonical manifest>",
  "importers": {
    "household": { "paths": ["home"], "options": {} },
    "tasks": {
      "paths": ["tasks/store.db"],
      "options": { "projects": { "t-1": "loom" }, "agent": "art" }
    }
  }
}
```

Preparation verifies file hashes, canonical manifest paths, kinds and sizes,
then recursively refuses symlinks, special files and files outside the inventory,
including unlisted SQLite sidecars. The manifest is an integrity inventory, not
a signature against someone able to replace both data and manifest. SQLite
source discovery deserializes verified main-file bytes into memory; a private
buffer's SQLite WAL-format header is changed to rollback format so deserialization
can read a completed backup. No source byte or directory entry changes.

Discovery uses copied `home/household.json`, optional `tasks/store.db`, every
copied `memories.db` with conversation tables, directories containing an agent's
`spool.jsonl`, `schedules.json` or `paused`, directories containing
`approvals.json`, and v1 `{changes: [...]}` JSON in a `changes/` directory or
named `changes.json`. Memories databases without conversation tables are not
Attention sources; missing required tables or importer-read columns, and duplicate
conversation ids, are errors. Optional legacy columns and absent optional tables
remain allowed; each importer still validates complete source row content. These are data-layout conventions, not a search through legacy
programs or settings for live paths. A nonstandard Changes export can be placed
in the old home under one of these names before snapshotting by its coordinator.
Multiple clock, approvals or Changes candidates require an explicit plan choosing
one; preparation never silently chooses a candidate. `migrationSnapshotChecksum`
can supply the snapshot field when constructing such an explicit plan.

Derived defaults are editable data, not inferred identity or access grants:

- Tasks preserve explicit epic projects and use the household's default agent
  for tasks without a project. Additional epic mappings are explicit; mappings
  to non-epics and conflicts with source projects are refused.
- Attention requires one audience for every conversation. Defaults are `{}`:
  the source agent and household owners retain access through central policy;
  no project or member audience is guessed from a venue, title or participant.
- Approval project mappings start empty. The existing importer accepts approval
  ids or proven conversation ids as keys.
- Changes starts with empty login/branch lists for each known agent and no owner
  logins. Edit attribution explicitly; `taskOwner`, if supplied, must identify a
  household agent or member. Projects are deliberately absent from plan options:
  the runner must derive them from the imported household's SharingDatabase,
  just as the individual Changes command does. Preparation does not create
  projects or assert that supplied project slugs already exist at the destination.

All known importer options use strict schemas; functions and importer hooks are
never JSON plan fields. Every discovered piece must remain in an edited plan,
Attention must retain all discovered source databases, and household/tasks use
their fixed copied inputs. Unknown registrations retain JSON options and confined
inventory paths and are reported as missing, never executed or counted as success.
The registry owns dependency ordering. Registrations added later need their own
option schema and discovery rule here before the runner may execute them.

`migrationPlanChecksum(plan)` covers the entire plan: all paths, audiences,
project maps and Changes attribution, including missing registrations. Object-key
and manifest-entry ordering are immaterial; array order is retained. The runner
must store the full plan and snapshot identity in its receipt, reject another
snapshot/plan in a populated destination, and hold the stopped-home lock for every
import. Same-source importer receipts alone do not validate Changes attribution
on repeat. Independent verify must compare expected and actual content every time,
not call checksum-only importer repeat paths.
