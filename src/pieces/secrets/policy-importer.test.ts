import { afterEach, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import subprocess from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openDb, migrate } from '../../core/index.js';
import { schema } from './schema/001.js';
import { importSecretPolicy, parseLegacySecretPolicy } from './policy-importer.js';
import { readSecretPolicy, requestDecision, secretStartPermission } from './policy.js';
const cleanups: (() => void)[] = [];
afterEach(() => { for (const close of cleanups.splice(0).reverse()) close(); });
function setup(source: unknown) {
  const home = mkdtempSync(join(tmpdir(), 'loom-policy-import-'));
  cleanups.push(() => rmSync(home, { recursive: true, force: true }));
  const opened = openDb(home); cleanups.push(opened.close);
  const from = join(home, 'policy.json'); writeFileSync(from, JSON.stringify(source));
  return { ...opened, from };
}
const fixture = { v: 1, default: 'never', secrets: {
  API: { grant: 'auto', agents: ['art'], houses: ['pond-bot'], minutes: 999 },
  START: { houses: ['art'] }, ASK: { grant: 'ask', minutes: 30 }, NEVER: { grant: 'never', houses: ['art'] },
} };
it('imports exact named policy, preserving independent start/request rules and old duration clamp', () => {
  const { db, from } = setup(fixture); const original = readFileSync(from);
  expect(importSecretPolicy(db, from)).toMatchObject({ imported: true, names: 4 });
  expect(readSecretPolicy(db)).toEqual({ default: 'never', secrets: { ...fixture.secrets, API: { ...fixture.secrets.API, minutes: 480 } } });
  const policy = readSecretPolicy(db);
  expect(requestDecision(policy, 'art', 'API')).toEqual({ level: 'auto', minutes: 480 });
  expect(requestDecision(policy, 'pond-bot', 'API')).toEqual({ level: 'ask', minutes: 480 });
  expect(secretStartPermission(db, 'art', 'API')).toBe('ask');
  expect(secretStartPermission(db, 'pond-bot', 'API')).toBe('allowed');
  expect(secretStartPermission(db, 'art', 'START')).toBe('allowed');
  expect(secretStartPermission(db, 'art', 'NEVER')).toBe('denied');
  expect(requestDecision(policy, 'art', 'ABSENT').level).toBe('never');
  expect(readFileSync(from)).toEqual(original);
  for (const table of ['secrets_names', 'secrets_requests', 'secrets_grants', 'secrets_changes', 'secrets_uses']) expect(db.prepare(`SELECT * FROM ${table}`).all()).toEqual([]);
});
it('same bytes are a no-op after an edit; different bytes refuse without overwriting the edited policy', () => {
  const { db, from } = setup(fixture);
  const first = importSecretPolicy(db, from);
  db.prepare("UPDATE secrets_meta SET value=? WHERE key='policy'").run(JSON.stringify({ default: 'ask', secrets: {} }));
  const before = db.prepare('SELECT * FROM secrets_meta ORDER BY key').all();
  expect(importSecretPolicy(db, from)).toEqual({ ...first, imported: false });
  writeFileSync(from, JSON.stringify({ ...fixture, default: 'auto' }));
  expect(() => importSecretPolicy(db, from)).toThrow('different secret policy source');
  expect(db.prepare('SELECT * FROM secrets_meta ORDER BY key').all()).toEqual(before);
});
it('interruption rolls back schema, policy and receipt together, then the same source succeeds', () => {
  const { db, from } = setup(fixture);
  const before = db.prepare('SELECT * FROM sqlite_master ORDER BY name').all();
  expect(() => importSecretPolicy(db, from, { interrupt: () => { throw new Error('interrupted'); } })).toThrow('interrupted');
  expect(db.prepare('SELECT * FROM sqlite_master ORDER BY name').all()).toEqual(before);
  expect(db.prepare('SELECT * FROM core_migrations').all()).toEqual([]);
  expect(importSecretPolicy(db, from).imported).toBe(true);
});
it('refuses populated policy and detects corrupted persisted content with complete rollback', () => {
  const { db, from } = setup(fixture); migrate(db, 'secrets', schema);
  db.prepare("INSERT INTO secrets_meta VALUES ('policy','{}')").run();
  expect(() => importSecretPolicy(db, from)).toThrow('destination must be empty');
  db.prepare("DELETE FROM secrets_meta WHERE key='policy'").run();
  db.exec("CREATE TRIGGER corrupt_policy AFTER INSERT ON secrets_meta WHEN NEW.key='policy' BEGIN UPDATE secrets_meta SET value='{}' WHERE key='policy'; END");
  expect(() => importSecretPolicy(db, from)).toThrow('comparison failed');
  expect(db.prepare('SELECT * FROM secrets_meta').all()).toEqual([]);
});
it('refuses malformed, unsupported and value-bearing sources without leaking their content or writing any schema', () => {
  const { db, from } = setup({}); const sentinel = 'SENTINEL-ACCIDENTAL-VALUE';
  for (const text of [sentinel, JSON.stringify({ value: sentinel }), JSON.stringify({ v: 2 }), JSON.stringify({ default: 'yes' }),
    JSON.stringify({ secrets: { API: { grant: 'auto', value: sentinel } } }), JSON.stringify({ secrets: { API: { minutes: 0 } } }),
    JSON.stringify({ secrets: { API: { agents: [null] } } }), JSON.stringify({ secrets: { 'bad name': {} } }), 'null', '[]']) {
    writeFileSync(from, text);
    expect(() => importSecretPolicy(db, from)).toThrow(/^Invalid legacy secret policy$/);
  }
  expect(db.prepare('SELECT * FROM core_migrations').all()).toEqual([]);
  expect(() => importSecretPolicy(db, from + '.missing')).toThrow(/^Cannot read legacy secret policy$/);
});
it('ports omitted policy defaults without inventing start grants or auto agent membership', () => {
  expect(parseLegacySecretPolicy(Buffer.from('{}'))).toEqual({ default: 'ask', secrets: {} });
  expect(parseLegacySecretPolicy(Buffer.from('{"v":1,"default":"auto","secrets":{"API":{"grant":"auto"}}}'))).toEqual({ default: 'auto', secrets: { API: { grant: 'auto' } } });
});
it('receipt failure and asynchronous interruption leave an initialized destination unchanged', () => {
  const { db, from } = setup(fixture); migrate(db, 'secrets', schema);
  const before = db.prepare('SELECT * FROM core_migrations ORDER BY number').all();
  db.exec("CREATE TRIGGER fail_receipt BEFORE INSERT ON secrets_meta WHEN NEW.key='policy-source-checksum' BEGIN SELECT RAISE(ABORT,'receipt failed'); END");
  expect(() => importSecretPolicy(db, from)).toThrow('receipt failed');
  expect(db.prepare('SELECT * FROM secrets_meta').all()).toEqual([]);
  db.exec('DROP TRIGGER fail_receipt');
  expect(() => importSecretPolicy(db, from, { interrupt: async () => { throw new Error('async interrupted'); } })).toThrow('must be synchronous');
  expect(db.prepare('SELECT * FROM secrets_meta').all()).toEqual([]);
  expect(db.prepare('SELECT * FROM core_migrations ORDER BY number').all()).toEqual(before);
  expect(importSecretPolicy(db, from).imported).toBe(true);
});

it('clamps all old positive integer durations, including beyond safe-integer range', () => {
  for (const minutes of [481, 999, Number.MAX_SAFE_INTEGER, 9007199254740992, 1e100]) {
    expect(parseLegacySecretPolicy(Buffer.from(JSON.stringify({ secrets: { API: { minutes } } })))).toEqual({ default: 'ask', secrets: { API: { minutes: 480 } } });
  }
});
it('reads only the explicit policy file and invokes no old program', () => {
  const { db, from } = setup(fixture); const bytes = readFileSync(from);
  const read = vi.spyOn(fs, 'readFileSync').mockImplementation(path => {
    if (path !== from) throw new Error('Unexpected filesystem read');
    return bytes;
  });
  const processes = (['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork'] as const)
    .map(name => vi.spyOn(subprocess, name).mockImplementation(() => { throw new Error('Unexpected child process'); }));
  syncBuiltinESMExports();
  try {
    expect(importSecretPolicy(db, from).imported).toBe(true);
    expect(read.mock.calls).toEqual([[from]]);
    for (const process of processes) expect(process).not.toHaveBeenCalled();
  } finally { vi.restoreAllMocks(); syncBuiltinESMExports(); }
});
it('commits SHA-256 of source bytes and refuses a whitespace-only change', () => {
  const { db, from } = setup(fixture); const bytes = readFileSync(from);
  const checksum = createHash('sha256').update(bytes).digest('hex');
  expect(importSecretPolicy(db, from).checksum).toBe(checksum);
  expect(db.prepare("SELECT value FROM secrets_meta WHERE key='policy-source-checksum'").get()).toEqual({ value: checksum });
  const before = db.prepare('SELECT * FROM secrets_meta ORDER BY key').all();
  writeFileSync(from, bytes.toString() + '\n');
  expect(() => importSecretPolicy(db, from)).toThrow('different secret policy source');
  expect(db.prepare('SELECT * FROM secrets_meta ORDER BY key').all()).toEqual(before);
});
it('detects changed membership even when the stored policy has exactly the expected names', () => {
  const { db, from } = setup(fixture); migrate(db, 'secrets', schema);
  const corrupted = { default: 'never', secrets: { ...fixture.secrets, API: { ...fixture.secrets.API, minutes: 480, houses: ['art'] } } };
  db.exec("CREATE TRIGGER corrupt_membership AFTER INSERT ON secrets_meta WHEN NEW.key='policy' BEGIN UPDATE secrets_meta SET value='" + JSON.stringify(corrupted) + "' WHERE key='policy'; END");
  expect(() => importSecretPolicy(db, from)).toThrow('comparison failed');
  expect(db.prepare('SELECT * FROM secrets_meta').all()).toEqual([]);
});
