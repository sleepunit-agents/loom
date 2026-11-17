import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { schema } from './schema.js';

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
function applyUpgrades(client: Database.Database, from: number, now: () => string) {
  const mark = client.prepare('INSERT INTO migrations (number, applied_at) VALUES (?, ?)');
  for (let number = from + 1; number <= dataSchemaNumber; number++) {
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
 * because a column an upgrade adds lands last and unnamed, where a fresh database has it in place and named. */
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
/** Recognise a household database without writing to it, and return its schema number. Its schema alone
 * is copied into memory and upgraded there; it is known only if that gives exactly the shape a fresh
 * database has. Anything else throws, so a foreign, interim or hand-altered database is never altered. */
export function recogniseDataSchema(client: Database.Database): number {
  const number = numberOf(client);
  const rehearsal = new Database(':memory:');
  try {
    // In the order they were made, so each index and trigger finds its table.
    for (const { sql } of client.prepare("SELECT sql FROM sqlite_schema WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY rowid").all() as { sql: string }[]) rehearsal.exec(sql);
    applyUpgrades(rehearsal, number, () => new Date().toISOString());
    if (!freshShape) {
      const fresh = new Database(':memory:');
      try { createDataSchema(fresh); freshShape = JSON.stringify(dataSchemaShape(fresh)); } finally { fresh.close(); }
    }
    if (JSON.stringify(dataSchemaShape(rehearsal)) !== freshShape) throw new Error(unknown);
  } catch (error) {
    // A schema SQLite cannot rebuild or a step that does not apply is as unknown as a wrong shape.
    throw error instanceof Error && error.message === unknown ? error : new Error(unknown, { cause: error });
  } finally { rehearsal.close(); }
  return number;
}
/** Bring an existing household database up to this program's shape. Safe to run at every start.
 * The database is recognised first, under the same write lock, so nothing is changed in one this
 * program does not know. */
export function upgradeDataSchema(client: Database.Database, now: () => string = () => new Date().toISOString()) {
  if (client.inTransaction) throw new Error('Upgrade the data schema outside a transaction');
  client.transaction(() => applyUpgrades(client, recogniseDataSchema(client), now)).immediate();
}
