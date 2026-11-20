export interface Clock { now(): number; at(time: number, fn: () => void): () => void }
/** How long the real clock waits at most before it reads the wall clock again. A deadline is a wall
 * time, and a timer counts time that has run: when the host's clock is set forward (a resume from
 * suspend, an unpaused machine, a time correction on a board with no clock of its own) a timer set for
 * the whole wait would end late by the size of the step. So no single wait is longer than this, and a
 * deadline runs at most this long after the wall clock reaches it, however the clock got there. */
export const STEP_CHECK_MS = 30_000;
export const clock: Clock = {
  now: () => Date.now(),
  at(time, fn) {
    let timer: ReturnType<typeof setTimeout>;
    let cancelled = false;
    const schedule = () => {
      if (cancelled) return;
      const remaining = time - Date.now();
      if (remaining <= 0) { fn(); return; }
      timer = setTimeout(schedule, Math.min(remaining, STEP_CHECK_MS)); timer.unref();
    };
    // Always defer, including deadlines already due.
    timer = setTimeout(schedule, Math.min(Math.max(0, time - Date.now()), STEP_CHECK_MS)); timer.unref();
    return () => { cancelled = true; clearTimeout(timer); };
  },
};
export class FakeClock implements Clock {
  private time: number;
  private events = new Set<{ time: number; fn: () => void }>();
  constructor(time = Date.UTC(2026, 10, 12)) { this.time = time; }
  now() { return this.time; }
  at(time: number, fn: () => void) { const e = { time, fn }; this.events.add(e); return () => { this.events.delete(e); }; }
  advance(ms: number) {
    if (ms < 0) throw new Error('clock cannot go backwards');
    const end = this.time + ms;
    for (;;) {
      const e = [...this.events].filter(e => e.time <= end).sort((a, b) => a.time - b.time)[0];
      if (!e) break;
      this.time = Math.max(this.time, e.time); this.events.delete(e); e.fn();
    }
    this.time = end;
  }
}
