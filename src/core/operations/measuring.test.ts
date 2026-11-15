import Database from 'better-sqlite3';
import { afterEach, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { FakeClock } from '../clock.js';
import { DEFAULT_MEASURING, type TimingDay } from '../measuring/index.js';
import { measuringRuntime } from '../measuring/runtime.js';
import { Operations } from './index.js';

const owner = { kind: 'member', id: 'owner' } as const;
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0)) await close(); });
function fixture() {
  const db = new Database(':memory:');
  db.exec('CREATE TABLE core_migrations (piece TEXT NOT NULL, number INTEGER NOT NULL, sql TEXT NOT NULL, PRIMARY KEY(piece,number))');
  const clock = new FakeClock();
  const operations = new Operations(db, clock, () => {});
  let settings = { ...DEFAULT_MEASURING };
  const rows: TimingDay[] = [];
  const transactions: boolean[] = [];
  let runtime: ReturnType<typeof measuringRuntime> | undefined;
  cleanup.push(async () => { await runtime?.close(); operations.close(); db.close(); });
  return { db, clock, operations, rows, transactions,
    setOn(on: boolean) { settings = { ...settings, on }; },
    async attach(on = true) {
      settings = { ...settings, on };
      runtime = measuringRuntime(() => settings, operations.timingTargets(), {
        add(row) { rows.push(row); transactions.push(db.inTransaction); }, prune() {},
      }, undefined, clock);
      await runtime.reload();
      operations.measureWith(runtime);
      return runtime;
    },
  };
}

it('counts sync and async-door dispatch once each, after the operation transaction', async () => {
  const { operations, rows, transactions, attach } = fixture();
  const run = vi.fn(() => 42);
  operations.register({ name: 'example.read', input: z.object({}), output: z.number(), may: () => true, run });
  expect(operations.timingTargets()).toEqual([{ kind: 'operation', name: 'example.read' }]);
  await attach();
  expect(operations.call('direct', owner, 'example.read', {})).toEqual({ ok: true, value: 42 });
  expect(await operations.callAsync('http', owner, 'example.read', {})).toEqual({ ok: true, value: 42 });
  expect(run).toHaveBeenCalledTimes(2);
  expect(rows.map(row => [row.kind, row.name, row.count])).toEqual([
    ['operation', 'example.read', 1], ['operation', 'example.read', 1],
  ]);
  expect(transactions).toEqual([false, false]);
});

it('includes asynchronous preparation and receipt replay without executing a write twice', async () => {
  const { operations, rows, attach } = fixture();
  let finish!: (value: string) => void;
  const prepare = vi.fn(() => new Promise<string>(resolve => { finish = resolve; }));
  const run = vi.fn((_ctx, _input, prepared) => prepared);
  operations.register({ name: 'example.save', input: z.object({ words: z.string() }), output: z.string(),
    write: true, may: () => true, prepare, run });
  await attach();
  const input = { words: 'private request text' };
  const pending = operations.callAsync('http', owner, 'example.save', input, 'receipt');
  expect(prepare).toHaveBeenCalledTimes(1);
  expect(rows).toEqual([]);
  finish('private result');
  expect(await pending).toEqual({ ok: true, value: 'private result' });
  expect(rows).toHaveLength(1);
  expect(await operations.callAsync('http', owner, 'example.save', input, 'receipt')).toEqual({ ok: true, value: 'private result' });
  expect(prepare).toHaveBeenCalledTimes(1);
  expect(run).toHaveBeenCalledTimes(1);
  expect(rows).toHaveLength(2);
  expect(JSON.stringify(rows)).not.toMatch(/private|receipt/);
});

it('preserves policy and post-await authentication checks and never records unknown caller names', async () => {
  const { operations, rows, attach } = fixture();
  const run = vi.fn(() => 1);
  operations.register({ name: 'example.denied', input: z.object({}), output: z.number(), may: () => false, run });
  let finish!: () => void;
  operations.register({ name: 'example.prepared', input: z.object({}), output: z.number(), may: () => true,
    prepare: () => new Promise<void>(resolve => { finish = resolve; }), run });
  await attach();
  expect(operations.call('http', owner, 'example.denied', {})).toMatchObject({ ok: false, code: 'denied' });
  let valid = true;
  const pending = operations.callAsync('http', owner, 'example.prepared', {}, undefined, false, () => valid);
  valid = false; finish();
  expect(await pending).toMatchObject({ ok: false, code: 'denied' });
  expect(run).not.toHaveBeenCalled();
  expect(rows.map(row => row.name)).toEqual(['example.denied', 'example.prepared']);
  expect(operations.call('http', owner, 'unknown.private-query', {})).toMatchObject({ code: 'not-found' });
  expect(await operations.callAsync('http', owner, 'unknown.private-query', {})).toMatchObject({ code: 'not-found' });
  expect(rows).toHaveLength(2);
});

it('leaves off and detached dispatch uncounted and records internal nested calls once each', async () => {
  const { operations, rows, attach, setOn } = fixture();
  operations.register({ name: 'example.inner', input: z.object({}), output: z.number(), may: () => false, run: () => 7 });
  const internal = operations.internal('example');
  operations.register({ name: 'example.outer', input: z.object({}), output: z.unknown(), may: () => true,
    run: () => internal.call('example.inner', {}) });
  const expected = { ok: true, value: { ok: true, value: 7 } };
  expect(operations.call('http', owner, 'example.outer', {})).toEqual(expected);
  const runtime = await attach(false);
  expect(await operations.callAsync('http', owner, 'example.outer', {})).toEqual(expected);
  expect(rows).toEqual([]);
  setOn(true);
  await runtime.reload();
  expect(await operations.callAsync('http', owner, 'example.outer', {})).toEqual(expected);
  expect(rows.map(row => row.name)).toEqual(['example.inner', 'example.outer']);
  operations.measureWith(undefined);
  expect(operations.call('http', owner, 'example.outer', {})).toEqual(expected);
  expect(rows).toHaveLength(2);
  await runtime.close();
});
