import { DAY_MS } from '../day.js';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { getTableName } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { polymorphicReferences, schema } from './schema.js';

/** Bind the one schema to an already-initialised connection; does no IO itself. */
export function dataDatabase(client: Database.Database, now: () => string = () => new Date().toISOString()) {
  client.function('loom_now', now);
  return drizzle(client, { schema });
}
export type DataDatabase = ReturnType<typeof dataDatabase>;

/** Bootstrap a NEW database. This is deliberately not a migration or an importer.
 * Refuse any existing schema, including an interim rebuild database. The separate
 * real-data move owns upgrading existing homes and preserving precious memories.
 */
export function createDataSchema(client: Database.Database, now: () => string = () => new Date().toISOString()): DataDatabase {
  if (client.inTransaction) throw new Error('Create the data schema outside a transaction');
  client.pragma('foreign_keys = ON');
  client.transaction(() => {
    const existing = client.prepare("SELECT name FROM sqlite_schema LIMIT 1").get();
    if (existing) throw new Error('Data schema requires an empty database; existing data must go through the separate move');
    client.exec(readFileSync(new URL('../../../assets/data/schema.sql', import.meta.url), 'utf8'));
    const mark = client.prepare('INSERT INTO migrations (number, applied_at) VALUES (?, ?)');
    for (let number = 1; number <= dataSchemaNumber; number++) mark.run(number, now());
  })();
  return dataDatabase(client, now);
}
/** The guards on a member-or-agent kind and id pair, as the installation SQL had them when step 6 was written. */
function kindAndIdGuards(table: string, kind: string, id: string): string[] {
  const guards: string[] = [];
  for (const [tag, parent] of [['member', 'members'], ['agent', 'agents']]) {
    for (const event of ['INSERT', 'UPDATE']) guards.push(`CREATE TRIGGER "${table}_${id}_${tag}_${event.toLowerCase()}" BEFORE ${event} ON "${table}" WHEN NEW."${kind}" = '${tag}' AND NEW."${id}" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "${parent}" WHERE id = NEW."${id}") BEGIN SELECT RAISE(ABORT, 'polymorphic foreign key failed'); END`);
    guards.push(`CREATE TRIGGER "${table}_${id}_${tag}_parent_delete" BEFORE DELETE ON "${parent}" WHEN 1 AND EXISTS (SELECT 1 FROM "${table}" WHERE "${id}" = OLD.id AND "${kind}" = '${tag}') BEGIN SELECT RAISE(ABORT, 'polymorphic foreign key failed'); END`);
    guards.push(`CREATE TRIGGER "${table}_${id}_${tag}_parent_update" BEFORE UPDATE OF id ON "${parent}" WHEN OLD.id <> NEW.id AND EXISTS (SELECT 1 FROM "${table}" WHERE "${id}" = OLD.id AND "${kind}" = '${tag}') BEGIN SELECT RAISE(ABORT, 'polymorphic foreign key failed'); END`);
  }
  for (const event of ['INSERT', 'UPDATE']) guards.push(`CREATE TRIGGER "${table}_${id}_pair_${event.toLowerCase()}" BEFORE ${event} ON "${table}" WHEN NOT coalesce(((NEW."${id}" IS NULL AND NEW."${kind}" IS NULL) OR (NEW."${id}" IS NOT NULL AND NEW."${kind}" IN ('member', 'agent'))), 0) BEGIN SELECT RAISE(ABORT, 'polymorphic reference pair failed'); END`);
  return guards;
}
/** The two lines loom itself wrote into a job's log_tail before step 7 gave them a column of their own. */
const loomsOwnLine = "((state = 'lost' AND log_tail LIKE 'Lost while %: its worker stopped reporting') OR (exit_code = 31 AND log_tail LIKE 'Never started: no machine took it within % hours'))";
/** Changes to an existing household's database since its first shape, in order. Number 1 is the
 * first shape itself. A fresh database is created whole and marked as having them all. */
const upgrades: readonly (readonly string[])[] = [
  // 2: removing a member, agent, project or bridge connection keeps the row and its history.
  ['members', 'agents', 'projects', 'bridge_connections'].map(table => `ALTER TABLE ${table} ADD COLUMN removed_at text CHECK (removed_at is null or coalesce(strftime('%Y-%m-%dT%H:%M:%SZ', removed_at) = removed_at or strftime('%Y-%m-%dT%H:%M:%fZ', removed_at) = removed_at, 0))`),
  // 3: what a trigger said before each edit, and who made it.
  [`CREATE TABLE trigger_edits (
	seq integer PRIMARY KEY NOT NULL,
	trigger text NOT NULL,
	at text NOT NULL,
	by_kind text NOT NULL,
	by text NOT NULL,
	before text NOT NULL,
	FOREIGN KEY (trigger) REFERENCES triggers(id) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "trigger_edits_at_utc" CHECK("trigger_edits"."at" is null or coalesce(strftime('%Y-%m-%dT%H:%M:%SZ', "trigger_edits"."at") = "trigger_edits"."at" or strftime('%Y-%m-%dT%H:%M:%fZ', "trigger_edits"."at") = "trigger_edits"."at", 0)),
	CONSTRAINT "trigger_edits_by_kind_choice" CHECK("trigger_edits"."by_kind" in ('member', 'agent'))
)`,
  // Written exactly as the fresh schema writes it: startup compares an index's text.
  'CREATE INDEX `trigger_edits_trigger_idx` ON `trigger_edits` (`trigger`)'],
  // 4: a lane can say what kind of model it should run on.
  ['ALTER TABLE triggers ADD COLUMN wants_model text'],
  // 5: asking a worker machine to sign a model account in. Both statements are the fresh schema's own text.
  ["CREATE TABLE `account_signins` (\n\t`id` text PRIMARY KEY NOT NULL,\n\t`account` text NOT NULL,\n\t`box` text NOT NULL,\n\t`asked_by_kind` text NOT NULL,\n\t`asked_by` text NOT NULL,\n\t`state` text NOT NULL,\n\t`item` text,\n\t`why` text,\n\t`asked_at` text NOT NULL,\n\t`changed_at` text NOT NULL,\n\tFOREIGN KEY (`account`) REFERENCES `model_accounts`(`id`) ON UPDATE no action ON DELETE no action,\n\tFOREIGN KEY (`box`) REFERENCES `boxes`(`id`) ON UPDATE no action ON DELETE no action,\n\tCONSTRAINT \"account_signins_asked_at_utc\" CHECK(\"account_signins\".\"asked_at\" is null or coalesce(strftime('%Y-%m-%dT%H:%M:%SZ', \"account_signins\".\"asked_at\") = \"account_signins\".\"asked_at\" or strftime('%Y-%m-%dT%H:%M:%fZ', \"account_signins\".\"asked_at\") = \"account_signins\".\"asked_at\", 0)),\n\tCONSTRAINT \"account_signins_changed_at_utc\" CHECK(\"account_signins\".\"changed_at\" is null or coalesce(strftime('%Y-%m-%dT%H:%M:%SZ', \"account_signins\".\"changed_at\") = \"account_signins\".\"changed_at\" or strftime('%Y-%m-%dT%H:%M:%fZ', \"account_signins\".\"changed_at\") = \"account_signins\".\"changed_at\", 0)),\n\tCONSTRAINT \"account_signins_asked_by_kind_choice\" CHECK(\"account_signins\".\"asked_by_kind\" in ('member', 'agent')),\n\tCONSTRAINT \"account_signins_state_choice\" CHECK(\"account_signins\".\"state\" in ('asked', 'started', 'waiting', 'done', 'failed'))\n)",
   "CREATE INDEX `account_signins_box_state_idx` ON `account_signins` (`box`,`state`)"],
  // 6: one step for several changes. It removes three kinds of existing data; why that was accepted
  // is in docs/accepted-tradeoffs.md.
  [
    // A browser remembers which passkey signed it in, so removing the passkey can end it.
    'ALTER TABLE sessions ADD COLUMN passkey text REFERENCES passkeys(id)',
    // What admission read from the platform event, so a held message can be tried again from its own row
    // after the raw event has expired. All absent on a row from before this step.
    ...['mentions text', 'replies_to text', 'parent text',
      ...['group_dm', 'bot', 'webhook'].map(name => `${name} integer CHECK (${name} in (0, 1))`)].map(column => `ALTER TABLE bridge_incoming ADD COLUMN ${column}`),
    // The Discord resume cursor now names the credential it was made under. A cursor from before does not,
    // so it is forgotten: each Discord connection identifies afresh once.
    'DROP TABLE bridge_resume',
    "CREATE TABLE `bridge_resume` (\n\t`connection` text PRIMARY KEY NOT NULL,\n\t`session` text NOT NULL,\n\t`sequence` integer NOT NULL,\n\t`resume_url` text NOT NULL,\n\t`identity` text NOT NULL,\n\tFOREIGN KEY (`connection`) REFERENCES `bridge_connections`(`id`) ON UPDATE no action ON DELETE no action\n)",
    // Never written or read.
    'DROP TABLE outside_effects',
    // conversations loses `job` (the job working in a conversation is the one active row in `jobs`) and gains
    // `direct`. SQLite cannot drop a column that carries a foreign key, so the table is rebuilt; this is why
    // upgrades run with foreign keys off and are checked whole before they commit. A conversation is direct
    // if a direct message was ever delivered into it.
    `CREATE TABLE conversations_rebuilt (
	id text PRIMARY KEY NOT NULL,
	agent text NOT NULL,
	project text,
	member text,
	venue text NOT NULL,
	place text NOT NULL,
	label text NOT NULL,
	direct integer DEFAULT false NOT NULL,
	started_at text NOT NULL,
	last_at text NOT NULL,
	turn_count integer NOT NULL,
	FOREIGN KEY (agent) REFERENCES agents(id) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (project) REFERENCES projects(id) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (member) REFERENCES members(id) ON UPDATE no action ON DELETE no action,
	CHECK (direct in (0, 1)),
	CHECK (started_at is null or coalesce(strftime('%Y-%m-%dT%H:%M:%SZ', started_at) = started_at or strftime('%Y-%m-%dT%H:%M:%fZ', started_at) = started_at, 0)),
	CHECK (last_at is null or coalesce(strftime('%Y-%m-%dT%H:%M:%SZ', last_at) = last_at or strftime('%Y-%m-%dT%H:%M:%fZ', last_at) = last_at, 0)),
	CHECK (venue in ('loom', 'discord', 'slack', 'wake', 'handoff'))
)`,
    `INSERT INTO conversations_rebuilt (id, agent, project, member, venue, place, label, direct, started_at, last_at, turn_count)
      SELECT id, agent, project, member, venue, place, label,
        EXISTS (SELECT 1 FROM bridge_incoming WHERE bridge_incoming.conversation = conversations.id AND bridge_incoming.is_dm = 1),
        started_at, last_at, turn_count FROM conversations`,
    'DROP TABLE conversations',
    'ALTER TABLE conversations_rebuilt RENAME TO conversations',
    'CREATE UNIQUE INDEX `conversations_place_unique` ON `conversations` (`agent`,`venue`,`place`)',
    'CREATE INDEX `conversations_project_idx` ON `conversations` (`project`)',
    'CREATE INDEX `conversations_member_idx` ON `conversations` (`member`)',
    'CREATE INDEX `conversations_agent_last_at_idx` ON `conversations` (`agent`,`last_at`)',
    // Who edited a trigger and who asked for an account sign-in are a kind and an id, guarded like the others.
    ...kindAndIdGuards('trigger_edits', 'by_kind', 'by'), ...kindAndIdGuards('account_signins', 'asked_by_kind', 'asked_by'),
  ],
  // 7: one step for several changes. What it removes is in docs/accepted-tradeoffs.md.
  [
    // A browser remembers the browser whose sign-in link signed it in, so ending that one ends it too.
    'ALTER TABLE sessions ADD COLUMN made_by text REFERENCES sessions(id)',
    // A link remembers the browser that made it and whether its maker said it is for an automated browser.
    // A link from before the step can say neither, and lives five minutes: none is kept.
    'DELETE FROM signin_links',
    'ALTER TABLE signin_links ADD COLUMN session text REFERENCES sessions(id)',
    'ALTER TABLE signin_links ADD COLUMN is_agent integer DEFAULT false NOT NULL CHECK (is_agent in (0, 1))',
    // Never written or read: passkey challenges are kept in memory.
    'DROP TABLE signin_challenges',
    // Every posted part of a reply, not only the last. A reply from before has the one id that was kept.
    "CREATE TABLE `bridge_send_parts` (\n\t`send` text NOT NULL,\n\t`part` integer NOT NULL,\n\t`posted_id` text NOT NULL,\n\tPRIMARY KEY(`send`, `part`),\n\tFOREIGN KEY (`send`) REFERENCES `bridge_sends`(`id`) ON UPDATE no action ON DELETE no action\n)",
    'CREATE INDEX `bridge_send_parts_posted_id_idx` ON `bridge_send_parts` (`posted_id`)',
    'INSERT INTO bridge_send_parts (send, part, posted_id) SELECT id, 0, posted_id FROM bridge_sends WHERE posted_id IS NOT NULL',
    'ALTER TABLE bridge_sends DROP COLUMN posted_id',
    // jobs loses the `waiting` state, which no program ever wrote, gains `ended_note` for loom's own line on
    // an ending it decided itself, and may say a job was ended by a Stop. A CHECK cannot be changed in
    // place, so the table is rebuilt as conversations was in step 6. A row in `waiting` was running; the
    // lines loom wrote into log_tail (a lost job, a job no machine took) move to ended_note.
    `CREATE TABLE jobs_rebuilt (
	id text PRIMARY KEY NOT NULL,
	agent text NOT NULL,
	project text,
	member text,
	box text,
	conversation text,
	title text NOT NULL,
	state text NOT NULL,
	brief text NOT NULL,
	model text NOT NULL,
	account text,
	harness text,
	started_by_kind text NOT NULL,
	started_by text NOT NULL,
	retry_of text,
	retry_at text,
	house_repository text NOT NULL,
	house_file text NOT NULL,
	house_branch text NOT NULL,
	build text,
	exit_code integer,
	log_tail text,
	ended_by text,
	ended_reason text,
	ended_note text,
	queued_at text NOT NULL,
	claimed_at text,
	heard_at text,
	ended_at text,
	FOREIGN KEY (agent) REFERENCES agents(id) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (project) REFERENCES projects(id) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (member) REFERENCES members(id) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (box) REFERENCES boxes(id) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (conversation) REFERENCES conversations(id) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (account) REFERENCES model_accounts(id) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (retry_of) REFERENCES jobs(id) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (ended_by) REFERENCES members(id) ON UPDATE no action ON DELETE no action,
	CHECK (retry_at is null or coalesce(strftime('%Y-%m-%dT%H:%M:%SZ', retry_at) = retry_at or strftime('%Y-%m-%dT%H:%M:%fZ', retry_at) = retry_at, 0)),
	CHECK (queued_at is null or coalesce(strftime('%Y-%m-%dT%H:%M:%SZ', queued_at) = queued_at or strftime('%Y-%m-%dT%H:%M:%fZ', queued_at) = queued_at, 0)),
	CHECK (claimed_at is null or coalesce(strftime('%Y-%m-%dT%H:%M:%SZ', claimed_at) = claimed_at or strftime('%Y-%m-%dT%H:%M:%fZ', claimed_at) = claimed_at, 0)),
	CHECK (heard_at is null or coalesce(strftime('%Y-%m-%dT%H:%M:%SZ', heard_at) = heard_at or strftime('%Y-%m-%dT%H:%M:%fZ', heard_at) = heard_at, 0)),
	CHECK (ended_at is null or coalesce(strftime('%Y-%m-%dT%H:%M:%SZ', ended_at) = ended_at or strftime('%Y-%m-%dT%H:%M:%fZ', ended_at) = ended_at, 0)),
	CHECK (state in ('queued', 'starting', 'running', 'done', 'failed', 'stopped', 'lost')),
	CHECK (ended_reason in ('reset', 'write-off', 'stop'))
)`,
    `INSERT INTO jobs_rebuilt (id, agent, project, member, box, conversation, title, state, brief, model, account, harness, started_by_kind, started_by, retry_of, retry_at, house_repository, house_file, house_branch, build, exit_code, log_tail, ended_by, ended_reason, ended_note, queued_at, claimed_at, heard_at, ended_at)
      SELECT id, agent, project, member, box, conversation, title, CASE state WHEN 'waiting' THEN 'running' ELSE state END, brief, model, account, harness, started_by_kind, started_by, retry_of, retry_at, house_repository, house_file, house_branch, build, exit_code,
        CASE WHEN ${loomsOwnLine} THEN NULL ELSE log_tail END, ended_by, ended_reason, CASE WHEN ${loomsOwnLine} THEN log_tail END,
        queued_at, claimed_at, heard_at, ended_at FROM jobs`,
    'DROP TABLE jobs',
    'ALTER TABLE jobs_rebuilt RENAME TO jobs',
    "CREATE UNIQUE INDEX `jobs_one_active_unique` ON `jobs` (`conversation`) WHERE \"jobs\".\"state\" in ('queued', 'starting', 'running')",
    'CREATE INDEX `jobs_agent_state_idx` ON `jobs` (`agent`,`state`)',
    'CREATE INDEX `jobs_box_state_idx` ON `jobs` (`box`,`state`)',
  ],
  // 8: which messages carried a kept Slack file. A file was kept under the first message alone, so the
  // same file shared again was not listed under the later one. Each file kept now is linked to the message
  // it has. Both statements that make the table and its index are the fresh schema's own text.
  [
    "CREATE TABLE `bridge_file_messages` (\n\t`connection` text NOT NULL,\n\t`file` text NOT NULL,\n\t`incoming` text NOT NULL,\n\tPRIMARY KEY(`connection`, `file`, `incoming`),\n\tFOREIGN KEY (`incoming`) REFERENCES `bridge_incoming`(`id`) ON UPDATE no action ON DELETE no action,\n\tFOREIGN KEY (`connection`,`file`) REFERENCES `bridge_files`(`connection`,`file`) ON UPDATE no action ON DELETE no action\n)",
    'CREATE INDEX `bridge_file_messages_incoming_idx` ON `bridge_file_messages` (`incoming`)',
    'INSERT INTO bridge_file_messages (connection, file, incoming) SELECT connection, file, incoming FROM bridge_files',
    // runtime.signInCode was once a write, so its answers, the one-time code included, were kept as retry
    // receipts. It is a read now and leaves none; the old ones go here, once. This ran at every start,
    // outside the steps (src/shared-account-signin.ts), until this step.
    "DELETE FROM operation_results WHERE operation = 'runtime.signInCode'",
  ],
  // 9: three changes.
  [
    // bridge_files loses `incoming`. Which messages carried a file is bridge_file_messages alone; the column
    // named the first of them and went stale when that message stopped listing the file. Nothing is copied
    // out of it: step 8 linked every file to it, and a link removed since was removed on purpose. The column
    // carries a foreign key, so the table is rebuilt (see step 6). It has no index or trigger of its own.
    `CREATE TABLE bridge_files_rebuilt (
	connection text NOT NULL,
	file text NOT NULL,
	name text NOT NULL,
	contents blob NOT NULL,
	fetched_at text NOT NULL,
	PRIMARY KEY (connection, file),
	FOREIGN KEY (connection) REFERENCES bridge_connections(id) ON UPDATE no action ON DELETE no action,
	CHECK (fetched_at is null or coalesce(strftime('%Y-%m-%dT%H:%M:%SZ', fetched_at) = fetched_at or strftime('%Y-%m-%dT%H:%M:%fZ', fetched_at) = fetched_at, 0))
)`,
    'INSERT INTO bridge_files_rebuilt (connection, file, name, contents, fetched_at) SELECT connection, file, name, contents, fetched_at FROM bridge_files',
    'DROP TABLE bridge_files',
    'ALTER TABLE bridge_files_rebuilt RENAME TO bridge_files',
    // Who chose a job's exit code, so a stage is named only for a code one of loom's own programs chose
    // (runtime/job-exit.ts). An ended job from before the step does not say, and stays unsaid: its code
    // may be a machine's own runner's. The one kind that is certain is a job no machine took, which only
    // loom ends, with its own code and its own line (the same recognition as step 7).
    "ALTER TABLE jobs ADD COLUMN exit_by text CHECK (exit_by in ('body', 'worker', 'loom', 'runner'))",
    "UPDATE jobs SET exit_by = 'loom' WHERE exit_code = 31 AND claimed_at IS NULL AND ended_note LIKE 'Never started: no machine took it within % hours'",
    // The member a trigger's work is for, apart from who set it. Until this step a firing read it from the
    // owner: a trigger a member owns that puts an agent to work. That is copied as it stands. Whether the
    // member is narrowed is still judged when it fires (src/shared-tempo.ts).
    'ALTER TABLE triggers ADD COLUMN member text REFERENCES members(id)',
    "UPDATE triggers SET member = owner WHERE owner_kind = 'member' AND to_kind = 'agent' AND owner IN (SELECT id FROM members)",
  ],
  // 10: when a project was retired. A state between in use and removed: the project and everything filed
  // under it stay readable, and its unfinished tasks are shelved until it is revived (shared-projects.ts).
  // One empty column; no row is touched, so no project is retired by upgrading. The check is removed_at's.
  ["ALTER TABLE projects ADD COLUMN retired_at text CHECK (retired_at is null or coalesce(strftime('%Y-%m-%dT%H:%M:%SZ', retired_at) = retired_at or strftime('%Y-%m-%dT%H:%M:%fZ', retired_at) = retired_at, 0))"],
  // 11: additions for the bridges, none changing what a row that is there says.
  //  - bridge_channels.brief: the role page a channel's rule names for the bodies of its conversations
  //    (pieces/bridges/settings.ts). Empty on every rule there is, so no channel gains a brief by upgrading.
  //  - bridge_send_files: the files a post carries until the post is settled (pieces/bridges/sends.ts).
  //  - conversation_sessions: a harness's own record of a conversation, sealed, kept between bodies so
  //    the next one resumes it (core/conversations/sessions.ts).
  // Both tables start empty.
  // And, for mail that starts work in a named conversation (a trigger's firing, a note between bodies):
  //  - triggers.conversation and who asked (asked_by_kind, asked_by, asked_at): src/shared-place-triggers.ts.
  //  - inbox.on_word_kind, on_word: the person on whose word mail was sent; chain, chain_started_at: the
  //    hand-offs a note has come through.
  //  - bridge_channels.reports_to: where a guest's body may hand a note.
  //  - bridge_sends is rebuilt: `incoming` may be absent and `conversation` says where such a post belongs.
  //    Every row is carried across as it is, in whatever state; none has a conversation.
  // Every added column is empty on every row there is.
  [
    'ALTER TABLE bridge_channels ADD COLUMN brief text',
    "ALTER TABLE bridge_channels ADD COLUMN reports_to text",
    "ALTER TABLE triggers ADD COLUMN conversation text",
    "ALTER TABLE triggers ADD COLUMN asked_by_kind text CHECK (asked_by_kind in ('member', 'outside', 'agent'))",
    "ALTER TABLE triggers ADD COLUMN asked_by text",
    "ALTER TABLE triggers ADD COLUMN asked_at text CHECK (asked_at is null or coalesce(strftime('%Y-%m-%dT%H:%M:%SZ', asked_at) = asked_at or strftime('%Y-%m-%dT%H:%M:%fZ', asked_at) = asked_at, 0)) CHECK ((conversation is null) = (asked_by_kind is null) and (asked_by_kind is null) = (asked_by is null) and (asked_by_kind is null) = (asked_at is null))",
    "ALTER TABLE inbox ADD COLUMN on_word_kind text CHECK (on_word_kind in ('member', 'outside'))",
    "ALTER TABLE inbox ADD COLUMN on_word text CHECK ((on_word_kind is null) = (on_word is null))",
    "ALTER TABLE inbox ADD COLUMN chain text",
    "ALTER TABLE inbox ADD COLUMN chain_started_at text CHECK (chain_started_at is null or coalesce(strftime('%Y-%m-%dT%H:%M:%SZ', chain_started_at) = chain_started_at or strftime('%Y-%m-%dT%H:%M:%fZ', chain_started_at) = chain_started_at, 0)) CHECK ((chain is null) = (chain_started_at is null) and (chain is null or (json_valid(chain) and json_type(chain) = 'array')))",
    "CREATE TABLE `bridge_sends_rebuilt` (\n\t`id` text PRIMARY KEY NOT NULL,\n\t`incoming` text,\n\t`connection` text NOT NULL,\n\t`channel` text NOT NULL,\n\t`thread` text,\n\t`conversation` text,\n\t`text` text NOT NULL,\n\t`state` text NOT NULL,\n\t`created_at` text NOT NULL,\n\tFOREIGN KEY (`incoming`) REFERENCES `bridge_incoming`(`id`) ON UPDATE no action ON DELETE no action,\n\tFOREIGN KEY (`connection`) REFERENCES `bridge_connections`(`id`) ON UPDATE no action ON DELETE no action,\n\tCONSTRAINT \"bridge_sends_created_at_utc\" CHECK(\"created_at\" is null or coalesce(strftime('%Y-%m-%dT%H:%M:%SZ', \"created_at\") = \"created_at\" or strftime('%Y-%m-%dT%H:%M:%fZ', \"created_at\") = \"created_at\", 0)),\n\tCONSTRAINT \"bridge_sends_state_choice\" CHECK(\"state\" in ('pending', 'held', 'sending', 'sent', 'uncertain', 'dismissed')),\n\tCONSTRAINT \"bridge_sends_answers_or_placed\" CHECK(coalesce(\"incoming\", \"conversation\") is not null)\n)",
    "INSERT INTO bridge_sends_rebuilt (rowid, id, incoming, connection, channel, thread, text, state, created_at) SELECT rowid, id, incoming, connection, channel, thread, text, state, created_at FROM bridge_sends ORDER BY rowid",
    "DROP TABLE bridge_sends",
    "ALTER TABLE bridge_sends_rebuilt RENAME TO bridge_sends",
    "CREATE TABLE `bridge_send_files` (\n\t`send` text NOT NULL,\n\t`position` integer NOT NULL,\n\t`name` text NOT NULL,\n\t`contents` blob NOT NULL,\n\tPRIMARY KEY(`send`, `position`),\n\tFOREIGN KEY (`send`) REFERENCES `bridge_sends`(`id`) ON UPDATE no action ON DELETE no action\n)",
    "CREATE TABLE `conversation_sessions` (\n\t`conversation` text NOT NULL,\n\t`harness` text NOT NULL,\n\t`session` text NOT NULL,\n\t`files` blob NOT NULL,\n\t`bytes` integer NOT NULL,\n\t`started_at` text NOT NULL,\n\tPRIMARY KEY(`conversation`, `harness`),\n\tFOREIGN KEY (`conversation`) REFERENCES `conversations`(`id`) ON UPDATE no action ON DELETE no action,\n\tCONSTRAINT \"conversation_sessions_started_at_utc\" CHECK(\"conversation_sessions\".\"started_at\" is null or coalesce(strftime('%Y-%m-%dT%H:%M:%SZ', \"conversation_sessions\".\"started_at\") = \"conversation_sessions\".\"started_at\" or strftime('%Y-%m-%dT%H:%M:%fZ', \"conversation_sessions\".\"started_at\") = \"conversation_sessions\".\"started_at\", 0))\n)",
  ],
  // 12: old attempts have no observed counters. Only elapsed claim-to-end time and placement survive.
  [
    "CREATE TABLE `job_usage` (\n\t`job` text PRIMARY KEY NOT NULL,\n\t`source` text NOT NULL,\n\t`tokens_in` integer,\n\t`tokens_out` integer,\n\t`cache_read` integer,\n\t`cache_written` integer,\n\t`model_calls` integer,\n\t`tool_calls` integer,\n\t`tools` text,\n\t`largest_context` integer,\n\t`wall_ms` integer,\n\t`harness` text,\n\t`model` text,\n\tFOREIGN KEY (`job`) REFERENCES `jobs`(`id`) ON UPDATE no action ON DELETE no action,\n\tCONSTRAINT \"job_usage_source_choice\" CHECK(\"job_usage\".\"source\" in ('report','transcript','none'))\n);",
    `INSERT INTO job_usage (job, source, harness, model, wall_ms)
     SELECT id, 'none', harness, model, max(0, round((julianday(ended_at) - julianday(claimed_at)) * ${DAY_MS}))
     FROM jobs WHERE state IN ('done', 'failed', 'lost', 'stopped')`,
  ],
  // 13: preserve every conversation while admitting the terminal venue.
  [
    `CREATE TABLE conversations_rebuilt (
	id text PRIMARY KEY NOT NULL,
	agent text NOT NULL,
	project text,
	member text,
	venue text NOT NULL,
	place text NOT NULL,
	label text NOT NULL,
	direct integer DEFAULT false NOT NULL,
	started_at text NOT NULL,
	last_at text NOT NULL,
	turn_count integer NOT NULL,
	FOREIGN KEY (agent) REFERENCES agents(id) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (project) REFERENCES projects(id) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (member) REFERENCES members(id) ON UPDATE no action ON DELETE no action,
	CHECK (direct in (0, 1)),
	CHECK (started_at is null or coalesce(strftime('%Y-%m-%dT%H:%M:%SZ', started_at) = started_at or strftime('%Y-%m-%dT%H:%M:%fZ', started_at) = started_at, 0)),
	CHECK (last_at is null or coalesce(strftime('%Y-%m-%dT%H:%M:%SZ', last_at) = last_at or strftime('%Y-%m-%dT%H:%M:%fZ', last_at) = last_at, 0)),
	CHECK (venue in ('loom', 'discord', 'slack', 'wake', 'handoff', 'terminal'))
)`,
    `INSERT INTO conversations_rebuilt (id, agent, project, member, venue, place, label, direct, started_at, last_at, turn_count)
      SELECT id, agent, project, member, venue, place, label,
        direct,
        started_at, last_at, turn_count FROM conversations`,
    'DROP TABLE conversations',
    'ALTER TABLE conversations_rebuilt RENAME TO conversations',
    'CREATE UNIQUE INDEX `conversations_place_unique` ON `conversations` (`agent`,`venue`,`place`)',
    'CREATE INDEX `conversations_project_idx` ON `conversations` (`project`)',
    'CREATE INDEX `conversations_member_idx` ON `conversations` (`member`)',
    'CREATE INDEX `conversations_agent_last_at_idx` ON `conversations` (`agent`,`last_at`)',
    "CREATE TABLE `terminal_credentials` (\n\t`fingerprint` text PRIMARY KEY NOT NULL,\n\t`machine` text NOT NULL,\n\t`member` text NOT NULL,\n\tFOREIGN KEY (`fingerprint`) REFERENCES `tokens`(`fingerprint`) ON UPDATE no action ON DELETE cascade,\n\tFOREIGN KEY (`machine`) REFERENCES `boxes`(`id`) ON UPDATE no action ON DELETE no action,\n\tFOREIGN KEY (`member`) REFERENCES `members`(`id`) ON UPDATE no action ON DELETE no action\n);",
    "CREATE TABLE `terminal_sessions` (\n\t`job` text PRIMARY KEY NOT NULL,\n\t`thread` text,\n\t`session_id` text NOT NULL,\n\t`instance_id` text,\n\t`machine` text NOT NULL,\n\t`member` text NOT NULL,\n\t`agent` text NOT NULL,\n\t`harness` text NOT NULL,\n\t`cwd` text NOT NULL,\n\tFOREIGN KEY (`job`) REFERENCES `jobs`(`id`) ON UPDATE no action ON DELETE no action,\n\tFOREIGN KEY (`thread`) REFERENCES `threads`(`id`) ON UPDATE no action ON DELETE set null,\n\tFOREIGN KEY (`machine`) REFERENCES `boxes`(`id`) ON UPDATE no action ON DELETE no action,\n\tFOREIGN KEY (`member`) REFERENCES `members`(`id`) ON UPDATE no action ON DELETE no action,\n\tFOREIGN KEY (`agent`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE no action\n);",
    "CREATE UNIQUE INDEX `terminal_sessions_identity` ON `terminal_sessions` (`machine`,`member`,`agent`,`harness`,`session_id`);",
    "CREATE TABLE `terminal_runs` (\n\t`job` text PRIMARY KEY NOT NULL,\n\t`parent` text NOT NULL,\n\t`run_id` text NOT NULL,\n\t`revision` integer NOT NULL,\n\tFOREIGN KEY (`job`) REFERENCES `jobs`(`id`) ON UPDATE no action ON DELETE no action,\n\tFOREIGN KEY (`parent`) REFERENCES `terminal_sessions`(`job`) ON UPDATE no action ON DELETE no action\n);",
    "CREATE UNIQUE INDEX `terminal_runs_identity` ON `terminal_runs` (`parent`,`run_id`);",
  ],
  // 14: existing machines have unknown capacity; old jobs have no recorded decision.
  ['ALTER TABLE boxes ADD COLUMN slots integer',
   'ALTER TABLE triggers ADD COLUMN needs text', 'ALTER TABLE triggers ADD COLUMN prefers text',
   'ALTER TABLE agent_run_settings ADD COLUMN prefers text',
   'ALTER TABLE jobs ADD COLUMN prefers text', 'ALTER TABLE jobs ADD COLUMN placement_decision text'],
  // 15: named kits, exact grants, outside project people and kit calls.
  [
    "CREATE TABLE `agent_kits` (\n\t`agent` text NOT NULL,\n\t`kit` text NOT NULL,\n\t`tools` text NOT NULL,\n\tPRIMARY KEY(`agent`, `kit`),\n\tFOREIGN KEY (`agent`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE no action\n);",
    "CREATE TABLE `agent_kit_projects` (\n\t`agent` text NOT NULL,\n\t`kit` text NOT NULL,\n\t`project` text NOT NULL,\n\tPRIMARY KEY(`agent`, `kit`, `project`),\n\tFOREIGN KEY (`agent`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE no action,\n\tFOREIGN KEY (`project`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action,\n\tFOREIGN KEY (`agent`,`kit`) REFERENCES `agent_kits`(`agent`,`kit`) ON UPDATE no action ON DELETE cascade\n);",
    "CREATE TABLE `agent_kit_members` (\n\t`agent` text NOT NULL,\n\t`kit` text NOT NULL,\n\t`member` text NOT NULL,\n\tPRIMARY KEY(`agent`, `kit`, `member`),\n\tFOREIGN KEY (`agent`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE no action,\n\tFOREIGN KEY (`member`) REFERENCES `members`(`id`) ON UPDATE no action ON DELETE no action,\n\tFOREIGN KEY (`agent`,`kit`) REFERENCES `agent_kits`(`agent`,`kit`) ON UPDATE no action ON DELETE cascade\n);",
    "CREATE TABLE `agent_kit_outside_people` (\n\t`agent` text NOT NULL,\n\t`kit` text NOT NULL,\n\t`platform` text NOT NULL,\n\t`workspace` text NOT NULL,\n\t`user` text NOT NULL,\n\tPRIMARY KEY(`agent`, `kit`, `platform`, `workspace`, `user`),\n\tFOREIGN KEY (`agent`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE no action,\n\tFOREIGN KEY (`agent`,`kit`) REFERENCES `agent_kits`(`agent`,`kit`) ON UPDATE no action ON DELETE cascade\n);",
    "CREATE TABLE `project_outside_people` (\n\t`project` text NOT NULL,\n\t`platform` text NOT NULL,\n\t`workspace` text NOT NULL,\n\t`user` text NOT NULL,\n\tPRIMARY KEY(`project`, `platform`, `workspace`, `user`),\n\tFOREIGN KEY (`project`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action\n);",
    "CREATE TABLE `kit_uses` (\n\t`agent` text NOT NULL,\n\t`conversation` text,\n\t`person_kind` text,\n\t`person` text,\n\t`id` text PRIMARY KEY NOT NULL,\n\t`job` text NOT NULL,\n\t`kit` text NOT NULL,\n\t`tool` text NOT NULL,\n\t`at` text NOT NULL,\n\t`outcome` text NOT NULL,\n\tFOREIGN KEY (`agent`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE no action,\n\tFOREIGN KEY (`conversation`) REFERENCES `conversations`(`id`) ON UPDATE no action ON DELETE no action,\n\tFOREIGN KEY (`job`) REFERENCES `jobs`(`id`) ON UPDATE no action ON DELETE no action\n);",
  ],
  // 16: program schedules and their durable attempts. Existing schedules keep the ordinary firing path.
  ["ALTER TABLE triggers ADD COLUMN program text",
   "ALTER TABLE triggers ADD COLUMN program_period text",
   "ALTER TABLE triggers ADD COLUMN read_state_from text REFERENCES triggers(id)",
   "ALTER TABLE triggers ADD COLUMN program_state text",
   "CREATE TABLE `program_firings` (\n\t`id` text PRIMARY KEY NOT NULL,\n\t`trigger` text NOT NULL,\n\t`at` text NOT NULL,\n\t`period` text,\n\t`job` text NOT NULL,\n\t`program` text NOT NULL,\n\t`status` text NOT NULL,\n\t`line` text,\n\tFOREIGN KEY (`trigger`) REFERENCES `triggers`(`id`) ON UPDATE no action ON DELETE no action,\n\tFOREIGN KEY (`job`) REFERENCES `jobs`(`id`) ON UPDATE no action ON DELETE no action\n);",
   "CREATE UNIQUE INDEX `program_firings_job` ON `program_firings` (`job`);",
   "CREATE UNIQUE INDEX `program_firings_pending` ON `program_firings` (`trigger`) WHERE \"program_firings\".\"status\" = 'pending';",
   "CREATE UNIQUE INDEX `program_firings_period` ON `program_firings` (`trigger`,`period`);",
   "ALTER TABLE job_usage RENAME TO old_job_usage",
   "CREATE TABLE `job_usage` (\n\t`job` text PRIMARY KEY NOT NULL,\n\t`source` text NOT NULL,\n\t`tokens_in` integer,\n\t`tokens_out` integer,\n\t`cache_read` integer,\n\t`cache_written` integer,\n\t`model_calls` integer,\n\t`tool_calls` integer,\n\t`tools` text,\n\t`largest_context` integer,\n\t`wall_ms` integer,\n\t`harness` text,\n\t`model` text,\n\tFOREIGN KEY (`job`) REFERENCES `jobs`(`id`) ON UPDATE no action ON DELETE no action,\n\tCONSTRAINT \"job_usage_source_choice\" CHECK(\"job_usage\".\"source\" in ('report','transcript','none','program'))\n);",
   "INSERT INTO job_usage (job, source, tokens_in, tokens_out, cache_read, cache_written, model_calls, tool_calls, tools, largest_context, wall_ms, harness, model) SELECT job, source, tokens_in, tokens_out, cache_read, cache_written, model_calls, tool_calls, tools, largest_context, wall_ms, harness, model FROM old_job_usage",
   "DROP TABLE old_job_usage"],

  // 17: machine inspection grants and metadata-only history.
  ['ALTER TABLE boxes ADD COLUMN readers text',
   "CREATE TABLE `machine_reads` (\n\t`id` text PRIMARY KEY NOT NULL,\n\t`machine` text NOT NULL,\n\t`agent` text NOT NULL,\n\t`job` text NOT NULL,\n\t`conversation` text,\n\t`word` text NOT NULL,\n\t`person` text,\n\t`read` text NOT NULL,\n\t`args` text NOT NULL,\n\t`asked_at` text NOT NULL,\n\t`bytes` integer NOT NULL,\n\t`outcome` text NOT NULL\n);",
   "CREATE INDEX `machine_reads_machine_time` ON `machine_reads` (`machine`,`asked_at`);"],
  // 18: what loom last learned about each model account sign-in. Existing sign-ins are unknown until a worker says.
  ["CREATE TABLE `model_account_logins` (\n\t`account` text NOT NULL,\n\t`box` text NOT NULL,\n\t`harness` text NOT NULL,\n\t`place` text NOT NULL,\n\t`state` text NOT NULL,\n\t`expires_at` text,\n\t`since` text NOT NULL,\n\t`checked_at` text NOT NULL,\n\t`learned_from` text NOT NULL,\n\t`why` text,\n\tPRIMARY KEY(`account`, `box`, `harness`, `place`),\n\tFOREIGN KEY (`account`) REFERENCES `model_accounts`(`id`) ON UPDATE no action ON DELETE no action,\n\tFOREIGN KEY (`box`) REFERENCES `boxes`(`id`) ON UPDATE no action ON DELETE no action,\n\tCONSTRAINT \"model_account_logins_harness\" CHECK(length(trim(\"model_account_logins\".\"harness\")) > 0),\n\tCONSTRAINT \"model_account_logins_place\" CHECK(\"model_account_logins\".\"place\" in ('containers', 'host')),\n\tCONSTRAINT \"model_account_logins_state\" CHECK(\"model_account_logins\".\"state\" in ('signed-in', 'signed-out')),\n\tCONSTRAINT \"model_account_logins_learned_from\" CHECK(\"model_account_logins\".\"learned_from\" in ('check', 'job')),\n\tCONSTRAINT \"model_account_logins_expires_at_utc\" CHECK(\"model_account_logins\".\"expires_at\" is null or coalesce(strftime('%Y-%m-%dT%H:%M:%SZ', \"model_account_logins\".\"expires_at\") = \"model_account_logins\".\"expires_at\" or strftime('%Y-%m-%dT%H:%M:%fZ', \"model_account_logins\".\"expires_at\") = \"model_account_logins\".\"expires_at\", 0)),\n\tCONSTRAINT \"model_account_logins_checked_at_utc\" CHECK(\"model_account_logins\".\"checked_at\" is null or coalesce(strftime('%Y-%m-%dT%H:%M:%SZ', \"model_account_logins\".\"checked_at\") = \"model_account_logins\".\"checked_at\" or strftime('%Y-%m-%dT%H:%M:%fZ', \"model_account_logins\".\"checked_at\") = \"model_account_logins\".\"checked_at\", 0)),\n\tCONSTRAINT \"model_account_logins_since_utc\" CHECK(\"model_account_logins\".\"since\" is null or coalesce(strftime('%Y-%m-%dT%H:%M:%SZ', \"model_account_logins\".\"since\") = \"model_account_logins\".\"since\" or strftime('%Y-%m-%dT%H:%M:%fZ', \"model_account_logins\".\"since\") = \"model_account_logins\".\"since\", 0))\n);"],
  // 19: who made each terminal binding. Existing bindings have nobody recorded and gain no new reach.
  ['ALTER TABLE terminal_credentials ADD COLUMN issued_by text REFERENCES members(id)'],
  // 20: the latest machine readings and the household's effective alert lines.
  ["ALTER TABLE boxes ADD COLUMN reading_sequence integer DEFAULT 0 NOT NULL",
   "CREATE TABLE `box_readings` (\n\t`box` text NOT NULL,\n\t`kind` text NOT NULL,\n\t`thing` text NOT NULL,\n\t`generation` text NOT NULL,\n\t`occasion` integer DEFAULT 0 NOT NULL,\n\t`urgent_occasion` integer DEFAULT 0 NOT NULL,\n\t`last_lines` text,\n\t`used_percent` integer,\n\t`size_mib` integer,\n\t`free_mib` integer,\n\t`engine_status` integer,\n\t`level` text NOT NULL,\n\t`since` text,\n\t`urgent_since` text,\n\t`read_at` text,\n\t`unknown_since` text,\n\t`observed_at` text,\n\t`unknown_ms` integer DEFAULT 0 NOT NULL,\n\t`absent_ms` integer,\n\t`report_sequence` integer DEFAULT 0 NOT NULL,\n\t`stale` integer DEFAULT false NOT NULL,\n\tPRIMARY KEY(`box`, `kind`, `thing`),\n\tFOREIGN KEY (`box`) REFERENCES `boxes`(`id`) ON UPDATE no action ON DELETE no action,\n\tCONSTRAINT \"box_readings_kind\" CHECK(\"box_readings\".\"kind\" in ('disk', 'memory', 'containers')),\n\tCONSTRAINT \"box_readings_level\" CHECK(\"box_readings\".\"level\" in ('ok', 'raised', 'urgent')),\n\tCONSTRAINT \"box_readings_used_percent_range\" CHECK(\"box_readings\".\"used_percent\" is null or \"box_readings\".\"used_percent\" between 0 and 100),\n\tCONSTRAINT \"box_readings_engine_status_range\" CHECK(\"box_readings\".\"engine_status\" is null or \"box_readings\".\"engine_status\" = 200 or \"box_readings\".\"engine_status\" between 300 and 599),\n\tCONSTRAINT \"box_readings_since_utc\" CHECK(\"box_readings\".\"since\" is null or coalesce(strftime('%Y-%m-%dT%H:%M:%SZ', \"box_readings\".\"since\") = \"box_readings\".\"since\" or strftime('%Y-%m-%dT%H:%M:%fZ', \"box_readings\".\"since\") = \"box_readings\".\"since\", 0)),\n\tCONSTRAINT \"box_readings_urgent_since_utc\" CHECK(\"box_readings\".\"urgent_since\" is null or coalesce(strftime('%Y-%m-%dT%H:%M:%SZ', \"box_readings\".\"urgent_since\") = \"box_readings\".\"urgent_since\" or strftime('%Y-%m-%dT%H:%M:%fZ', \"box_readings\".\"urgent_since\") = \"box_readings\".\"urgent_since\", 0)),\n\tCONSTRAINT \"box_readings_read_at_utc\" CHECK(\"box_readings\".\"read_at\" is null or coalesce(strftime('%Y-%m-%dT%H:%M:%SZ', \"box_readings\".\"read_at\") = \"box_readings\".\"read_at\" or strftime('%Y-%m-%dT%H:%M:%fZ', \"box_readings\".\"read_at\") = \"box_readings\".\"read_at\", 0)),\n\tCONSTRAINT \"box_readings_unknown_since_utc\" CHECK(\"box_readings\".\"unknown_since\" is null or coalesce(strftime('%Y-%m-%dT%H:%M:%SZ', \"box_readings\".\"unknown_since\") = \"box_readings\".\"unknown_since\" or strftime('%Y-%m-%dT%H:%M:%fZ', \"box_readings\".\"unknown_since\") = \"box_readings\".\"unknown_since\", 0)),\n\tCONSTRAINT \"box_readings_stale_boolean\" CHECK(\"box_readings\".\"stale\" in (0, 1))\n);",
   "CREATE TABLE `box_alert_settings` (\n\t`singleton` integer PRIMARY KEY DEFAULT 1 NOT NULL,\n\t`disk_percent` integer DEFAULT 85 NOT NULL,\n\t`disk_urgent_percent` integer DEFAULT 95 NOT NULL,\n\t`disk_free_mib` integer DEFAULT 5120 NOT NULL,\n\t`memory_free_mib` integer DEFAULT 512 NOT NULL,\n\tCONSTRAINT \"box_alert_settings_singleton\" CHECK(\"box_alert_settings\".\"singleton\" = 1),\n\tCONSTRAINT \"box_alert_settings_disk_percent_range\" CHECK(typeof(\"box_alert_settings\".\"disk_percent\") = 'integer' and \"box_alert_settings\".\"disk_percent\" between 10 and 99),\n\tCONSTRAINT \"box_alert_settings_disk_urgent_percent_range\" CHECK(typeof(\"box_alert_settings\".\"disk_urgent_percent\") = 'integer' and \"box_alert_settings\".\"disk_urgent_percent\" > \"box_alert_settings\".\"disk_percent\" and \"box_alert_settings\".\"disk_urgent_percent\" <= 100),\n\tCONSTRAINT \"box_alert_settings_disk_free_mib_range\" CHECK(typeof(\"box_alert_settings\".\"disk_free_mib\") = 'integer' and \"box_alert_settings\".\"disk_free_mib\" between 0 and 1000000000),\n\tCONSTRAINT \"box_alert_settings_memory_free_mib_range\" CHECK(typeof(\"box_alert_settings\".\"memory_free_mib\") = 'integer' and \"box_alert_settings\".\"memory_free_mib\" between 0 and 1000000000)\n);",
   "INSERT INTO box_alert_settings (singleton) VALUES (1)"],
];
/** The schema number this program writes: the first shape plus every upgrade since. */
export const dataSchemaNumber = upgrades.length + 1;

const unknown = 'This is not a household database this program knows; existing data needs its separate move';
function numberOf(client: Database.Database): number {
  if (!client.prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'migrations'").get()) throw new Error(unknown);
  const numbers = (client.prepare('SELECT number FROM migrations ORDER BY number').all() as { number: number }[]).map(row => row.number);
  if (numbers.some(number => number > dataSchemaNumber)) throw new Error('This household database is from a newer program');
  // Every step up to the last is marked, so a hand-written number cannot skip one.
  if (!numbers.length || numbers.some((number, index) => number !== index + 1)) throw new Error(unknown);
  return numbers.length;
}
/** Run the steps after `from`, up to `to`. Exported for upgrade.test.ts alone, which stops at each number
 * to hold the steps to the pinned shapes; the program always runs them all, through upgradeDataSchema. */
export function applyUpgrades(client: Database.Database, from: number, now: () => string, to = dataSchemaNumber) {
  const mark = client.prepare('INSERT INTO migrations (number, applied_at) VALUES (?, ?)');
  for (let number = from + 1; number <= to; number++) {
    for (const statement of upgrades[number - 2]) client.exec(statement);
    mark.run(number, now());
  }
}

/** SQL outside quoted strings with spaces, identifier quotes and the table's own qualifier removed,
 * so `CHECK("members"."removed_at" is null)` and `CHECK (removed_at is null)` read the same. */
function plain(sql: string, table: string): string {
  return sql.split(/('(?:[^']|'')*')/).map((part, index) => index % 2 ? part
    : part.replace(/["`\s]/g, '').toLowerCase().replace(new RegExp(`(?<![a-z0-9_])${table.toLowerCase()}\\.`, 'g'), '')).join('');
}
/** Every CHECK a table's SQL carries, named or not, on a column or on the table. */
function checks(sql: string, table: string): string[] {
  const found: string[] = [];
  // Strings are blanked to the same length first so a bracket or the word CHECK inside one is not read as SQL.
  const code = sql.replace(/'(?:[^']|'')*'/g, text => ' '.repeat(text.length));
  for (const match of code.matchAll(/\bCHECK\s*\(/gi)) {
    let depth = 1, end = match.index + match[0].length;
    while (depth && end < code.length) { if (code[end] === '(') depth++; else if (code[end] === ')') depth--; end++; }
    found.push(plain(sql.slice(match.index + match[0].length, end - 1), table));
  }
  return found.sort();
}
/** Everything about a database's shape that changes what it accepts or returns: each table's columns
 * (type, required, default, key), foreign keys with their actions, CHECKs, and unique or key constraints;
 * and each index, trigger and view as written. Row order of columns and a constraint's name are left out,
 * because a column an upgrade adds lands last and unnamed, where a fresh database has it in place and named.
 * So two recognised databases can order a table's columns differently, and no statement may place a value by
 * position: src/stored-data.contract.test.ts fails on an insert that does not name its columns. */
export function dataSchemaShape(client: Database.Database): unknown[] {
  const objects = client.prepare("SELECT type, name, tbl_name, sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name").all() as { type: string; name: string; tbl_name: string; sql: string }[];
  return objects.map(object => object.type !== 'table' ? object : {
    type: object.type, name: object.name,
    columns: client.prepare('SELECT name, type, "notnull" AS required, dflt_value AS fallback, pk, hidden FROM pragma_table_xinfo(?) ORDER BY name').all(object.name),
    keys: client.prepare('SELECT "table", "from", "to", on_update, on_delete, "match" FROM pragma_foreign_key_list(?) ORDER BY "table", "from", "to"').all(object.name),
    checks: checks(object.sql, object.name),
    // Constraints SQLite keeps as its own indexes (PRIMARY KEY, UNIQUE); named indexes are objects above.
    unique: (client.prepare("SELECT name, origin FROM pragma_index_list(?) WHERE origin <> 'c'").all(object.name) as { name: string; origin: string }[])
      .map(index => `${index.origin}:${(client.prepare('SELECT name FROM pragma_index_info(?) ORDER BY seqno').all(index.name) as { name: string }[]).map(column => column.name).join(',')}`).sort(),
    options: client.prepare('SELECT wr AS without_rowid, strict FROM pragma_table_list(?)').get(object.name),
    autoincrement: /\bAUTOINCREMENT\b/i.test(object.sql),
  });
}
let freshShape: string | undefined;
const shippedShapes = new Map<number, string>();
/** The shape of a household as the program at that schema number installed it: the pinned installation
 * SQL of that number (shipped-shapes/, never edited), read into memory. The files are source, so they are
 * read from src/ beside dist/ as well as from src/ itself; package.json ships that directory. */
function shippedShape(number: number): string {
  let shape = shippedShapes.get(number);
  if (!shape) {
    const pinned = new Database(':memory:');
    try {
      pinned.exec(readFileSync(new URL(`../../../src/core/data/shipped-shapes/${number}.sql`, import.meta.url), 'utf8'));
      shape = JSON.stringify(dataSchemaShape(pinned));
    } finally { pinned.close(); }
    shippedShapes.set(number, shape);
  }
  return shape;
}
/** Recognise a household database without writing to it, and return its schema number. It is known only
 * if it has, as it is, exactly the shape the program at its number gave a household. Anything else throws,
 * so a foreign, interim or hand-altered database is never altered. Comparing only the result of the
 * pending steps would not do: a step that rebuilds or drops a table erases whatever was changed in it by
 * hand, so the altered database would pass and the rebuild would then drop the altered data.
 * When steps are pending they are also rehearsed on a copy of the schema in memory, and must give
 * exactly the shape a fresh database has. */
export function recogniseDataSchema(client: Database.Database): number {
  const number = numberOf(client);
  if (!freshShape) {
    const fresh = new Database(':memory:');
    try { createDataSchema(fresh); freshShape = JSON.stringify(dataSchemaShape(fresh)); } finally { fresh.close(); }
  }
  // The usual start: nothing is pending, so there is nothing to rehearse and the file's own shape is read.
  if (number === dataSchemaNumber) {
    if (JSON.stringify(dataSchemaShape(client)) !== freshShape) throw new Error(unknown);
    return number;
  }
  // Before any step, in memory or on the file: the database as it is against the pinned shape of its number.
  let pinned: string;
  try { pinned = shippedShape(number); } catch (error) { throw new Error(`The shipped shape of schema ${number} is missing from this installation; nothing was changed`, { cause: error }); }
  if (JSON.stringify(dataSchemaShape(client)) !== pinned) throw new Error(unknown);
  const rehearsal = new Database(':memory:');
  try {
    // In the order they were made, so each index and trigger finds its table.
    for (const { sql } of client.prepare("SELECT sql FROM sqlite_schema WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY rowid").all() as { sql: string }[]) rehearsal.exec(sql);
    applyUpgrades(rehearsal, number, () => new Date().toISOString());
    if (JSON.stringify(dataSchemaShape(rehearsal)) !== freshShape) throw new Error(unknown);
  } catch (error) {
    // A schema SQLite cannot rebuild or a step that does not apply is as unknown as a wrong shape.
    throw error instanceof Error && error.message === unknown ? error : new Error(unknown, { cause: error });
  } finally { rehearsal.close(); }
  return number;
}
/** The first kind-and-id reference whose row names a parent that is not there, in words, or nothing.
 * These references are held by triggers, which only look at a row when it is written, and SQLite's
 * foreign_key_check does not know them. A step that adds such guards to a table with rows needs this. */
function danglingKindAndId(client: Database.Database): string | undefined {
  for (const reference of polymorphicReferences) {
    const table = getTableName(reference.table), id = reference.id;
    for (const [tag, parent] of Object.entries(reference.targets)) {
      const tagged = 'kind' in reference ? `"${reference.kind}" = '${tag}' AND "${id}" IS NOT NULL` : `"${id}" IS NOT NULL${'emptyIsAbsent' in reference ? ` AND "${id}" <> ''` : ''}`;
      if (client.prepare(`SELECT 1 FROM "${table}" WHERE ${tagged} AND NOT EXISTS (SELECT 1 FROM "${getTableName(parent)}" WHERE id = "${table}"."${id}") LIMIT 1`).get())
        return `${table}.${id} names ${tag ? `a ${tag}` : `one of ${getTableName(parent)}`} that is not there`;
    }
  }
}
/** Bring an existing household database up to this program's shape. Safe to run at every start.
 * The database is recognised first, under the same write lock, so nothing is changed in one this
 * program does not know. */
export function upgradeDataSchema(client: Database.Database, now: () => string = () => new Date().toISOString()) {
  if (client.inTransaction) throw new Error('Upgrade the data schema outside a transaction');
  // A step that rebuilds a table drops the old one while other tables still point at it, which SQLite
  // allows only with foreign keys off. So the steps run with them off, every reference is checked before
  // the commit, and the connection gets its own setting back.
  const enforced = client.pragma('foreign_keys', { simple: true });
  client.pragma('foreign_keys = OFF');
  try {
    client.transaction(() => {
      const from = recogniseDataSchema(client);
      applyUpgrades(client, from, now);
      if (from === dataSchemaNumber) return;
      if ((client.pragma('foreign_key_check') as unknown[]).length) throw new Error('Upgrading this household database would leave a record pointing at nothing; nothing was changed');
      const dangling = danglingKindAndId(client);
      if (dangling) throw new Error(`Upgrading this household database would leave a record pointing at nothing (${dangling}); nothing was changed`);
    }).immediate();
  } finally { client.pragma(`foreign_keys = ${enforced ? 'ON' : 'OFF'}`); }
}
