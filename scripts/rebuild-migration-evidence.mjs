import assert from 'node:assert/strict';
import {mkdtempSync, readdirSync, readFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import Database from 'better-sqlite3';
import {dataSchemaNumber, dataSchemaShape, upgradeDataSchema} from '../dist/core/data/database.js';

const installedAt = '2026-01-01T00:00:00.000Z';
const upgradedAt = '2026-02-01T00:00:00.000Z';
const ledger = db => db.prepare('SELECT number, applied_at FROM migrations ORDER BY number').all();
const member = db => db.prepare('SELECT id, role, joined_at FROM members').all();
const schemaVersion = db => db.pragma('schema_version', {simple: true});

// Exercise the installed upgrade routine against disposable copies of every shipped shape.
function migrationEvidence() {
  const shapes = new URL('../src/core/data/shipped-shapes/', import.meta.url);
  const versions = Array.from({length: dataSchemaNumber}, (_, i) => i + 1);
  assert.ok(versions.length > 0);
  assert.deepEqual(readdirSync(shapes).sort(), versions.map(n => n + '.sql').sort());
  const dir = mkdtempSync(join(tmpdir(), 'loom-walk-migrations-'));
  const current = new Database(':memory:');
  try {
    current.exec(readFileSync(new URL('../assets/data/schema.sql', import.meta.url), 'utf8'));
    const shape = dataSchemaShape(current);
    for (const from of versions) {
      const path = join(dir, from + '.db');
      const fixture = new Database(path);
      const expected = Array.from({length: dataSchemaNumber}, (_, i) => ({
        number: i + 1, applied_at: i < from ? installedAt : upgradedAt,
      }));
      const retained = [{id: 'walk-member', role: 'member', joined_at: installedAt}];
      let version;
      try {
        fixture.exec(readFileSync(new URL(from + '.sql', shapes), 'utf8'));
        const insert = fixture.prepare('INSERT INTO migrations (number, applied_at) VALUES (?, ?)');
        for (let n = 1; n <= from; n++) insert.run(n, installedAt);
        fixture.prepare('INSERT INTO members (id, role, joined_at) VALUES (?, ?, ?)').run('walk-member', 'member', installedAt);
        upgradeDataSchema(fixture, () => upgradedAt);
        assert.deepEqual(ledger(fixture), expected);
        assert.deepEqual(dataSchemaShape(fixture), shape);
        assert.deepEqual(member(fixture), retained);
        version = schemaVersion(fixture);
      } finally { fixture.close(); }

      const reopened = new Database(path, {fileMustExist: true});
      try {
        upgradeDataSchema(reopened);
        assert.equal(reopened.prepare('SELECT total_changes()').pluck().get(), 0);
        assert.equal(schemaVersion(reopened), version);
        assert.deepEqual(ledger(reopened), expected);
        assert.deepEqual(member(reopened), retained);
      } finally { reopened.close(); }
    }
    return {ok: true, from: 1, through: dataSchemaNumber,
      reason: 'Every shipped schema reached the installed shape with its original migration dates and member row intact. Each pending number appeared once. Reopening each upgraded database produced zero row or schema changes.'};
  } finally {
    current.close();
    rmSync(dir, {recursive: true, force: true});
  }
}

console.log(JSON.stringify(migrationEvidence()));
