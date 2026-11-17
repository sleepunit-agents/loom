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
