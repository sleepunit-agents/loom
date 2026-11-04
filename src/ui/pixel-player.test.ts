// @vitest-environment node
/**
 * A pixel face's motion (web/src/pixel-face.tsx createPlayer) on a fake clock, against the model Jonathan signed off on
 * (the preview's player): frames 90 ms apart, a beat then a rest, gaps per state, error resting on its worried frame
 * (4 from its end), done once then idle, a new state waiting for the beat to end; turns only while resting, one step at
 * a time (south-east never straight to south-west), waiting on you always south; a rare variant never twice running;
 * and nothing at all while it isn't live.
 */
import { describe, expect, it } from 'vitest';
import { createPlayer, PIXEL, type Frame, type PlayerEnv } from '../../web/src/pixel-face';
import type { FaceState } from '../../web/src/face';

/** A clock and timers that only move when told, and chance from a seed. */
function fakeEnv(seed = 7): PlayerEnv & { run: (ms: number) => void; t: () => number } {
  let now = 0, id = 0, s = seed;
  const timers = new Map<number, { at: number; f: () => void }>();
  return {
    now: () => now, t: () => now,
    setTimeout: (f, ms) => { timers.set(++id, { at: now + ms, f }); return id; },
    clearTimeout: (t) => { timers.delete(t); },
    random: () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 2 ** 32; },
    run(ms) {
      const end = now + ms;
      for (;;) {
        let next: [number, { at: number; f: () => void }] | undefined;
        for (const e of timers) if (!next || e[1].at < next[1].at) next = e;
        if (!next || next[1].at > end) break;
        timers.delete(next[0]); now = next[1].at; next[1].f();
      }
      now = end;
    },
  };
}
const v = (row: number, frames = 17, weight = 1, rare = false) => ({ row, frames, weight, ...(rare ? { rare } : {}) });
// Mark's layout (the hard one): done 9 frames, waiting south only, two south-east observer variants.
const M = {
  cell: [96, 80] as [number, number],
  states: {
    idle: { south: [v(16, 17, 85), v(19, 17, 15, true)], 'south-east': [v(17, 17, 85), v(20, 17, 7.5, true), v(21, 17, 7.5, true)], 'south-west': [v(18, 17, 85), v(22, 17, 15, true)] },
    thinking: { south: [v(1)], 'south-east': [v(2)], 'south-west': [v(3)] },
    working: { south: [v(4)], 'south-east': [v(5)], 'south-west': [v(6)] },
    error: { south: [v(7)], 'south-east': [v(8)], 'south-west': [v(9)] },
    done: { south: [v(10, 9)], 'south-east': [v(11, 9)], 'south-west': [v(12, 9)] },
    waiting: { south: [v(13)] },
  },
};
type Draw = Frame & { at: number };
function play(first: FaceState, seed?: number) {
  const env = fakeEnv(seed);
  const draws: Draw[] = [];
  const p = createPlayer(M, first, (f) => draws.push({ ...f, at: env.t() }), env);
  return { env, draws, p };
}
/** The beats: each run of beat frames, from a frame 0. */
function beats(draws: Draw[]) {
  const out: Draw[][] = [];
  for (const d of draws) {
    if (!d.beat) continue;
    if (d.frame === 0) out.push([d]);
    else out[out.length - 1]?.push(d);
  }
  return out;
}

describe('a pixel face, on a fake clock', () => {
  it('nothing moves until it is live, and nothing after it stops being live', () => {
    const { env, draws, p } = play('idle');
    env.run(60_000);
    expect(draws.length).toBe(1);   // its rest frame, once
    p.live(true); env.run(60_000);
    const n = draws.length;
    expect(n).toBeGreaterThan(17);
    p.live(false); env.run(5_000);   // a beat in progress finishes, then it stops
    const after = draws.length;
    env.run(10 * 60_000);
    expect(draws.length).toBe(after);
  });

  it('a beat: every frame 90 ms apart, then a rest of 4–9 s between idle beats', () => {
    const { env, draws, p } = play('idle', 3);
    p.live(true); env.run(10 * 60_000);
    const bs = beats(draws);
    expect(bs.length).toBeGreaterThan(30);
    for (const b of bs) for (let i = 1; i < b.length; i++) expect(b[i].at - b[i - 1].at).toBeCloseTo(PIXEL.frameMs, 6);
    for (let i = 2; i < bs.length; i++) {
      const gap = bs[i][0].at - bs[i - 1][bs[i - 1].length - 1].at - PIXEL.frameMs;
      expect(gap).toBeGreaterThanOrEqual(4000 - 1e-6); expect(gap).toBeLessThanOrEqual(9000 + 1e-6);
    }
  });

  it('turns only while resting, one step at a time: south-east never straight to south-west', () => {
    for (const seed of [1, 2, 3, 4, 5]) {
      const { env, draws, p } = play('idle', seed);
      p.live(true); env.run(2 * 60 * 60_000);
      const turns = draws.filter((d, i) => i > 0 && d.facing !== draws[i - 1].facing).map((d, i) => [draws[draws.indexOf(d) - 1].facing, d.facing]);
      expect(turns.length).toBeGreaterThan(0);
      for (const [a, b] of turns) expect(a === 'south' || b === 'south').toBe(true);
      // Within a beat the facing never changes.
      for (const b of beats(draws)) expect(new Set(b.map((d) => d.facing)).size).toBe(1);
      // Away from south for a while (at least 3 s), mostly in south.
      const south = draws.filter((d) => d.facing === 'south').length / draws.length;
      expect(south).toBeGreaterThan(0.5);
    }
  });

  it('a rare variant never plays twice running, and comes up about as often as its weight', () => {
    const { env, draws, p } = play('idle', 11);
    p.live(true); env.run(6 * 60 * 60_000);
    const picked = beats(draws).map((b) => b[0].v!);
    for (let i = 1; i < picked.length; i++) expect(picked[i - 1].rare && picked[i].rare).toBeFalsy();
    const rare = picked.filter((x) => x.rare).length / picked.length;
    expect(rare).toBeGreaterThan(0.08); expect(rare).toBeLessThan(0.2);
    // Mark's two south-east observers both turn up.
    expect(new Set(picked.filter((x) => x.rare).map((x) => x.row)).size).toBeGreaterThan(1);
  });

  it('waiting on you always faces south, turning back first if it was angled', () => {
    for (const seed of [21, 22, 23]) {
      const { env, draws, p } = play('idle', seed);
      p.live(true);
      env.run(60 * 60_000);
      p.want('needs-input');
      const from = draws.length;
      env.run(10 * 60_000);
      const waiting = draws.slice(from).filter((d) => d.v?.row === 13 || d.at > draws[from]?.at + 3000);
      expect(waiting.length).toBeGreaterThan(17);
      for (const d of waiting) expect(d.facing).toBe('south');
    }
  });

  it('error rests on its worried frame, 4 from its end; done plays once, its 9 frames, then rests as idle', () => {
    const { env, draws, p } = play('idle', 5);
    p.live(true); env.run(1000);
    p.want('error'); env.run(20_000);
    const errorBeat = beats(draws).find((b) => [7, 8, 9].includes(b[0].v!.row))!;
    expect(errorBeat).toBeDefined();
    const restAfter = draws[draws.indexOf(errorBeat[errorBeat.length - 1]) + 1];
    expect(restAfter.frame).toBe(17 - PIXEL.errorHoldFromEnd);
    const before = draws.length;
    p.want('complete'); env.run(60_000);
    const done = beats(draws.slice(before)).filter((b) => [10, 11, 12].includes(b[0].v!.row));
    expect(done.length).toBe(1);
    expect(done[0].length).toBe(9);
    expect(draws[draws.length - 1].v!.row).not.toBe(10);   // after it, idle
  });

  it('a new state waits for the beat in progress to finish', () => {
    const { env, draws, p } = play('working', 9);
    p.live(true);
    env.run(20_000);
    // Mid-beat: find a moment with frames still to come.
    const at = draws.length;
    while (draws[draws.length - 1].frame === 0 || draws[draws.length - 1].frame > 10) env.run(PIXEL.frameMs);
    const mid = draws[draws.length - 1];
    p.want('thinking');
    env.run(5000);
    const rest = draws.slice(draws.indexOf(mid) + 1);
    // The working beat runs to its last frame before anything of thinking's.
    const firstThinking = rest.findIndex((d) => [1, 2, 3].includes(d.v!.row));
    expect(rest.slice(0, firstThinking).every((d) => [4, 5, 6].includes(d.v!.row))).toBe(true);
    expect(rest[firstThinking - 1].frame).toBe(16);
    expect(at).toBeLessThan(draws.length);
  });

  it('an animation may name its own rest frame in the manifest', () => {
    const env = fakeEnv(1); const draws: Draw[] = [];
    const m = { ...M, states: { ...M.states, error: { south: [{ row: 7, frames: 17, weight: 1, rest: 10 }] } } };
    const p = createPlayer(m, 'idle', (f) => draws.push({ ...f, at: env.t() }), env);
    p.live(true); p.want('error'); env.run(5000);
    expect(draws.filter((d) => !d.beat && d.v?.row === 7).every((d) => d.frame === 10)).toBe(true);
  });
});
