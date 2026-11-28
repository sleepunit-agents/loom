import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { installTableTracker, recordReads, tableTracker, trackerStatement, type WrittenTables } from './table-tracker.js';
import { DataWrites } from './writes.js';
import { createDataSchema, dataDatabase } from './database.js';

const clean: (() => void)[] = [];
afterEach(() => { clean.splice(0).reverse().forEach(fn => fn()); });

function setup(file = ':memory:') {
  const client = new Database(file); clean.push(() => client.close());
  client.pragma('foreign_keys = ON');
  client.exec(`
    CREATE TABLE parents (id INTEGER PRIMARY KEY, name TEXT);
    CREATE INDEX parents_name ON parents(name);
    CREATE TABLE children (id INTEGER PRIMARY KEY, parent INTEGER REFERENCES parents(id) ON DELETE CASCADE, name TEXT);
    CREATE TABLE audit (what TEXT);
    CREATE TABLE quiet (x);
    CREATE TRIGGER parents_audit AFTER INSERT ON parents BEGIN INSERT INTO audit VALUES (new.name); END;
    CREATE VIEW family AS SELECT parents.name AS parent, children.name AS child FROM parents JOIN children ON children.parent = parents.id;
    INSERT INTO parents (id, name) VALUES (1, 'Ada');
    INSERT INTO children (parent, name) VALUES (1, 'Byron');`);
  const tracker = installTableTracker(client);
  return { client, tracker };
}
const tables = (written: WrittenTables) => written === 'unknown' ? written : [...written].sort();

it('installs once per connection and runs no statement doing so', () => {
  const statements: string[] = [];
  const client = new Database(':memory:', { verbose: sql => statements.push(String(sql)) }); clean.push(() => client.close());
  const tracker = installTableTracker(client);
  expect(installTableTracker(client)).toBe(tracker);
  expect(tableTracker(client)).toBe(tracker);
  expect(statements).toEqual([]);
});

it('names every statement it runs itself, and only those, for tests that count a connection\'s statements', () => {
  const statements: string[] = [];
  const client = new Database(':memory:', { verbose: sql => statements.push(String(sql)) }); clean.push(() => client.close());
  client.exec('CREATE TABLE things (a, b)');
  installTableTracker(client);
  const reads = ["SELECT a FROM things WHERE b = 'x'", 'SELECT lower(a) FROM things', 'WITH n AS (SELECT 1) SELECT * FROM n'];
  client.prepare('INSERT INTO things VALUES (1, 2)').run();
  for (const sql of reads) client.prepare(sql).all();
  client.prepare('EXPLAIN QUERY PLAN SELECT a FROM things').all();
  const own = statements.filter(trackerStatement), rest = statements.filter(sql => !trackerStatement(sql));
  // What is left is exactly what this test ran, in order.
  expect(rest).toEqual(['CREATE TABLE things (a, b)', 'INSERT INTO things VALUES (1, 2)', ...reads, 'EXPLAIN QUERY PLAN SELECT a FROM things']);
  expect(own).toContain('PRAGMA schema_version');
  expect(own.some(sql => sql.startsWith('EXPLAIN SELECT a FROM things'))).toBe(true);
  expect(own.some(sql => sql.startsWith('EXPLAIN INSERT INTO things'))).toBe(true);
  expect(own.some(sql => /pragma_function_list/.test(sql))).toBe(true);
  expect(trackerStatement('EXPLAIN QUERY PLAN SELECT 1')).toBe(false);
  expect(trackerStatement('SELECT type, name FROM sqlite_schema')).toBe(false);
});

it('reads a view as the tables under it, including through an index', () => {
  const { client, tracker } = setup();
  const view = tracker.shape('SELECT * FROM family WHERE parent = ?');
  expect([...view.reads].sort()).toEqual(['children', 'parents']);
  expect(view.writes).toEqual([]);
  expect(view.unknown).toBeUndefined();
  const { record } = recordReads(() => client.prepare("SELECT name FROM parents WHERE name = ?").all('Ada'));
  expect([...record.tables]).toEqual(['parents']);
  expect(record.unscoped.size).toBe(0);
  expect(record.statements).toBe(1);
});

it('counts what a trigger writes as written by the statement that fired it', () => {
  const { client, tracker } = setup();
  const insert = client.prepare('INSERT INTO parents (name) VALUES (?)');
  expect(tables(tracker.capture(() => insert.run('Grace')).written)).toEqual(['audit', 'parents']);
});

it('counts the rows a foreign key cascade deletes', () => {
  const { client, tracker } = setup();
  expect(tables(tracker.capture(() => client.prepare('DELETE FROM parents WHERE id = ?').run(1)).written)).toEqual(['children', 'parents']);
  expect(client.prepare('SELECT count(*) FROM children').pluck().get()).toBe(0);
});

it('counts a table cleared whole', () => {
  const { client, tracker } = setup();
  client.prepare('INSERT INTO quiet (x) VALUES (1)').run();
  tracker.capture(() => undefined);
  expect(tables(tracker.capture(() => client.prepare('DELETE FROM quiet').run()).written)).toEqual(['quiet']);
});

it('counts a writing statement that changed no row as writing nothing, unless a trigger or cascade wrote', () => {
  const { client, tracker } = setup();
  expect(tables(tracker.capture(() => client.prepare('UPDATE children SET name = ? WHERE id = 99').run('Nobody')).written)).toEqual([]);
  expect(tables(tracker.capture(() => client.prepare('DELETE FROM quiet').run()).written)).toEqual([]);
  // INSERT OR IGNORE that hit its conflict wrote nothing; the trigger fired for a new row wrote audit.
  expect(tables(tracker.capture(() => client.prepare('INSERT OR IGNORE INTO parents (id, name) VALUES (1, ?)').run('Again')).written)).toEqual([]);
  expect(tables(tracker.capture(() => client.prepare('INSERT INTO parents (id, name) VALUES (2, ?)').run('Bo')).written)).toEqual(['audit', 'parents']);
  // A row changed by an INSTEAD OF trigger only is still counted: the connection's count includes it.
  client.exec("CREATE VIEW renames AS SELECT id, name FROM children; CREATE TRIGGER renames_set INSTEAD OF UPDATE ON renames BEGIN UPDATE children SET name = new.name WHERE id = old.id; END;");
  tracker.capture(() => undefined);
  expect(tables(tracker.capture(() => client.prepare('UPDATE renames SET name = ? WHERE id = 1').run('Via view')).written)).toEqual(['children']);
  // Through iterate (RETURNING read row by row) it is counted as writing whatever it did.
  expect(tables(tracker.capture(() => { for (const row of client.prepare('UPDATE quiet SET x = 1 WHERE x = 99 RETURNING x').iterate()) void row; }).written)).toEqual(['quiet']);
});

it('over-reports a write that was rolled back, and says nothing for transaction control alone', () => {
  const { client, tracker } = setup();
  const { written } = tracker.capture(() => {
    try { client.transaction(() => { client.prepare('UPDATE children SET name = ?').run('Lord'); throw new Error('no'); })(); } catch { /* rolled back */ }
  });
  expect(tables(written)).toEqual(['children']);
  expect(client.prepare('SELECT name FROM children').pluck().get()).toBe('Byron');
  expect(tables(tracker.capture(() => client.transaction(() => undefined)()).written)).toEqual([]);
});

it('carries a write made with no capture open into the next capture', () => {
  const { client, tracker } = setup();
  client.prepare('UPDATE children SET name = ?').run('Loose');
  expect(tables(tracker.capture(() => client.prepare('INSERT INTO quiet (x) VALUES (1)').run()).written)).toEqual(['children', 'quiet']);
  expect(tables(tracker.capture(() => client.prepare('INSERT INTO quiet (x) VALUES (2)').run()).written)).toEqual(['quiet']);
  client.exec('UPDATE quiet SET x = 3');
  expect(tracker.capture(() => undefined).written).toBe('unknown');
});

it('takes anything run through exec as unknown, to a write and to a reading', () => {
  const { client, tracker } = setup();
  expect(tracker.capture(() => client.exec("UPDATE quiet SET x = 1")).written).toBe('unknown');
  const { record } = recordReads(() => client.exec('SELECT 1'));
  expect([...record.unscoped]).toEqual(['exec']);
});

it('takes a virtual table, sqlite_schema, a pragma and another database as unknown', () => {
  const { client, tracker } = setup();
  client.exec("CREATE VIRTUAL TABLE words USING fts5(text); ATTACH ':memory:' AS other; CREATE TABLE other.elsewhere (x); CREATE TEMP TABLE scratch (x)");
  expect(tracker.shape('SELECT * FROM words WHERE words MATCH ?').unknown).toBe('a virtual table');
  expect(tracker.capture(() => client.prepare('INSERT INTO words (text) VALUES (?)').run('hello')).written).toBe('unknown');
  // Only reading a virtual table, or sqlite_schema, leaves a commit's writes known.
  expect(tables(tracker.capture(() => { client.prepare('SELECT * FROM words WHERE words MATCH ?').all('hello'); client.prepare('SELECT name FROM sqlite_schema').all(); client.prepare('INSERT INTO quiet (x) VALUES (5)').run(); }).written)).toEqual(['quiet']);
  expect(tracker.shape('SELECT name FROM sqlite_schema').unknown).toBe('sqlite_schema');
  expect(tracker.shape('SELECT * FROM other.elsewhere').unknown).toBe('an attached database');
  expect(tracker.shape('SELECT * FROM scratch').unknown).toBe('the temp database');
  expect(tracker.shape('PRAGMA user_version').unknownWrite).toBe('statement PRAGMA');
  const { record } = recordReads(() => { client.prepare('SELECT name FROM sqlite_schema').all(); client.pragma('user_version'); });
  expect([...record.unscoped].sort()).toEqual(['sqlite_schema', 'statement PRAGMA']);
});

it('takes the clock and other functions that are not deterministic as unscoped reads', () => {
  const { client } = setup();
  dataDatabase(client, () => '2026-11-27T00:00:00.000Z');
  client.function('steady', { deterministic: true }, (x: unknown) => x);
  const read = (sql: string, ...args: unknown[]) => [...recordReads(() => client.prepare(sql).all(...args)).record.unscoped];
  expect(read('SELECT loom_now() FROM parents')).toEqual(['function loom_now()']);
  expect(read('SELECT random() FROM parents')).toEqual(['function random()']);
  expect(read("SELECT datetime('now') FROM parents")).toEqual(['the clock (now)']);
  expect(read('SELECT datetime(?) FROM parents', 'now')).toEqual(['the clock (now)']);
  expect(read('SELECT datetime(?) FROM parents', '2026-01-01')).toEqual([]);
  expect(read('SELECT steady(name), count(*), max(id) FROM parents')).toEqual([]);
});

it('classifies statements prepared before it was installed, and counts another connection as another database', () => {
  const client = new Database(':memory:'); clean.push(() => client.close());
  client.exec('CREATE TABLE early (x)');
  const before = client.prepare('SELECT * FROM early');
  installTableTracker(client);
  expect([...recordReads(() => before.all()).record.tables]).toEqual(['early']);
  const other = new Database(':memory:'); clean.push(() => other.close());
  other.exec('CREATE TABLE early (x)');
  const { record } = recordReads(() => other.prepare('SELECT * FROM early').all());
  expect([...record.unscoped]).toEqual(['another database']);
  expect(record.tables.size).toBe(0);
});

it('classifies again after the schema changes, here or from another connection', () => {
  const directory = mkdtempSync(join(tmpdir(), 'loom-tracker-')); clean.push(() => rmSync(directory, { recursive: true, force: true }));
  const { client, tracker } = setup(join(directory, 'data.db'));
  const insert = client.prepare('INSERT INTO quiet (x) VALUES (?)');
  expect(tables(tracker.capture(() => insert.run(1)).written)).toEqual(['quiet']);
  const generation = tracker.generation;
  // Our own DDL, through exec.
  client.exec('CREATE TABLE echo (x); CREATE TRIGGER quiet_echo AFTER INSERT ON quiet BEGIN INSERT INTO echo VALUES (new.x); END;');
  expect(tracker.generation).toBeGreaterThan(generation);
  // The script ran with no capture open: it is carried into the next one, which is unknown for it.
  expect(tracker.capture(() => insert.run(2)).written).toBe('unknown');
  expect(tables(tracker.capture(() => insert.run(2)).written)).toEqual(['echo', 'quiet']);
  // Another connection's DDL is seen at the next prepare or capture.
  const other = new Database(join(directory, 'data.db')); clean.push(() => other.close());
  other.exec('CREATE TABLE more (x); CREATE TRIGGER quiet_more AFTER INSERT ON quiet BEGIN INSERT INTO more VALUES (new.x); END;');
  const { written } = tracker.capture(() => insert.run(3));
  // Another process changed the file since the last capture: unknown, whatever this capture saw.
  expect(written).toBe('unknown');
  expect(tables(tracker.capture(() => insert.run(4)).written)).toEqual(['echo', 'more', 'quiet']);
});

it('takes a write by another connection since the last capture as unknown', () => {
  const directory = mkdtempSync(join(tmpdir(), 'loom-tracker-')); clean.push(() => rmSync(directory, { recursive: true, force: true }));
  const { client, tracker } = setup(join(directory, 'data.db'));
  const insert = client.prepare('INSERT INTO quiet (x) VALUES (?)');
  expect(tables(tracker.capture(() => insert.run(1)).written)).toEqual(['quiet']);
  const other = new Database(join(directory, 'data.db')); clean.push(() => other.close());
  other.prepare('INSERT INTO children (parent, name) VALUES (1, ?)').run('Ann');
  expect(tracker.capture(() => insert.run(2)).written).toBe('unknown');
  expect(tables(tracker.capture(() => insert.run(3)).written)).toEqual(['quiet']);
});

it('tells DataWrites.changed which tables the outer run wrote, nested runs included', () => {
  const client = new Database(':memory:'); clean.push(() => client.close());
  const db = createDataSchema(client);
  const tracker = installTableTracker(client);
  const told: WrittenTables[] = [];
  const writes = new DataWrites(db, { refreshAccess() {}, changed: written => { told.push(written!); } }, tracker);
  writes.run(() => {
    client.prepare("INSERT INTO members (id, role, joined_at) VALUES ('sam','member','2026-11-14T00:00:00.000Z')").run();
    writes.run(() => client.prepare("INSERT INTO projects (id, name) VALUES ('pond','Pond')").run());
  });
  expect(told).toHaveLength(1);
  expect(told[0]).not.toBe('unknown');
  expect(told[0]).toEqual(expect.any(Set));
  expect([...(told[0] as Set<string>)]).toEqual(expect.arrayContaining(['members', 'projects']));
  // Without a tracker, as with LOOM_LIVE_SCOPE off, it is told unknown.
  const plain: unknown[] = [];
  new DataWrites(db, { refreshAccess() {}, changed: written => { plain.push(written); } }).run(() => client.prepare("INSERT INTO projects (id, name) VALUES ('dam','Dam')").run());
  expect(plain).toEqual(['unknown']);
});
