import { afterEach, beforeEach, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEMAND_TTL_MS, domainOf, indexOf, publishDemand, sharedDemand, withLog } from './log.js';
import { configureCollectionBackground, stopAll } from './subs.js';
import { PeriodicOwner } from '../transport/periodic-owner.js';
import { registerCoreSource } from './core-types.js';
import { nudge } from './pull.js';
import type { Household } from '../household.js';

let home: string;
let stop: (() => Promise<void>) | undefined;
let owner: PeriodicOwner | undefined;
beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'loom-periodic-demand-')); });
afterEach(async () => { await owner?.close(); await stop?.(); stopAll(); rmSync(home, { recursive: true, force: true }); });

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
