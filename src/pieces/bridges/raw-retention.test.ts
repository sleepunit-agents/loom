import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startLoom } from '../../foundation.js';
import { fixture as seedHome } from '../../fixture.js';
import { FakeClock } from '../../core/clock.js';
import { openDb, migrate } from '../../core/index.js';
import { installBridges } from './index.js';
import { schema as s1 } from './schema/001.js';
import { schema as s2 } from './schema/002.js';
import { schema as s3 } from './schema/003.js';
import { schema as s4 } from './schema/004.js';
import { schema as s5 } from './schema/005.js';
import { schema as s6 } from './schema/006.js';
import { installBridgeRawRetention } from './raw-retention.js';
const HOUR = 3_600_000, MINUTE = 60_000, NOW = Date.UTC(2026, 10, 14);
interface RawRow { id: string; event: string | null; state: string; received: number }
const roots: string[] = [], closes: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of closes.splice(0)) await close();
  for (const home of roots.splice(0)) rmSync(home, { recursive: true, force: true });
  vi.restoreAllMocks();
});
async function fixture(home?: string, at = NOW, staging = false, next = true) {
  if (!home) { home = mkdtempSync(join(tmpdir(), 'bridge-raw-retention-')); roots.push(home); seedHome(home); }
  const clock = new FakeClock(at);
  const app = await startLoom({ home, next, staging, clock, port: 0, stdout: () => {},
    install: next ? undefined : app => installBridges(app, () => ({ members: {}, projects: {}, services: {} })) });
  let closed = false;
  const close = async () => { if (!closed) { closed = true; await app.close(); } };
  closes.push(close);
  const seed = (id: string, age: number, binding = 'replaced', state = 'pending') => {
    for (const platform of ['discord', 'slack']) {
      const field = platform === 'discord' ? 'message_id' : 'event_id';
      app.db.prepare(`INSERT INTO bridges_${platform}_receipts(id,venue,binding,${field},event,state,received) VALUES (?,?,?,?,?,?,?)`)
        .run(id, 'removed-venue', binding, id, state === 'pending' ? '{"content":"PRIVATE WORDS"}' : null, state, clock.now() - age);
    }
  };
  const rows = (platform: string) => app.db.prepare(`SELECT id,event,state,received FROM bridges_${platform}_receipts ORDER BY id`).all() as RawRow[];
  return { app, clock, home, close, seed, rows };
}
async function settle() { for (let n = 0; n < 10; n++) await Promise.resolve(); }
it.each([false, true])('expires unreachable words on real next startup without credentials (staging=%s)', async staging => {
  const f = await fixture(undefined, NOW, staging);
  f.seed('old', HOUR + 1); f.seed('edge', HOUR); f.seed('young', 0, 'current'); f.seed('dedup', HOUR * 2, 'old', 'consumed');
  f.app.db.prepare('INSERT INTO bridges_discord_sessions VALUES (?,?)').run('replaced', '{"session":"KEEP"}');
  await f.close();
  const g = await fixture(f.home, NOW, staging);
  for (const platform of ['discord', 'slack']) {
    expect(g.rows(platform)).toEqual([
      { id: 'dedup', event: null, state: 'consumed', received: NOW - HOUR * 2 },
      { id: 'edge', event: '{"content":"PRIVATE WORDS"}', state: 'pending', received: NOW - HOUR },
      { id: 'old', event: null, state: 'consumed', received: NOW - HOUR - 1 },
      { id: 'young', event: '{"content":"PRIVATE WORDS"}', state: 'pending', received: NOW },
    ]);
    // Normal platform INSERT OR IGNORE cannot resurrect an expired id.
    const field = platform === 'discord' ? 'message_id' : 'event_id';
    g.app.db.prepare(`INSERT OR IGNORE INTO bridges_${platform}_receipts VALUES (?,?,?,?,?,'pending',?)`)
      .run('old', 'removed-venue', 'replaced', field, 'REPLAY', NOW);
    expect(g.rows(platform).find((r) => r.id === 'old')).toEqual({ id: 'old', event: null, state: 'consumed', received: NOW - HOUR - 1 });
  }
  expect(g.app.db.prepare('SELECT * FROM bridges_discord_sessions').all()).toEqual([{ binding: 'replaced', checkpoint: '{"session":"KEEP"}' }]);
  expect(g.app.db.prepare('SELECT id FROM core_effects').all()).toEqual([]);
});
it('bounds each minute to 64 oldest receipts per platform and coalesces missed ticks', async () => {
  const f = await fixture();
  for (let n = 0; n < 65; n++) f.seed(String(n).padStart(3, '0'), HOUR + 65 - n);
  installBridgeRawRetention(f.app); // duplicate registration cannot accelerate expiry
  f.clock.advance(3 * MINUTE); await settle();
  for (const platform of ['discord', 'slack']) expect(f.rows(platform).filter((r) => r.state === 'pending').map((r) => r.id)).toEqual(['064']);
  f.clock.advance(MINUTE - 1); await settle();
  expect(f.rows('discord').filter((r) => r.state === 'pending')).toHaveLength(1);
  f.clock.advance(1); await settle();
  for (const platform of ['discord', 'slack']) expect(f.rows(platform).every((r) => r.event === null)).toBe(true);
});
it('atomically rolls back both platforms, sanitizes failures and retries on the next tick', async () => {
  const f = await fixture(); f.seed('old', HOUR + 1);
  f.app.db.exec("CREATE TRIGGER fail_raw BEFORE UPDATE ON bridges_slack_receipts BEGIN SELECT RAISE(ABORT,'PRIVATE ERROR'); END");
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  f.clock.advance(MINUTE); await settle();
  for (const platform of ['discord', 'slack']) expect(f.rows(platform)[0]).toMatchObject({ state: 'pending', event: '{"content":"PRIVATE WORDS"}' });
  expect(warn.mock.calls).toEqual([['Bridges raw receipt retention failed']]);
  f.app.db.exec('DROP TRIGGER fail_raw'); f.clock.advance(MINUTE); await settle();
  for (const platform of ['discord', 'slack']) expect(f.rows(platform)[0]).toMatchObject({ state: 'consumed', event: null });
});
it('recovers a failed startup sweep and cancels queued work on shutdown', async () => {
  const f = await fixture(); f.seed('old', HOUR + 1);
  f.app.db.exec("CREATE TRIGGER fail_raw BEFORE UPDATE ON bridges_slack_receipts BEGIN SELECT RAISE(ABORT,'PRIVATE STARTUP'); END");
  await f.close(); const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const g = await fixture(f.home);
  expect(warn.mock.calls).toEqual([['Bridges raw receipt retention failed']]);
  g.app.db.exec('DROP TRIGGER fail_raw'); g.clock.advance(MINUTE); await settle();
  expect(g.rows('discord')[0]).toMatchObject({ state: 'consumed', event: null });
  const prepare = vi.spyOn(g.app.db, 'prepare');
  g.clock.advance(MINUTE); await g.close(); const calls = prepare.mock.calls.length;
  g.clock.advance(MINUTE); await settle(); expect(prepare.mock.calls).toHaveLength(calls);
});
it('uses partial age indexes in the installed UPDATE rather than scanning permanent tombstones', async () => {
  const f = await fixture();
  const prepare = vi.spyOn(f.app.db, 'prepare');
  f.clock.advance(MINUTE); await settle();
  const statements = prepare.mock.calls.map(([sql]) => sql);
  for (const platform of ['discord', 'slack']) {
    const sql = statements.find(sql => sql.startsWith(`UPDATE bridges_${platform}_receipts`))!;
    expect(sql).toBeDefined();
    const plan = f.app.db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(NOW);
    expect(JSON.stringify(plan)).toContain(`bridges_${platform}_raw_expiry`);
  }
});

it('upgrades a populated version-005 store without modifying rows and is repeatable', () => {
  const home = mkdtempSync(join(tmpdir(), 'bridge-raw-v5-')); roots.push(home);
  const lease = openDb(home), db = lease.db;
  try {
    migrate(db, 'bridges', [...s1, ...s2, ...s3, ...s4, ...s5]);
    db.exec(`INSERT INTO bridges_discord_sessions VALUES ('binding','checkpoint');
      INSERT INTO bridges_discord_receipts VALUES ('id','venue','binding','message','words','pending',1);
      INSERT INTO bridges_slack_receipts VALUES ('id','venue','binding','event',NULL,'consumed',2);
      INSERT INTO bridges_inbox(id,venue,identity,message,state,received) VALUES ('in','venue','identity','words','pending',1);
      INSERT INTO bridges_outbox(id,incoming,venue,identity,address,text,state,created) VALUES ('out','in','venue','identity','address','words','uncertain',1);`);
    const tables = ['bridges_discord_sessions', 'bridges_discord_receipts', 'bridges_slack_receipts', 'bridges_inbox', 'bridges_outbox'];
    const snapshot = () => tables.map(table => db.prepare(`SELECT * FROM ${table}`).all());
    const before = snapshot();
    migrate(db, 'bridges', [...s1, ...s2, ...s3, ...s4, ...s5, ...s6]);
    expect(snapshot()).toEqual(before);
    migrate(db, 'bridges', [...s1, ...s2, ...s3, ...s4, ...s5, ...s6]);
    expect(snapshot()).toEqual(before);
    expect(db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'bridges_%_raw_expiry' ORDER BY name").all()).toEqual([
      {name: 'bridges_discord_raw_expiry'}, {name: 'bridges_slack_raw_expiry'},
    ]);
  } finally { lease.close(); }
});
it('refuses to join an enclosing transaction then retries independently', async () => {
  const f = await fixture(undefined, NOW, false, false); f.seed('old', HOUR + 1);
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  expect(() => f.app.db.transaction(() => {
    installBridgeRawRetention(f.app);
    expect(f.rows('discord')[0]).toMatchObject({ state: 'pending' });
    throw Error('rollback enclosing transaction');
  })()).toThrow('rollback enclosing transaction');
  expect(warn.mock.calls).toEqual([['Bridges raw receipt retention failed']]);
  f.clock.advance(MINUTE); await settle();
  for (const platform of ['discord', 'slack']) expect(f.rows(platform)[0]).toMatchObject({ state: 'consumed', event: null });
});
it('preserves existing normalized pending/uncertain work and Runtime jobs/turns', async () => {
  const f = await fixture(); f.seed('old', HOUR + 1);
  f.app.db.exec(`INSERT INTO bridges_inbox(id,venue,identity,message,state,received) VALUES ('in','venue','identity','words','pending',1);
    INSERT INTO bridges_outbox(id,incoming,venue,identity,address,text,state,created) VALUES ('out','in','venue','identity','address','words','uncertain',1);
    INSERT INTO runtime_jobs VALUES ('job','{"id":"job","state":"running"}',1);
    INSERT INTO runtime_bridge_turns(id,conversation,direction,record) VALUES ('turn','conversation','in','{"text":"words"}');`);
  const tables = ['bridges_inbox', 'bridges_outbox', 'runtime_jobs', 'runtime_bridge_turns'];
  const snapshot = () => tables.map(table => f.app.db.prepare(`SELECT * FROM ${table}`).all());
  const before = snapshot(); f.clock.advance(MINUTE); await settle();
  expect(f.rows('discord')[0]).toMatchObject({ state: 'consumed', event: null });
  expect(snapshot()).toEqual(before);
});
