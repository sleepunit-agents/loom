import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Household } from '../household.js';
import { CORE_TYPES, coreAnswers, registerCoreSource } from './core-types.js';
import { CONSISTENCY_MS, consistencyMs, nudge, pullDomain, Puller } from './pull.js';
import { indexOf, pendingRefreshes, refreshRequest, withLog, writeTxn } from './log.js';
import type { Provider } from './serve.js';
import type { MemRecord } from './memory.js';

const DOMAIN = 'loom/agent-status';
const provider: Provider = { name: 'loom', owners2: true, types: { 'agent-status': CORE_TYPES['agent-status'] } };
const row = (id: string, reason: string): MemRecord => ({ id, agent: id, reason, audience: { members: ['jonathan'] } });

describe('change-driven collection pulls', () => {
  let h: Household;
  let rows: MemRecord[];
  let calls: Array<readonly string[] | undefined>;
  let ctx: { household: Household; env: NodeJS.ProcessEnv };
  beforeEach(() => {
    h = { home: mkdtempSync(join(tmpdir(), 'loom-change-driven-')), agents: ['art', 'mark'] } as Household;
    ctx = { household: h, env: { LOOM_HOME: h.home } };
    rows = [row('art', 'idle'), row('mark', 'idle')]; calls = [];
    registerCoreSource(h.home, 'agent-status', async (_v, _now, ids) => {
      calls.push(ids); return ids ? rows.filter(r => ids.includes(r.id)) : rows;
    });
  });
  afterEach(() => { vi.useRealTimers(); rmSync(h.home, { recursive: true, force: true }); });
  const pull = () => pullDomain(ctx, provider, DOMAIN);
  const index = () => withLog(h.home, db => indexOf(db, DOMAIN));

  it('keeps different keyed queries and an unfiltered query independent in one batch', async () => {
    const q = { id: 'a', type: 'agent-status', version: 1, where: [], order: [], limit: 100, after: null, fields: ['agent', 'reason'], aggregates: [] };
    const got = await coreAnswers(h, { kind: 'core' }, [
      { ...q, where: [['id', 'in', ['art']]] },
      { ...q, id: 'b', where: [['id', 'in', ['mark']]] },
      { ...q, id: 'all' },
    ]);
    expect(got.map(a => a.rows.map(r => r.id))).toEqual([['art'], ['mark'], ['art', 'mark']]);
  });

  it('a row hint reads only that row, preserves others, and deletes only a missing named row', async () => {
    await pull();
    rows[0] = row('art', 'working');
    await nudge(h.home, DOMAIN, 'art');
    await pull();
    expect(calls).toEqual([undefined, ['art']]);
    expect(index().map(r => r.key).sort()).toEqual(['loom/agent-status/art', 'loom/agent-status/mark']);
    expect(JSON.parse(index().find(r => r.key.endsWith('/art'))!.record).reason).toBe('working');
    rows = rows.filter(r => r.id !== 'art');
    await nudge(h.home, DOMAIN, 'art'); await pull();
    expect(index().map(r => r.key)).toEqual(['loom/agent-status/mark']);
    expect(withLog(h.home, pendingRefreshes)).toEqual([]);
  });

  it('retains a same-key write made during a pull, even in the same millisecond', async () => {
    await pull();
    let release!: () => void;
    let entered!: () => void;
    const started = new Promise<void>(r => { entered = r; });
    const gate = new Promise<void>(r => { release = r; });
    registerCoreSource(h.home, 'agent-status', async () => { const old = [...rows]; entered(); await gate; return old; });
    await nudge(h.home, DOMAIN, 'art');
    const pending = pull(); await started;
    rows[0] = row('art', 'newer');
    await nudge(h.home, DOMAIN, 'art');
    release(); await pending;
    expect(withLog(h.home, db => refreshRequest(db, DOMAIN)).keys).toEqual(['art']);
    registerCoreSource(h.home, 'agent-status', async (_v, _n, ids) => rows.filter(r => !ids || ids.includes(r.id)));
    await pull();
    expect(JSON.parse(index().find(r => r.key.endsWith('/art'))!.record).reason).toBe('newer');
  });

  it('one owner reads, other listeners deliver the shared log, and a dead owner can be replaced', async () => {
    await pull(); const before = calls.length;
    withLog(h.home, db => db.prepare('UPDATE domains SET lease = ?, lease_until = ? WHERE domain = ?').run('other-listener', Date.now() + 30_000, DOMAIN));
    await nudge(h.home, DOMAIN, 'art');
    expect(await pull()).toBe('busy');
    expect(calls.length).toBe(before);
    expect(withLog(h.home, pendingRefreshes)).toHaveLength(1);
    withLog(h.home, db => db.prepare('UPDATE domains SET lease_until = 0 WHERE domain = ?').run(DOMAIN));
    expect(await pull()).toBe('quiet');
    expect(calls.length).toBe(before + 1);
    // Freshness is shared too: a successor does not repeat a recent full consistency read.
    withLog(h.home, db => db.prepare('UPDATE domains SET lease = ?, lease_until = 0 WHERE domain = ?').run('other-listener', DOMAIN));
    expect(await pullDomain(ctx, provider, DOMAIN, true)).toBe('quiet');
    expect(calls.length).toBe(before + 1);
  });

  it('fences a suspended snapshot after a successor has committed', async () => {
    await pull();
    registerCoreSource(h.home, 'agent-status', async () => {
      withLog(h.home, db => writeTxn(db, DOMAIN, index()[0].epoch, [{ op: 'upsert', id: 'art', rev: null, txn: null,
        record: row('art', 'successor'), audience: { members: ['jonathan'] }, agent: 'art' }], () => ({ key: 'loom/agent-status/art', type: 'agent-status' })));
      return rows;
    });
    await nudge(h.home, DOMAIN, 'art');
    expect(await pull()).toBe('busy');
    expect(JSON.parse(index().find(r => r.key.endsWith('/art'))!.record).reason).toBe('successor');
    expect(withLog(h.home, pendingRefreshes)).toHaveLength(1);
  });

  it('an idle open subscription performs zero reads in 19 rounds; stale readers stop checking', async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() });
    const puller = new Puller(() => ctx, () => new Set([DOMAIN]));
    puller.observed(DOMAIN);
    await puller.now(DOMAIN);
    const initial = calls.length;
    for (let i = 0; i < 19; i++) { vi.setSystemTime(Date.now() + 15_000); puller.round(); await puller.settle(); }
    expect(calls.length - initial).toBe(0);
    vi.setSystemTime(Date.now() + 15_000); puller.round(); await puller.settle();
    expect(calls.length - initial).toBe(1);
    vi.setSystemTime(Date.now() + CONSISTENCY_MS); puller.round(); await puller.settle();
    expect(calls.length - initial).toBe(1);
    // A targeted write still reaches a stale reader without restarting full polling.
    rows[0] = row('art', 'new work'); await nudge(h.home, DOMAIN, 'art');
    const req = withLog(h.home, pendingRefreshes)[0]; puller.pending(DOMAIN, req.id); await puller.settle();
    expect(calls.at(-1)).toEqual(['art']); puller.stop();
    process.stdout.write('collection idle seam: 19 rounds / 285 s = 0 provider reads; one slow check at 300 s; stale reader = 0 further checks\n');
  });

  it('targeted writes cannot postpone a full consistency check', async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() });
    const puller = new Puller(() => ctx, () => new Set([DOMAIN]));
    puller.observed(DOMAIN); await puller.now(DOMAIN);
    for (let i = 0; i < 4; i++) {
      vi.setSystemTime(Date.now() + 60_000);
      await nudge(h.home, DOMAIN, 'art');
      puller.pending(DOMAIN, withLog(h.home, pendingRefreshes)[0].id); await puller.settle();
      puller.round(); await puller.settle();
    }
    expect(calls.filter(x => x === undefined)).toHaveLength(1);
    vi.setSystemTime(Date.now() + 60_000);
    await nudge(h.home, DOMAIN, 'art');
    puller.pending(DOMAIN, withLog(h.home, pendingRefreshes)[0].id);
    puller.round(); await puller.settle();
    expect(calls.at(-1)).toBeUndefined();
    expect(calls.filter(x => x === undefined)).toHaveLength(2); puller.stop();
  });

  it('backs off a failing source without acknowledging its hint; a new hint retries immediately', async () => {
    await pull();
    let attempts = 0;
    registerCoreSource(h.home, 'agent-status', async () => { attempts++; throw Error('offline'); });
    await nudge(h.home, DOMAIN, 'art');
    const puller = new Puller(() => ctx, () => new Set([DOMAIN]));
    const req = withLog(h.home, pendingRefreshes)[0];
    puller.pending(DOMAIN, req.id); await puller.settle();
    puller.pending(DOMAIN, req.id); await puller.settle();
    expect(attempts).toBe(1);
    expect(withLog(h.home, pendingRefreshes)).toHaveLength(1);
    await nudge(h.home, DOMAIN, 'art');
    puller.pending(DOMAIN, withLog(h.home, pendingRefreshes)[0].id); await puller.settle();
    expect(attempts).toBe(2); puller.stop();
  });

  it('bounds the repair interval and collapses a large hint queue to one full invalidation', async () => {
    expect(consistencyMs({})).toBe(CONSISTENCY_MS);
    expect(consistencyMs({ LOOM_COLLECTIONS_CHECK_MS: '60000' })).toBe(60_000);
    expect(consistencyMs({ LOOM_COLLECTIONS_CHECK_MS: '1' })).toBe(CONSISTENCY_MS);
    await pull();
    const { markNudged } = await import('./log.js');
    withLog(h.home, db => db.transaction(() => { for (let i = 0; i < 1001; i++) markNudged(db, DOMAIN, Date.now(), `a${i}`); }).immediate());
    expect(withLog(h.home, db => refreshRequest(db, DOMAIN)).keys).toBeUndefined();
    expect(withLog(h.home, db => db.prepare('SELECT COUNT(*) AS n FROM refresh_requests').get())).toEqual({ n: 1 });
  });
});
