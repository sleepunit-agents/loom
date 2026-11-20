import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startLoom } from '../../foundation.js';
import { fixture as seedHome } from '../../fixture.js';
import { FakeClock } from '../../core/clock.js';
import { installBridgeFileRetention } from './file-retention.js';
import { installBridges } from './index.js';
import { bridgeFileStore, BRIDGE_FILE_RETENTION } from './file-store.js';
const HOUR = 3600_000;
const NOW = Date.UTC(2026, 10, 14);
const roots: string[] = [], closes: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of closes.splice(0)) await close();
  for (const home of roots.splice(0)) rmSync(home, { recursive: true, force: true });
  vi.restoreAllMocks();
});
async function fixture(home?: string, at = NOW, staging = false, next = true) {
  if (!home) { home = mkdtempSync(join(tmpdir(), 'bridge-retention-')); roots.push(home); seedHome(home); }
  const clock = new FakeClock(at);
  const app = await startLoom({ home, next, staging, clock, port: 0, stdout: () => {},
    install: next ? undefined : app => { installBridges(app, () => ({ members: {}, projects: {}, services: {} })); installBridgeFileRetention(app); },
  });
  let closed = false;
  const close = async () => { if (!closed) { closed = true; await app.close(); } };
  closes.push(close);
  const store = bridgeFileStore(app.db, () => clock.now());
  // Explicit fake save issuer only seeds private bytes. No production issuer exists.
  const save = (delivery: string, file: string, deliveredAt = clock.now()) => store.save({
    agent: 'art', venue: 'slack-art', workspace: 'T1', channel: 'D1', delivery, deliveredAt,
    files: [{ id: file, name: 'photo.jpg', size: 4, url: 'https://files.slack.com/x' }], current: () => true,
  }, [{ id: file, name: 'photo.jpg', bytes: Buffer.from('data') }]);
  const counts = () => ['bridges_files', 'bridges_file_deliveries', 'bridges_file_sources'].map(table =>
    (app.db.prepare(`SELECT count(*) n FROM ${table}`).get() as { n: number }).n);
  return { app, clock, home, close, save, counts };
}
async function settle() { for (let i = 0; i < 10; i++) await Promise.resolve(); }
it.each([false, true])('prunes on actual next startup without adapter credentials (staging=%s)', async staging => {
  const f = await fixture(undefined, NOW, staging);
  f.save('old', 'FOLD', NOW - BRIDGE_FILE_RETENTION + HOUR); f.save('young', 'FYOUNG');
  await f.close();
  const g = await fixture(f.home, NOW + HOUR, staging);
  expect(g.counts()).toEqual([1, 1, 1]);
  expect(g.app.db.prepare('SELECT file FROM bridges_files').all()).toEqual([{ file: 'FYOUNG' }]);
  expect(g.app.db.prepare('SELECT id FROM core_effects').all()).toEqual([]);
});
it('deletes expired bytes and cascaded associations on the running daemon, preserving younger deliveries', async () => {
  const f = await fixture(); f.save('old', 'FOLD', NOW - BRIDGE_FILE_RETENTION + HOUR);
  f.save('young', 'FYOUNG', NOW - BRIDGE_FILE_RETENTION + 2 * HOUR);
  f.clock.advance(HOUR - 1); await settle(); expect(f.counts()).toEqual([2, 2, 2]);
  f.clock.advance(1); await settle(); expect(f.counts()).toEqual([1, 1, 1]);
  f.clock.advance(HOUR); await settle(); expect(f.counts()).toEqual([0, 0, 0]);
});
it('rolls back failed cleanup, logs no source words, and recovers on the next tick', async () => {
  const f = await fixture(); f.save('old', 'FOLD', NOW - BRIDGE_FILE_RETENTION + HOUR);
  f.app.db.exec("CREATE TRIGGER fail_retention BEFORE DELETE ON bridges_file_deliveries BEGIN SELECT RAISE(ABORT,'PRIVATE-SOURCE-WORDS'); END");
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  f.clock.advance(HOUR); await settle();
  expect(f.counts()).toEqual([1, 1, 1]);
  expect(warn.mock.calls).toEqual([['Bridges attachment retention failed']]);
  f.app.db.exec('DROP TRIGGER fail_retention');
  f.clock.advance(HOUR); await settle(); expect(f.counts()).toEqual([0, 0, 0]);
});
it('coalesces missed ticks and cancels queued work when the daemon closes', async () => {
  const f = await fixture(undefined, NOW, false, false); f.save('old', 'FOLD', NOW - BRIDGE_FILE_RETENTION + HOUR);
  const prepare = vi.spyOn(f.app.db, 'prepare');
  installBridgeFileRetention(f.app); // Duplicate installation must be harmless.
  f.clock.advance(365 * 86400_000); await settle();
  expect(prepare.mock.calls.filter(([sql]) => sql === 'DELETE FROM bridges_files WHERE created<=?')).toHaveLength(1);
  expect(f.counts()).toEqual([0, 0, 0]);
  // A queued microtask must see the closing fence before touching SQLite.
  f.clock.advance(HOUR); await f.close();
  const calls = prepare.mock.calls.length;
  f.clock.advance(HOUR); await settle(); expect(prepare.mock.calls).toHaveLength(calls);
});
it('starts despite a failed startup sweep and retries without retaining private exception text', async () => {
  const f = await fixture(); f.save('old', 'FOLD', NOW - BRIDGE_FILE_RETENTION + HOUR);
  f.app.db.exec("CREATE TRIGGER fail_retention BEFORE DELETE ON bridges_file_deliveries BEGIN SELECT RAISE(ABORT,'PRIVATE-STARTUP-WORDS'); END");
  await f.close();
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const g = await fixture(f.home, NOW + HOUR);
  expect(g.counts()).toEqual([1, 1, 1]);
  expect(warn.mock.calls).toEqual([['Bridges attachment retention failed']]);
  g.app.db.exec('DROP TRIGGER fail_retention');
  g.clock.advance(HOUR); await settle(); expect(g.counts()).toEqual([0, 0, 0]);
});
