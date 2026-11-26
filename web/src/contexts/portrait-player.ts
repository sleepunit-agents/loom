import type { FaceState } from '../face';

/** The numbers, as settings: the preview (art-pixel-faces.html: MS, the gaps, ROLL_MS, P_LEAVE, P_BACK, MIN_AWAY). */
export const PIXEL = {
  frameMs: 90,
  /** Between beats, per state (ms): a random gap in the range, per face. */
  gaps: { idle: [4000, 9000], working: [600, 1800], thinking: [3000, 5000], 'needs-input': [4000, 6000], error: [12000, 20000],
    // A breath between talking beats (the owner, 2026-11-05: "small breaks between the talking loops"; the preview's v5).
    talking: [400, 1200] } as Record<string, [number, number]>,
  /** A talking run, at most (comms.md, "How talking plays"): one beat per 150 characters of the reply, 1 to 4. */
  talkMax: 4,
  /** Error's rest frame, counted from its animation's end (the worried pose: 13 of Art's 17); every other state rests on 0. */
  errorHoldFromEnd: 4,
  /** The box every agent's cell is centred in, so faces of different cell sizes line up (Art 56×84, Mark 96×80). */
  box: [96, 84] as [number, number],
  turn: { rollMs: 2000, leave: 0.03, back: 0.3, minAwayMs: 3000 },
};

const FACINGS = ['south', 'south-east', 'south-west'] as const;
type Facing = typeof FACINGS[number];
/** One animation: a row of a sheet, its frame count, its weight among its state's animations in that facing. */
export type Variant = { sheet?: string; row: number; frames: number; weight: number; rare?: boolean; rest?: number };
/** The agent's manifest (src/desk-sprite-layout.ts SpriteManifest): its states by PixelLab's names. */
export type Manifest = { cell: [number, number]; states: Partial<Record<string, Partial<Record<Facing, Variant[]>>>>;
  /** drawn smaller or larger (src/desk-sprite-layout.ts: 0.5 to 1.5), and moved, in the sheet's pixels: tuned per agent in the file */
  scale?: number; offset?: [number, number];
  /** A small avatar's crop of its rest frame (idle, south), in the cell's pixels; else a 24-pixel square over the top
   * of what's drawn there (PixelAvatar). */
  avatar?: Crop };
/** A box in a cell, in the sheet's pixels. */
export type Crop = { x: number; y: number; w: number; h: number };
/** loom's states by the manifest's names. */
const NAME: Record<FaceState, string> = { idle: 'idle', working: 'working', thinking: 'thinking', 'needs-input': 'waiting', complete: 'done', error: 'error', talking: 'talking' };

/**
 * The manifest state a face state plays from: its own, else (talking only, comms.md) done's, then working's. A talking
 * sheet added to the manifest later is then the whole change.
 */
export function stateFrom(m: Manifest, st: FaceState): string {
  if (st !== 'talking' || m.states.talking) return NAME[st];
  return m.states.done ? 'done' : m.states.working ? 'working' : 'idle';
}
/** A state's animations in a facing: its own; with none, that state's south (else idle's south, the base). A face
 * whose sheets have no south-west at all wears south-east's, mirrored, there. Waiting on you is south only. */
export function variantsFor(m: Manifest, st: FaceState, f: Facing): { list: Variant[]; flip: boolean } {
  const byF = m.states[stateFrom(m, st)] ?? {};
  const face = st === 'needs-input' ? 'south' : f;
  if (byF[face]?.length) return { list: byF[face]!, flip: false };
  const noSouthWest = !Object.values(m.states).some((x) => x?.['south-west']?.length);
  if (face === 'south-west' && noSouthWest && byF['south-east']?.length) return { list: byF['south-east']!, flip: true };
  if (byF.south?.length) return { list: byF.south, flip: false };
  return { list: m.states.idle?.south ?? [], flip: false };
}

/** A state's usual animation in a facing: its weightiest, never a rare one (unless all are). What it rests on. */
export function usualOf(list: Variant[]): Variant | undefined {
  const plain = list.filter((v) => !v.rare);
  return (plain.length ? plain : list).reduce<Variant | undefined>((x, y) => (!x || y.weight > x.weight ? y : x), undefined);
}

/** One animation by weight, among the facing's own. After a rare one (marked rare in the manifest), the next is never
 * rare, so a rare one never plays twice running (the preview's pick(): VARIANTS, lastRare). */
export function pick(list: Variant[], last: Variant | undefined, r = Math.random()): Variant {
  const pool = last?.rare && list.some((v) => !v.rare) ? list.filter((v) => !v.rare) : list;
  let x = r * pool.reduce((n, v) => n + v.weight, 0);
  for (const v of pool) { x -= v.weight; if (x < 0) return v; }
  return pool[pool.length - 1];
}

/** What a player needs from the world: a clock, timers, and chance. A page's are the real ones; a test's are fake. */
export type IdleTiming = { gap: [number, number]; blinkDuration: [number, number] };
export type PlayerEnv = { now: () => number; setTimeout: (f: () => void, ms: number) => number; clearTimeout: (t: number) => void; random: () => number };
/** What a player draws: an animation (none: nothing to draw), its frame, the facing, mirrored or not. */
export type Frame = { v: Variant | undefined; frame: number; facing: Facing; flip: boolean; /** part of a beat (else a rest) */ beat: boolean;
  /** the manifest state it's drawn from (a talking face without a talking sheet: done's, or working's) */ from: string };

/**
 * One face's motion, apart from any canvas (so it can be tested on a fake clock): the beats, the rests, the gaps, the
 * variants by weight, and the turns. `want` asks for a state (taken up at once while resting, or when the beat in
 * progress ends); `live` says whether it may move (on screen, a visible page, motion allowed). Still, it rests facing south.
 */
export function createPlayer(m: Manifest, first: FaceState, draw: (f: Frame) => void, env: PlayerEnv,
  /** Told each time the state it shows changes (the comm screen's data-face follows talking, then done, then idle). */
  onShown?: (st: FaceState) => void, idleTiming?: IdleTiming) {
  const rnd = ([a, b]: [number, number]) => a + env.random() * (b - a);
  const gapFor = (state: FaceState) => rnd(state === 'idle' && idleTiming ? idleTiming.gap : PIXEL.gaps[state] ?? PIXEL.gaps.idle);
  let want = first;
  // A face that first appears done is simply at rest (done is a moment, not a place).
  let shownNow: FaceState = first === 'complete' ? 'idle' : first;
  // Every change of what it shows goes through here, so onShown hears each one.
  const setShown = (st: FaceState) => { if (st !== shownNow) { shownNow = st; onShown?.(st); } };
  let facing: Facing = 'south', awaySince = 0, frame = 0, playing = false, live = false;
  let timer = 0, roll = 0;
  // The animation playing, if one is, and the last one played (a rare one is never followed by a rare one).
  let anim: Variant | undefined, last: Variant | undefined;
  const southOnly = () => shownNow === 'needs-input';
  // At rest: the state's usual animation in this facing (its weightiest, never a rare one); error rests on its worried frame.
  const usual = () => usualOf(variantsFor(m, shownNow, facing).list);
  // Its rest frame: the manifest's, else 0 (error: its worried pose, 4 from its end, as both sheets end on the neutral one).
  const rest = () => { const u = usual(); return u?.rest ?? (shownNow === 'error' ? Math.max(0, (u?.frames ?? 1) - PIXEL.errorHoldFromEnd) : 0); };
  const paint = (i: number) => { const { flip } = variantsFor(m, shownNow, facing); draw({ v: anim ?? usual(), frame: i, facing, flip, beat: !!anim, from: stateFrom(m, shownNow) }); };
  // A talking run (talk): beats still owed, and beats played in this run (never more than PIXEL.talkMax in all).
  let talkLeft = 0, talkPlayed = 0;
  const clear = () => { env.clearTimeout(timer); env.clearTimeout(roll); timer = 0; roll = 0; };
  const still = () => { clear(); facing = 'south'; paint(rest()); };
  // A beat: the animation's frames at frameMs, then rest. A state asked for meanwhile is taken up after it.
  const beat = () => {
    env.clearTimeout(roll); roll = 0;
    if (southOnly()) facing = 'south';
    anim = pick(variantsFor(m, shownNow, facing).list, last, env.random());
    const frameMs = idleTiming && shownNow === 'idle' && !anim.rare
      ? rnd(idleTiming.blinkDuration) / anim.frames : PIXEL.frameMs;
    last = anim;
    playing = true; frame = 0; paint(0);
    const step = () => {
      frame++;
      if (frame < anim!.frames) { paint(frame); timer = env.setTimeout(step, frameMs); return; }
      playing = false; anim = undefined;
      const played = shownNow;
      // A talking beat: a breath, then the next, until the run is spent; then the done beat, then rest as idle.
      if (shownNow === 'talking' && want === 'talking') {
        talkPlayed++; talkLeft--;
        if (!live) { talkLeft = 0; talkPlayed = 0; want = 'idle'; setShown('idle'); return still(); }
        if (talkLeft > 0) { paint(rest()); timer = env.setTimeout(beat, rnd(PIXEL.gaps.talking)); return; }
        talkPlayed = 0; want = 'complete';
        return enter('complete');
      }
      if (shownNow === 'talking') { talkLeft = 0; talkPlayed = 0; }
      // Done plays once, then rests as idle: asked for once, it's had.
      if (shownNow === 'complete') { setShown('idle'); if (want === 'complete') want = 'idle'; }
      // No longer live: stop at rest; a newer state is drawn still, and taken up when it's live again.
      if (!live) { if (want !== played) setShown(want === 'complete' ? 'idle' : want); return still(); }
      // A state asked for during the beat (done too, unless it was done that just played).
      if (want !== shownNow) return enter(want);
      paint(rest()); resting(gapFor(shownNow), false);
    };
    timer = env.setTimeout(step, frameMs);
  };
  // Resting: the turn rolls (never while waiting on you), one step at a time, and the next beat after its gap.
  const rolls = () => {
    const t = PIXEL.turn;
    if (!southOnly()) {
      if (facing === 'south') {
        if (env.random() < t.leave) { facing = env.random() < 0.5 ? 'south-east' : 'south-west'; awaySince = env.now(); paint(rest()); }
      } else if (env.now() - awaySince >= t.minAwayMs && env.random() < t.back) { facing = 'south'; paint(rest()); }
    }
    roll = env.setTimeout(rolls, t.rollMs);
  };
  const resting = (gap: number, firstRest: boolean) => {
    timer = env.setTimeout(beat, gap);
    roll = env.setTimeout(rolls, firstRest ? env.random() * PIXEL.turn.rollMs : PIXEL.turn.rollMs);
  };
  const enter = (st: FaceState) => {
    clear();
    setShown(st); anim = undefined; last = undefined;
    if (st === 'complete' || st === 'error' || st === 'needs-input' || st === 'talking') return beat();
    paint(rest());
    // The first gap in a state is a random part of a whole one, so faces that start together don't move together.
    resting(gapFor(st) * (st === 'idle' && idleTiming ? 1 : 0.2 + env.random() * 0.8), true);
  };
  still();
  return {
    want(st: FaceState) {
      want = st;
      if (!live) { setShown(st === 'complete' ? 'idle' : st); return still(); }
      if (!playing && st !== shownNow) enter(st);
    },
    /**
     * A reply landed: `n` talking beats (comms.md, "How talking plays"), added to a run already going, never past
     * PIXEL.talkMax in one run. Still (reduced motion, off screen): no beats at all.
     */
    talk(n: number) {
      if (!live) return;
      const room = PIXEL.talkMax - talkPlayed - talkLeft;
      const add = Math.max(0, Math.min(Math.max(1, Math.round(n)), room));
      if (!add) return;
      talkLeft += add;
      if (want === 'talking') return;
      want = 'talking';
      if (!playing) enter('talking');
    },
    live(on: boolean, finishBeat = true) {
      if (on === live) return;
      live = on;
      if (!live) {
        if (!finishBeat) {
          playing = false; anim = undefined; talkLeft = 0; talkPlayed = 0;
          setShown(want === 'complete' ? 'idle' : want);
        }
        if (!playing) still();
        return;
      }
      if (!playing) enter(want === 'complete' && shownNow === 'idle' ? 'idle' : want);
    },
    dispose: clear,
  };
}
