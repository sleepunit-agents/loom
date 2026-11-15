import Database from 'better-sqlite3';
import { createHmac } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { createDataSchema, dataDatabase } from './database.js';
import { members, secretWriteJournal } from './schema.js';
import { dataHttp } from './http.js';
import { dataQueries } from './queries.js';

const at = '2026-11-14T00:00:00.000Z';
const closed: (() => void)[] = [];
afterEach(() => closed.splice(0).reverse().forEach(close => close()));
function fresh() {
  const client = new Database(':memory:'); closed.push(() => client.close());
  const db = createDataSchema(client, () => at);
  db.insert(members).values({ id: 'sam', role: 'member', joinedAt: at }).run();
  return { client, db };
}
const inputHash = createHmac('sha256', 'synthetic-daemon-key').update('canonical synthetic input').digest('hex');
it('requires a real authenticated member and a nonblank input fingerprint for prepared writes', () => {
  const { client, db } = fresh();
  const insert = (member: string | null, hash: string | null, description: string | null = 'API account') => client.prepare('INSERT INTO secret_write_journal (id,secret,member,description,input_hash,operation,state,started_at) VALUES (?,?,?,?,?,?,?,?)').run('write', 'API', member, description, hash, 'add', 'prepared', at);
  expect(() => insert('unknown', inputHash)).toThrow(/FOREIGN KEY/);
  expect(() => insert(null, inputHash)).toThrow(/NOT NULL/);
  expect(() => insert('sam', null)).toThrow(/NOT NULL/);
  expect(() => insert('sam', inputHash, null)).toThrow(/NOT NULL/);
  for (const blank of ['', '   ', '\t', '\n', '\r', '\v', '\f', '\u0085', '\u00a0', '\u2000', '\u2028', '\ufeff']) expect(() => insert('sam', blank)).toThrow(/CHECK/);
  insert('sam', inputHash);
  expect(db.select().from(secretWriteJournal).get()).toMatchObject({ member: 'sam', description: 'API account', inputHash, state: 'prepared' });
});
it('keeps pending recovery identity, description and keyed fingerprint across close/reopen', () => {
  const directory = mkdtempSync(join(tmpdir(), 'loom-journal-'));
  closed.push(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, 'fresh.sqlite');
  const initial = new Database(path);
  try {
    const db = createDataSchema(initial, () => at);
    db.insert(members).values({ id: 'sam', role: 'member', joinedAt: at }).run();
    db.insert(secretWriteJournal).values({ id: 'holder-write-uuid', secret: 'API', member: 'sam', description: 'Pending account description', inputHash, operation: 'add', state: 'prepared', startedAt: at }).run();
  } finally { initial.close(); }
  const recovered = new Database(path); closed.push(() => recovered.close());
  const db = dataDatabase(recovered, () => at);
  expect(db.select().from(secretWriteJournal).get()).toEqual({ id: 'holder-write-uuid', secret: 'API', member: 'sam', description: 'Pending account description', inputHash, operation: 'add', state: 'prepared', startedAt: at, completedAt: null });
  // Prepared add intentionally precedes secret metadata creation.
  expect(recovered.prepare('SELECT count(*) AS n FROM secrets').get()).toEqual({ n: 0 });
});
it('allows remove recovery without a replacement description and never requires secret value bytes', () => {
  const { db } = fresh();
  db.insert(secretWriteJournal).values({ id: 'remove', secret: 'API', member: 'sam', inputHash, operation: 'remove', state: 'prepared', startedAt: at }).run();
  expect(db.select().from(secretWriteJournal).get()).toMatchObject({ member: 'sam', description: '', inputHash, operation: 'remove' });
});

it('keeps recovery identity and HMAC in internal plumbing, unavailable to outside queries', async () => {
  const { db, client } = fresh();
  expect(() => dataQueries(client, { tables: ['secretWriteJournal' as never], visibility: {} })).toThrow('Unknown query table');
  const app = dataHttp(db, () => ({ viewer: { kind: 'member', id: 'sam' }, valid: () => true }));
  const response = await app.request('/graphql', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ query: '{ secretWriteJournal { id member inputHash } }' }) });
  const result = await response.json();
  expect(result.errors?.[0]?.message).toContain('Cannot query field "secretWriteJournal"');
  expect(result.data).toBeUndefined();
});
