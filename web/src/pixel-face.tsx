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
// frame count) with weights, one picked by weight at each beat (say the usual idle at 85, a rare one at 15), a rare one
// never twice in a row. A facing's animations differ from south's, on purpose; a facing with none for a state uses that
// state's south (south-west: south-east's, mirrored, first).
import { useEffect, useRef, useState } from 'react';
import type { FaceState } from './face';

/** The numbers, as settings: the preview (art-pixel-faces.html: MS, the gaps, ROLL_MS, P_LEAVE, P_BACK, MIN_AWAY). */
export const PIXEL = {
  frameMs: 90,
  /** Between beats, per state (ms): a random gap in the range, per face. */
  gaps: { idle: [4000, 9000], working: [600, 1800], thinking: [3000, 5000], 'needs-input': [4000, 6000], error: [12000, 20000] } as Record<string, [number, number]>,
  /** Error's rest frame (worried); every other state rests on 0. */
  errorHold: 13,
  turn: { rollMs: 2000, leave: 0.03, back: 0.3, minAwayMs: 3000 },
};

const FACINGS = ['south', 'south-east', 'south-west'] as const;
type Facing = typeof FACINGS[number];
/** One animation: a row of a sheet, its frame count, its weight among its state's animations in that facing. */
type Variant = { sheet?: string; row: number; frames: number; weight: number };
/** The agent's manifest (src/household.ts SpriteManifest): its states by PixelLab's names. */
type Manifest = { cell: [number, number]; states: Partial<Record<string, Partial<Record<Facing, Variant[]>>>> };
type Sheet = { m: Manifest; imgs: Record<string, HTMLImageElement>; top: number; height: number };
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
        // The character's own height in its cells (its pixels' extent over every animation), so nothing is cut off.
        const [cw, ch] = m.cell;
        let top = ch, bottom = 0;
        const c = document.createElement('canvas');
        c.width = cw; c.height = ch;
        const g = c.getContext('2d', { willReadFrequently: true })!;
        for (const v of all) for (let i = 0; i < v.frames; i++) {
          const img = imgs[fileOf(v)], cols = Math.max(1, Math.floor(img.width / cw));
          g.clearRect(0, 0, cw, ch);
          g.drawImage(img, (i % cols) * cw, v.row * ch, cw, ch, 0, 0, cw, ch);
          const px = g.getImageData(0, 0, cw, ch).data;
          for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) if (px[(y * cw + x) * 4 + 3] > 8) { if (y < top) top = y; if (y > bottom) bottom = y; }
        }
        if (bottom < top) { top = 0; bottom = ch - 1; }
        return { m, imgs, top, height: bottom - top + 1 };
      } catch { return null; }
    })();
    sheets.set(key, p);
  }
  return p;
}

/** A state's animations in a facing: its own, else south-east's mirrored for south-west, else its south's, else idle's
 * south (the base). Waiting on you is south only. */
export function variantsFor(m: Manifest, st: FaceState, f: Facing): { list: Variant[]; flip: boolean } {
  const byF = m.states[NAME[st]] ?? {};
  const face = st === 'needs-input' ? 'south' : f;
  if (byF[face]?.length) return { list: byF[face]!, flip: false };
  if (face === 'south-west' && byF['south-east']?.length) return { list: byF['south-east']!, flip: true };
  if (byF.south?.length) return { list: byF.south, flip: false };
  return { list: m.states.idle?.south ?? [], flip: false };
}

/** One animation by weight. The most-weighted is the usual one; any other is rare, and a rare one never plays twice in a
 * row (the last one played is left out of the draw when it was rare). */
export function pick(list: Variant[], last: Variant | undefined, r = Math.random()): Variant {
  const usual = list.reduce((a, b) => (b.weight > a.weight ? b : a), list[0]);
  const pool = last && last !== usual && list.length > 1 ? list.filter((v) => v !== last) : list;
  let x = r * pool.reduce((n, v) => n + v.weight, 0);
  for (const v of pool) { x -= v.weight; if (x < 0) return v; }
  return pool[pool.length - 1];
}

const rnd = ([a, b]: [number, number]) => a + Math.random() * (b - a);
const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
/** The character's width (PixelLab's square): the face is cropped to it, centred in its cell. */
const CHAR = 48;

export default function PixelFace({ sprite, state = 'idle', size, label }: { sprite: Sprite; state?: FaceState; size: number; label?: string }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [sheet, setSheet] = useState<Sheet | null>(null);
  const want = useRef(state);
  want.current = state;
  // Set by the running face: a new state, taken up at once while resting, or when the beat in progress ends.
  const kick = useRef<() => void>(() => {});
  const scale = size >= 64 ? 2 : 1;

  useEffect(() => { let on = true; void sheetOf(sprite).then((s) => { if (on) setSheet(s); }); return () => { on = false; }; }, [sprite.base, sprite.v]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const cv = canvas.current;
    if (!sheet || !cv) return;
    const g = cv.getContext('2d')!;
    // A face that first appears done is simply at rest (done is a moment, not a place).
    let shown: FaceState = want.current === 'complete' ? 'idle' : want.current;
    let facing: Facing = 'south', awaySince = 0, frame = 0, playing = false, live = false, seen = false;
    let timer = 0, roll = 0;
    const southOnly = () => shown === 'needs-input';
    const rest = () => (shown === 'error' ? PIXEL.errorHold : 0);
    // The animation playing, or the one resting (a state's usual one: its rest frame is that one's).
    let anim: Variant | undefined, last: Variant | undefined;
    const usual = () => { const { list } = variantsFor(sheet.m, shown, facing); return list.reduce((a, b) => (b.weight > a.weight ? b : a), list[0]); };
    const draw = (i: number) => {
      const { flip } = variantsFor(sheet.m, shown, facing);
      const v = anim ?? usual();
      if (!v) return;
      const img = sheet.imgs[fileOf(v)], [cw, ch] = sheet.m.cell, cols = Math.max(1, Math.floor(img.width / cw));
      const f = Math.min(i, v.frames - 1);
      g.clearRect(0, 0, cv.width, cv.height);
      g.save();
      if (flip) { g.translate(cv.width, 0); g.scale(-1, 1); }
      g.drawImage(img, (f % cols) * cw + (cw - CHAR) / 2, v.row * ch + sheet.top, CHAR, sheet.height, 0, 0, CHAR, sheet.height);
      g.restore();
    };
    const clear = () => { clearTimeout(timer); clearTimeout(roll); timer = 0; roll = 0; };
    // A beat: the row's frames at frameMs, then rest. A state asked for meanwhile is taken up after it.
    const beat = () => {
      clearTimeout(roll); roll = 0;
      if (southOnly()) facing = 'south';
      // This beat's animation, by weight, in the facing it's in.
      anim = pick(variantsFor(sheet.m, shown, facing).list, last);
      last = anim;
      playing = true; frame = 0; draw(0);
      const step = () => {
        frame++;
        if (frame < anim!.frames) { draw(frame); timer = window.setTimeout(step, PIXEL.frameMs); return; }
        playing = false; anim = undefined;
        if (shown === 'complete') shown = 'idle';   // done plays once, then rests as idle
        if (want.current !== shown && want.current !== 'complete') return enter(want.current);
        draw(rest()); resting(rnd(PIXEL.gaps[shown] ?? PIXEL.gaps.idle), false);
      };
      timer = window.setTimeout(step, PIXEL.frameMs);
    };
    // Resting: the rest frame, the turn rolls (not while waiting on you), and the next beat after its gap.
    const rolls = () => {
      const t = PIXEL.turn;
      if (!southOnly()) {
        if (facing === 'south') {
          if (Math.random() < t.leave) { facing = Math.random() < 0.5 ? 'south-east' : 'south-west'; awaySince = performance.now(); draw(rest()); }
        } else if (performance.now() - awaySince >= t.minAwayMs && Math.random() < t.back) { facing = 'south'; draw(rest()); }
      }
      roll = window.setTimeout(rolls, t.rollMs);
    };
    const resting = (gap: number, first: boolean) => {
      timer = window.setTimeout(beat, gap);
      roll = window.setTimeout(rolls, first ? Math.random() * PIXEL.turn.rollMs : PIXEL.turn.rollMs);
    };
    const enter = (st: FaceState) => {
      clear();
      shown = st; anim = undefined; last = undefined;
      if (st === 'complete' || st === 'error' || st === 'needs-input') return beat();
      draw(rest());
      resting(rnd(PIXEL.gaps[st] ?? PIXEL.gaps.idle) * (0.2 + Math.random() * 0.8), true);
    };
    const still = () => { clear(); facing = 'south'; draw(rest()); };
    // Only on screen, in a visible page, with motion allowed.
    const go = () => {
      const now = seen && document.visibilityState === 'visible' && !reduced();
      if (now === live) return;
      live = now;
      if (!live) { if (!playing) clear(); return; }
      if (!playing) enter(want.current === 'complete' && shown === 'idle' ? 'idle' : want.current);
    };
    kick.current = () => {
      if (!live) { shown = want.current === 'complete' ? 'idle' : want.current; return still(); }
      if (!playing && want.current !== shown) enter(want.current);
    };
    const io = new IntersectionObserver(([e]) => { seen = e.isIntersecting; go(); }, { rootMargin: '40px' });
    io.observe(cv);
    document.addEventListener('visibilitychange', go);
    still();
    return () => { clear(); io.disconnect(); document.removeEventListener('visibilitychange', go); kick.current = () => {}; };
  }, [sheet]);

  useEffect(() => { kick.current(); }, [state]);

  const h = sheet?.height ?? CHAR;
  return (
    <span className="loom-pixel-face" style={{ width: size, height: size }}>
      <canvas ref={canvas} role="img" aria-label={label ? `${label}, ${STATE_WORDS[state]}` : STATE_WORDS[state]} width={CHAR} height={h}
        style={{ width: CHAR * scale, height: h * scale }} data-state={state} />
    </span>
  );
}

const STATE_WORDS: Record<FaceState, string> = { idle: 'quiet', thinking: 'thinking', working: 'working', 'needs-input': 'waiting on you', complete: 'done', error: 'needs a look' };
