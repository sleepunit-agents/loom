# Memory moves into the household database

*2026-11-26. Status: **draft**, not accepted. Cold-reviewed three rounds on 2026-11-26 (six critical findings, then two, then
one); the third was still blocking and its findings are folded here without a further round. It needs another cold
read and the owner's before anything is built. This is a design doc in the `docs/specs/` sense: what loom
builds, and the checks its suites must pin. The owner decided the direction on 2026-11-26 ("full merge, it just makes
sense to me"). This doc is how. The move of a real household's data is one-way and is run with the owner present.*

## Why

> "on the shared schema shit not having knowledge and memory, that's a big miss. if we need that to do what we want
> here, we should start with that... all of our big performance and data changes have been super useful across the
> board. if we need to mop that up first, lets do it." — the owner, 2026-11-26

`docs/architecture.md` says of Memory: "The only part whose data is outside the household database." Memories, notes,
person and project cards, and knowledge pages are in four kinds of SQLite file beside `loom.db`. That costs three
things today.

- **Nothing joins.** A memory names a ticket or a person as text. "What do we know about this ticket" is a search.
- **Writes are not atomic.** Every Memory write commits in its own file and then again in `loom.db`, with a receipt
  table in each file and a recovery path to reconcile them. Adding a person is two commits in two files, and
  `docs/accepted-tradeoffs.md` ("A new person is two commits, not one") names "People moving into one file" as what
  would change that.
- **Everything is built twice.** Memory has its own upgrade steps, version numbers, receipts and connections,
  parallel to the ones every other part shares.

## What is true today

Read from the code on 2026-11-26. An implementer confirms each before relying on it, and stops and says so if one is
false.

- **Four kinds of file.** Per agent: `<home>/agents/<id>/memories.db` and `notes.db`. Shared: the knowledge and people
  files whose paths `program.json` gives under `memory.sources.commons`. Their tables are listed in
  `docs/architecture.md`.
- **Only `loom serve` opens them** while it runs, and a second server on one home is refused by the home lock.
  Bodies, workers and the `loom` command line go through the door. `scripts/rebuild-agent-memory-files.mjs`,
  `rebuild-shared-household-files.mjs`, `rebuild-memory-temperature.mjs`, `rebuild-tempo-calendar.mjs` and
  `check-knowledge-policy.py` open them directly.
- **Every start prepares every file**: creates a missing one and upgrades an older one in place
  (`prepareSharedMemorySources`), and an agent added while the server runs has its files made before anything reads
  them (`prepareAgentMemory`). So every agent in `agents` has both of its files and both commons files exist. A
  removed agent keeps its row in `agents` and its files; no row of `agents` is ever deleted.
- **No two homes share a commons file.** Nothing in the code checks this. The owner confirms it before a phase 1 or
  2 release is started ("The real move").
- **Keys are local to a file.** In `memories.db` the integer `id` columns are `AUTOINCREMENT`, cards are keyed by
  `slug`, and in `notes.db` a note is keyed by `path`. All repeat across agents. Outside callers see `<agent>:<uuid>`,
  `<agent>:<slug>`, `commons:<slug>`, a page's slug and a note's path.
- **Vectors are only in `memories.db`**: `vec_memories`, a `vec0` virtual table of 384-number embeddings whose
  `rowid` is `memories.id`, read through the `sqlite-vec` extension. Archiving a memory deletes its vector. The file
  does not record which model made the vectors. There is no full-text index anywhere.
- **A memory command's effect, its receipt and the removal of its reservation commit together** in `memories.db`
  (`memory_command_receipts`, `memory_command_preparations`). A reservation left behind is a command that took no
  effect. Knowledge, note and person writes commit their effect with a row in `mind_operation_receipts`. If the
  server stops before the matching `operation_results` row is saved in `loom.db`, a retry finds the file's receipt
  through the operation's `recover` hook.
- **Reads are served by hand-written fields** (`src/transport/memory-queries.ts` and `src/pieces/mind/*-query.ts`),
  each checking `maySee`. No Memory table is a query table.
- **Upgrade steps are SQL only**, rehearsed on an in-memory copy with no rows and no extensions and compared with
  pinned shapes. A step cannot run code or read another file.
- **There is no backup code.** `household.backup_target` is stored and nothing acts on it.

## Words (to be added to CONTEXT.md)

**The move**:
the one-time copy of a household's Memory files into `loom.db`, done by the program at start, one phase at a time.
_Avoid_: migration (that is a schema step), import (that is the offline importer for older homes)

**Source**:
one Memory file of a phase that is moving or has moved: a `memories.db`, a `notes.db`, the knowledge file or the
people file. A Memory file whose phase has not started is not yet a source, and is used as it is today.

**Working copy**:
a copy of a source that the move makes, upgrades and reads from.

**The index**:
the vector search file, `memory-index.db`, built from the embeddings in `loom.db`. It is derived and can be deleted.

## Rules

1. **One database.** When a phase has moved, its records are rows in `loom.db` and nothing in the program outside the
   move's own module opens a source of that phase.
2. **One write, one commit.** A Memory operation whose records have all moved commits its effect and its
   `operation_results` row in one `loom.db` transaction. Two operations span a moved and an unmoved store for a
   while, and keep today's order and today's recovery until the later phase: `mind.personAdd` between phases 2 and 3
   (the agent's card commits in `memories.db` with its receipt there, then the directory card and the
   `operation_results` row commit in `loom.db`), and the note sweep between phases 3 and 4 (`loom.db` is locked first
   and `notes.db` is written last, as today).
3. **The same answers.** Every Memory read field and operation returns, for every viewer, what it returned from the
   files. No moved table becomes a query table in this spec: they are declared in the `plumbing` group of
   `src/core/data/schema.ts`, which cannot be selected, and are read only by the fields that read the files today.
4. **What a source holds is never changed.** The only write the program makes to a source is a WAL checkpoint at the
   start of an attempt at its phase's move, which folds the `-wal` file into the main file and changes no row. After
   that checkpoint the source is one file, and every later open of it is read-only with `immutable=1`, which creates
   no `-wal` or `-shm`. The program renames it once and never edits, deletes or replaces it, then or later. The
   release that has a phase does not run today's start-time preparation on that phase's files.
5. **A phase moves everything it covers or nothing.** One `loom.db` transaction per phase. Between phases a household
   has some Memory in `loom.db` and the rest in files, and works.
6. **Absence is never taken for emptiness** by the move. A source that should exist and does not stops the start.
7. **The move widens nobody's reach.** Before a phase runs, `loom.db` and any `-wal` and `-shm` beside it must be
   owned by the server's user with mode 0600, or the start is refused naming the file. Every file the program creates
   for the move or the index (`memory-index.db`, working copies, copies of `loom.db`) is created with mode 0600, and
   every directory 0700. A renamed source keeps its own mode.
8. **The vector extension stays out of `loom.db`.** `loom.db` holds each embedding as a blob. The `vec0` table is in
   the index.
9. **The agent's own pages stay files.** `IDENTITY.md`, `preferences.md`, `self-model.md` and the directories beside
   them are not moved. Note attachments stay on disk under `agents/<id>/note-files/`.

## The tables

Every table moves with the columns and CHECKs it has today. No value is rewritten: integer ids, uuids, refs, slugs and
paths are carried as they are, including ids held inside JSON and text.

| Source | Table today | Table in `loom.db` | Key in `loom.db` |
| --- | --- | --- | --- |
| knowledge | `pages`, `citations`, `supersessions`, `page_supersessions`, `page_annotations`, `page_revisions`, `verifications`, `knowledge_access` | `knowledge_pages`, `knowledge_citations`, `knowledge_supersessions`, `knowledge_page_supersessions`, `knowledge_annotations`, `knowledge_revisions`, `knowledge_verifications`, `knowledge_access` | as today |
| people | `people`, `person_revisions`, `person_merges`, `person_account_sightings`, `person_sighting_aliases` | `directory_people`, `directory_person_revisions`, `directory_person_merges`, `directory_account_sightings`, `directory_sighting_aliases` | as today |
| `memories.db` | `memories`, `proposals`, `memory_revisions`, `memory_supersessions`, `memory_deletions` | `memories`, `memory_proposals`, `memory_revisions`, `memory_supersessions`, `memory_deletions` | `agent` + today's |
| | `vec_memories` | `memory_embeddings`: `id`, `agent`, `memory_id`, `model`, `embedding` | `id`; unique on `agent`, `memory_id` |
| | `people`, `person_revisions`, `person_merges` | `relationship_people`, `relationship_person_revisions`, `relationship_person_merges` | `agent` + today's |
| | `projects`, `project_revisions`, `project_names` | `project_cards`, `project_card_revisions`, `project_card_names` | `agent` + today's |
| | `memory_card_references` | `memory_card_references` | `agent` + today's |
| `notes.db` | `notes`, `note_revisions`, `note_files` | `notes`, `note_revisions`, `note_files` | `agent` + today's |

- **`agent` + today's** means: the table gains an `agent` column that references `agents(id)` with no action on
  delete (no row of `agents` is deleted today, and one that had Memory could not be); it becomes the first
  column of the primary key and of every unique index; and every foreign key between two such tables includes it.
  So `memory_revisions(agent, memory_id)` references `memories(agent, id)`, and two agents' rows with the same id
  never meet. Every moved table has a primary key; where today's table has none declared, its `rowid` is carried as
  an `id` column and is the key.
- **New ids.** A table whose `id` was `AUTOINCREMENT` in a `memories.db` or `notes.db` gets its next id per agent
  from `memory_sequences` (`agent`, `table_name`, `next`), seeded by the move from the source's `sqlite_sequence`, so
  an id is never reused within an agent, as today. An agent with no row there starts at 1. The knowledge and people
  tables keep SQLite's own `AUTOINCREMENT`, and the move sets their `sqlite_sequence` rows to the source's.
- **`memory_embeddings`** has one row for each row of `vec_memories`: `memory_id` is its `rowid`; `embedding` is its
  384 floats as the 1,536 little-endian bytes `sqlite-vec` returns for the column; `id` is assigned by `loom.db` and
  never reused (`AUTOINCREMENT`); `model` is the embedding model the program is configured with at the move. A vector
  that is not 1,536 bytes stops the move.
- **Receipts are carried, not copied.** For each row of `mind_operation_receipts` and `memory_command_receipts` that
  has not expired, the move saves an `operation_results` row with the value the operation's `recover` hook would
  return for it today, with the receipt's own expiry, unless `loom.db` already has a row for that caller and id. A
  retry of that command after the move is then answered from that row and writes nothing.
- **Left behind, on purpose:** `memory_command_preparations` (a reservation is a command that took no effect);
  expired receipts; `mind_source_migrations`, `memory_command_schema`, `memory_card_schema` (the files' own version
  records); `person_account_sightings` and `person_sighting_aliases` in a `memories.db`, which must be empty; and the
  conversation tables an older `memories.db` still has, which `docs/migration-plan.md` already leaves to the offline
  importer. They stay in the renamed source.
- **Anything else stops the move.** A source table that is in neither list, or a left-behind table that must be empty
  and is not, refuses the start and names the table.

## The index

`memory_embeddings` in `loom.db` is the record. `memory-index.db`, beside `loom.db`, holds one `vec0` table whose
`rowid` is `memory_embeddings.id`, and one single-row table with the model name, `indexed_through`, `vectors` (a
count) and `digest`.

- `loom.db` has a counter, `memory_embedding_changes`, raised by one in each transaction that inserts, updates or
  deletes in `memory_embeddings`.
- A Memory write commits in `loom.db` first. The program then applies the same change to the index and sets
  `indexed_through` to the counter and `vectors` to the number of rows in `memory_embeddings`, in one transaction in
  the index file.
- The index is **level** when the file opens, names the configured model, `indexed_through` equals the counter and
  `vectors` equals the number of rows in `memory_embeddings`. The program checks this before every vector query. At
  start it checks that and one thing more: `digest` equals the `sha256` over every `memory_embeddings` row's `id` and
  `embedding` in `id` order. An index that is not level is deleted and built whole from `memory_embeddings`, with its
  `digest`. That is the only repair. No embedding is computed during it.
- The index is first built at the start that moves phase 3, after the phase commits and before anything is served.
- A row whose `model` is not the configured model makes every vector query fail with a message that names both.
  Changing the embedding model is not built today and is not built here.
- Recall, duplicate search and audit ask the index for nearest rows, join them to `memory_embeddings` for `agent` and
  `memory_id`, drop every row that is not the asking agent's, and ask for more, as recall does today, until they have
  the number they need or the index has no more. Every other column is read from `loom.db`.

## The move

The move is code, because a schema step cannot read another file. It is the second code-driven rewrite at start, so
by `docs/accepted-tradeoffs.md` ("One rewrite of stored rows runs at start") it gets a table that records what ran,
and that entry is updated to say so.

**`memory_moves`** in `loom.db`: `phase` (1 to 4, primary key), `moved_at`, `before_copy` (the name of the copy of
`loom.db` this phase can be undone to, or null), and `sources`, JSON: for each source its path relative to the home
and either `absent: true` or its `sha256`, its `renamed_to`, and the number of rows copied into each `loom.db` table.
A phase with a row has moved.

A household created by a program that has a phase is **born moved** for it: the installation SQL inserts that phase's
`memory_moves` row with `moved_at` the time of installation, a null `before_copy` and no sources, and no Memory file
of that phase is ever created.

**Names.** Everything the move creates has a fixed name, so a start can tell what an earlier one left:
`<home>/memory-move/<phase>/` for working copies; `loom.db.before-upgrade-<n>` for a copy of `loom.db` taken at schema
number n, and that name with `.partial` while it is being written; `<source name>.moved-<phase>` for a renamed source.

**A phase's sources** are: phase 1, the knowledge file; phase 2, the people file; phase 3, `agents/<id>/memories.db`
for every row in `agents`; phase 4, `agents/<id>/notes.db` for every row in `agents`. A Memory file in a directory
under `agents/` that has no row in `agents` is not a source. It is never read, and each start prints its path.

At every start, under the home lock and before anything is served:

**Before the schema steps.** Let n be `loom.db`'s schema number. If this release has a phase with no `memory_moves`
row (or the table does not exist yet) and schema steps are pending: delete any `.partial`; delete
`loom.db.before-upgrade-<n>` if it exists, since `loom.db` is still at n and may have been written since that copy was
taken; then copy `loom.db` there by SQLite's online backup, written as `.partial`, synced, renamed, and its directory
synced. If no schema step is pending, nothing is copied: an earlier start of this release took the copy and upgraded
the schema, and nothing has been served since.

**Then the schema steps**, as today. Each phase's step creates that phase's empty tables.

**Then, for each phase in order:**

*If the phase has a row.* Delete `memory-move/<phase>/` if it exists. For each of its sources that is not `absent`:
if a file is at the source's old path, take its `sha256`. Equal to the row's means the server stopped between commit
and rename: rename it now. Different refuses the start and names the file. A file at the old path of an `absent`
source also refuses the start. An agent added after the phase moved has no entry, and a file found at its path
refuses the start too: a Memory file exists for data that lives in `loom.db`.

*If it has no row*, the phase runs:

1. **Clear.** Delete `memory-move/<phase>/` if it exists: it is what a failed attempt left. If any
   `<source name>.moved-<phase>` exists, refuse.
2. **Expect.** Every source of the phase must exist as a regular file whose real path is inside the home, with no
   `-journal` file beside it. A missing source refuses the start, unless `program.json` lists its path relative to
   the home under `memory.moveWithout`; a listed source that does exist also refuses. A source outside the home refuses the start:
   the owner stops the older release, moves the file into the home, corrects `program.json`, and starts again.
3. **Settle.** Open each source and run `PRAGMA wal_checkpoint(TRUNCATE)`, then close it. Its `-wal` file must now be
   absent or empty, or the start is refused. Take the `sha256` of the main file. This is the one write of Rule 4.
4. **Copy.** Copy each source to `memory-move/<phase>/<relative path>` by online backup from a connection opened
   read-only with `immutable=1`.
5. **Prepare the working copies.** Each is upgraded to the newest file version by the code that prepares a Memory
   file at start today, which from this release on lives in the move's module. Then `PRAGMA integrity_check` and
   `PRAGMA foreign_key_check` must be clean. A copy newer than the program knows, or failing either, refuses.
6. **Move, in one `loom.db` transaction** with `synchronous = FULL`. Each working copy is opened read-only (with
   `sqlite-vec` loaded for a `memories.db`). Every row of every moved table is inserted, receipts are carried, and
   the sequences are seeded.
7. **Verify, inside that transaction.**
   - For every source and moved table, read the rows back from `loom.db` and from the working copy, in primary-key
     order, `agent` left out. They must be the same number of rows with the same `sha256`, taken over each row as its
     columns rendered by SQLite's `quote()` and joined with commas, rows joined with newlines. For
     `memory_embeddings` the columns compared are `memory_id` against `rowid` and `embedding` against the vector's
     bytes; `id` and `model` are left out.
   - Every unexpired source receipt has its `operation_results` row. Every sequence is at least the greatest id in
     its table.
   - `PRAGMA foreign_key_check` on `loom.db` is clean.
   - Each source's `sha256` is taken again and equals step 3's.

   Any failure rolls back and refuses the start, naming the table or file.
8. **Record and commit.** The phase's `memory_moves` row. `before_copy` is the `loom.db.before-upgrade-<n>` with the
   greatest n that exists.
9. **Rename and clean.** After the commit returns: for each source, take its `sha256` once more; if it equals the
   row's, rename it to `<source name>.moved-<phase>` and sync the directory; if not, refuse the start and name it.
   Then delete `memory-move/<phase>/`.

A start that is refused or killed in steps 1 to 8 leaves `loom.db` without the phase and every source holding what it
held. The next start begins the phase again from step 1 by itself; nobody has to delete anything. If the cause was a
bad row or a damaged file, it is refused again with the same message.

Every release that has a phase keeps the move code for that phase and all earlier ones. A household that skips
releases runs its pending phases in order in one start, each as above, and they share one `before_copy`, also when
the start is killed between two of them and finished by the next.

**What the owner does about a refusal.** The message names the file or table and one of these:

| Refusal | What it means | What to do |
| --- | --- | --- |
| A file is at a moved source's old path, or at the path of an agent added later | Something put a Memory file back after its data moved. `loom.db` is right. | Rename the file aside, to a name that does not end in `.db`, and start. |
| `loom.db` or a file beside it is not mode 0600 | The household database is readable more widely than the Memory files were. | Correct the mode and start. |
| A source is missing, outside the home, or has a `-journal` | The files are not where the program expects them. | Restore or move the file; or, for a file known to be gone, list it in `memory.moveWithout`. |
| A source fails a check, has an unknown table, has sighting rows in an agent's file, or a vector of the wrong size | The file holds something this move was not written for. | Nothing the owner can fix. The phase is held. Stay on, or go back to, the release before it, and report it. |

After phase 2, the `bridge_person_sightings` queue is filed by the routine that files it today, now writing
`directory_account_sightings` and deleting the queued row in one `loom.db` transaction. The move itself does not
touch the queue. Dropping the queue's table is a later schema step and not part of this spec.

## Phases

Each phase is one release. The readers and writers of a phase's tables switch to `loom.db` in the same change as its
move. Each script listed under "What is true today" is rewritten to go through the running program's door in the
first phase that moves a file it opens (open decision 5).

1. **Knowledge.** The `mind.knowledge*` operations and the `memoryKnowledge*` fields.
2. **The directory.** The people file and the sightings queue. `mind.personAdd` still writes the agent's half to
   `memories.db`, so it stays two commits until phase 3.
3. **Memories and cards.** Every `memories.db`, the index, and one commit for `mind.personAdd`.
   `docs/accepted-tradeoffs.md` loses "A new person is two commits, not one".
4. **Notes.** Every `notes.db`. The nightly note sweep becomes one transaction on one file.

After phase 4, a further change removes what serving no longer uses: the start-time preparation call, the per-file
connections, the receipt and recovery code. `program.json`'s `memory.sources` is still accepted and ignored. It
updates `docs/architecture.md`, `docs/data-schema.md`, `CONTEXT.md` ("Context directory" no longer holds the stores)
and the contract tests that pin the file layout.

## Not in this spec

The joins are the point and they are the next spec: a table that says which ticket, project or person a memory, note
or page is about; serving Memory tables as query tables with visibility rules of their own; and the bricks in
`docs/specs/boards.md` that read them. Also not here: encrypting Memory at rest; a backup that acts on
`household.backup_target`; moving the identity pages into the database; per-table live invalidation.

## What is given up

- **An agent is no longer moved by copying its directory.** `CONTEXT.md` says "Portable — move it and the agent
  moves". After phase 3 that is false. Moving an agent needs an export and an import, which this spec does not
  build. Until they exist, an agent cannot be moved between households.
- **Going back loses everything since, and undoes every later phase.** The way back is by hand and nothing in the
  program does it. To undo phase N: stop the server; delete `loom.db`, `loom.db-wal` and `loom.db-shm`; copy (not
  move) phase N's `before_copy` to `loom.db`; rename back the source of every phase whose `before_copy` is that file
  or a later one; delete `memory-index.db` and `memory-move/`; and run the release that writes the schema number in
  that copy's name. Every write of any kind made since that copy is lost, not only Memory's.
- **Every copy of `loom.db` now carries every agent's memories and notes.** Whoever is handed `loom.db`, or a backup
  of it, is handed all of Memory. Before, the files could be handed over apart.
- **A file lost before the move is not noticed.** Releases before a phase recreate a missing Memory file as empty at
  every start. If a file was lost and recreated that way, the move sees an empty source and moves it. Rule 6 covers
  only a file missing at the start that moves it.
- **The model label is assumed.** A `memories.db` does not record which model made its vectors, so the move labels
  them with the configured one, as the program assumes today.
- **The first start of a phase serves nothing until the phase has moved**: the copy, the insert, the read-back and
  the hashes all run before the door opens.
- **A household that skips releases can be stranded.** If phase 3 is refused after phases 1 and 2 moved in the same
  start, that release will not start, and the only way to serve again is the way back above.
- **A Memory file in a directory with no `agents` row never moves.** After phase 4 nothing in the program reads it.
- **Changing the embedding model stays unbuilt**, and after phase 3 a changed setting stops vector search with a
  message until it is set back.
- **Old conversation tables in an older `memories.db` leave the live system.** They stay in the renamed source for
  the offline importer.
- **A household whose commons files are outside its home must move them in by hand** before starting a phase 1 or 2
  release.
- **`loom.db` grows** by the size of the stores. The owner's `memories.db` is 52 MB and `notes.db` 44 MB on
  2026-11-26. A start compares the schema's shape, not the rows, so an ordinary start does not slow with it; a start
  after phase 3 also hashes every embedding once.
- **The index can lag by one write after a crash** and is then rebuilt whole before the next vector query.
- **The household is partly moved between phases**, for as long as it runs a release between them.
- **Disk.** A phase needs room for a working copy of each source and a copy of `loom.db`. Renamed sources and copies
  of `loom.db` are kept until a person deletes them.

## Checks

Each phase's suite builds its sources with the code that makes them today, at the newest file version and at the
oldest version today's start can still upgrade, with rows in their `-wal` files, fills them, and runs a start.
"Killed at" means the suite stops the process at the named point and starts again. "Held" means: `loom.db` has no
row from any source of the phase and no `memory_moves` row for it, and every source is at its old path and returns
the same rows to a read-only reader as before the first start.

**What moved**

1. Every source row is in `loom.db`: equal counts per table and, row by row, equal values in every column. For a
   source at an older file version, the comparison is with what today's start-time preparation makes of a separate
   copy of that source. The suite compares them itself and does not use the move's own digest.
2. Every `<agent>:<uuid>`, `<agent>:<slug>`, `commons:<slug>`, page slug and note path that resolved before resolves
   after to the same content, and every revision, supersession, citation and card reference returns the same target.
3. With the same slug, note path and integer ids in two agents' sources, both agents' rows are present and each
   agent's reads and operations return only its own.
4. For every table that had `AUTOINCREMENT`, in all four kinds of source: the next row written after the move gets an
   id greater than every id its source ever issued, including deleted ones. An agent added after phase 3 gets id 1.
5. An unexpired receipt in a source: retrying that command after the move writes nothing and is answered, until the
   receipt's own expiry. A reservation in a source: retrying that command runs it once.
6. Phase 2: a sighting queued before the start is in `directory_account_sightings`, and the queue is empty, once the
   server is serving and the filing routine has run once.

**The same answers**

7. For each Memory read field and operation of the phase, and for each of these viewers: a household owner; a member
   who has the agent; a member who has another agent; a member with no agent; the agent; another agent; a body of
   the agent working for each kind of member; a caller who is not signed in. The suite runs the read against a
   household still on files and the same household moved, and the results are equal.
8. No moved table is selectable: a query for any of them by table name is refused.
9. A knowledge page written by an operation appears in an open live read of the knowledge field. (Any committed write
   wakes every live read today; nothing new is needed.)

**Nothing lost, nothing widened**

10. After the move every source is at `<name>.moved-<phase>` with the `sha256` in the row, no file whose name begins
    with the source's old name is left at the old path, `before_copy` opens, passes `integrity_check` and is
    recognised at the schema number in its name, and `memory-move/` is gone.
11. Killed at each of: during the copy of `loom.db`; between that copy and the schema steps; during the schema steps;
    steps 3, 4, 5; step 6 after half the rows; step 7; just before
    the commit. Each time the next start, by itself, ends with the phase wholly moved and check 1 passing, and until
    then the phase is held.
12. A source row that breaks a CHECK, a carried receipt that cannot be saved, and a source changed between steps 3
    and 7: the start is refused naming the cause, the phase is held, and a second start refuses the same way.
13. Killed after the commit and before any rename; after renaming one of several sources; and after the renames but
    before the working copies are deleted. The next start renames what is left, deletes the working copies, and
    changes nothing in `loom.db`.
14. Refused before `loom.db` is written, each naming the file or table: a missing source; a source outside the home;
    a source with a `-journal` file; one whose `-wal` is not empty after the checkpoint; one that fails
    `integrity_check` or `foreign_key_check`; one newer than the program; an agent source with a sighting row; a
    source with an unknown table; a vector that is not 1,536 bytes; a `<name>.moved-<phase>` already there; a source
    listed in `memory.moveWithout` that exists; `loom.db` with mode 0644.
15. A missing source listed in `memory.moveWithout` is recorded `absent`, and the phase moves. A source changed after
    the commit and before its rename refuses the start naming it, and is renamed at the next start once the changed
    file has been renamed aside. An unexpired source receipt whose caller and id already have an `operation_results`
    row leaves that row as it was.
16. A second start does nothing. With a phase moved, each of these refuses the start: a file at a moved source's old
    path with another `sha256`; a file at an `absent` source's path; a Memory file at the path of an agent added
    after the phase. A Memory file under `agents/` in a directory with no `agents` row does not refuse, and is
    printed.
17. Starting the phase-4 release on a household that has moved nothing moves all four phases in order with one
    `before_copy`. Killed between phase 2 and phase 3 of that start: phases 1 and 2 stay moved and the next start
    moves 3 and 4.
18. After a hundred starts and a note sweep, every renamed source and every copy of `loom.db` is still there with
    the same bytes. The identity pages and `note-files/` have the bytes they had before the move.
19. Under a umask of 022, every file the program created for the move and the index is mode 0600 and owned by the
    server's user, and every directory 0700.
19a. Going back: after phase N, following "What is given up" to the letter leaves a `loom.db` that is recognised at
    the schema number in the copy's name, every source of phase N and later at its old path returning the rows it had,
    and the copy still in place.
20. From the release that has a phase, a start does not create or upgrade that phase's files: with the phase born
    moved, no such file appears.

**One commit**

21. For each Memory operation whose records have all moved, a failure injected after its effect and before its
    `operation_results` row leaves neither. For `mind.personAdd` in phase 2 and the note sweep in phase 3, today's
    crash tests pass unchanged.
22. Phase 3: a failure injected between a new person's two cards leaves neither.

**The index**

23. For a fixed set of queries, recall returns the same uuids in the same order as against the source.
24. With the index file deleted, with `indexed_through` behind, with `vectors` wrong, and with `loom.db` replaced by
    an older copy whose counter and count happen to match: the index is rebuilt (the last at the next start, the
    others before the next vector query), check 23 still holds, and the embedding model is not called.
25. After `VACUUM` on `loom.db`, check 23 still holds without a rebuild.
26. With two agents whose memories are near each other: recall, duplicate search and audit for one never return or
    name the other's, and recall still returns as many as it would alone.
26a. Removing an agent after phase 3 behaves as it does today and leaves its Memory rows in place.
27. With a `memory_embeddings` row labelled with another model, a vector query fails naming both models.
28. `loom.db` opens and is recognised on a connection without `sqlite-vec`, and the upgrade suite passes with no
    extension loaded.

**Nothing opens a source**

29. From its phase on, a contract test fails if any file under `src/` or `scripts/`, outside the move's own module,
    names that phase's source file or opens a path under `memory.sources`.
30. A household born at the newest number has all four `memory_moves` rows with no sources, creates no Memory file
    in a hundred starts, and passes checks 7 to 9.

## The real move

Not a suite. Before a release with a phase is started on the owner's household:

0. The owner confirms that no other home's `program.json` names this home's knowledge or people file.
1. With the server stopped, the home is copied to another directory, and the copy's `program.json` is edited so that
   every path in it is inside the copy. The move's own refusal of a source outside the home (step 2) is what stops a
   rehearsal from touching the real files if this edit is missed.
2. The release is started on the copy. The counts in `memory_moves` for `memories`, `notes`, `knowledge_pages` and
   `directory_people` are compared with counts taken by hand from the renamed sources, each opened with
   `immutable=1` so that reading it cannot change it.
3. The owner uses the copy: recall, a knowledge page, a person, a note.
4. The real start is done with the owner present. The renamed sources and the copy of `loom.db` are left in place.

Other households get each phase by starting the release. Each phase's release notes say that it moves data, what it
renames, how much disk it needs, and how to go back.

## Open, for the owner

The spec is written to the first answer in each case.

1. **Moving an agent.** Written as: not possible until export and import are built, and they are not built here.
   The other answer adds them after phase 4.
2. **Four releases or one.** Decided by the owner, 2026-11-27: one release. All four phases ship together and run in
   order in one start, each still its own verified move with its own `memory_moves` row, which is the path this spec
   already defines for a household that skips releases. Not yet folded: "Phases" and the checks still speak of a
   release per phase, and "A household that skips releases can be stranded" now describes every household, so the
   way back from a refused later phase has to be designed, not just listed as given up.
3. **How long renamed sources and copies are kept.** Written as: until a person deletes them. The other answer is a
   setting.
4. **`memory.moveWithout`.** Written as: an owner may name a source that is known to be gone, and the phase then
   moves without it. The other answer is no such setting, and a household with a missing file cannot move until the
   file is restored from somewhere.
5. **The scripts that open Memory files.** Written as: each is rewritten to go through the door in the first phase
   that moves a file it opens. The other answer is to delete those nobody runs; the owner says which.
