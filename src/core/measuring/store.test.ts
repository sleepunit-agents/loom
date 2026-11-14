import Database from 'better-sqlite3';
import { afterEach, expect, it } from 'vitest';
import { createDataSchema } from '../data/database.js';
import { timingDays } from '../data/schema.js';
import { createMeasuring, DEFAULT_MEASURING } from './index.js';
import { timingStore } from './store.js';

const client = new Database(':memory:');
const db = createDataSchema(client);
afterEach(() => db.delete(timingDays).run());

it('atomically rolls up repeated spans while keeping days, kinds and names separate', () => {
  const store = timingStore(db);
  const row = { day: '2026-11-14', kind: 'request' as const, name: 'tasks', count: 1, total_ms: 12.5, slowest_ms: 12.5, typical_ms: 12.5 };
  store.add(row);
  store.add({ ...row, total_ms: 7.5, slowest_ms: 7.5 });
  store.add({ ...row, day: '2026-11-13' });
  store.add({ ...row, kind: 'operation' });
  store.add({ ...row, name: 'memory' });
  const rows = db.select().from(timingDays).all();
  expect(rows).toHaveLength(4);
  expect(rows.find(r => r.day === row.day && r.kind === row.kind && r.name === row.name)).toEqual({
    day: row.day, kind: row.kind, name: row.name, count: 2, totalMs: 20, slowestMs: 12.5, typicalMs: 10,
  });
  store.prune('2026-11-14');
  expect(db.select().from(timingDays).all()).toHaveLength(3);
});

it('feeds actual OpenTelemetry completions into the shared table and leaves off work uncounted', async () => {
  const targets = [{ kind: 'job', name: 'github.read' }] as const;
  const store = timingStore(db);
  const off = await createMeasuring(DEFAULT_MEASURING, targets, store);
  off.run('job', 'github.read', () => 42);
  expect(db.select().from(timingDays).all()).toEqual([]);
  const measuring = await createMeasuring({ ...DEFAULT_MEASURING, on: true }, targets, store);
  try {
    await measuring.runAsync('job', 'github.read', async () => 42);
    const [row] = db.select().from(timingDays).all();
    expect(row).toMatchObject({ kind: 'job', name: 'github.read', count: 1 });
    expect(row.totalMs).toBeGreaterThanOrEqual(0);
    expect(row.typicalMs).toBe(row.totalMs);
  } finally { await measuring.close(); }
});
