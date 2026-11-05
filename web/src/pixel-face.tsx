// An agent's pixel face (Jonathan, 2026-11-04: the PixelLab sheets he made for Art, "he likes them"): its sprite sheet,
// kept with the household's marks (src/household.ts spriteOf, served at /faces/<agent>/sheet.png), drawn at whole
// pixels (1x, 2x on a card). An agent with no sheet keeps its drawn face (face.tsx); Appearance's "Pixel faces" turns
// these off for the person who'd rather compare. Its own chunk, and its sheet loads only when a face is drawn.
//
// How it moves is the preview he signed off on (the "Art pixel faces" artifact, v2): each state plays as a beat, then
// rests on frame 0, with a random gap per face so a row of them never moves together. Done plays once and goes back to
// rest as idle; error glitches once and holds its worried frame, replaying now and then. A new state waits for the beat
// in progress to finish. Nothing runs off screen or in a hidden tab; reduced motion shows the rest frame, facing south.
//
// Facing (his design): south, south-east or south-west, never further round, one step at a time (SE never straight to
// SW). Only while resting, a roll every couple of seconds: from south a small chance to turn, left or right; from an
// angle, after a few seconds, a fair chance to come back. Waiting on you is south only (it's looking at him), and turns
// back to south first; error and done may stay angled. A turn is a cut at the rest frame.
//
// What plays is the agent's manifest (src/household.ts): per state and facing, its animations (a row of a sheet, its
// frame count) with weights, one picked by weight at each beat among the facing's own (say the usual idle at 85, a
// rare neck crack at 15), a rare one never twice in a row. A facing's animations differ from south's, on purpose; a facing with none for a state uses that
// state's south (south-west: south-east's, mirrored, first).
import { useEffect, useRef, useState } from 'react';
import type { FaceState } from './face';
import { useLook } from './look';
import { motionQuery, reducedMotion } from './access';

/** The numbers, as settings: the preview (art-pixel-faces.html: MS, the gaps, ROLL_MS, P_LEAVE, P_BACK, MIN_AWAY). */
export const PIXEL = {
  frameMs: 90,
  /** Between beats, per state (ms): a random gap in the range, per face. */
  gaps: { idle: [4000, 9000], working: [600, 1800], thinking: [3000, 5000], 'needs-input': [4000, 6000], error: [12000, 20000] } as Record<string, [number, number]>,
  /** Error's rest frame, counted from its animation's end (the worried pose: 13 of Art's 17); every other state rests on 0. */
  errorHoldFromEnd: 4,
  /** The box every agent's cell is centred in, so faces of different cell sizes line up (Art 56×84, Mark 96×80). */
  box: [96, 84] as [number, number],
  turn: { rollMs: 2000, leave: 0.03, back: 0.3, minAwayMs: 3000 },
};

const FACINGS = ['south', 'south-east', 'south-west'] as const;
type Facing = typeof FACINGS[number];
/** One animation: a row of a sheet, its frame count, its weight among its state's animations in that facing. */
type Variant = { sheet?: string; row: number; frames: number; weight: number; rare?: boolean; rest?: number };
/** The agent's manifest (src/household.ts SpriteManifest): its states by PixelLab's names. */
type Manifest = { cell: [number, number]; states: Partial<Record<string, Partial<Record<Facing, Variant[]>>>>;
  /** drawn smaller or larger (src/household.ts: 0.5 to 1.5), and moved, in the sheet's pixels: tuned per agent in the file */
  scale?: number; offset?: [number, number];
  /** A small avatar's crop of its rest frame (idle, south, frame 0), in the cell's pixels; else a 24-pixel square over
   * the top of what's drawn there (PixelAvatar). */
  avatar?: { x: number; y: number; w: number; h: number } };
type Sheet = { m: Manifest; imgs: Record<string, HTMLImageElement> };
export type Sprite = { facings: string[]; v: string; base: string };

/** loom's states by the manifest's names. */
const NAME: Record<FaceState, string> = { idle: 'idle', working: 'working', thinking: 'thinking', 'needs-input': 'waiting', complete: 'done', error: 'error' };
const fileOf = (v: Variant) => v.sheet ?? 'sheet.png';

const sheets = new Map<string, Promise<Sheet | null>>();
/** The manifest and its sheets, loaded once per page. */
function sheetOf(s: Sprite): Promise<Sheet | null> {
  const key = `${s.base}?${s.v}`;
  let p = sheets.get(key);
  if (!p) {
    p = (async () => {
      try {
        const m = (await (await fetch(`${s.base}manifest.json?v=${s.v}`)).json()) as Manifest;
        const all = Object.values(m.states).flatMap((byF) => Object.values(byF ?? {}).flat()) as Variant[];
        const imgs: Record<string, HTMLImageElement> = {};
        await Promise.all([...new Set(all.map(fileOf))].map(async (f) => { const i = new Image(); i.src = `${s.base}${f}?v=${s.v}`; await i.decode(); imgs[f] = i; }));
        return { m, imgs };
      } catch { return null; }
    })();
    sheets.set(key, p);
  }
  return p;
}

/** A state's animations in a facing: its own; with none, that state's south (else idle's south, the base). A face
 * whose sheets have no south-west at all wears south-east's, mirrored, there. Waiting on you is south only. */
export function variantsFor(m: Manifest, st: FaceState, f: Facing): { list: Variant[]; flip: boolean } {
  const byF = m.states[NAME[st]] ?? {};
  const face = st === 'needs-input' ? 'south' : f;
  if (byF[face]?.length) return { list: byF[face]!, flip: false };
  const noSouthWest = !Object.values(m.states).some((x) => x?.['south-west']?.length);
  if (face === 'south-west' && noSouthWest && byF['south-east']?.length) return { list: byF['south-east']!, flip: true };
  if (byF.south?.length) return { list: byF.south, flip: false };
  return { list: m.states.idle?.south ?? [], flip: false };
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
export type PlayerEnv = { now: () => number; setTimeout: (f: () => void, ms: number) => number; clearTimeout: (t: number) => void; random: () => number };
/** What a player draws: an animation (none: nothing to draw), its frame, the facing, mirrored or not. */
export type Frame = { v: Variant | undefined; frame: number; facing: Facing; flip: boolean; /** part of a beat (else a rest) */ beat: boolean };

/**
 * One face's motion, apart from any canvas (so it can be tested on a fake clock): the beats, the rests, the gaps, the
 * variants by weight, and the turns. `want` asks for a state (taken up at once while resting, or when the beat in
 * progress ends); `live` says whether it may move (on screen, a visible page, motion allowed). Still, it rests facing south.
 */
export function createPlayer(m: Manifest, first: FaceState, draw: (f: Frame) => void, env: PlayerEnv) {
  const rnd = ([a, b]: [number, number]) => a + env.random() * (b - a);
  let want = first;
  // A face that first appears done is simply at rest (done is a moment, not a place).
  let shown: FaceState = first === 'complete' ? 'idle' : first;
  let facing: Facing = 'south', awaySince = 0, frame = 0, playing = false, live = false;
  let timer = 0, roll = 0;
  // The animation playing, if one is, and the last one played (a rare one is never followed by a rare one).
  let anim: Variant | undefined, last: Variant | undefined;
  const southOnly = () => shown === 'needs-input';
  // At rest: the state's usual animation in this facing (its weightiest, never a rare one); error rests on its worried frame.
  const usual = () => { const { list } = variantsFor(m, shown, facing); const plain = list.filter((v) => !v.rare); return (plain.length ? plain : list).reduce((x, y) => (y.weight > x.weight ? y : x), list[0]); };
  // Its rest frame: the manifest's, else 0 (error: its worried pose, 4 from its end, as both sheets end on the neutral one).
  const rest = () => { const u = usual(); return u?.rest ?? (shown === 'error' ? Math.max(0, (u?.frames ?? 1) - PIXEL.errorHoldFromEnd) : 0); };
  const paint = (i: number) => { const { flip } = variantsFor(m, shown, facing); draw({ v: anim ?? usual(), frame: i, facing, flip, beat: !!anim }); };
  const clear = () => { env.clearTimeout(timer); env.clearTimeout(roll); timer = 0; roll = 0; };
  const still = () => { clear(); facing = 'south'; paint(rest()); };
  // A beat: the animation's frames at frameMs, then rest. A state asked for meanwhile is taken up after it.
  const beat = () => {
    env.clearTimeout(roll); roll = 0;
    if (southOnly()) facing = 'south';
    anim = pick(variantsFor(m, shown, facing).list, last, env.random());
    last = anim;
    playing = true; frame = 0; paint(0);
    const step = () => {
      frame++;
      if (frame < anim!.frames) { paint(frame); timer = env.setTimeout(step, PIXEL.frameMs); return; }
      playing = false; anim = undefined;
      const played = shown;
      // Done plays once, then rests as idle: asked for once, it's had.
      if (shown === 'complete') { shown = 'idle'; if (want === 'complete') want = 'idle'; }
      // No longer live: stop at rest; a newer state is drawn still, and taken up when it's live again.
      if (!live) { if (want !== played) shown = want === 'complete' ? 'idle' : want; return still(); }
      // A state asked for during the beat (done too, unless it was done that just played).
      if (want !== shown) return enter(want);
      paint(rest()); resting(rnd(PIXEL.gaps[shown] ?? PIXEL.gaps.idle), false);
    };
    timer = env.setTimeout(step, PIXEL.frameMs);
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
    shown = st; anim = undefined; last = undefined;
    if (st === 'complete' || st === 'error' || st === 'needs-input') return beat();
    paint(rest());
    // The first gap in a state is a random part of a whole one, so faces that start together don't move together.
    resting(rnd(PIXEL.gaps[st] ?? PIXEL.gaps.idle) * (0.2 + env.random() * 0.8), true);
  };
  still();
  return {
    want(st: FaceState) {
      want = st;
      if (!live) { shown = st === 'complete' ? 'idle' : st; return still(); }
      if (!playing && st !== shown) enter(st);
    },
    live(on: boolean) {
      if (on === live) return;
      live = on;
      if (!live) { if (!playing) still(); return; }
      if (!playing) enter(want === 'complete' && shown === 'idle' ? 'idle' : want);
    },
    dispose: clear,
  };
}

const pageEnv: PlayerEnv = { now: () => performance.now(), setTimeout: (f, ms) => window.setTimeout(f, ms), clearTimeout: (t) => window.clearTimeout(t), random: Math.random };

export default function PixelFace({ sprite, state = 'idle', size, label, fallback }: { sprite: Sprite; state?: FaceState; size: number; label?: string; fallback: React.ReactNode }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [sheet, setSheet] = useState<Sheet | null>(null);
  const [failed, setFailed] = useState(false);
  const want = useRef(state);
  want.current = state;
  const player = useRef<ReturnType<typeof createPlayer> | null>(null);
  const scale = size >= 64 ? 2 : 1;
  const look = useLook();

  useEffect(() => { let on = true; void sheetOf(sprite).then((s) => { if (on) { setSheet(s); setFailed(!s); } }); return () => { on = false; }; }, [sprite.base, sprite.v]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const cv = canvas.current;
    if (!sheet || !cv) return;
    const g = cv.getContext('2d')!;
    const [bw, bh] = PIXEL.box;
    const draw = ({ v, frame, flip }: Frame) => {
      g.clearRect(0, 0, cv.width, cv.height);
      if (!v) return;
      const img = sheet.imgs[fileOf(v)], [cw, ch] = sheet.m.cell, cols = Math.max(1, Math.floor(img.width / cw));
      const f = Math.min(frame, v.frames - 1);
      g.save();
      if (flip) { g.translate(cv.width, 0); g.scale(-1, 1); }
      // The cell, centred in the common box: every agent's character (48×48, centred in its cell) lands in the same place.
      g.drawImage(img, (f % cols) * cw, v.row * ch, cw, ch, Math.round((bw - cw) / 2), Math.round((bh - ch) / 2), cw, ch);
      g.restore();
    };
    const p = createPlayer(sheet.m, want.current, draw, pageEnv);
    player.current = p;
    // Only on screen, in a visible page, with motion allowed.
    let seen = false;
    const go = () => p.live(seen && document.visibilityState === 'visible' && !reducedMotion());
    const io = new IntersectionObserver(([e]) => { seen = e.isIntersecting; go(); }, { rootMargin: '40px' });
    io.observe(cv);
    document.addEventListener('visibilitychange', go);
    // Reduce motion turned on (or off) while it's showing: it stops on its rest frame (or comes alive) at once.
    const motion = motionQuery();
    motion.addEventListener('change', go);
    return () => { p.dispose(); io.disconnect(); document.removeEventListener('visibilitychange', go); motion.removeEventListener('change', go); player.current = null; };
  }, [sheet]);

  useEffect(() => { player.current?.want(state); }, [state]);

  // A sheet that can't be had (gone, refused): the agent's drawn face, not an empty square.
  if (failed) return <>{fallback}</>;
  const [w, h] = PIXEL.box;
  // The agent's own scale and offset (its manifest), on top of the whole-pixel 1x or 2x, under Neon (t-1849: 000h draws
  // every face as it always has). None, and it's drawn as ever.
  const tuned = look === 'neon';
  const k = scale * (tuned ? sheet?.m.scale ?? 1 : 1);
  const [ox, oy] = tuned ? sheet?.m.offset ?? [0, 0] : [0, 0];
  return (
    <span className="loom-pixel-face" style={{ width: size, height: size }}>
      <canvas ref={canvas} role="img" aria-label={label ? `${label}, ${STATE_WORDS[state]}` : STATE_WORDS[state]} width={w} height={h}
        style={{ width: w * k, height: h * k, ...(ox || oy ? { translate: `calc(-50% + ${ox * k}px) calc(-50% + ${oy * k}px)` } : {}) }} data-state={state} />
    </span>
  );
}

const STATE_WORDS: Record<FaceState, string> = { idle: 'quiet', thinking: 'thinking', working: 'working', 'needs-input': 'waiting on you', complete: 'done', error: 'needs a look' };

/** The usual rest frame: idle, facing south, its heaviest animation that isn't rare, frame 0. */
const restVariant = (m: Manifest): Variant | undefined => [...(m.states.idle?.south ?? [])].sort((a, b) => Number(!!a.rare) - Number(!!b.rare) || b.weight - a.weight)[0];
/** The side of a small avatar's square when the manifest names no crop: 24 sheet pixels, 1x at 24 px, 2x at 48. */
export const AVATAR_SIDE = 24;

/**
 * Where a small avatar is cut from the rest frame: the manifest's crop, else a square of AVATAR_SIDE over the top of
 * what's drawn (centred on it across, from its top down: the head, and the shoulders where they fit). `opaque` says
 * whether a cell pixel has anything drawn.
 */
export function avatarCrop(m: Manifest, opaque: (x: number, y: number) => boolean): { x: number; y: number; w: number; h: number } {
  if (m.avatar) return m.avatar;
  const [cw, ch] = m.cell;
  let left = cw, right = -1, top = ch;
  for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) if (opaque(x, y)) { left = Math.min(left, x); right = Math.max(right, x); top = Math.min(top, y); }
  const side = Math.min(AVATAR_SIDE, cw, ch);
  if (right < 0) return { x: Math.round((cw - side) / 2), y: 0, w: side, h: side };
  const x = Math.max(0, Math.min(cw - side, Math.round((left + right + 1) / 2 - side / 2)));
  return { x, y: Math.max(0, Math.min(ch - side, top)), w: side, h: side };
}
/** A whole-pixel scale for a crop in a box: the nearest whole number of screen pixels per sheet pixel, never under 1. */
export const avatarScale = (size: number, side: number) => Math.max(1, Math.round(size / side));

/**
 * An agent's small pixel avatar (under 36 px, where a whole 48-pixel sprite would swamp the words beside it; Jonathan,
 * 2026-11-05: "anywhere we currently have the 0000h face should be the pixel art guy now"): a still crop of its rest
 * frame (avatarCrop), drawn at a whole-pixel scale (avatarScale: 24 at 1x, 48 at 2x), never smoothed, centred in its
 * box. It doesn't move: quieter in a list, and cheaper. A sheet that can't be had: its drawn face.
 */
export function PixelAvatar({ sprite, size, label, fallback }: { sprite: Sprite; size: number; label?: string; fallback: React.ReactNode }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [sheet, setSheet] = useState<Sheet | null>(null);
  const [failed, setFailed] = useState(false);
  const [crop, setCrop] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
  useEffect(() => { let on = true; void sheetOf(sprite).then((s) => { if (on) { setSheet(s); setFailed(!s || !restVariant(s.m)); } }); return () => { on = false; }; }, [sprite.base, sprite.v]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const cv = canvas.current, v = sheet && restVariant(sheet.m);
    if (!sheet || !cv || !v) return;
    const img = sheet.imgs[fileOf(v)], [cw, ch] = sheet.m.cell, sy = v.row * ch;
    // The rest frame, alone, to find what's drawn in it.
    const cell = document.createElement('canvas');
    cell.width = cw; cell.height = ch;
    const cg = cell.getContext('2d', { willReadFrequently: true })!;
    cg.drawImage(img, 0, sy, cw, ch, 0, 0, cw, ch);
    let data: Uint8ClampedArray | null = null;
    try { data = cg.getImageData(0, 0, cw, ch).data; } catch { /* a tainted sheet: the default square */ }
    const c = avatarCrop(sheet.m, (x, y) => !!data && data[(y * cw + x) * 4 + 3] > 0);
    cv.width = c.w; cv.height = c.h;
    const g = cv.getContext('2d')!;
    g.imageSmoothingEnabled = false;
    g.clearRect(0, 0, c.w, c.h);
    g.drawImage(img, c.x, sy + c.y, c.w, c.h, 0, 0, c.w, c.h);
    setCrop(c);
  }, [sheet]);
  if (failed) return <>{fallback}</>;
  const k = crop ? avatarScale(size, Math.max(crop.w, crop.h)) : 1;
  return (
    <span className="loom-pixel-face loom-pixel-avatar" style={{ width: size, height: size }}>
      <canvas ref={canvas} role="img" aria-label={label} data-scale={crop ? k : undefined}
        style={crop ? { width: crop.w * k, height: crop.h * k } : { width: 0, height: 0 }} />
    </span>
  );
}
