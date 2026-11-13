# Snapshot for the move

Run `loom migrate snapshot --from <old-home> --tasks <taskstore.db> --to <new-directory>`.
The tasks argument is optional when no separate taskstore exists. The destination must
not exist and must be separate from the source. It contains `home/`, optional
`tasks/store.db`, and `manifest.json` (the completion marker).

The source's records, JSON files and keys are never changed; SQLite may create its
normal `-shm` and `-wal` read coordination files beside a source database.

SQLite uses its backup API, including committed WAL contents. Each database has a
consistent committed view; for a final snapshot consistent across stores, stop all
old writers first. A live snapshot is for rehearsal. JSON and keys are copied byte
for byte; a running-source rehearsal can be a few seconds stale across databases and
files. A JSON file replaced atomically is copied as one version; an in-place writer
can leave a partial JSON copy and plan/import validation then refuses it. Stop all
writers for the real move.

The registry's `sourceReads` file globs declare what the importers consume. Only
those files, `*.key`, `review.pub`, and files below `keys/` are copied. Installed
program and runtime directories (`current`, `versions`, `releases`, `node_modules`,
`.git`, `run`, `runs`, `pieces/bin`) are pruned without walking them. Locks, SQLite
coordination files, sockets, pipes, devices and undeclared files are skipped.
`manifest.skipped` records names relative to the home and rules, with sizes for
files; a null size means a live handle, alias or unvisited subtree, not zero bytes.

Internal aliases are resolved, deduplicated and copied at their real data paths;
`manifest.followed` records alias and real path. A file alias explicitly named by
an importer is also materialized as regular bytes at its original name so fixed
paths (such as `tokens.json`) continue to work; discovery counts that data once.
Both copies use the same captured bytes, and no destination symlinks are created. Dangling and external aliases are
skipped, with only the alias name and rule (never the target). A destination path
containing a symlink is refused so snapshot writes cannot escape it. On Linux,
SQLite backup writes use a pinned destination directory descriptor through
`/proc/self/fd`; temporary backups are published only after confinement checks. Refusals name
a relative source path (or `<destination>` / `<tasks>`) and one plain rule; they
never echo a library exception or file contents.

Append `--dry-run` to the snapshot command first. It prints JSON lists of copied
and skipped names, byte sizes and followed aliases, and writes nothing, including
no SQLite coordination files. Sizes are source main-file sizes; the backup may
have a different size once committed WAL data is included. Directory skips are
not traversed to calculate sizes. The actual copy uses the same inventory rules.

The destination is exclusively reserved before copying; readers must validate its
manifest with `readSnapshot` before consuming it. A normal failure removes the
incomplete destination. A killed process can leave an incomplete destination:
choose a fresh destination and keep the incomplete directory until it is inspected.
Never use a copy without a valid completion manifest. Directories are private
(mode 0700), files are private (0600); protect the snapshot as carefully as the old
home because it includes keys. Manifest checks detect changed contents, duplicate
paths and paths or links escaping the snapshot. The manifest is an integrity
inventory, not a signature against somebody who can rewrite the snapshot itself.
