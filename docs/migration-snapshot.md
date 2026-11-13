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
for byte; stop their writers for a stable copy. Symlinks are refused. `.git`,
`node_modules`, SQLite sidecars and special files such as sockets are excluded.
Other directories, including `dist`, are copied.

The destination is exclusively reserved before copying; readers must validate its
manifest with `readSnapshot` before consuming it. A normal failure removes the
incomplete destination. A killed process can leave an incomplete destination:
choose a fresh destination and keep the incomplete directory until it is inspected.
Never use a copy without a valid completion manifest. Directories are private
(mode 0700), files are private (0600); protect the snapshot as carefully as the old
home because it includes keys. Manifest checks detect changed contents, duplicate
paths and paths or links escaping the snapshot. The manifest is an integrity
inventory, not a signature against somebody who can rewrite the snapshot itself.
