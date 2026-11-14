import { afterEach, expect, it } from 'vitest';
import BetterSqlite3, { type Database } from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FakeClock } from '../../core/clock.js';
import { Sweep, type SweepDelivery } from '../../core/tempo/sweep.js';
import { SqliteKnowledgeBackend } from '../../backends/sqlite-knowledge.js';
import { knowledgeSweep } from './knowledge-sweep.js';

const cleanup: Array<() => void> = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'fictional-knowledge-sweep-'));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'knowledge.db');
  const store = new SqliteKnowledgeBackend({ dbPath: path }); cleanup.push(() => store.close());
  const db = new BetterSqlite3(path); cleanup.push(() => db.close());
  const reader = new BetterSqlite3(path, { readonly: true }); cleanup.push(() => reader.close());
  const clock = new FakeClock(Date.UTC(2026, 10, 14));
  return { store, db, reader, clock, part: knowledgeSweep(reader, clock, 'checker') };
}
const who = { kind: 'agent', id: 'checker' } as const;
function snapshot(db: Database) {
  return ['pages', 'verifications', 'page_revisions'].map(table => db.prepare(`SELECT * FROM ${table} ORDER BY id`).all());
}

it('reminds at exactly thirty days, routes only to the configured agent, and never stamps on delivery', async () => {
  const { store, db, reader, clock, part } = fixture();
  const anchor = new Date(clock.now() - 30 * 86_400_000 + 1).toISOString();
  await store.writePage({ slug: 'pump', title: 'The fictional pump hose', domain: 'pond', body: 'A made-up fact', verified_at: anchor });
  expect(part.open(who)).toEqual([]);
  clock.advance(1);
  const before = snapshot(reader);
  const deliveries: SweepDelivery[] = [];
  const sweep = new Sweep(clock, d => deliveries.push(d)); sweep.register(part);
  expect(sweep.run(who, 'morning')).toMatchObject([{ part: 'Knowledge', count: 1, ageMs: 0,
    items: [{ id: 'pump', openedAt: new Date(clock.now()).toISOString(), words: expect.stringContaining('pump') }] }]);
  sweep.run(who, 'next-morning');
  expect(deliveries).toHaveLength(2);
  expect(snapshot(reader)).toEqual(before);
  expect(db.prepare('SELECT total_changes() AS n').get()).toEqual({ n: 0 });
  for (const recipient of [{ kind: 'person', id: 'checker' }, { kind: 'agent', id: 'other' }] as const) expect(part.open(recipient)).toEqual([]);
  await store.verifyPages({ slug: 'pump', verified_at: new Date(clock.now()).toISOString(), verifier: 'checker' });
  expect(part.open(who)).toEqual([]);
  await store.verifyPages({ slug: 'pump', outcome: 'stale', verified_at: new Date(clock.now()).toISOString() });
  expect(part.open(who)).toMatchObject([{ id: 'pump', openedAt: new Date(clock.now()).toISOString() }]);
  await store.archivePage({ slug: 'pump' }); expect(part.open(who)).toEqual([]);
  await store.restorePage({ slug: 'pump' }); expect(part.open(who)).toHaveLength(1);
});

it('reads every active due page beyond the tile list cap, without reading bodies or changing the source', async () => {
  const { store, db, reader, clock, part } = fixture();
  await store.writePage({ slug: 'template', title: 'Fictional template', domain: 'testing', body: 'Words' });
  const columns = db.prepare('PRAGMA table_info(pages)').all() as Array<{ name: string }>;
  const fields = columns.map(c => c.name).filter(c => c !== 'id');
  const values = fields.map(c => c === 'slug' || c === 'verified_at' || c === 'uuid' ? `@${c}` : `"${c}"`).join(', ');
  const insert = db.prepare(`INSERT INTO pages (${fields.map(c => `"${c}"`).join(', ')}) SELECT ${values} FROM pages WHERE slug = 'template'`);
  db.transaction(() => { for (let i = 0; i < 2001; i++) insert.run({ slug: `page-${i}`, uuid: `fictional-${i}`, verified_at: new Date(clock.now() - 31 * 86_400_000).toISOString() }); })();
  const before = snapshot(reader);
  expect(part.open(who)).toHaveLength(2001);
  expect(snapshot(reader)).toEqual(before);
});

it('handles absent and older stores without creating anything, and rejects implicit recipients', () => {
  const clock = new FakeClock();
  expect(knowledgeSweep(undefined, clock, 'checker').open(who)).toEqual([]);
  expect(() => knowledgeSweep(undefined, clock, ' ')).toThrow('checking agent');
  const db = new BetterSqlite3(':memory:'); cleanup.push(() => db.close());
  db.exec("CREATE TABLE pages (id INTEGER PRIMARY KEY, slug TEXT, title TEXT, updated TEXT, verified_at TEXT, status TEXT); INSERT INTO pages VALUES (1, 'old', 'Old fictional fact', '2020-01-01', NULL, 'active')");
  expect(knowledgeSweep(db, clock, 'checker').open(who)).toMatchObject([{ id: 'old', openedAt: '2020-01-31T00:00:00.000Z' }]);
  expect(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all()).toEqual([{ name: 'pages' }]);
});
