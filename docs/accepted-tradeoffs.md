# Accepted trade-offs

Things in this program that are real, were looked at, and were left as they are on purpose. Each entry says
what it is, where it is, why it was accepted, and what would change the answer. If you find one of these in
the code and think it is a defect, read its entry first: a reviewer who finds one of these has found a
decision, not an oversight, and the site carries a one-line pointer back here.

Entries are grouped by the part of the program they belong to.

## Credentials

### A sign-in link carries its one-time code in the URL
- Where: `src/core/signin/shared-links.ts` (`makeLink`, `GET`/`POST /login/:code`); printed by `loom signin`
  and `loom-token link`.
- What: the code is the last part of the link's path, so a reverse proxy's access log, a browser's history
  or a terminal's scrollback can hold it.
- Why accepted: a link a person can be handed and open is the whole mechanism. The code is good once, for
  five minutes at most (`LINK_MS`); opening the page spends nothing, redeeming is a POST from that page, and
  the page sends only its origin as referrer. Putting the code in the fragment would need script on a page
  whose policy is `default-src 'none'`.
- What would change it: links that last longer or can be used more than once, or a deployment whose proxy
  logs are read by people who must not be able to sign in.

### The sign-in routes are not registered operations
- Where: `src/core/signin/shared-links.ts` (`sharedSigninLinkRoutes`): `/api/signin/token`,
  `/api/signin/program`, `/api/signin/link`, `/passkeys`, `/logout`, `/login/*`.
- What: these writes do not go through the operation dispatcher, so they have no `may` function and no
  receipt. Each route carries its own gate.
- Why accepted: every one of them answers with a credential (a token, a link, a cookie), and a registered
  write's answer is kept as a retry receipt for thirty days. The gates use the same authentication as every
  other door, refuse program tokens, and are checked before, inside and after the write.
- What would change it: a dispatcher that can run a write without keeping its answer. Then these become
  operations and the gates become `may`.

### A device sign-in's user code stays in the inbox item
- Where: `src/shared-account-signin.ts` (`runtime.signInPage`).
- What: for a provider's device flow, the short code the person types on the provider's page is part of the
  item's words and is not removed when the sign-in ends.
- Why accepted: it is meant to be read by that person, it grants nothing without the half the provider's
  program keeps on the worker, and it is dead when the flow ends. Rewriting an item's words afterwards
  would change what the person's own history says.
- What would change it: a provider whose user code is enough by itself, or stays valid after the flow.

### A pasted sign-in code is in clear for a moment, in two places
- Where: `inbox.answer_text` between the owner's answer and the worker's take
  (`src/shared-account-signin.ts`, `runtime.signInTake`); the `code` file in the relay's private directory
  on the worker (`src/runtime/account-signin-relay.ts`).
- What: the owner hands the code to loom by answering an inbox item, so it is an ordinary answer until the
  worker takes it (one poll, about two seconds), and the owner can read their own answer back in that time.
  After the take it exists only in loom's memory, then in a file only the worker's OS user can read, until
  the provider's program deletes it or the sign-in ends.
- Why accepted: an inbox answer is how a person gives loom words, and a file is how the provider's program
  is given them. The code is a provider's one-time code and is useless without the half that program holds.
- What would change it: an answer kind that never touches the database, or a provider program that reads
  the code from a pipe.

### A taken sign-in code does not survive a restart of loom
- Where: `src/shared-account-signin.ts` (`held`).
- What: once taken, the code is kept in memory for the one worker that took it. If loom restarts before
  that worker has read it, the sign-in fails and has to be asked for again.
- Why accepted: keeping it anywhere durable is what "handed over once" is meant to prevent, and the window
  is one request.
- What would change it: sign-ins failing this way in practice.

### An automated browser is recognised by its own name when nobody said it was one
- Where: `isAgentBrowser` in `src/core/data/authentication.ts`; `startBrowser` in
  `src/core/signin/shared-browser.ts`.
- What: a browser that calls itself HeadlessChrome gets the short session and may not make links or add
  passkeys. One that sends another User-Agent is treated as a person's unless its link was made with
  `loom signin --agent`.
- Why accepted: a link is a member's credential, and whoever is handed one is that member. The limit that
  can be relied on is the one the link's maker sets; the User-Agent check only catches the automation that
  does not hide.
- What would change it: agents being able to ask for links themselves.

### Root keys are readable on disk by their own process
- Where: `push-vapid.json` in the home (`src/core/signin/notification-key.ts`).
- What: the push-signing private key is stored in clear.
- Why accepted: the program has to read it unattended. The file is created exclusively with mode 0600 and
  read through `privateBytes`, which refuses a file that is not this OS user's, has another mode, or has a
  second link. Whoever can read the home as that user already holds the database.
- What would change it: running loom where an OS keyring or a hardware key is available to an unattended
  service.

### Passkey challenges are kept in memory and can be pushed out by a sustained flood
- Where: `src/core/signin/shared-passkeys.ts`.
- What: sign-in challenges live in a set of 1024 that drops its oldest when full. Somebody sending more
  than a thousand requests in the seconds a person's sign-in takes can still make that sign-in fail; a
  restart forgets outstanding challenges.
- Why accepted: the route has to answer strangers, and loom has no rate limiter of its own; a household's
  loom sits behind a proxy or on a private network. Sign-in by link is unaffected.
- What would change it: loom being served to the open internet with nothing in front of it.

## Stored data

### Upgrade step 6 removed three kinds of existing data
- **What.** A household upgraded from schema 5 or earlier lost every stored Discord resume cursor, the
  `outside_effects` table, and each conversation's `job` pointer.
- **Where.** Step 6 of `upgrades` in `src/core/data/database.ts`; `src/core/data/upgrade.test.ts` asserts it.
- **Why accepted.** None of the three was the only copy of anything. A resume cursor is a convenience: without
  one a Discord connection identifies afresh once, and the cursors from before named no credential, which was
  the defect the step closed. `outside_effects` was never written or read. The job working in a conversation is
  the one row in `jobs` that has not ended, so the pointer repeated it.
- **What would change the answer.** A step that removes data a household cannot get back. That needs the
  owner's say first, and a line printed at startup.

### A new person is two commits, not one
- **What.** `mind.personAdd` writes a person's card into two SQLite files (the directory's `people.db` and the
  adding agent's `memories.db`). A refusal or a failure on either side saves neither, but a process crash
  between the two commits leaves the agent's card alone.
- **Where.** `src/pieces/mind/people-actions.ts`; the repair is in `src/backends/people-creation.ts`.
- **Why accepted.** SQLite has no atomic commit across two WAL files. The survivor is harmless and is repaired
  by the next add of the same person, under any operation id: the agent's card is kept as it is and the
  directory card is written. Words that differ from the kept card are refused instead of dropped.
- **What would change the answer.** People moving into one file, or a need for the directory to be complete
  without anyone adding the person again.

### Only `loom.db` and `knowledge.db` are checked for being the right kind of file
- **What.** `memories.db`, `people.db` and `notes.db` are refused when a newer program has changed them (their
  version number in the file header), but a wrong SQLite file at one of those paths is not recognised as
  wrong: the store's tables would be created in it.
- **Where.** `refuseNewerStore` in `src/backends/migrations.ts`, the constructor in `src/notes.ts`; compare
  `recogniseDataSchema` in `src/core/data/database.ts`.
- **Why accepted.** The paths come from `program.json`, which the program writes at first install and nothing
  else chooses. Several modules legitimately make their own tables in `memories.db` first (cards, receipts,
  command bookkeeping), so "a file with other tables in it" is the normal case and "foreign" has no cheap
  definition. The household database, which a person might plausibly point at the wrong file, is recognised
  in full.
- **What would change the answer.** A way to choose these paths by hand, or an importer that writes them.

### The memory and knowledge tables are defined in their own stores, with no pinned shapes
- **What.** `memories`, `pages` and the tables beside them are created by the store that owns them and brought
  up to date by steps that read the file's shape. Nothing compares an upgraded file with a fresh one column by
  column, as `src/core/data/upgrade.test.ts` does for the household database.
- **Where.** `src/backends/sqlite-vec.ts`, `src/backends/migrations.ts`, `src/backends/sqlite-knowledge.ts`.
  `src/core/data/schema.ts` describes `loom.db` and nothing else (`docs/architecture.md`, "Where every table
  lives").
- **Why accepted.** These files predate the household database and already hold people's memories; every
  step is additive, runs whole or not at all, and is covered by `src/backends/migrations.test.ts` and
  `src/backends/upgrade-steps.test.ts`. Each table has one definition now that the script with a second copy
  is gone.
- **What would change the answer.** A step that rebuilds or narrows a table. Pin the shapes before writing one.

### Some household tables are written by more than one module
- **What.** A table has one module that owns its rows' life. A few other modules write single columns of
  those rows, because the column records a fact that is theirs.
- **Where, and whose fact it is.**
  - `inbox.job`, `messages.delivery`, `threads.working`: `src/runtime/jobs.ts`. Which job holds a piece of
    mail, whether it was delivered to a body, and whether a body is working are facts about a job.
  - `inbox.volume`, `inbox.quiet_until`: `src/core/tempo/volume.ts`. Tempo owns how loudly an item is shown.
  - `jobs.title`, `conversations.label`: `src/core/conversations/threads.ts`, the one place a title changes
    (next entry).
  - `inbox.words`, `bridge_sends.text`, `bridge_incoming.text`: `src/core/conversations/private-bridge-words.ts`
    erases the words of private direct messages when they expire, across the three tables that hold them.
  - `tokens.last_used_at`, `sessions.seen_at`: `src/shared-credentials.ts` stamps a credential when it is used.
  - `tokens` (a job body's token): `src/shared-body-enrollment.ts` registers a fingerprint the body made, which
    the issuing function cannot take, under stricter checks than issuing has.
  - `operation_results`: `src/shared-account-signin.ts` deletes, once at start, the receipts of an operation
    that used to keep a one-time code.
  - `approvals.state`, `changes.waiting_on`: `src/shared-work-lifetime.ts` expires an allowed card on the clock.
  - `agents.sprite_version`: `src/desk-sprites.ts`, with the sprite it describes, in one transaction.
  - `bridge_connections` (switched off): `src/apps/household.ts`, when the connection is removed.
  - `agent_run_settings.repository_secret`: `src/shared-secret-commands.ts`, which owns which secrets a house gets.
  - `household.secrets_default`: `src/shared-root.ts`, the settings operation for that one answer.
  - `boxes.last_seen_at`: `src/runtime/machines.ts`, on a machine's report.
- **Why accepted.** Each was read against its owner: none skips a check the owner makes, and each write is in
  the transaction of the fact it records. Routing them through the owner would give every owner a method per
  foreign fact and move no rule.
- **What would change the answer.** A second writer that repeats or skips a rule of the owner (a second copy
  of how a machine is revoked, or of how the approval record is appended to). That is a defect, not this
  pattern: the second writer calls the first.

### A thread's title is kept in three tables
- **What.** `threads.title`, `conversations.label` and `jobs.title` hold the same words.
- **Where.** `src/core/conversations/threads.ts` changes all three together; `src/runtime/jobs.ts` copies the
  title when a job is queued.
- **Why accepted.** Each is read alone on a hot path (the thread list, the conversation list, the jobs list)
  by a visibility predicate that does not join. A finished job keeps the title it ran under, on purpose.
- **What would change the answer.** A second place that changes a title, or a new job state that should
  follow a rename: add it to the list in `threads.ts`.

### An account's usage summary is stored beside the windows it is worked out from
- **What.** `model_accounts.usage`, `usage_read_at`, `resets_at` and `has_room` are derived from
  `model_account_windows`.
- **Where.** `src/runtime/account-windows.ts`. The function that writes the summary is not exported and has
  one caller, the one that records the windows.
- **Why accepted.** Admission reads the summary for every placement and the app shows it; both read one row.
- **What would change the answer.** A second writer of either table.

### Each agent's `memories.db` still has four unused conversation tables
- **What.** `conversations`, `conversation_turns`, `conversation_days` and `conversation_digests` are created
  in every agent's memory file and never read or written. Conversations live in `loom.db`.
- **Where.** `src/backends/conversations.ts`, run by the `conversations` step in `src/backends/migrations.ts`.
- **Why accepted.** An older home's conversations are in these tables, and the move of that data reads them
  (owner's ruling, 2026-11-16).
- **What would change the answer.** The move being done. Then a step drops the four tables.

### Retry receipts are kept in the file whose write they protect
- **What.** There is more than one receipt table: `operation_results` in `loom.db`, `mind_operation_receipts`
  in each memory, knowledge and people file, and `memory_command_receipts` in each `memories.db`.
- **Where.** `src/core/data/operation-results.ts`, `src/pieces/mind/receipt-schema.ts`,
  `src/pieces/mind/semantic-commands.ts`.
- **Why accepted.** A receipt has to commit with the effect it answers for, and these effects are in different
  files. `memory_command_receipts` differs from the other memory table because a memory command reserves its
  id in one short transaction and commits its answer in a later one, around an embedding that takes time.
  `mind_operation_receipts` has one reader and writer.
- **What would change the answer.** Memory moving into the household database.

### The command-line clients and `loom mcp` take the program's address by different rules
- **What.** `loom-taskstore`, `loom-token` and their siblings accept plain `http` to any host. `loom mcp`
  accepts plain `http` only to this machine. All three read the token file the same way.
- **Where.** `src/cli/connection.ts` (`doorUrl`); `bodyOrigin` in `src/runtime/body-bootstrap.ts`.
- **Why accepted.** A household reaches its program over its own network with the command-line clients, and
  that has worked over plain `http`. An MCP session is started by a harness for an agent and carries that
  agent's token on every call.
- **What would change the answer.** The owner deciding either way: the stricter rule for all would refuse a
  plain-`http` address the clients take today.

### `memories.salience` is written and never read
- **What.** Each memory is stored with a `salience` of 1 and the column is not updated afterwards.
- **Where.** `src/backends/sqlite-vec.ts` writes it; `src/backends/salience.ts` works heat out at every read
  (`heatOf`, `hottestIds`) and ignores it.
- **Why accepted.** Dropping a column from every agent's memory file is a step with no gain in behaviour, and
  the stored number went stale whenever its refresh was missed, which is why nothing reads it.
- **What would change the answer.** A read that must rank many memories in SQL. Then store heat again, and
  refresh it where memories are written and recalled.
