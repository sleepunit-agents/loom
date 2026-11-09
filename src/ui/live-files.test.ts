import { mkdtempSync, rmSync, writeFileSync, renameSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import BetterSqlite3 from 'better-sqlite3';
import { dataChanges } from './live-files.js';
const homes: string[] = [];
afterEach(() => { for (const h of homes.splice(0)) rmSync(h, { recursive: true, force: true }); });
const home = () => { const h = mkdtempSync(join(tmpdir(), 'live-files-')); homes.push(h); return h; };
const pattern = /memories\.db(-wal)?$/;
it('suppresses readonly WAL notifications and detects a real memory commit', () => {
  const h = home(); const path = join(h, 'memories.db');
  const db = new BetterSqlite3(path); db.pragma('journal_mode = WAL');
  db.exec('CREATE TABLE memories (text); INSERT INTO memories VALUES (\'before\')');
  try {
    const files = dataChanges(h, pattern);
    const reader = new BetterSqlite3(path, { readonly: true });
    reader.prepare('SELECT * FROM memories').all(); reader.close();
    expect(files.moved('memories.db-wal')).toBe(false);
    db.exec("INSERT INTO memories VALUES ('after')");
    expect(files.moved('memories.db-wal')).toBe(true);
    expect(files.moved('memories.db-wal')).toBe(false);
  } finally { db.close(); }
});
it('detects deletion, recreation and same-size replacement with preserved mtime', () => {
  const h = home(); const p = join(h, 'memories.db');
  writeFileSync(p, 'one'); utimesSync(p, 100, 100);
  const files = dataChanges(h, pattern);
  writeFileSync(join(h, 'replacement'), 'two'); utimesSync(join(h, 'replacement'), 100, 100);
  renameSync(join(h, 'replacement'), p);
  expect(files.moved('memories.db')).toBe(true);
  rmSync(p); expect(files.moved('memories.db')).toBe(true);
  expect(files.moved('memories.db')).toBe(false);
  writeFileSync(p, 'new'); expect(files.moved('memories.db')).toBe(true);
});
it('reconciles writes, creations and deletions during watcher registration', () => {
  const h = home(); writeFileSync(join(h, 'memories.db'), 'old');
  const files = dataChanges(h, pattern);
  rmSync(join(h, 'memories.db')); writeFileSync(join(h, 'memories.db-wal'), 'new');
  expect(files.reconcile().sort()).toEqual(['memories.db', 'memories.db-wal']);
  expect(files.reconcile()).toEqual([]);
});
