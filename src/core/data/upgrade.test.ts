import Database from 'better-sqlite3';
import { readFileSync, readdirSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { createDataSchema, dataSchemaNumber, dataSchemaShape, recogniseDataSchema, upgradeDataSchema } from './database.js';

// The installation SQL exactly as each schema number shipped it, recovered from history and never edited.
// Adding upgrade step N+1 means checking today's assets/data/schema.sql in here as N+1.sql.
const shapes = new URL('./shipped-shapes/', import.meta.url);
const shipped = (number: number) => readFileSync(new URL(`${number}.sql`, shapes), 'utf8');
const installation = readFileSync(new URL('../../../assets/data/schema.sql', import.meta.url), 'utf8');
const numbers = Array.from({ length: dataSchemaNumber }, (_, index) => index + 1);
const at = '2026-11-15T00:00:00.000Z';

const opened: Database.Database[] = [];
afterEach(() => { for (const client of opened.splice(0)) client.close(); });
function open() { const client = new Database(':memory:'); client.pragma('foreign_keys = ON'); opened.push(client); return client; }
function fresh() { const client = open(); createDataSchema(client, () => at); return client; }
/** A household as the program at that schema number installed it. */
function household(number: number) {
  const client = open(); client.exec(shipped(number));
  const mark = client.prepare('INSERT INTO migrations (number, applied_at) VALUES (?, ?)');
  for (let step = 1; step <= number; step++) mark.run(step, at);
  return client;
}
const everything = (client: Database.Database) => client.prepare('SELECT type, name, sql FROM sqlite_schema ORDER BY rowid').all();

describe('upgrading a household database', () => {
  it('has the installation SQL of every shipped schema number, the newest being today\'s', () => {
    expect(readdirSync(shapes).sort()).toEqual(numbers.map(number => `${number}.sql`));
    // A change to the schema with no upgrade step fails here: the newest pinned shape is no longer what is installed.
    expect(shipped(dataSchemaNumber)).toBe(installation);
  });

  it.each(numbers)('brings a household installed at schema %i to exactly the shape of a fresh one', number => {
    const old = household(number);
    upgradeDataSchema(old, () => '2026-11-16T00:00:00.000Z');
    // Columns, defaults, keys, foreign keys with their actions, CHECKs, and each index and trigger as written, for every table.
    expect(dataSchemaShape(old)).toEqual(dataSchemaShape(fresh()));
    expect(old.prepare('SELECT number FROM migrations ORDER BY number').all()).toEqual(numbers.map(n => ({ number: n })));
    expect(old.pragma('foreign_key_check')).toEqual([]);
  });

  it('keeps existing rows, enforces the new rules on them, and does nothing the second time', () => {
    const old = household(1);
    expect(old.prepare("SELECT name FROM pragma_table_info('members')").all()).not.toContainEqual({ name: 'removed_at' });
    old.prepare("INSERT INTO members (id, role, joined_at) VALUES ('sam', 'owner', ?)").run(at);
    upgradeDataSchema(old, () => '2026-11-16T00:00:00.000Z');
    expect(old.prepare('SELECT id, role, removed_at FROM members').all()).toEqual([{ id: 'sam', role: 'owner', removed_at: null }]);
    expect(() => old.prepare("UPDATE members SET removed_at = 'yesterday'").run()).toThrow();
    const before = everything(old);
    upgradeDataSchema(old);
    expect(everything(old)).toEqual(before);
    expect(old.prepare('SELECT count(*) AS n FROM migrations').get()).toEqual({ n: dataSchemaNumber });
    const made = fresh(); upgradeDataSchema(made);
    expect(made.prepare('SELECT count(*) AS n FROM migrations').get()).toEqual({ n: dataSchemaNumber });
  });

  it('refuses a database from a newer program', () => {
    const made = fresh();
    made.prepare('INSERT INTO migrations (number, applied_at) VALUES (?, ?)').run(dataSchemaNumber + 1, at);
    expect(() => upgradeDataSchema(made)).toThrow('newer program');
  });

  // Each of these carries a `migrations` table with a believable number, which is all the old check asked for.
  it.each<[string, (client: Database.Database) => void]>([
    ['a foreign database that happens to have a migrations table', client => {
      client.exec("CREATE TABLE migrations (number integer PRIMARY KEY, applied_at text); INSERT INTO migrations VALUES (1, 'then'); CREATE TABLE members (id text PRIMARY KEY, precious text); CREATE TABLE triggers (id text)");
    }],
    ['an interim household with a table this program never made', client => {
      client.exec(shipped(1)); client.prepare('INSERT INTO migrations VALUES (1, ?)').run(at); client.exec('CREATE TABLE interim_notes (words text)');
    }],
    ['a household whose column was altered by hand', client => {
      client.exec(shipped(2).replace('`role` text NOT NULL', '`role` text')); for (const n of [1, 2]) client.prepare('INSERT INTO migrations VALUES (?, ?)').run(n, at);
    }],
    ['a household that lost a CHECK', client => {
      client.exec(shipped(4).replace(/\tCONSTRAINT "members_role_choice" CHECK\([^\n]*\n/, '').replace(/,\n\);/g, '\n);')); for (const n of [1, 2, 3, 4]) client.prepare('INSERT INTO migrations VALUES (?, ?)').run(n, at);
    }],
    ['a household whose foreign key acts differently', client => {
      client.exec(shipped(3).replace('REFERENCES `triggers`(`id`) ON UPDATE no action ON DELETE no action', 'REFERENCES `triggers`(`id`) ON UPDATE no action ON DELETE cascade')); for (const n of [1, 2, 3]) client.prepare('INSERT INTO migrations VALUES (?, ?)').run(n, at);
    }],
    ['a household marked with a number it skipped to', client => {
      client.exec(shipped(1)); for (const n of [1, 3]) client.prepare('INSERT INTO migrations VALUES (?, ?)').run(n, at);
    }],
    ['a household already at this number with a dropped index', client => {
      createDataSchema(client, () => at); client.exec('DROP INDEX `trigger_edits_trigger_idx`');
    }],
  ])('refuses %s and changes nothing in it', (_, build) => {
    const client = open(); build(client);
    const before = everything(client), marks = client.prepare('SELECT * FROM migrations ORDER BY number').all();
    expect(() => recogniseDataSchema(client)).toThrow('separate move');
    expect(() => upgradeDataSchema(client)).toThrow('separate move');
    expect(everything(client)).toEqual(before);
    expect(client.prepare('SELECT * FROM migrations ORDER BY number').all()).toEqual(marks);
  });

  it('recognises a readable household without opening it for writing', () => {
    const old = household(2), before = everything(old);
    old.pragma('query_only = ON');
    expect(recogniseDataSchema(old)).toBe(2);
    expect(everything(old)).toEqual(before);
  });
});
