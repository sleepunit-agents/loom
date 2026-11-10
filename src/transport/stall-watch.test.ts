import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Puller } from '../collections/pull.js';
import type { pullDomain } from '../collections/pull.js';
type PullContext = Parameters<typeof pullDomain>[0];
import { refreshPieceManifests } from '../ui/pieces.js';
import { afterEach, expect, it } from 'vitest';
import { backgroundAttributionState, backgroundJob, routeOf, watchStalls, type StallWatch } from './stall-watch.js';

let w: StallWatch | undefined;
afterEach(() => { w?.stop(); w = undefined; });

const block = (ms: number) => { const until = performance.now() + ms; while (performance.now() < until) { /* hold the loop */ } };
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

it('keeps only the method and the first path segment of a request', () => {
  expect(routeOf('/login?next=/secret&token=abc')).toBe('/login');
  expect(routeOf('/api/loom/audit')).toBe('/api/loom');
  expect(routeOf('/conversation/cv-123/x')).toBe('/conversation');
  expect(routeOf('/%3Cscript%3E')).toBe('/?');
  expect(routeOf(undefined)).toBe('/');
});

it('names a stall, the requests in flight and the job that held the loop', async () => {
  const lines: string[] = [];
  w = watchStalls({ thresholdMs: 150, tickMs: 20, jobMs: 100, log: (l) => lines.push(l) });
  const end = w.request('GET', '/login?token=secret');
  await wait(50);
  w.timed('audit sweep', () => block(300));
  await wait(60);
  end();
  const job = lines.find((l) => l.includes('audit sweep held the event loop'));
  const stall = lines.find((l) => l.startsWith('loom: event loop stalled'));
  expect(job).toBeTruthy();
  expect(stall).toMatch(/in flight: GET \/login \d+ ms/);
  expect(stall).toMatch(/jobs: audit sweep \d+ ms/);
  expect(lines.join('\n')).not.toContain('secret');
});

it('says nothing when the loop keeps up, and is off at 0', async () => {
  const lines: string[] = [];
  w = watchStalls({ thresholdMs: 150, tickMs: 20, log: (l) => lines.push(l) });
  w.timed('quick', () => block(5));
  await wait(100);
  expect(lines).toEqual([]);
  w.stop();
  w = watchStalls({ thresholdMs: 0, tickMs: 20, log: (l) => lines.push(l) });
  w.timed('slow', () => block(250));
  await wait(60);
  expect(lines).toEqual([]);
});


it('attributes a slow continuation after await, without charging an async wait to the loop', async () => {
  const lines: string[] = [];
  w = watchStalls({ thresholdMs: 100, tickMs: 20, log: (l) => lines.push(l) });
  await backgroundJob('sleeping child', () => wait(180));
  expect(lines).toEqual([]);
  await backgroundJob('collection refresh loom/thread', async () => {
    await wait(30);
    block(220);
  });
  // Cheap activity must not evict the slow continuation (the previous sampler kept only 50 jobs).
  for (let i = 0; i < 100; i++) w.timed('quick', () => undefined);
  await wait(60);
  const stall = lines.find((l) => l.startsWith('loom: event loop stalled'));
  expect(stall).toMatch(/slowest: collection refresh loom\/thread 2\d\d ms/);
  expect(stall).not.toMatch(/sleeping child [12]\d\d ms/);
});

it('times callbacks registered by a named timer and keeps thrown work throwing', async () => {
  const lines: string[] = [];
  w = watchStalls({ thresholdMs: 100, tickMs: 20, log: (l) => lines.push(l) });
  await new Promise<void>((resolve) => {
    backgroundJob('live heartbeat', () => setTimeout(() => { block(220); resolve(); }, 30));
  });
  await wait(60);
  expect(lines.find((l) => l.startsWith('loom: event loop stalled'))).toMatch(/slowest: live heartbeat 2\d\d ms/);
  const error = new Error('unchanged');
  expect(() => backgroundJob('failed job', () => { throw error; })).toThrow(error);
});


it('keeps the slowest callback, even when a different named callback ran more recently', async () => {
  const lines: string[] = [];
  w = watchStalls({ thresholdMs: 100, tickMs: 20, log: (l) => lines.push(l) });
  backgroundJob('earlier blocker', () => block(220));
  backgroundJob('later callback', () => block(110));
  await wait(60);
  expect(lines.find((l) => l.startsWith('loom: event loop stalled'))).toMatch(/slowest: earlier blocker 2\d\d ms/);
});

it('preserves values, promise identity, and rejected promises', async () => {
  w = watchStalls({ thresholdMs: 100, log: () => undefined });
  const value = {};
  expect(backgroundJob('value', () => value)).toBe(value);
  const promise = Promise.resolve(value);
  expect(backgroundJob('promise', () => promise)).toBe(promise);
  const error = new Error('rejected');
  await expect(backgroundJob('rejection', async () => { await wait(1); throw error; })).rejects.toBe(error);
});

it('releases completed promises and destroyed timers, and disables the hook after the last watch', async () => {
  w = watchStalls({ thresholdMs: 100, log: () => undefined });
  const baseline = backgroundAttributionState().resources;
  await backgroundJob('resolved promises', async () => {
    for (let i = 0; i < 1000; i++) await Promise.resolve();
  });
  // Resolved promise state is released without waiting for GC to destroy the promises.
  expect(backgroundAttributionState().resources).toBe(baseline);
  const timer = backgroundJob('pending timer', () => setTimeout(() => undefined, 10_000));
  expect(backgroundAttributionState().resources).toBe(baseline + 1);
  clearTimeout(timer);
  await wait(20);
  expect(backgroundAttributionState().resources).toBe(baseline);
  const second = watchStalls({ thresholdMs: 100, log: () => undefined });
  w.stop();
  expect(backgroundAttributionState().watches).toBe(1);
  backgroundJob('final stop', () => {
    second.stop();
    expect(backgroundAttributionState().context).toBeUndefined();
  });
  expect(backgroundAttributionState()).toMatchObject({ resources: 0, running: 0, watches: 0 });
  const disabled = backgroundAttributionState();
  w = watchStalls({ thresholdMs: 0 });
  await backgroundJob('disabled work', () => wait(1));
  expect(backgroundAttributionState()).toEqual(disabled);
});


it('names the nested offender rather than its enclosing round', async () => {
  const lines: string[] = [];
  w = watchStalls({ thresholdMs: 100, tickMs: 20, log: (l) => lines.push(l) });
  await backgroundJob('round', async () => {
    await wait(20);
    backgroundJob('specific refresh', () => block(220));
  });
  await wait(60);
  expect(lines.find((l) => l.startsWith('loom: event loop stalled'))).toMatch(/slowest: specific refresh 2\d\d ms/);
});

it('keeps pending named work attributed when one of two watches stops', async () => {
  w = watchStalls({ thresholdMs: 100, tickMs: 20, log: () => undefined });
  const lines: string[] = [];
  const other = watchStalls({ thresholdMs: 100, tickMs: 20, log: (l) => lines.push(l) });
  try {
    const pending = backgroundJob('shared watch work', async () => { await wait(30); block(220); });
    w.stop();
    await pending;
    await wait(60);
    expect(lines.find((l) => l.startsWith('loom: event loop stalled'))).toMatch(/slowest: shared watch work 2\d\d ms/);
  } finally { other.stop(); }
});

it('chooses a later slower callback as well as an earlier one', async () => {
  const lines: string[] = [];
  w = watchStalls({ thresholdMs: 100, tickMs: 20, log: (l) => lines.push(l) });
  backgroundJob('earlier callback', () => block(110));
  backgroundJob('later blocker', () => block(220));
  await wait(60);
  expect(lines.find((l) => l.startsWith('loom: event loop stalled'))).toMatch(/slowest: later blocker 2\d\d ms/);
});


it('names actual collection and piece-manifest rounds', async () => {
  const lines: string[] = [];
  w = watchStalls({ thresholdMs: 100, tickMs: 20, log: (l) => lines.push(l) });
  const home = mkdtempSync(join(tmpdir(), 'loom-attribution-'));
  try {
    const puller = new Puller(() => {
      block(220);
      return { household: { home }, env: {} } as PullContext;
    }, () => new Set());
    puller.round();
    await wait(60);
    expect(lines.find((l) => l.startsWith('loom: event loop stalled'))).toMatch(/slowest: collection round 2\d\d ms/);
    lines.length = 0;
    let first = true;
    const env = { get LOOM_HOME() { if (first) { first = false; block(220); } return home; } };
    await refreshPieceManifests(env);
    await wait(60);
    expect(lines.find((l) => l.startsWith('loom: event loop stalled'))).toMatch(/slowest: piece manifest round 2\d\d ms/);
  } finally { rmSync(home, { recursive: true, force: true }); }
});


it('never ranks a completed async sleep above a shorter real blocker in the same interval', async () => {
  const lines: string[] = [];
  w = watchStalls({ thresholdMs: 100, tickMs: 20, log: (l) => lines.push(l) });
  await backgroundJob('sleep only', () => wait(250));
  backgroundJob('real blocker', () => block(150));
  await wait(60);
  expect(lines.find((l) => l.startsWith('loom: event loop stalled'))).toMatch(/slowest: real blocker 1[45]\d ms/);
});


it('releases abandoned unresolved promises when GC destroys them', () => {
  const code = `
    import { backgroundJob, backgroundAttributionState, watchStalls } from ${JSON.stringify(new URL('./stall-watch.ts', import.meta.url).href)};
    const w = watchStalls({ thresholdMs: 500, log: () => {} });
    backgroundJob('abandoned promises', () => { for (let i = 0; i < 1000; i++) new Promise(() => {}); });
    const before = backgroundAttributionState().resources;
    for (let i = 0; i < 30 && backgroundAttributionState().resources; i++) {
      global.gc(); await new Promise(r => setTimeout(r, 10));
    }
    const after = backgroundAttributionState().resources;
    w.stop(); console.log(JSON.stringify({ before, after }));
  `;
  const child = spawnSync(process.execPath, ['--expose-gc', '--import', 'tsx', '--input-type=module', '-e', code], { encoding: 'utf-8', timeout: 10_000 });
  expect(child.status, child.stderr).toBe(0);
  const counts = JSON.parse(child.stdout.trim());
  expect(counts.before).toBeGreaterThanOrEqual(1000);
  expect(counts.after).toBe(0);
});
