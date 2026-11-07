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
import { motionQuery, reducedMotion } from './access';

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
type Variant = { sheet?: string; row: number; frames: number; weight: number; rare?: boolean; rest?: number };
/** The agent's manifest (src/household.ts SpriteManifest): its states by PixelLab's names. */
type Manifest = { cell: [number, number]; states: Partial<Record<string, Partial<Record<Facing, Variant[]>>>>;
  /** drawn smaller or larger (src/household.ts: 0.5 to 1.5), and moved, in the sheet's pixels: tuned per agent in the file */
  scale?: number; offset?: [number, number];
  /** A small avatar's crop of its rest frame (idle, south), in the cell's pixels; else a 24-pixel square over the top
   * of what's drawn there (PixelAvatar). */
  avatar?: Crop };
/** A box in a cell, in the sheet's pixels. */
export type Crop = { x: number; y: number; w: number; h: number };
type Sheet = { m: Manifest; imgs: Record<string, HTMLImageElement> };
export type Sprite = { facings: string[]; v: string; base: string };

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
  onShown?: (st: FaceState) => void) {
  const rnd = ([a, b]: [number, number]) => a + env.random() * (b - a);
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
    last = anim;
    playing = true; frame = 0; paint(0);
    const step = () => {
      frame++;
      if (frame < anim!.frames) { paint(frame); timer = env.setTimeout(step, PIXEL.frameMs); return; }
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
      paint(rest()); resting(rnd(PIXEL.gaps[shownNow] ?? PIXEL.gaps.idle), false);
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
    setShown(st); anim = undefined; last = undefined;
    if (st === 'complete' || st === 'error' || st === 'needs-input' || st === 'talking') return beat();
    paint(rest());
    // The first gap in a state is a random part of a whole one, so faces that start together don't move together.
    resting(rnd(PIXEL.gaps[st] ?? PIXEL.gaps.idle) * (0.2 + env.random() * 0.8), true);
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
    live(on: boolean) {
      if (on === live) return;
      live = on;
      if (!live) { if (!playing) still(); return; }
      if (!playing) enter(want === 'complete' && shownNow === 'idle' ? 'idle' : want);
    },
    dispose: clear,
  };
}

const pageEnv: PlayerEnv = { now: () => performance.now(), setTimeout: (f, ms) => window.setTimeout(f, ms), clearTimeout: (t) => window.clearTimeout(t), random: Math.random };

/** This sprite's manifest and sheets once they're here, and whether they can't be had. */
function useSheet(sprite: Sprite): { sheet: Sheet | null; failed: boolean } {
  const [got, setGot] = useState<{ sheet: Sheet | null; failed: boolean }>({ sheet: null, failed: false });
  useEffect(() => { let on = true; void sheetOf(sprite).then((s) => { if (on) setGot({ sheet: s, failed: !s }); }); return () => { on = false; }; }, [sprite.base, sprite.v]); // eslint-disable-line react-hooks/exhaustive-deps
  return got;
}

export default function PixelFace({ sprite, state = 'idle', size, label, fallback, talk, scale: fixed, onShown, onFrom }: { sprite: Sprite; state?: FaceState; size: number; label?: string; fallback: React.ReactNode;
  /** A reply landed: `n` talking beats; `key` changes for each reply (comms.md, "How talking plays"). */
  talk?: { n: number; key: number };
  /** A whole-number scale of its own (the comm screen's 2x or more), instead of the size's. */
  scale?: number;
  /** The state it shows, as it changes, and the manifest state each frame is drawn from (the comm screen's data-face, data-anim). */
  onShown?: (st: FaceState) => void; onFrom?: (from: string) => void }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const { sheet, failed } = useSheet(sprite);
  const want = useRef(state);
  want.current = state;
  const player = useRef<ReturnType<typeof createPlayer> | null>(null);
  const scale = fixed && Number.isInteger(fixed) && fixed >= 1 ? fixed : size >= 64 ? 2 : 1;

  useEffect(() => {
    const cv = canvas.current;
    if (!sheet || !cv) return;
    const g = cv.getContext('2d')!;
    const [bw, bh] = PIXEL.box;
    let lastFrom = '';
    const draw = ({ v, frame, flip, from }: Frame) => {
      cv.dataset.anim = from;
      if (from !== lastFrom) { lastFrom = from; onFrom?.(from); }
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
    const p = createPlayer(sheet.m, want.current, draw, pageEnv, (st) => onShown?.(st));
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
  useEffect(() => { if (talk) player.current?.talk(talk.n); }, [talk?.key]); // eslint-disable-line react-hooks/exhaustive-deps

  // A sheet that can't be had (gone, refused): the agent's drawn face, not an empty square.
  if (failed) return <>{fallback}</>;
  const [w, h] = PIXEL.box;
  // The agent's own scale and offset (its manifest, t-1849), on top of the whole-pixel 1x or 2x. None, and it's drawn as ever.
  const k = scale * (sheet?.m.scale ?? 1);
  const [ox, oy] = sheet?.m.offset ?? [0, 0];
  return (
    <span className="loom-pixel-face" style={{ width: size, height: size }}>
      <canvas ref={canvas} role="img" aria-label={label ? `${label}, ${STATE_WORDS[state]}` : STATE_WORDS[state]} width={w} height={h}
        style={{ width: w * k, height: h * k, ...(ox || oy ? { translate: `calc(-50% + ${ox * k}px) calc(-50% + ${oy * k}px)` } : {}) }} data-state={state} />
    </span>
  );
}

const STATE_WORDS: Record<FaceState, string> = { idle: 'quiet', thinking: 'thinking', working: 'working', 'needs-input': 'waiting on you', complete: 'done', error: 'needs a look', talking: 'talking' };

/** The rest frame a face shows at idle, facing south: its usual animation, on its rest frame (the manifest's, else 0). */
const restOf = (m: Manifest): { v: Variant; frame: number } | undefined => { const v = usualOf(m.states.idle?.south ?? []); return v && { v, frame: v.rest ?? 0 }; };
/** The side of a small avatar's square when the manifest names no crop: 32 sheet pixels, about a whole head (Art's is
 * 30 across, Mark's 25), so a small avatar is the agent's head, not the top of it (t-1925: "crops of the big heads"). */
export const AVATAR_SIDE = 32;
/** How many rows under the top of what's drawn are its head, for centring the crop across (the shoulders are wider). */
const HEAD_ROWS = 16;

/**
 * Where a small avatar is cut from the rest frame: the manifest's crop, else a square of AVATAR_SIDE over the top of
 * what's drawn, centred across on its head (the top HEAD_ROWS rows of it). `opaque` says whether a cell pixel has
 * anything drawn.
 */
export function avatarCrop(m: Manifest, opaque: (x: number, y: number) => boolean): Crop {
  if (m.avatar) return m.avatar;
  const [cw, ch] = m.cell;
  let top = ch;
  for (let y = 0; y < ch && top === ch; y++) for (let x = 0; x < cw; x++) if (opaque(x, y)) { top = y; break; }
  const side = Math.min(AVATAR_SIDE, cw, ch);
  if (top === ch) return { x: Math.round((cw - side) / 2), y: 0, w: side, h: side };
  let left = cw, right = -1;
  for (let y = top; y < Math.min(ch, top + HEAD_ROWS); y++) for (let x = 0; x < cw; x++) if (opaque(x, y)) { left = Math.min(left, x); right = Math.max(right, x); }
  const x = Math.max(0, Math.min(cw - side, Math.round((left + right + 1) / 2 - side / 2)));
  return { x, y: Math.max(0, Math.min(ch - side, top)), w: side, h: side };
}

/**
 * How a crop is drawn in a box of `size`: whole screen pixels per sheet pixel, never smoothed. A box about as big as
 * the crop or bigger (28 px and up for a 32-pixel head: a pixel or two of its margin clipped at most): the crop itself,
 * at the largest whole scale that fits (1x under 64). A smaller box (a list's 20 or 24): the crop at half its
 * resolution (each 2x2 of it one pixel, avatarHalf), at a whole scale that fits, so the whole head shows, not its middle.
 */
export function avatarFit(size: number, side: number): { half: boolean; k: number } {
  if (size >= side * 0.85) return { half: false, k: Math.max(1, Math.floor(size / side)) };
  return { half: true, k: Math.max(1, Math.floor(size / Math.ceil(side / 2))) };
}

/**
 * A crop at half its resolution: each 2x2 block one pixel, the average colour of its drawn pixels when at least two of
 * the four are drawn (else nothing), fully opaque: a smaller head with crisp edges, never a blur.
 */
export function avatarHalf(src: Uint8ClampedArray, w: number, h: number): { data: Uint8ClampedArray<ArrayBuffer>; w: number; h: number } {
  const hw = Math.ceil(w / 2), hh = Math.ceil(h / 2);
  const out = new Uint8ClampedArray(hw * hh * 4);
  for (let y = 0; y < hh; y++) for (let x = 0; x < hw; x++) {
    let n = 0, r = 0, g = 0, b = 0;
    for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) {
      const sx = x * 2 + dx, sy = y * 2 + dy;
      if (sx >= w || sy >= h) continue;
      const i = (sy * w + sx) * 4;
      if (src[i + 3] > 0) { n++; r += src[i]; g += src[i + 1]; b += src[i + 2]; }
    }
    if (n < 2) continue;
    const o = (y * hw + x) * 4;
    out[o] = Math.round(r / n); out[o + 1] = Math.round(g / n); out[o + 2] = Math.round(b / n); out[o + 3] = 255;
  }
  return { data: out, w: hw, h: hh };
}

/**
 * An agent's small pixel avatar (under 36 px, where a whole 48-pixel sprite would swamp the words beside it; Jonathan,
 * 2026-11-05: "anywhere we currently have the 0000h face should be the pixel art guy now"): its head, from its rest
 * frame (avatarCrop), drawn at a whole-pixel scale (avatarFit: the head itself from 32 px, at half resolution below),
 * never smoothed, centred in its box. It's drawn once and doesn't move: quieter in a list, and cheaper. A sheet that
 * can't be had: its drawn face.
 */
export function PixelAvatar({ sprite, size, label, fallback }: { sprite: Sprite; size: number; label?: string; fallback: React.ReactNode }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const { sheet, failed } = useSheet(sprite);
  const [drawn, setDrawn] = useState<{ w: number; h: number; k: number } | null>(null);
  const rest = sheet && restOf(sheet.m);
  useEffect(() => {
    const cv = canvas.current;
    if (!sheet || !cv || !rest) return;
    const { v, frame } = rest;
    const img = sheet.imgs[fileOf(v)], [cw, ch] = sheet.m.cell, cols = Math.max(1, Math.floor(img.width / cw));
    const sx = (frame % cols) * cw, sy = v.row * ch;
    // The rest frame, alone, to find what's drawn in it.
    const cell = document.createElement('canvas');
    cell.width = cw; cell.height = ch;
    const cg = cell.getContext('2d', { willReadFrequently: true })!;
    cg.drawImage(img, sx, sy, cw, ch, 0, 0, cw, ch);
    let data: Uint8ClampedArray | null = null;
    try { data = cg.getImageData(0, 0, cw, ch).data; } catch { /* a tainted sheet: the default square, never halved */ }
    const c = avatarCrop(sheet.m, (x, y) => !!data && data[(y * cw + x) * 4 + 3] > 0);
    const fit = avatarFit(size, Math.max(c.w, c.h));
    const g = cv.getContext('2d')!;
    g.imageSmoothingEnabled = false;
    if (fit.half && data) {
      const half = avatarHalf(cg.getImageData(c.x, c.y, c.w, c.h).data, c.w, c.h);
      cv.width = half.w; cv.height = half.h;
      g.putImageData(new ImageData(half.data, half.w, half.h), 0, 0);
      setDrawn({ w: half.w, h: half.h, k: fit.k });
    } else {
      cv.width = c.w; cv.height = c.h;
      g.clearRect(0, 0, c.w, c.h);
      g.drawImage(img, sx + c.x, sy + c.y, c.w, c.h, 0, 0, c.w, c.h);
      setDrawn({ w: c.w, h: c.h, k: fit.half ? 1 : fit.k });
    }
  }, [sheet, size]); // eslint-disable-line react-hooks/exhaustive-deps
  if (failed || (sheet && !rest)) return <>{fallback}</>;
  return (
    <span className="loom-pixel-face loom-pixel-avatar" style={{ width: size, height: size }}>
      <canvas ref={canvas} role="img" aria-label={label} data-scale={drawn ? drawn.k : undefined}
        style={drawn ? { width: drawn.w * drawn.k, height: drawn.h * drawn.k } : { width: 0, height: 0 }} />
    </span>
  );
}
