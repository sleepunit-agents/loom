import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startLoom } from '../../foundation.js';
import { fixture as seedHome } from '../../fixture.js';
import { FakeClock } from '../../core/clock.js';
import { installBridgeRawRetention } from './raw-retention.js';
const HOUR = 3_600_000, MINUTE = 60_000, NOW = Date.UTC(2026, 10, 14);
interface RawRow { id: string; event: string | null; state: string; received: number }
const roots: string[] = [], closes: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of closes.splice(0)) await close();
  for (const home of roots.splice(0)) rmSync(home, { recursive: true, force: true });
  vi.restoreAllMocks();
});
async function fixture(home?: string, at = NOW, staging = false) {
  if (!home) { home = mkdtempSync(join(tmpdir(), 'bridge-raw-retention-')); roots.push(home); seedHome(home); }
  const clock = new FakeClock(at);
  const app = await startLoom({ home, next: true, staging, clock, port: 0, stdout: () => {} });
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
it('uses partial age indexes rather than scanning permanent tombstones', async () => {
  const f = await fixture();
  for (const platform of ['discord', 'slack']) {
    const plan = f.app.db.prepare(`EXPLAIN QUERY PLAN SELECT id FROM bridges_${platform}_receipts WHERE state='pending' AND received<? ORDER BY received,id LIMIT 64`).all(NOW);
    expect(JSON.stringify(plan)).toContain(`bridges_${platform}_raw_expiry`);
  }
});
