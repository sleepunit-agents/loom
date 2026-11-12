import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEMAND_TTL_MS, domainOf, indexOf, publishDemand, resetEpoch, sharedDemand, withLog } from './log.js';
import { attach, closeStream, configureCollectionBackground, deliverNow, openStream, prepare, pullNow, stopAll } from './subs.js';
import { PeriodicOwner } from '../transport/periodic-owner.js';
import { CORE_TYPES, registerCoreSource } from './core-types.js';
import { nudge } from './pull.js';
import type { Household } from '../household.js';

let home: string;
let stop: (() => Promise<void>) | undefined;
let owner: PeriodicOwner | undefined;
beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'loom-periodic-demand-')); });
afterEach(async () => { vi.useRealTimers(); await owner?.close(); await stop?.(); stopAll(); rmSync(home, { recursive: true, force: true }); });

it('combines follower demand without letting heartbeats become reads; disconnects and death expire demand', () => {
  withLog(home, db => {
    publishDemand(db, 'lan', new Map([['loom/attention', 100]]), 100);
    publishDemand(db, 'tailnet', new Map([['loom/attention', 200], ['loom/agent-status', 150]]), 200);
    expect([...sharedDemand(db, 201)]).toEqual([['loom/agent-status', 150], ['loom/attention', 200]]);
    publishDemand(db, 'tailnet', new Map([['loom/attention', 200]]), 500);
    expect([...sharedDemand(db, 501)]).toEqual([['loom/attention', 200]]);
    publishDemand(db, 'tailnet', new Map(), 600);
    expect([...sharedDemand(db, 601)]).toEqual([['loom/attention', 100]]);
    expect(sharedDemand(db, 100 + DEMAND_TTL_MS).size).toBe(0);
    publishDemand(db, 'cleanup', new Map(), 100 + DEMAND_TTL_MS);
    expect(db.prepare('SELECT * FROM listener_demand').all()).toEqual([]);
  });
});

it('an owner with no local streams pulls a follower-only domain, while a follower admits no pulls', async () => {
  const h = { home, agents: ['art'] } as Household;
  let calls = 0;
  registerCoreSource(home, 'agent-status', async () => { calls++; return [{ id: 'art', agent: 'art', reason: 'working', audience: { members: ['jonathan'] } }]; });
  withLog(home, db => { domainOf(db, 'loom/agent-status', 'loom'); publishDemand(db, 'remote-listener', new Map([['loom/agent-status', Date.now()]])); });
  owner = new PeriodicOwner(home, () => undefined);
  stop = configureCollectionBackground(() => h, () => ({ LOOM_HOME: home }), owner);
  await nudge(home, 'loom/agent-status');
  // The first two-second poll reads demand but must leave the request pending while ineligible.
  await new Promise(r => setTimeout(r, 2100));
  expect(calls).toBe(0);
  // A killed background owner must not impose the old thirty-second domain lease on takeover.
  withLog(home, db => db.prepare('UPDATE domains SET lease = ?, lease_until = ?').run('periodic:dead-worker', Date.now() + 30_000));
  owner.setEligible(true);
  await expect.poll(() => withLog(home, db => indexOf(db, 'loom/agent-status').length)).toBe(1);
  expect(calls).toBe(1);
}, 15_000);

it('holds ownership until an admitted background pull drains during retirement', async () => {
  const h = { home, agents: ['art'] } as Household;
  let entered = false;
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  registerCoreSource(home, 'agent-status', async () => { entered = true; await gate; return []; });
  withLog(home, db => { domainOf(db, 'loom/agent-status', 'loom'); publishDemand(db, 'remote-listener', new Map([['loom/agent-status', Date.now()]])); });
  owner = new PeriodicOwner(home, () => undefined);
  const successor = new PeriodicOwner(home, () => undefined);
  stop = configureCollectionBackground(() => h, () => ({ LOOM_HOME: home }), owner);
  owner.setEligible(true);
  try {
    await nudge(home, 'loom/agent-status');
    await expect.poll(() => entered).toBe(true);
    owner.setEligible(false);
    successor.setEligible(true);
    expect(successor.active).toBe(false);
    release();
    await expect.poll(() => successor.active).toBe(true);
  } finally { release(); await successor.close(); }
}, 15_000);

it('publishes actual follower subscriptions, renews demand without a read, and withdraws disconnects', async () => {
  const h = { home, agents: ['art'] } as Household;
  owner = new PeriodicOwner(home, () => undefined);
  const env = () => ({ LOOM_HOME: home });
  stop = configureCollectionBackground(() => h, env, owner);
  const provider = { name: 'loom', owners2: true, types: { 'agent-status': CORE_TYPES['agent-status'] } };
  const viewer = { kind: 'core' } as const;
  const port = { id: 'actual-stream', session: 'session', viewer: () => viewer, frame: () => 1, seq: () => 0, behind: () => 0, close: () => {} };
  openStream(() => h, env, port, viewer);
  const { startSeq } = await prepare(() => h, env, provider, 'agent-status');
  const q = { id: 'q', type: 'agent-status', version: 1, where: [], order: [], limit: 100, after: null, fields: ['agent', 'reason'], aggregates: [] };
  expect(await attach(() => h, env, { stream: port.id, session: port.session }, viewer, provider, q,
    { next: null, complete: true }, [], undefined, undefined, startSeq, async () => ({ rows: [], admitted: [] }))).toHaveProperty('scope');
  await deliverNow(home);
  const demand = () => withLog(home, db => db.prepare('SELECT read_at, until FROM listener_demand').get() as { read_at: number; until: number });
  const first = demand(); expect(first.read_at).toBeGreaterThan(0);
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(Date.now() + 11_000);
  await deliverNow(home);
  expect(demand().read_at).toBe(first.read_at); expect(demand().until).toBeGreaterThan(first.until);
  closeStream(home, port.id); await deliverNow(home);
  expect(withLog(home, db => db.prepare('SELECT * FROM listener_demand').all())).toEqual([]);
});

it('a second ineligible registration does not replace or tear down the active owner', async () => {
  const h = { home, agents: ['art'] } as Household;
  let calls = 0;
  registerCoreSource(home, 'agent-status', async () => { calls++; return []; });
  owner = new PeriodicOwner(home, () => undefined); owner.setEligible(true);
  const follower = new PeriodicOwner(home, () => undefined);
  stop = configureCollectionBackground(() => h, () => ({ LOOM_HOME: home }), owner);
  const off = configureCollectionBackground(() => h, () => ({ LOOM_HOME: home }), follower);
  try {
    withLog(home, db => { domainOf(db, 'loom/agent-status', 'loom'); publishDemand(db, 'remote', new Map([['loom/agent-status', Date.now()]])); });
    await nudge(home, 'loom/agent-status'); await expect.poll(() => calls).toBe(1);
    await off(); await nudge(home, 'loom/agent-status'); await expect.poll(() => calls).toBe(2);
  } finally { await follower.close(); await off(); }
}, 15_000);

it('a completed request pull does not retain its lease against the background owner', async () => {
  const h = { home, agents: ['art'] } as Household;
  let calls = 0; registerCoreSource(home, 'agent-status', async () => { calls++; return []; });
  owner = new PeriodicOwner(home, () => {}); owner.setEligible(true);
  stop = configureCollectionBackground(() => h, () => ({ LOOM_HOME: home }), owner);
  await pullNow(home, 'loom/agent-status'); expect(calls).toBe(1);
  withLog(home, db => publishDemand(db, 'remote', new Map([['loom/agent-status', Date.now()]])));
  await nudge(home, 'loom/agent-status'); await expect.poll(() => calls, { timeout: 5000 }).toBe(2);
}, 10_000);

it('shutdown withdraws demand, waits for an automatic reask and suppresses its late frame', async () => {
  const h = { home, agents: ['art'] } as Household;
  owner = new PeriodicOwner(home, () => {});
  stop = configureCollectionBackground(() => h, () => ({ LOOM_HOME: home }), owner);
  const p = { name: 'loom', owners2: true, types: { 'agent-status': CORE_TYPES['agent-status'] } }, viewer = { kind: 'core' } as const;
  const frames = vi.fn(() => 1);
  const port = { id: 'closing', session: 'session', viewer: () => viewer, frame: frames, seq: () => 0, behind: () => 0, close: () => {} };
  openStream(() => h, () => ({ LOOM_HOME: home }), port, viewer);
  const { startSeq } = await prepare(() => h, () => ({ LOOM_HOME: home }), p, 'agent-status');
  let entered = false, release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const q = { id: 'q', type: 'agent-status', version: 1, where: [], order: [], limit: 100, after: null, fields: ['agent','reason'], aggregates: [] };
  await attach(() => h, () => ({ LOOM_HOME: home }), { stream: port.id, session: port.session }, viewer, p, q,
    { next: null, complete: true }, [], undefined, undefined, startSeq, async () => { entered = true; await gate; const rows = [{ id: 'art', agent: 'art', reason: 'late' }]; return { rows, admitted: rows }; });
  const { writeTxn, domainRow } = await import('./log.js');
  withLog(home, db => { const row = domainRow(db, 'loom/agent-status')!; writeTxn(db, 'loom/agent-status', row.epoch,
    [{ key: 'loom/agent-status/art', type: 'agent-status', id: 'art', op: 'upsert' as const, audience: { members: ['jonathan'] }, agent: 'art', record: { id: 'art', agent: 'art', reason: 'late' } }], c => c); });
  await deliverNow(home); await expect.poll(() => entered).toBe(true);
  let closed = false; const closing = stop().then(() => { closed = true; });
  try {
    await Promise.resolve(); expect(closed).toBe(false);
    expect(withLog(home, db => db.prepare('SELECT * FROM listener_demand').all())).toEqual([]);
    const before = frames.mock.calls.length; release(); await closing;
    expect(closed).toBe(true); expect(frames).toHaveBeenCalledTimes(before);
  } finally { release(); await closing; }
});

it.each(['viewer', 'install', 'scope', 'epoch'])('withdrawn %s authority while a reask is pending suppresses its late rows', async mode => {
  const h = { home, agents: ['art'] } as Household;
  owner = new PeriodicOwner(home, () => {});
  stop = configureCollectionBackground(() => h, () => ({ LOOM_HOME: home }), owner);
  const p = { name: 'loom', owners2: true, types: { 'agent-status': CORE_TYPES['agent-status'] }, install: 'one' };
  const serving = await import('./serve.js');
  let install = 'one';
  const registry = vi.spyOn(serving, 'providers').mockImplementation(() => new Map([['loom', { ...p, install }]]));
  const viewer: import('./viewer.js').Viewer = mode === 'scope'
    ? { kind: 'member', person: 'jonathan', household: false, agents: ['art', 'mark'] } : { kind: 'core' };
  let current: import('./viewer.js').Viewer | null = viewer;
  const frames = vi.fn((_event: string, _data: Record<string, unknown>) => 1);
  const port = { id: 'authority-change', session: 'session', viewer: () => current, frame: frames, seq: () => 0, behind: () => 0, close: () => {} };
  openStream(() => h, () => ({ LOOM_HOME: home }), port, viewer);
  const { startSeq } = await prepare(() => h, () => ({ LOOM_HOME: home }), p, 'agent-status');
  let entered = false, release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const q = { id: 'q', type: 'agent-status', version: 1, where: [], order: [], limit: 100, after: null, fields: ['agent','reason'], aggregates: [] };
  await attach(() => h, () => ({ LOOM_HOME: home }), { stream: port.id, session: port.session }, viewer, p, q,
    { next: null, complete: true }, [], undefined, undefined, startSeq, async () => { entered = true; await gate; const rows = [{ id: 'art', agent: 'art', reason: 'late' }]; return { rows, admitted: rows }; });
  const { writeTxn, domainRow } = await import('./log.js');
  withLog(home, db => { const row = domainRow(db, 'loom/agent-status')!; writeTxn(db, 'loom/agent-status', row.epoch,
    [{ key: 'loom/agent-status/art', type: 'agent-status', id: 'art', op: 'upsert' as const, audience: { members: ['jonathan'] }, agent: 'art', record: { id: 'art', agent: 'art', reason: 'late' } }], c => c); });
  try {
    await deliverNow(home); await expect.poll(() => entered).toBe(true);
    if (mode === 'viewer') current = null;
    else if (mode === 'scope') current = { kind: 'member', person: 'jonathan', household: false, agents: ['mark'] };
    else if (mode === 'epoch') withLog(home, db => { const row = db.prepare('SELECT epoch FROM domains WHERE domain = ?').get('loom/agent-status') as { epoch: string }; resetEpoch(db, 'loom/agent-status', row.epoch); });
    else install = 'two';
    const before = frames.mock.calls.length;
    release(); await new Promise(resolve => setImmediate(resolve));
    expect(frames.mock.calls.slice(before).map(([event]) => event)).not.toContain('rows');
  } finally { release(); registry.mockRestore(); }
});
