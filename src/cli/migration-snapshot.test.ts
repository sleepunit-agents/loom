import { afterEach, expect, test } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { Readable } from 'node:stream';
import { migrateSnapshot, createSnapshot, readSnapshot } from './migration-snapshot.js';
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'loom-snapshot-')); roots.push(root);
  const home = join(root, 'old'); mkdirSync(home);
  writeFileSync(join(home, 'household.json'), '{"defaultAgent":"art"}');
  writeFileSync(join(home, 'comms.key'), 'private-key-material');
  return { root, home, to: join(root, 'snapshot') };
}
test('backs up a live WAL database while an uncommitted writer is active', async () => {
  const { home, to, root } = fixture();
  const path = join(home, 'comms.db');
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.exec('CREATE TABLE messages (id INTEGER PRIMARY KEY, body TEXT); INSERT INTO messages VALUES (1, \'committed\')');
  db.exec('BEGIN IMMEDIATE; INSERT INTO messages VALUES (2, \'uncommitted\')');
  const tasks = join(root, 'store.db');
  const taskDb = new Database(tasks); taskDb.exec('CREATE TABLE tasks (id TEXT)'); taskDb.close();
  try {
    const manifest = await createSnapshot(home, to, tasks);
    expect(manifest.files.map(f => f.path)).toEqual(['home/comms.db', 'home/comms.key', 'home/household.json', 'tasks/store.db']);
    expect(statSync(to).mode & 0o777).toBe(0o700);
    expect(statSync(join(to, 'home/comms.key')).mode & 0o777).toBe(0o600);
    expect(JSON.stringify(manifest)).not.toContain('private-key-material');
    const copy = new Database(join(to, 'home/comms.db'), { readonly: true });
    try { expect(copy.prepare('SELECT * FROM messages').all()).toEqual([{ id: 1, body: 'committed' }]); }
    finally { copy.close(); }
    expect(readSnapshot(to)).toEqual(manifest);
    expect(readFileSync(join(home, 'comms.key'), 'utf8')).toBe('private-key-material');
  } finally { db.exec('ROLLBACK'); db.close(); }
});
test('refuses existing and nested destinations without altering them', async () => {
  const { home, to } = fixture();
  await expect(createSnapshot(home, join(home, 'snapshot'))).rejects.toThrow();
  await createSnapshot(home, to);
  const before = readFileSync(join(to, 'manifest.json'));
  await expect(createSnapshot(home, to)).rejects.toThrow();
  expect(readFileSync(join(to, 'manifest.json'))).toEqual(before);
});
test('removes a partial snapshot on failure and can retry', async () => {
  const { home, to, root } = fixture();
  symlinkSync(join(root, 'missing'), join(home, 'link'));
  await expect(createSnapshot(home, to)).rejects.toThrow('source unchanged');
  expect(existsSync(to)).toBe(false);
  expect(existsSync(to + `.partial-${process.pid}`)).toBe(false);
  rmSync(join(home, 'link'));
  await createSnapshot(home, to);
  expect(readSnapshot(to).files).toHaveLength(2);
});
test('detects a changed snapshot and manifest traversal', async () => {
  const { home, to } = fixture();
  await createSnapshot(home, to);
  writeFileSync(join(to, 'home/comms.key'), 'different');
  expect(() => readSnapshot(to)).toThrow('integrity');
  writeFileSync(join(to, 'manifest.json'), JSON.stringify({ version: 1, files: [{ path: '../old/comms.key' }] }));
  expect(() => readSnapshot(to)).toThrow('path');
});

test('preserves JSON and key contents, including names resembling program files or sidecars', async () => {
  const { home, to } = fixture();
  mkdirSync(join(home, 'dist'));
  writeFileSync(join(home, 'dist/settings.json'), '{"enabled":true}');
  writeFileSync(join(home, 'credentials-journal'), 'private-journal-key');
  await createSnapshot(home, to);
  for (const path of ['household.json', 'comms.key', 'dist/settings.json', 'credentials-journal']) {
    expect(readFileSync(join(to, 'home', path))).toEqual(readFileSync(join(home, path)));
  }
});
test('rejects external manifest and entry symlinks and same-length corruption', async () => {
  const { home, to, root } = fixture();
  await createSnapshot(home, to);
  const key = join(to, 'home/comms.key');
  const original = readFileSync(key);
  writeFileSync(key, Buffer.alloc(original.length, 65));
  expect(() => readSnapshot(to)).toThrow('integrity');
  rmSync(key); symlinkSync(join(home, 'comms.key'), key);
  expect(() => readSnapshot(to)).toThrow('link');
  const manifest = join(to, 'manifest.json');
  const external = join(root, 'external.json');
  writeFileSync(external, '{"version":1,"files":[]}');
  rmSync(manifest); symlinkSync(external, manifest);
  expect(() => readSnapshot(to)).toThrow('manifest link');
});
test('CLI validates arguments and never forwards key material in success or failure output', async () => {
  const { home, to } = fixture();
  const output: string[] = [];
  const io = { stdout: (s: string) => output.push(s), stderr: (s: string) => output.push(s), stdin: Readable.from([]), stdinIsTTY: false, env: {} };
  expect(await migrateSnapshot([], io)).toBe(2);
  expect(await migrateSnapshot(['--from', home, '--to', to], io)).toBe(0);
  expect(await migrateSnapshot(['--from', home, '--to', to], io)).toBe(1);
  expect(output.join('')).not.toContain('private-key-material');
  expect(output.join('')).toContain('"status":"ok"');
});
