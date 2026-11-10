import { afterEach, expect, it } from 'vitest';
import { routeOf, watchStalls, type StallWatch } from './stall-watch.js';

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
