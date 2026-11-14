import { afterEach, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { exportDatabaseImage } from './export-image.js';
import { registerExportFilter } from './export.js';
import { startLoom } from '../../foundation.js';
import { fixture, installFixture } from '../../fixture.js';
import { createHash } from 'node:crypto';
import { TokenDatabase } from '../household/tokens.js';
import { HouseholdDatabase } from '../household/document.js';
import { TokenResolver } from '../../household.js';
import { setupLocal, caller, prompt } from '../../__fixtures__/clock-local.js';

const close: (() => void | Promise<void>)[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const stop of close.splice(0).reverse()) await stop(); });
function database() { const db = new Database(':memory:'); close.push(() => db.close()); return db; }
it('rebuilds filtered rows into fresh pages and preserves blobs, constraints, indexes, triggers and sequence high water', () => {
  const db = database();
  db.exec(`CREATE TABLE core_migrations(piece TEXT, number INTEGER, sql TEXT);
    CREATE TABLE data(id INTEGER PRIMARY KEY AUTOINCREMENT, label TEXT UNIQUE, bytes BLOB, gone TEXT);
    CREATE INDEX data_label ON data(label);
    CREATE TABLE audit(label TEXT);
    CREATE TRIGGER data_added AFTER INSERT ON data BEGIN INSERT INTO audit VALUES (NEW.label); END;
    CREATE TABLE comms_words(secret TEXT);
    INSERT INTO comms_words VALUES ('COMMS_NEVER_EXPORT');
    INSERT INTO core_migrations VALUES ('comms',1,'COMMS_MIGRATION');`);
  db.prepare('INSERT INTO data(label,bytes) VALUES (?,?)').run('survives', Buffer.from([0, 255, 1]));
  db.prepare('INSERT INTO data(label) VALUES (?)').run('FILTERED_NEVER_EXPORT');
  db.prepare('INSERT INTO data(id,label) VALUES (?,?)').run(999, 'DELETED_NEVER_EXPORT');
  db.exec('DELETE FROM data WHERE id=999');
  registerExportFilter(db, 'data', (table, row) => !['data', 'audit'].includes(table) || row.label === 'survives');
  const original = db.serialize();
  const image = exportDatabaseImage(db);
  expect(db.serialize()).toEqual(original);
  for (const word of ['COMMS_NEVER_EXPORT', 'COMMS_MIGRATION', 'FILTERED_NEVER_EXPORT', 'DELETED_NEVER_EXPORT']) expect(image.bytes.includes(Buffer.from(word))).toBe(false);
  const restored = new Database(image.bytes); close.push(() => restored.close());
  expect(restored.prepare('SELECT bytes FROM data').get()).toEqual({ bytes: Buffer.from([0, 255, 1]) });
  expect(restored.prepare('SELECT * FROM audit').all()).toEqual([{ label: 'survives' }]);
  expect(restored.prepare("INSERT INTO data(label) VALUES ('next')").run().lastInsertRowid).toBe(1000);
  expect(restored.prepare('SELECT * FROM audit').all()).toEqual([{ label: 'survives' }, { label: 'next' }]);
  expect(() => restored.prepare("INSERT INTO data(label) VALUES ('survives')").run()).toThrow();
  expect(image.tables.find(t => t.name === 'data')).toMatchObject({ rows: 1 });
});
it('refuses a missing owning filter after reopen and never exports private pages as a fallback', () => {
  const db = database(); db.exec('CREATE TABLE core_migrations(piece TEXT, number INTEGER, sql TEXT); CREATE TABLE private_words(word TEXT)');
  db.prepare('INSERT INTO private_words VALUES (?)').run('PRIVATE');
  registerExportFilter(db, 'private', table => table !== 'private_words');
  const reopened = new Database(db.serialize()); close.push(() => reopened.close());
  expect(() => exportDatabaseImage(reopened)).toThrow('installed privacy filter');
});
it('refuses a broken filtered foreign key, unsupported view or rounded integer rather than claiming a restore drill', () => {
  const db = database();
  db.exec('CREATE TABLE core_migrations(piece TEXT, number INTEGER, sql TEXT); CREATE TABLE parent(id INTEGER PRIMARY KEY); CREATE TABLE child(id INTEGER REFERENCES parent(id)); INSERT INTO parent VALUES (1); INSERT INTO child VALUES (1)');
  registerExportFilter(db, 'parent', table => table !== 'parent');
  expect(() => exportDatabaseImage(db)).toThrow('integrity');
  registerExportFilter(db, 'parent', () => true);
  db.exec('CREATE VIEW public_view AS SELECT * FROM parent');
  expect(() => exportDatabaseImage(db)).toThrow('restore policy');
  db.exec('DROP VIEW public_view; INSERT INTO parent VALUES (9007199254740993)');
  expect(() => exportDatabaseImage(db)).toThrow('unsupported number');
  expect(() => db.transaction(() => exportDatabaseImage(db))()).toThrow('offline job');
});
it('exports the installed next household with synthetic token and settings continuity and no legacy file discovery', async () => {
  const home = mkdtempSync(join(tmpdir(), 'export-image-')); close.push(() => rmSync(home, { recursive: true, force: true }));
  fixture(home);
  const app = await startLoom({ home, next: true, install: installFixture, stdout() {} }); close.push(() => app.close());
  const token = 'synthetic-backup-token';
  app.db.transaction(() => new TokenDatabase(app.db).replace({ v: 1, tokens: [{ label: 'fixture', role: 'owner', member: 'jonathan', sha256: createHash('sha256').update(token).digest('hex'), created: '2026-11-12T00:00:00Z' }] }, {}))();
  writeFileSync(join(home, 'household.json'), 'LEGACY_POISON');
  writeFileSync(join(home, 'drill.key'), 'LOCAL_DRILL_POISON');
  const before = readdirSync(home).sort();
  const image = exportDatabaseImage(app.db);
  expect(readdirSync(home).sort()).toEqual(before);
  expect(image.bytes.includes(Buffer.from('LEGACY_POISON'))).toBe(false);
  expect(image.bytes.includes(Buffer.from('LOCAL_DRILL_POISON'))).toBe(false);
  const restored = new Database(image.bytes); close.push(() => restored.close());
  expect(restored.prepare('SELECT * FROM household_settings').all()).toEqual(app.db.prepare('SELECT * FROM household_settings').all());
  expect(restored.prepare('SELECT * FROM household_tokens').all()).toEqual(app.db.prepare('SELECT * FROM household_tokens').all());
  const household = new HouseholdDatabase(restored).household(home)!;
  expect(new TokenResolver(household, { persistence: new TokenDatabase(restored) }).resolve(token)).toMatchObject({ kind: 'owner', member: 'jonathan' });
  expect(restored.prepare("SELECT name FROM sqlite_master WHERE name LIKE 'comms_%'").all()).toEqual([]);
});
it('honors installed Clock and Approvals private exclusions in a real restored image', async () => {
  const s = await setupLocal('once');
  const result = s.request(prompt, 'PRIVATE_APPROVAL_SENTINEL', { ...caller, member: 'jonathan', people: ['jonathan'], project: 'pond' });
  expect(result.ok).toBe(true);
  expect(JSON.stringify(s.app.db.prepare('SELECT * FROM approvals_approvals').all())).toContain('PRIVATE_APPROVAL_SENTINEL');
  const image = exportDatabaseImage(s.app.db);
  expect(image.bytes.includes(Buffer.from('PRIVATE_APPROVAL_SENTINEL'))).toBe(false);
  const restored = new Database(image.bytes); close.push(() => restored.close());
  expect(restored.prepare('SELECT * FROM approvals_approvals').all()).toEqual([]);
});
it.each([
  ['missing row', 'DELETE FROM data', 'rows differ'],
  ['changed row', "UPDATE data SET label='changed'", 'rows differ'],
  ['extra schema', 'CREATE TABLE extra(value TEXT)', 'schema differs'],
  ['changed sequence', "UPDATE sqlite_sequence SET seq=900 WHERE name='data'", 'sequences differ'],
])('rejects an independently reopened image with %s', (_name, damage, error) => {
  const db = database();
  db.exec("CREATE TABLE data(id INTEGER PRIMARY KEY AUTOINCREMENT, label TEXT); INSERT INTO data(label) VALUES ('original')");
  const serialize = Database.prototype.serialize;
  // Damage only the reconstructed database immediately before its image is
  // reopened. The expected rows/schema/sequence were already captured.
  vi.spyOn(Database.prototype, 'serialize').mockImplementation(function (this: Database.Database) {
    this.exec(damage); return serialize.call(this);
  });
  expect(() => exportDatabaseImage(db)).toThrow(error);
  expect(db.prepare('SELECT label FROM data').get()).toEqual({ label: 'original' });
});
it('rejects a failed integrity check even when the image rows still match', () => {
  const db = database(); db.exec('CREATE TABLE data(value TEXT)');
  const pragma = Database.prototype.pragma;
  vi.spyOn(Database.prototype, 'pragma').mockImplementation(function (this: Database.Database, source: string, options?: Database.PragmaOptions) {
    return source === 'integrity_check' ? 'fixture integrity failure' : pragma.call(this, source, options);
  });
  expect(() => exportDatabaseImage(db)).toThrow('restore integrity failed');
});
it('preserves implicit rowids and integer/real storage classes in columns without affinity', () => {
  const db = database();
  db.exec(`CREATE TABLE data(integer_value CHECK(typeof(integer_value)='integer'), real_value CHECK(typeof(real_value)='real'), label TEXT);
    INSERT INTO data(rowid,integer_value,real_value,label) VALUES (42,1,1.0,'first'), (9007199254740993,2,2.0,'second');
    CREATE TRIGGER identity_read AFTER UPDATE ON data BEGIN INSERT INTO identities VALUES (NEW.rowid); END;
    CREATE TABLE identities(value INTEGER);`);
  const image = exportDatabaseImage(db), restored = new Database(image.bytes); close.push(() => restored.close());
  expect(restored.prepare('SELECT rowid,typeof(integer_value) AS i,typeof(real_value) AS r FROM data').safeIntegers().all()).toEqual([
    { rowid: 42n, i: 'integer', r: 'real' }, { rowid: 9007199254740993n, i: 'integer', r: 'real' },
  ]);
  restored.exec("UPDATE data SET label='updated' WHERE rowid=42");
  expect(restored.prepare('SELECT * FROM identities').get()).toEqual({ value: 42 });
});
it.each([
  ['renumbered identity', 'UPDATE data SET rowid=99'],
  ['changed numeric storage class', 'UPDATE data SET value=CAST(value AS REAL)'],
])('rejects %s even when ordinary SELECT * JS values match', (_name, damage) => {
  const db = database(); db.exec('CREATE TABLE data(value); INSERT INTO data(rowid,value) VALUES (42,1)');
  const serialize = Database.prototype.serialize;
  vi.spyOn(Database.prototype, 'serialize').mockImplementation(function (this: Database.Database) { this.exec(damage); return serialize.call(this); });
  expect(() => exportDatabaseImage(db)).toThrow('rows differ');
});
it('supports WITHOUT ROWID and a shadowed rowid alias, but refuses when all aliases are shadowed', () => {
  const db = database(); db.exec("CREATE TABLE data(rowid TEXT PRIMARY KEY) WITHOUT ROWID; INSERT INTO data VALUES ('named'); CREATE TABLE alias(_rowid_ TEXT); INSERT INTO alias(rowid,_rowid_) VALUES (42,'shadow')");
  const restored = new Database(exportDatabaseImage(db).bytes); close.push(() => restored.close());
  expect(restored.prepare('SELECT rowid FROM data').get()).toEqual({ rowid: 'named' });
  expect(restored.prepare('SELECT rowid,_rowid_ FROM alias').get()).toEqual({ rowid: 42, _rowid_: 'shadow' });
  db.exec('CREATE TABLE opaque(rowid TEXT,_rowid_ TEXT,oid TEXT)');
  expect(() => exportDatabaseImage(db)).toThrow('cannot capture table identity');
});
