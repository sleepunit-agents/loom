# The export: an agent's own records as plain files

*2026-11-26. Status: **draft**, not accepted, and **not clear**. Cold-reviewed three rounds on 2026-11-26: seven critical findings,
then three, then five. It did not converge. After the third round the design was made smaller in three places (the
JSON form is now a published standard, the command only writes a tar, the marker names the agent), and what is still
unsettled is listed under "Known holes". It needs a fresh cold review as the smaller document before it is built. This is a design doc in the `docs/specs/` sense: what loom
builds, and the checks its suites must pin. It is the first of three. The other two, a household backup
([household-backup.md](household-backup.md)) and an import ([agent-import.md](agent-import.md)), are outlines and are
specified after this one.*

## Why

> "we need to solve backup here too for sure. the idea is that each agent can send its own stuff up to a git repo,
> but I was kind of handwaving how that worked for memories and such. feels like we need an export/import to handle
> that stuff" — the owner, 2026-11-26

An agent's memories, notes and cards are rows in SQLite files, one of which has a vector table. A git repository of
those files shows nothing and grows by the whole file on every change. The export writes the same records as a
directory of plain files, the same bytes every time, so a repository of it shows what changed and can be read by a
person.

It has a second use at once. [memory-in-the-household.md](memory-in-the-household.md) moves these records into
`loom.db`. An export taken before a phase of that move and one taken after must be the same bytes, and the export
reads the tables with code of its own that shares nothing with the move.

## Words (to be added to CONTEXT.md)

**Export**:
an agent's own records written as a directory of plain files, the same bytes every time for the same records.
_Avoid_: dump, snapshot, backup (that is the household's)

**The commons export**:
the same for what the household shares: knowledge pages and the people directory.

**Volatile**:
a value that changes when a record is read, not when it is written: when a memory was last recalled and how warm it
is, how often a page was opened. Volatile values are not exported.

**Digest**:
one `sha256` that stands for a whole export.

## Rules

1. **An export is stable.** The same records give the same files with the same bytes, whenever and wherever the
   export is taken. No file holds the time of the export, the machine, the household, or an integer id from the
   database.
2. **Every table is accounted for.** Each table in a Memory store is either exported, in a file this spec names, or
   on the list under "Not exported". A table on neither fails the suite.
3. **A record's change stays in its own files.** Writing to one record changes only that record's own files and the
   list files it has a line in (below). It never changes another record's files.
4. **An export is one picture.** Everything read from one store is read in one read transaction.
5. **An export holds only what is the agent's.** No conversation, message, ticket, secret, token, key, or another
   agent's record. Nothing of the commons is in an agent's export and nothing of an agent's is in the commons export.
6. **An export is whole or it fails.** A record that cannot be written as this spec says stops the export. It is
   never silently short.
7. **Only two callers, and by loom's own rule.** Loom's stated rule for an agent's memories, notes and cards is: "The
   agent itself, the agent's owners, and household owners" (`docs/how-it-works/site/memory.html`), enforced by
   `maySee` in `src/policy.ts`. An agent's export is given to a caller who is that agent itself (a credential of the
   agent, or a body of the agent) or a household owner, **and** who passes `maySee` for a `memory` and for a `person`
   of that agent. The commons export is given to a household owner. A refused call reads nothing and writes no row.
8. **Every row, whatever the clock says.** The export reads each table whole. A row that has passed its `expires_at`
   or its note's lifespan and has not yet been swept is exported like any other, so an export changes only when a row
   is written or removed.

Loom writes the export to a directory and stops there. Committing it and pushing it to a git host is a routine
outside loom, which holds the repository and its credentials.

## The files

### Bytes

- A **`.md`** file is a record's words exactly as stored, byte for byte. Nothing is added, removed or changed,
  including line ends and a missing final newline.
- A **`.json`** file is one JSON value in the **canonical form**, then one LF.
- A **`.jsonl`** file is one canonical value per line, each followed by one LF.
- **Canonical form** is RFC 8785, the JSON Canonicalization Scheme, as it stands: its key order, its string escapes
  and its number form. The suite runs that RFC's own test vectors. Loom defines no JSON form of its own.
- **From SQL.** NULL is `null`, and a key is never left out. TEXT is a string holding the stored text unchanged;
  times and dates are not reformatted. INTEGER and REAL are numbers; `archived` and `pinned` stay `0` or `1`. These
  stop the export: a BLOB in a listed column; a REAL that is not finite; an INTEGER beyond ±(2^53 − 1), which RFC 8785
  cannot carry; and a NULL in a column written as a `.md` file.
- A column that holds JSON text (`metadata`, `card_json`, `snapshot_json`, `counts_json`) is parsed and written as a
  JSON value in canonical form, under the key named below. The export stops if it does not parse, has the same key
  twice in one object, holds a string with an unpaired surrogate, or holds a number that RFC 8785 would not write
  back to the same value: an integer literal beyond ±(2^53 − 1), a literal with more digits than a 64-bit float
  keeps, or one that is not finite.
- A column that holds bytes that are not valid UTF-8 stops the export.

### An agent's export

`<ref>` is a memory's `ref` (`<category>/<slug>-<8 characters>`, unique within an agent). `<path>` is a note's path.

| File | Holds |
| --- | --- |
| `loom-export.json` | `{"agent":"<id>","format":1,"kind":"agent"}` |
| `identity/…` | every regular file under the agent's `IDENTITY.md`, `preferences.md`, `self-model.md`, `harnesses/`, `models/`, `roles/`, `projects/`, `clients/`, at the same relative path, byte for byte. A file or directory whose name begins with `.`, ends `.bak` or contains `.bak-` is left out with everything under it. |
| `memories/<ref>.md` | the memory's `content` |
| `memories/<ref>.json` | `uuid`, `ref`, `title`, `category`, `project`, `metadata`, `created`, `updated`, `ttl`, `expires_at`, `archived`, `archive_note`, `salience`, `sourcing`, `provenance`, `confidence`, `evidence_count`, `observed_at`, `scope`, `times_seen`, `uniq`, `authored_at` |
| `memories/<ref>.history.jsonl` | one line per row of `memory_revisions` for that memory, in `id` order: `content`, `op`, `replaced_at` |
| `proposals/<uuid>.md` | the proposal's `content` |
| `proposals/<uuid>.json` | `uuid`, `category`, `title`, `project`, `ttl`, `metadata`, `source`, `created`, `status` |
| `memory-supersessions.jsonl` | `old_ref`, `new_ref`, `note`, `created`, each as stored in `memory_supersessions`; a ref is kept even when its memory is gone |
| `people/<slug>.json` | `slug`, `name`, `card` (from `card_json`), `archived_at`, `archived_by`, `archive_reason`, `updated`, `synthesized_at` |
| `people/<slug>.history.jsonl` | `person_revisions` for that slug, in `id` order: `snapshot`, `op`, `replaced_at`, `actor` |
| `people-merges.jsonl` | `from_slug`, `into_slug`, `merged_at`, `merged_by`, `counts` |
| `projects/<slug>.json` | `slug`, `name`, `status`, `card`, `archived_at`, `archived_by`, `archive_reason`, `updated`, `synthesized_at`, and `names`: that project's `project_names` rows as `{"kind","name"}`, in order of `name` |
| `projects/<slug>.history.jsonl` | `project_revisions` for that slug, in `id` order: `snapshot`, `op`, `replaced_at`, `actor` |
| `card-references.jsonl` | `uuid`, `kind`, `slug`, each as stored in `memory_card_references` |
| `notes/<path>.note.md` | the note's `body` |
| `notes/<path>.note.json` | `path`, `lifespan`, `pinned`, `created`, `updated`, `by`, and `files`: that note's `note_files` rows as `{"added","bytes","name","sha256","type"}`, in order of `name` |
| `notes/<path>.note.history.jsonl` | `note_revisions` for that path, in `id` order: `body`, `lifespan`, `at`, `by` |
| `note-files/<first two characters of sha256>/<sha256>` | an attachment's bytes, once however many notes name it |

- Archived memories and archived cards are included. They are records.
- A `.history.jsonl` file is in `id` order because that is the order the revisions were made. The `id` is not
  written. A record with no revisions has no history file.
- The other `.jsonl` files (`memory-supersessions`, `people-merges`, `card-references`) are **list files**. Their
  lines are sorted by the bytes of the whole line, so the order is total and needs no id. An empty list file is not
  written.
- No empty directory is written.

### The commons export

| File | Holds |
| --- | --- |
| `loom-export.json` | `{"format":1,"kind":"commons"}` |
| `knowledge/<slug>.md` | the page's `body` |
| `knowledge/<slug>.json` | `uuid`, `slug`, `title`, `domain`, `sourcing`, `provenance`, `status`, `created`, `updated`, `verified_at`, `freshness_anchor`, `sla_class`, `tombstone_note`, `created_by`, `version`, `author` |
| `knowledge/<slug>.citations.jsonl` | `citations` for the page, in `id` order: `claim`, `source_kind`, `source_locator`, `excerpt`, `retrieved_at`, `created` |
| `knowledge/<slug>.annotations.jsonl` | `page_annotations`, in `id` order: `kind`, `actor`, `words`, `evidence`, `created` |
| `knowledge/<slug>.verifications.jsonl` | `verifications`, in `id` order: `verifier`, `verified_at`, `outcome`, `citation_checked` |
| `knowledge/<slug>.replaced.jsonl` | `page_supersessions`, in `revision` order: `revision`, `actor`, `reason`, `evidence`, `created` |
| `knowledge/<slug>.history.jsonl` | `page_revisions`, in `id` order: `slug`, `body`, `op`, `replaced_at`, `actor` |
| `knowledge-supersessions.jsonl` | list file: `old_slug`, `new_slug`, `note`, `created` |
| `directory/<slug>.json`, `directory/<slug>.history.jsonl` | a directory card and its revisions, with the keys of `people/` above |
| `directory-merges.jsonl` | list file, with the keys of `people-merges.jsonl` |
| `directory-sightings.jsonl` | list file: `platform`, `workspace`, `account`, `slug`, `seen_at`, `seen_order`, `label`, `label_order` |
| `directory-aliases.jsonl` | list file: `workspace`, `account`, `slug`, `recipient_display_slug` |

`page_supersessions.revision` is a number the page's own text refers to, not a row id, and is kept.

### Every table and column

**The Memory tables** are, before the memory merge, every table in an agent's `memories.db` and `notes.db`, in the
knowledge file and in the people file; and after it, the tables that
[memory-in-the-household.md](memory-in-the-household.md) lists under "The tables" together with `memory_sequences`,
`memory_embeddings` and `memory_moves`. Nothing else in `loom.db` is a Memory table.

Exported, each to the files above: `memories`, `memory_revisions`, `proposals`, `memory_supersessions`, `people`,
`person_revisions`, `person_merges`, `projects`, `project_revisions`, `project_names`, `memory_card_references`,
`notes`, `note_revisions`, `note_files`; and for the commons `pages`, `citations`, `page_annotations`,
`verifications`, `page_supersessions`, `page_revisions`, `supersessions`, and the people file's `people`,
`person_revisions`, `person_merges`, `person_account_sightings`, `person_sighting_aliases`. After the merge the same
tables under the names that spec gives them.

Not exported:

- **Volatile columns:** `memories.last_accessed`, `recall_heat`, `recall_heat_at`; `pages.last_accessed`,
  `hit_count`.
- **Volatile table:** `knowledge_access`.
- **Worked out again:** `vec_memories` and every table whose name begins `vec_memories_`.
- **Deleted content:** `memory_deletions`. It holds the words of memories that were deleted. Decided 2026-11-27: not exported.
- **Bookkeeping:** `mind_operation_receipts`, `mind_source_migrations`, `memory_command_preparations`,
  `memory_command_receipts`, `memory_command_schema`, `memory_card_schema`, `sqlite_sequence`, and after the merge
  `memory_sequences`, `memory_embeddings`, `memory_moves`.
- **Empty by design:** `person_account_sightings` and `person_sighting_aliases` in an agent's store. A row there
  stops the export.
- **Linking columns:** every `id`, `memory_id` and `page_id`; `memory_revisions.ref`, `person_revisions.slug`,
  `project_revisions.slug`, `project_names.slug`, `note_revisions.path` and `note_files.path`, which the file's own
  path already says; and after the merge every `agent` column.

Every column of every exported table is either written under a key this spec names or is on that list. The agent's
row in `agents`, its settings, its conversations and its tickets are not Memory tables and are not in an export.

### Stops

The export fails, saying what stopped it, when:

- two files would have paths that are equal when lowercased, or one file's path is a directory on another's;
- a `ref`, a slug, a note path, or an identity file's relative path is not made of segments matching
  `[A-Za-z0-9][A-Za-z0-9._-]*`;
- a column is not valid UTF-8, a JSON column fails as said under "Bytes", or a value is one of the SQL stops there;
- an attachment's bytes do not match its row's `sha256` and `bytes`, twice running;
- something kept under the identity paths is not a regular file or a directory;
- an agent's store has a sighting row;
- a Memory table is neither exported nor on the list, or an exported table has a column that is neither.

### The digest

For every file in the export, one line: the file's `sha256` in lowercase hex, two spaces, the file's path with `/`
between segments, one LF. The lines are sorted by the bytes of the path. The digest is the `sha256` of those lines,
in lowercase hex. It is what `sha256sum` prints for the output of `sha256sum` over the files in that order.

## How it is taken

**The door.** `POST /agents/<id>/export` and `POST /commons/export`, with an empty body.

1. The caller is checked (rule 7). Anyone else is refused; nothing is read and no row is written.
2. The files are built under `<home>/export-work/<random>/`, directories mode 0700 and files 0600.
   - Before the memory merge, an agent's export reads `memories.db` in one read transaction and `notes.db` in
     another; the commons export reads the knowledge file in one and the people file in another. After the merge
     each export is one read transaction on `loom.db`.
   - Attachments and identity pages are read from disk after the transactions. An attachment that fails its check
     may be one a note lost a moment ago, so the whole export is built once more from the start. A second failure
     stops it.
3. The digest is taken, and one row is written to `exports` in `loom.db`: `kind`, `agent` (null for the commons),
   `at`, `caller_kind` (`agent` or `member`), `caller` (its id), `outcome` (`built` or `failed`), and `files`,
   `bytes`, `digest` (null on failure) or `reason` (null when built). A failed export answers with the reason and no
   files. `exports` is readable by household owners only.
4. The answer is a pax tar of the files, with the digest in the `loom-export-digest` response header. The tar is
   only a way to carry the files: its order, times and owners mean nothing.
5. `export-work/<random>/` is deleted when the answer has been sent or has failed. At start, `export-work/` and
   everything in it is deleted.

**The command.** `loom agent export --url <origin> --token-file <file> --agent <id> --out <file>` and
`loom commons export --url <origin> --token-file <file> --out <file>`.

The command writes one tar and nothing else. It does not unpack, and it does not manage a directory.

1. It refuses if `<file>` exists.
2. It writes the answer to `<file>.partial`, mode 0600.
3. It reads the tar back: every entry must be a regular file at a path this kind's format can write, and the digest
   of the entries must equal the header's. Otherwise `<file>.partial` is deleted and the command fails.
4. It renames `<file>.partial` to `<file>`, and prints the number of files, their bytes, and the digest.

A leftover `<file>.partial` from a killed run is overwritten by the next. Putting the files in a repository is the
routine's, and it is four lines: make an empty directory, unpack the tar into it, replace the repository's export
directory with it, commit. Git sees the same files whichever way they arrived.

The Setup page shows household owners, for each agent and for the commons, the newest `exports` row: when, its
outcome, and for a failure its reason. Nobody else is shown it.

## What is given up

- **Git keeps what loom forgets.** A memory that is deleted, a note that expires, a card that is archived and later
  removed: its file leaves the export and stays in the repository's history. Removing something for good means
  rewriting that history by hand.
- **The export is plain text; what goes to a git host is not.** The directory this spec defines is plain files on
  the household's own machine. Before any of it leaves that machine it is encrypted with age (decided 2026-11-27,
  below), so a repository shows which records changed and when, and never their words.
- **Deleted memories are not in it.** An agent rebuilt from an export has no record of what it deleted.
- **Volatile values are not in it.** An agent rebuilt from an export starts with every memory cold.
- **JSON columns are not kept byte for byte.** `metadata` and the cards are written in canonical form, so spacing and
  key order inside them are not the stored text's. Their values are the same.
- **An agent's settings and conversations are not in it.** They are the household's and are in its backup.
- **One bad record stops the whole export**, and the only signs are the command's failure and the Setup page.
- **The two callers get everything.** No single read field today returns an agent's whole history, its proposals
  and its archived cards at once. The export does, to the same two callers loom's rule already names.
- **A `built` row is not a pushed repository.** Loom knows it built an export. It does not know whether the command
  unpacked it, or whether anything was committed or pushed, and a directory left by a failed run carries no mark of
  its age.
- **Loom does not look after the repository's directory.** Unpacking, replacing and committing are the routine's.
- **Identity pages are exported as they are at that moment**, not inside a read transaction.
- **The whole export is built on disk before it is sent**, so it needs that much room in the home, each time.
- **A full export every time.** Nothing is incremental.

## Checks

The suites build stores with the code that makes them today and fill every exported table, with history, archived
records, expired rows not yet swept, attachments shared by two notes, non-ASCII words, words with CRLF and with no
final newline, and JSON columns with odd spacing.

1. **Stable.** The same store files are exported twice: once as they are, and once copied to a second home whose
   clock is a year later and whose time zone and locale differ. The two exports are byte-identical with one digest.
   The same for the commons.
2. **Complete.** For every exported table the suite reads the store itself and finds every row, and every listed
   column's value in the named file under the named key, in the form "Bytes" gives. Every `.md` file equals its
   column byte for byte.
3. **Accounted for.** The suite lists every Memory table and every column of each exported table from the stores
   themselves, and fails on a table that is neither exported nor listed, and on a column that is neither written nor
   listed. Run against a store with one extra table, and one with one extra column, the export itself also stops.
4. **Own files.** For each of these, every file that changes belongs to the record written or is a list file:
   editing a memory's content; superseding it; attaching a file to a note (plus one file under `note-files/`);
   editing a person card; annotating a knowledge page. No other record's file changes.
5. **Not volatile.** Recalling a memory, opening a knowledge page and reading a note change no file in either
   export. Moving the clock past a memory's `expires_at` changes no file until the row is removed.
6. **Only its own.** With another agent's memory, note and card, a knowledge page, a directory card, a ticket, a
   message, a secret and a token in the household, each holding a marker string: no marker is in any file of the
   agent's export, and no agent's marker is in the commons export.
7. **Who may.** The agent's own credential, a body of the agent, and a household owner get an agent's export. A
   member who has the agent but is not an owner, another agent, that other agent's body, and a caller who is not
   signed in are refused, and no `exports` row is written for them. Each caller who gets the export also passes
   `maySee` for that agent's `memory` and `person`; with `maySee` stubbed to refuse, a household owner is refused.
   Only a household owner gets the commons export, reads `exports`, or is shown the Setup rows.
8. **One picture.** A write that commits while an export is being built is wholly in it or wholly absent, for a
   memory with its revision and for a note with its attachment.
9. **Stops.** Each fails saying what stopped it, writes a `failed` row with null `files`, `bytes` and `digest`, and
   answers with no files: two note paths equal when lowercased; a note `a` beside a note `a.note.md/b`; a slug with a
   space; an identity file named with a newline; an attachment whose bytes do not match its row, twice running; a
   column with invalid UTF-8; a `metadata` that does not parse, one with a repeated key, one with 2^60, and each of
   `card_json`, `snapshot_json`, `counts_json` not parsing; a BLOB in `title`; a symlink and a socket under the
   identity paths; a sighting row in an agent's store. An attachment that fails once and passes on the second build
   gives a whole export.
10. **Canonical form.** RFC 8785's published test vectors pass. Also, for the record of what round 3 asked: `{"b":1.0,"a":[0.1,-0.0,1e21,0.0000001,null,"",{}],"é":"é\u0001\"\\","n":9007199254740991}`
    in a `metadata` column is written as
    `{"a":[0.1,0,1e+21,1e-7,null,"",{}],"b":1,"n":9007199254740991,"é":"é\u0001\"\\"}`. A SQL INTEGER of
    9223372036854775807 in `times_seen` is written in full.
11. **The digest.** The digest in the header, the one the command prints, the one in the `exports` row and the one
    `sha256sum` gives over the unpacked files are equal.
12. **The command.** It writes a tar whose entries, unpacked, are exactly the export's files with the printed
    digest. It refuses an `--out` that exists. An answer in which one byte of one file's content was changed, and
    answers holding a symlink, an absolute path, a `..` path and a path outside the format, each fail and leave no
    `<file>` and no `<file>.partial`.
13. **Killed.** Killed while writing, the next run writes a whole `<file>`.
14. **Nothing left in the home.** After a built export, a failed one, and a killed server's next start, no
    `export-work/<random>/` remains. While one exists its files are mode 0600.
15. **Across the memory merge.** Before the merge and after each of its four phases, the agent's and the commons'
    digests are unchanged. This check is also added to that spec.

## Known holes

Found by the third cold review and not yet settled. Each needs a decision or a measurement before this is built.

1. **Rows whose parent is gone.** A revision, a note file, a citation or a card reference whose record has been
   deleted: written, dropped, or a stop? If revisions outlive a deleted memory, exporting them is settled by decided 2:
   it is not written.
2. **A revision's own ref or slug.** The spec leaves out `memory_revisions.ref`, the revisions' `slug` and
   `note_revisions.path` as "said by the file's path". That holds only if they always equal the record's current one.
   Not measured.
3. **The grammar of a path the format can write** is given by example, not as a pattern, for `<ref>`, `<uuid>`,
   `<sha256>` and `identity/…`. `proposals.uuid` and `note_files.sha256` are used as path segments and are not yet
   among the values that stop an export when malformed.
4. **What each caller could read before.** Rule 7 rests on `maySee` for `memory` and `person`. It is not yet shown
   which check covers notes, attachments, project cards, proposals and the identity pages, or that a household owner
   passes it for each. Nor is a stated rule cited for the commons export, which hands an owner all page history, the
   directory's sightings and its aliases at once.
5. **One picture, before the merge, is two.** An agent's export reads `memories.db` and `notes.db` in separate read
   transactions. A write that touches both between them is half in.
6. **Rules with no check yet:** identity pages exported byte for byte and the leave-out rule; no empty list file, no
   history file for a record with none, no empty directory; the stops for a non-finite REAL, a NULL words column, an
   unpaired surrogate and a malformed ref; directory mode 0700; the values in an `exports` row; which `caller_kind` a
   body records.
7. **A note's attachment is no record's own file**, so rule 3 and check 4 disagree about it.
8. **Refused calls leave no record**, so a caller who is not entitled can probe unseen.

## Decided by the owner, 2026-11-27

1. **Encrypted with age before it leaves the machine**, to the household's backup recipients, the same keys the
   offsite backup already uses (`bin/loom-new-backup offsite` in ~/Art, and `src/backup.ts` in the older program).
   Not yet designed, and it must be before this is built: age output differs on every run, so encrypting the whole
   directory each time would make every file change in every commit. The shape to design is one age file per export
   file, rewritten only when that file's plain bytes changed, with the plain digests kept in a list that is itself
   encrypted. The digest in this spec stays a digest of the plain bytes.
2. **Deleted memories are not exported.** "Deleted memories are deleted, they don't need to come along."
   `memory_deletions` stays out. Known hole 1 is narrowed by this: a revision of a deleted memory is not written.

## Open, for the owner

The spec is written to the first answer in each case.

1. **Who commits and pushes.** Written as: a routine outside loom, per agent. The other answer is a loom setting per
   agent (a repository and a schedule), with loom holding the credentials.
2. **Members who have the agent.** Written as: they do not get its export; only the agent and household owners do.
   The other answer gives it to any member who can read the agent's memories today.
