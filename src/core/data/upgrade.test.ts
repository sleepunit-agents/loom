import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { createDataSchema, upgradeDataSchema } from './database.js';
const columns = (client: Database.Database, table: string) => (client.prepare(`SELECT name FROM pragma_table_info('${table}')`).all() as { name: string }[]).map(row => row.name);
const tables = ['members', 'agents', 'projects', 'bridge_connections'];
it('brings a database made before removal up to date once, keeping its rows, and leaves a fresh one alone', () => {
  // A database as the first shape made it: the fresh schema without the later columns, marked as number 1.
  const old = new Database(':memory:'); old.pragma('foreign_keys = ON');
  const first = readFileSync(new URL('../../../assets/data/schema.sql', import.meta.url), 'utf8')
    .replace(/\t`removed_at` text,\n/g, '').replace(/\tCONSTRAINT "\w+_removed_at_utc" CHECK\([^\n]*\n/g, '').replace(/,\n\);/g, '\n);');
  old.exec(first); old.prepare('INSERT INTO migrations (number, applied_at) VALUES (1, ?)').run('2026-11-15T00:00:00.000Z');
  for (const table of tables) expect(columns(old, table)).not.toContain('removed_at');
  old.prepare("INSERT INTO members (id, role, joined_at) VALUES ('sam', 'owner', '2026-11-15T00:00:00.000Z')").run();
  upgradeDataSchema(old, () => '2026-11-16T00:00:00.000Z');
  for (const table of tables) expect(columns(old, table)).toContain('removed_at');
  expect(old.prepare('SELECT id, role, removed_at FROM members').all()).toEqual([{ id: 'sam', role: 'owner', removed_at: null }]);
  expect(old.prepare('SELECT number FROM migrations ORDER BY number').all()).toEqual([{ number: 1 }, { number: 2 }]);
  expect(() => old.prepare("UPDATE members SET removed_at = 'yesterday'").run()).toThrow();
  upgradeDataSchema(old); expect(old.prepare('SELECT count(*) AS n FROM migrations').get()).toEqual({ n: 2 });
  old.close();
  const fresh = new Database(':memory:'); createDataSchema(fresh);
  expect(fresh.prepare('SELECT number FROM migrations ORDER BY number').all()).toEqual([{ number: 1 }, { number: 2 }]);
  upgradeDataSchema(fresh); expect(fresh.prepare('SELECT count(*) AS n FROM migrations').get()).toEqual({ n: 2 });
  fresh.prepare('INSERT INTO migrations (number, applied_at) VALUES (9, ?)').run('2026-11-16T00:00:00.000Z');
  expect(() => upgradeDataSchema(fresh)).toThrow('newer program');
  fresh.close();
});
