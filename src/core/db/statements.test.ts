import Database from 'better-sqlite3';
import { afterEach, expect, it, vi } from 'vitest';
import { statement, statementMetrics } from './index.js';
const dbs: Database.Database[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const db of dbs.splice(0)) db.close(); });
const database = () => { const db = new Database(':memory:'); dbs.push(db); return db; };
it('prepares once per connection and never retains bindings or results', () => {
  const db = database(), other = database(), prepare = vi.spyOn(db, 'prepare');
  const sql = 'SELECT ? AS value';
  expect(statement(db, sql).get('first private argument')).toEqual({ value: 'first private argument' });
  expect(statement(db, sql).get('second private argument')).toEqual({ value: 'second private argument' });
  expect(statement(other, sql).all('another home')).toEqual([{ value: 'another home' }]);
  expect(prepare).toHaveBeenCalledTimes(1);
  expect(statementMetrics(db).statements).toMatchObject([{ sql, calls: 2, prepares: 1, failures: 0 }]);
  expect(statementMetrics(other).statements).toMatchObject([{ calls: 1 }]);
  expect(JSON.stringify(statementMetrics(db))).not.toContain('private argument');
  const snapshot = statementMetrics(db); snapshot.statements[0].calls = 500;
  expect(statementMetrics(db).statements[0].calls).toBe(2);
});
it('records failed execution and time while preserving rollback and reusable statements', () => {
  const db = database(); db.exec('CREATE TABLE fixture (id INTEGER PRIMARY KEY)');
  let tick = 0; vi.spyOn(performance, 'now').mockImplementation(() => tick += 2);
  const put = statement(db, 'INSERT INTO fixture VALUES (?)');
  expect(() => db.transaction(() => { put.run(1); put.run(1); })()).toThrow();
  expect(db.prepare('SELECT * FROM fixture').all()).toEqual([]);
  put.run(2);
  expect(statementMetrics(db).statements).toMatchObject([{ calls: 3, failures: 1, ms: 6, prepares: 1, prepareMs: 2 }]);
  expect(db.prepare('SELECT * FROM fixture').all()).toEqual([{ id: 2 }]);
});
it('keeps cached statements correct when SQLite recompiles after schema changes', () => {
  const db = database(); db.exec('CREATE TABLE fixture (id INTEGER); INSERT INTO fixture VALUES (1)');
  const read = statement(db, 'SELECT * FROM fixture'); expect(read.get()).toEqual({ id: 1 });
  db.exec('ALTER TABLE fixture ADD COLUMN label TEXT');
  expect(statement(db, 'SELECT * FROM fixture').get()).toEqual({ id: 1, label: null });
});
it('bounds dynamic SQL and reports evictions, and refuses execution after close', () => {
  const db = database();
  for (let n = 0; n < 520; n++) statement(db, `SELECT ${n}`).get();
  expect(statementMetrics(db).statements).toHaveLength(512);
  expect(statementMetrics(db).evictions).toBe(8);
  const cached = statement(db, 'SELECT 519');
  dbs.splice(dbs.indexOf(db), 1); db.close();
  expect(() => cached.get()).toThrow();
});
