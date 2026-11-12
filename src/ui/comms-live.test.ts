import { waitForLocks } from '../lock-gate.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PeriodicOwner } from '../transport/periodic-owner.js';
import Database from 'better-sqlite3';
import { liveDbPath, withLog } from '../collections/log.js';
import { changedFor } from './live.js';
import { afterEach, expect, it, vi } from 'vitest';

const reads = vi.hoisted(() => ({ COMMS_DB: 'comms.db', movedSince: vi.fn((_home: string, _since: number): Array<{ id: string; member: string; updated: number }> => []), seqsOf: vi.fn(), threadState: vi.fn(), onBump: vi.fn(() => () => {}) }));
vi.mock('../comms.js', () => ({ ...reads, movesAfter: (home: string, since: number) => reads.movedSince(home, since).map(m => ({ ...m, seq: m.updated })) }));
vi.mock('../lock-gate.js', async importOriginal => { const actual = await importOriginal<typeof import('../lock-gate.js')>(); return { ...actual, waitForLocks: vi.fn(actual.waitForLocks) }; });
vi.mock('./live.js', () => ({ changedFor: vi.fn() }));
import { openThreadStream, stopCommsWatch, watchComms } from './comms-live.js';

afterEach(() => { stopCommsWatch(); vi.useRealTimers(); vi.restoreAllMocks(); });

// SQLITE_BUSY_RECOVERY is busy too: a WAL recovery in another connection (the deploy that refused Comms posts).
it.each(['SQLITE_BUSY', 'SQLITE_LOCKED', 'SQLITE_BUSY_RECOVERY'])('retries %s on the next poll without terminating the listener', async (code) => {
  vi.useFakeTimers();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  reads.movedSince.mockClear();
  reads.movedSince.mockImplementationOnce(() => { throw Object.assign(new Error('database is locked'), { code }); });
  watchComms('/missing-comms-busy-test');
  await expect(vi.advanceTimersByTimeAsync(2000)).resolves.not.toThrow();
  expect(reads.movedSince).toHaveBeenCalledTimes(1);
  const since = reads.movedSince.mock.calls[0];
  await vi.advanceTimersByTimeAsync(2000);
  expect(reads.movedSince).toHaveBeenCalledTimes(2);
  expect(reads.movedSince.mock.calls[1]).toEqual(since);
});

it('reports unexpected polling failures without terminating the listener', async () => {
  vi.useFakeTimers();
  const report = vi.spyOn(console, 'error').mockImplementation(() => {});
  reads.movedSince.mockImplementationOnce(() => { throw new Error('unexpected'); });
  watchComms('/missing-comms-bug-test');
  await vi.advanceTimersByTimeAsync(2000);
  expect(report).toHaveBeenCalledWith(expect.stringContaining('Comms live update failed'), expect.objectContaining({ message: 'unexpected' }));
  await vi.advanceTimersByTimeAsync(2000);
  expect(reads.movedSince.mock.calls.length).toBeGreaterThanOrEqual(2);
});

it('names the actual Comms timer continuation after its async database probe', async () => {
  const { watchStalls } = await import('../transport/stall-watch.js');
  const lines: string[] = [];
  const w = watchStalls({ thresholdMs: 100, tickMs: 20, log: (l) => lines.push(l) });
  reads.movedSince.mockImplementationOnce(() => {
    const end = performance.now() + 220;
    while (performance.now() < end) { /* the real tick's work, after its awaited probe */ }
    return [];
  });
  try {
    watchComms('/missing-comms-attribution');
    await expect.poll(() => lines.some((l) => /slowest: comms live tick 2\d\d ms/.test(l))).toBe(true);
  } finally { w.stop(); }
});

it('followers read shared member markers without scanning Comms, then scan on ownership takeover', async () => {
  const home = mkdtempSync(join(tmpdir(), 'loom-comms-owner-'));
  const owner = new PeriodicOwner(home, () => undefined);
  reads.movedSince.mockReset();
  vi.mocked(changedFor).mockClear();
  watchComms(home, () => owner);
  try {
    withLog(home, db => db.prepare('INSERT INTO comms_member_moves(member) VALUES (?)').run('jonathan'));
    await expect.poll(() => vi.mocked(changedFor).mock.calls).toContainEqual(['jonathan', false]);
    expect(reads.movedSince).not.toHaveBeenCalled();
    reads.movedSince.mockReturnValueOnce([{ id: 'thread', member: 'jonathan', updated: Date.now() + 10 }]);
    owner.setEligible(true);
    await expect.poll(() => vi.mocked(changedFor).mock.calls).toContainEqual(['jonathan', true]);
    expect(reads.movedSince).toHaveBeenCalledTimes(1);
  } finally { stopCommsWatch(); await owner.close(); rmSync(home, { recursive: true, force: true }); }
}, 15_000);

it('multiple listener registrations keep the active Comms owner and dispose independently', async () => {
  const home = mkdtempSync(join(tmpdir(), 'loom-comms-registrations-'));
  const owner = new PeriodicOwner(home, () => {}), follower = new PeriodicOwner(home, () => {});
  owner.setEligible(true); reads.movedSince.mockReset(); reads.movedSince.mockReturnValue([]);
  const first = watchComms(home, () => owner), second = watchComms(home, () => follower);
  try {
    await expect.poll(() => reads.movedSince.mock.calls.length).toBeGreaterThan(0);
    second(); const before = reads.movedSince.mock.calls.length;
    await expect.poll(() => reads.movedSince.mock.calls.length).toBeGreaterThan(before);
  } finally { first(); second(); await owner.close(); await follower.close(); rmSync(home, { recursive: true, force: true }); }
}, 15_000);

it('a lock probe from a disposed home cannot scan a replacement registration', async () => {
  vi.useFakeTimers(); reads.movedSince.mockReset(); reads.movedSince.mockReturnValue([]);
  let release!: (ready: boolean) => void;
  vi.mocked(waitForLocks).mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
  const stop = watchComms('/missing-comms-restart');
  await vi.advanceTimersByTimeAsync(2000);
  expect(release).toBeTypeOf('function');
  stop(); watchComms('/missing-comms-restart');
  release(true); await vi.advanceTimersByTimeAsync(0);
  expect(reads.movedSince).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(2000);
  expect(reads.movedSince).toHaveBeenCalledTimes(1);
});

it.each([false, true])('counts duplicate callback and ownerless registrations independently (owner: %s)', async withOwner => {
  const home = mkdtempSync(join(tmpdir(), 'loom-comms-refcount-'));
  const owner = new PeriodicOwner(home, () => {}); owner.setEligible(true);
  reads.movedSince.mockReset(); reads.movedSince.mockReturnValue([]);
  const getter = withOwner ? () => owner : undefined;
  const first = watchComms(home, getter), second = watchComms(home, getter);
  try {
    first(); first();
    await expect.poll(() => reads.movedSince.mock.calls.length).toBeGreaterThan(0);
  } finally { second(); await owner.close(); rmSync(home, { recursive: true, force: true }); }
});
it('successor scans from the persisted cursor and preserves previously published member markers', async () => {
  const home = mkdtempSync(join(tmpdir(), 'loom-comms-cursor-'));
  const firstOwner = new PeriodicOwner(home, () => {}), nextOwner = new PeriodicOwner(home, () => {});
  firstOwner.setEligible(true); reads.movedSince.mockReset();
  const through = Date.now() + 10;
  reads.movedSince.mockReturnValueOnce([{ id: 'thread', member: 'jonathan', updated: through }]).mockReturnValue([]);
  let off = watchComms(home, () => firstOwner);
  try {
    await expect.poll(() => withLog(home, db => db.prepare('SELECT through FROM comms_sequence_scan').get())).toEqual({ through });
    off(); await firstOwner.close(); nextOwner.setEligible(true); reads.movedSince.mockClear();
    off = watchComms(home, () => nextOwner);
    await expect.poll(() => reads.movedSince.mock.calls.length).toBeGreaterThan(0);
    expect(reads.movedSince.mock.calls[0]).toEqual([home, through]);
    expect(withLog(home, db => db.prepare('SELECT member FROM comms_member_moves').all())).toEqual([{ member: 'jonathan' }]);
  } finally { off(); await firstOwner.close(); await nextOwner.close(); rmSync(home, { recursive: true, force: true }); }
});
it('sends the Comms heartbeat to local thread streams', async () => {
  vi.useFakeTimers(); reads.seqsOf.mockReturnValue({ last: 0 }); reads.threadState.mockReturnValue('idle');
  reads.movedSince.mockReturnValue([]);
  const write = vi.fn(() => true);
  const response = { writeHead: vi.fn(), write, on: vi.fn(), end: vi.fn() };
  openThreadStream(response as unknown as import('node:http').ServerResponse, {}, '/missing-comms-heartbeat', { thread: 'thread', session: 'session', from: 0, may: () => true });
  await vi.advanceTimersByTimeAsync(25_000);
  expect(write).toHaveBeenCalledWith(': beat\n\n');
});

it('an owner waits for a shared WAL writer without blocking the event loop', async () => {
  const home = mkdtempSync(join(tmpdir(), 'loom-comms-writer-'));
  const owner = new PeriodicOwner(home, () => {}); owner.setEligible(true);
  reads.movedSince.mockReset().mockReturnValue([]);
  const intervals = vi.spyOn(globalThis, 'setInterval');
  const off = watchComms(home, () => owner);
  withLog(home, () => {});
  const writer = new Database(liveDbPath(home));
  writer.exec('BEGIN IMMEDIATE');
  try {
    const tick = intervals.mock.calls.find(([, ms]) => ms === 2_000)![0] as () => void;
    const started = performance.now();
    tick();
    await new Promise(resolve => setTimeout(resolve, 25));
    expect(performance.now() - started).toBeLessThan(500);
    expect(reads.movedSince).not.toHaveBeenCalled();
    writer.exec('ROLLBACK');
    await expect.poll(() => reads.movedSince.mock.calls.length).toBeGreaterThan(0);
  } finally {
    if (writer.inTransaction) writer.exec('ROLLBACK');
    writer.close(); off(); await owner.close(); intervals.mockRestore();
    rmSync(home, { recursive: true, force: true });
  }
});
it('removing the last owner-backed watch returns remaining ownerless registrations to local scans', async () => {
  const home = mkdtempSync(join(tmpdir(), 'loom-comms-mixed-'));
  const owner = new PeriodicOwner(home, () => {}); owner.setEligible(true);
  reads.movedSince.mockReset(); reads.movedSince.mockReturnValue([]); vi.mocked(changedFor).mockClear();
  const local = watchComms(home), shared = watchComms(home, () => owner);
  try {
    shared(); await owner.close();
    reads.movedSince.mockReturnValue([{ id: 'thread', member: 'jonathan', updated: Date.now() + 10 }]);
    await expect.poll(() => vi.mocked(changedFor).mock.calls).toContainEqual(['jonathan']);
  } finally { local(); shared(); await owner.close(); rmSync(home, { recursive: true, force: true }); }
});
it('a failed shared publication keeps the cursor and retries its member marker', async () => {
  const home = mkdtempSync(join(tmpdir(), 'loom-comms-failed-publish-'));
  const owner = new PeriodicOwner(home, () => {}); owner.setEligible(true);
  const through = Date.now() + 10;
  reads.movedSince.mockReset(); reads.movedSince.mockReturnValue([{ id: 'thread', member: 'jonathan', updated: through }]);
  const off = watchComms(home, () => owner);
  const report = vi.spyOn(console, 'error').mockImplementation(() => {});
  withLog(home, db => db.exec("CREATE TRIGGER reject_move BEFORE INSERT ON comms_member_moves BEGIN SELECT RAISE(ABORT, 'publish failed'); END"));
  try {
    const initial = { through: 0 };
    await expect.poll(() => report.mock.calls.length).toBeGreaterThan(0);
    expect(withLog(home, db => db.prepare('SELECT through FROM comms_sequence_scan').get())).toEqual(initial);
    expect(withLog(home, db => db.prepare('SELECT * FROM comms_member_moves').all())).toEqual([]);
    withLog(home, db => db.exec('DROP TRIGGER reject_move'));
    await expect.poll(() => withLog(home, db => db.prepare('SELECT through FROM comms_sequence_scan').get())).toEqual({ through });
    expect(withLog(home, db => db.prepare('SELECT member FROM comms_member_moves').all())).toEqual([{ member: 'jonathan' }]);
  } finally { off(); await owner.close(); rmSync(home, { recursive: true, force: true }); }
});

it('an idle follower does not probe databases again until publication or fallback', async () => {
  vi.useFakeTimers();
  const home = mkdtempSync(join(tmpdir(), 'loom-comms-idle-follower-'));
  const follower = new PeriodicOwner(home, () => {});
  const off = watchComms(home, () => follower);
  vi.mocked(waitForLocks).mockClear();
  vi.mocked(changedFor).mockClear();
  try {
    await vi.advanceTimersByTimeAsync(2_000);
    expect(waitForLocks).toHaveBeenCalledTimes(1);
    vi.mocked(waitForLocks).mockClear();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(waitForLocks).not.toHaveBeenCalled();
    // Publication follows the durable marker, as in the owner's real scan.
    withLog(home, db => db.prepare('INSERT INTO comms_member_moves(member) VALUES (?)').run('jonathan'));
    const { writeFileSync } = await import('node:fs');
    const { COMMS_LIVE_TICK } = await import('./comms-live.js');
    writeFileSync(join(home, COMMS_LIVE_TICK), 'new-publication');
    await vi.advanceTimersByTimeAsync(2_000);
    expect(changedFor).toHaveBeenCalledWith('jonathan', false);
    expect(waitForLocks).toHaveBeenCalledTimes(1);
    vi.mocked(waitForLocks).mockClear();
    // A missing signal is repaired by the bounded fallback, even without a watcher event.
    withLog(home, db => db.prepare('INSERT INTO comms_member_moves(member) VALUES (?)').run('other'));
    await vi.advanceTimersByTimeAsync(30_000);
    expect(changedFor).toHaveBeenCalledWith('other', false);
    expect(waitForLocks).toHaveBeenCalledTimes(1);
  } finally { off(); await follower.close(); rmSync(home, { recursive: true, force: true }); }
});

it('acquiring ownership during a reader probe rechecks the WAL writer before scanning', async () => {
  const home = mkdtempSync(join(tmpdir(), 'loom-comms-role-fence-'));
  const owner = new PeriodicOwner(home, () => {});
  const intervals = vi.spyOn(globalThis, 'setInterval');
  const off = watchComms(home, () => owner);
  reads.movedSince.mockReset().mockReturnValue([]);
  let release!: (ready: boolean) => void;
  vi.mocked(waitForLocks).mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
  withLog(home, () => {});
  const writer = new Database(liveDbPath(home)); writer.exec('BEGIN IMMEDIATE');
  try {
    const tick = intervals.mock.calls.find(([, ms]) => ms === 2_000)![0] as () => void;
    tick(); owner.setEligible(true); release(true);
    const started = performance.now();
    await new Promise(r => setTimeout(r, 25));
    expect(performance.now() - started).toBeLessThan(500);
    expect(reads.movedSince).not.toHaveBeenCalled();
    expect(waitForLocks).toHaveBeenCalledWith(expect.objectContaining({ write: expect.arrayContaining([liveDbPath(home)]) }));
    writer.exec('ROLLBACK');
    await expect.poll(() => reads.movedSince.mock.calls.length).toBeGreaterThan(0);
  } finally { if (writer.inTransaction) writer.exec('ROLLBACK'); writer.close(); off(); await owner.close(); intervals.mockRestore(); rmSync(home, { recursive: true, force: true }); }
});

it.each([false, true])('registering a Comms watch under a held writer stays responsive (eligible: %s)', async eligible => {
  const home = mkdtempSync(join(tmpdir(), 'loom-comms-start-writer-'));
  withLog(home, () => {});
  const writer = new Database(liveDbPath(home)); writer.exec('BEGIN IMMEDIATE');
  const owner = new PeriodicOwner(home, () => {}); owner.setEligible(eligible);
  reads.movedSince.mockReset().mockReturnValue([]);
  let off = () => {};
  try {
    const started = performance.now(); off = watchComms(home, () => owner);
    await new Promise(resolve => setTimeout(resolve, 25));
    expect(performance.now() - started).toBeLessThan(500);
    expect(reads.movedSince).not.toHaveBeenCalled();
    writer.exec('ROLLBACK');
    if (eligible) await expect.poll(() => reads.movedSince.mock.calls.length).toBeGreaterThan(0);
  } finally { if (writer.inTransaction) writer.exec('ROLLBACK'); writer.close(); off(); await owner.close(); rmSync(home, { recursive: true, force: true }); }
});
