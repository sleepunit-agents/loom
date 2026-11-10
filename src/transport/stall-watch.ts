/**
 * Event-loop stall evidence for a listener (t-2114 follow-up). A worker whose loop is blocked answers nothing: on
 * 2026-11-10 /login took 14.3 s, then 4.9, 3.6 and 4.8 s over a minute, with the machine's CPU mostly idle. This
 * names what held the loop, from inside the worker, without a debugger:
 *
 * - a tick every `tickMs` measures how late it ran (perf_hooks' delay histogram backs it, for the p99 and max);
 * - a stall past `thresholdMs` is one stderr line: how long, the requests in flight then (method and first path
 *   segment only: never a query, header, cookie or body), the named jobs that ran on the loop during it with their
 *   own time, and the GC pause time inside it;
 * - `timed(label, fn)` runs a synchronous background job and says so itself when it held the loop past `jobMs`.
 *
 * Off with LOOM_STALL_MS=0. It never throws and never keeps the process alive.
 */
import { monitorEventLoopDelay, performance, PerformanceObserver } from 'node:perf_hooks';

export type StallWatch = {
  /** A request began: returns its end. Only the method and the first path segment are kept. */
  request(method: string | undefined, url: string | undefined): () => void;
  /** Runs `fn` on the loop as a named job: its time is kept for the next stall line, and said itself past jobMs. */
  timed<T>(label: string, fn: () => T): T;
  stop(): void;
};

type Opts = { thresholdMs?: number; tickMs?: number; jobMs?: number; log?: (line: string) => void; now?: () => number };

/** `/login?x` → `/login`, `/api/loom/audit` → `/api/loom`, anything odd → `/?`. */
export function routeOf(url: string | undefined): string {
  const path = (url ?? '/').split('?')[0]!;
  const parts = path.split('/').filter(Boolean).slice(0, 2);
  if (!parts.length) return '/';
  const safe = parts.map((p) => (/^[A-Za-z0-9._-]{1,40}$/.test(p) ? p : '?'));
  return `/${safe[0] === 'api' ? safe.join('/') : safe[0]}`;
}

const NOOP: StallWatch = { request: () => () => undefined, timed: (_l, fn) => fn(), stop: () => undefined };

export function watchStalls(o: Opts = {}): StallWatch {
  const env = Number(process.env.LOOM_STALL_MS);
  // A test run's loop is busy by design: there, only an explicit LOOM_STALL_MS turns it on.
  const set = process.env.LOOM_STALL_MS !== undefined && Number.isFinite(env);
  const thresholdMs = o.thresholdMs ?? (set ? env : process.env.VITEST ? 0 : 500);
  if (thresholdMs <= 0) return NOOP;
  const tickMs = o.tickMs ?? 100;
  const jobMs = o.jobMs ?? 200;
  const log = o.log ?? ((line: string) => { try { process.stderr.write(`${line}\n`); } catch { /* never */ } });
  const now = o.now ?? (() => performance.now());

  const inFlight = new Map<number, { route: string; at: number }>();
  let nextId = 0;
  const jobs: { label: string; at: number; ms: number }[] = [];
  const gcs: { at: number; ms: number }[] = [];
  let observer: PerformanceObserver | undefined;
  try {
    observer = new PerformanceObserver((list) => {
      for (const e of list.getEntries()) { gcs.push({ at: e.startTime, ms: e.duration }); if (gcs.length > 200) gcs.shift(); }
    });
    observer.observe({ entryTypes: ['gc'] });
  } catch { observer = undefined; }
  const delay = monitorEventLoopDelay({ resolution: 20 });
  delay.enable();

  let last = now();
  const tick = setInterval(() => {
    try {
      const t = now();
      const late = t - last - tickMs;
      const from = last;
      last = t;
      if (late < thresholdMs) return;
      // A stream open for minutes (an SSE feed, a held MCP session) didn't do it: counted, not listed.
      const recent = [...inFlight.values()].filter((r) => t - r.at <= late + 10_000);
      const streams = inFlight.size - recent.length;
      const flying = recent.sort((a, b) => a.at - b.at).map((r) => `${r.route} ${fmt(t - r.at)}`).slice(0, 12);
      const ran = jobs.filter((j) => j.at + j.ms >= from).map((j) => `${j.label} ${fmt(j.ms)}`).slice(-12);
      const gc = gcs.filter((g) => g.at + g.ms >= from).reduce((s, g) => s + g.ms, 0);
      const mem = process.memoryUsage();
      log(`loom: event loop stalled ${fmt(late)}` +
        `; in flight: ${flying.length ? flying.join(', ') : 'none'}${streams ? ` (+${streams} long-lived)` : ''}` +
        `; jobs: ${ran.length ? ran.join(', ') : 'none'}` +
        `; gc ${fmt(gc)}; rss ${Math.round(mem.rss / 1e6)} MB, heap ${Math.round(mem.heapUsed / 1e6)} MB` +
        `; loop delay max ${fmt(delay.max / 1e6)}, p99 ${fmt(delay.percentile(99) / 1e6)}`);
      delay.reset();
    } catch { /* evidence never breaks the listener */ }
  }, tickMs);
  tick.unref();

  return {
    request(method, url) {
      const id = nextId++;
      inFlight.set(id, { route: `${(method ?? 'GET').slice(0, 7)} ${routeOf(url)}`, at: now() });
      return () => { inFlight.delete(id); };
    },
    timed(label, fn) {
      const at = now();
      try { return fn(); } finally {
        const ms = now() - at;
        jobs.push({ label, at, ms });
        if (jobs.length > 50) jobs.shift();
        if (ms >= jobMs) log(`loom: ${label} held the event loop ${fmt(ms)}`);
      }
    },
    stop() { clearInterval(tick); delay.disable(); observer?.disconnect(); },
  };
}

function fmt(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms)} ms`;
}
