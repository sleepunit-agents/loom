import type Database from 'better-sqlite3';
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
    for (let number = 1; number <= upgrades.length + 1; number++) mark.run(number, now());
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
];
/** Bring an existing household database up to this program's shape. Safe to run at every start. */
export function upgradeDataSchema(client: Database.Database, now: () => string = () => new Date().toISOString()) {
  if (client.inTransaction) throw new Error('Upgrade the data schema outside a transaction');
  client.transaction(() => {
    const at = (client.prepare('SELECT max(number) AS number FROM migrations').get() as { number: number | null }).number ?? 0;
    if (at < 1) throw new Error('This is not a household database');
    if (at > upgrades.length + 1) throw new Error('This household database is from a newer program');
    for (let number = at + 1; number <= upgrades.length + 1; number++) {
      for (const statement of upgrades[number - 2]) client.exec(statement);
      client.prepare('INSERT INTO migrations (number, applied_at) VALUES (?, ?)').run(number, now());
    }
  }).immediate();
}
