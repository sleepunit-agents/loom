"use client";

import * as React from "react";
import { path as outline, spring, type Spring } from "@/lib/cojeev-motion/geometry";
import {
  cancelMotion,
  registerMotionClock,
  scheduleMotion,
  type MotionTimer,
} from "@/lib/cojeev-motion/clock";

export type MilestoneTravel = "seed" | "droplet" | "division";
type State = "complete" | "current" | "upcoming" | "needs";
type Fill = "pink" | "olive" | "danger";
type Glyph = "none" | "core" | "check" | "bang";
type Pts = number[][];

const f2 = (n: number) => n.toFixed(2),
  f3 = (n: number) => n.toFixed(3);

/* ---------- marks: 64 polar samples from the top, so any two morph point-to-point ---------- */
const R = 17;
const polar = (f: (t: number) => number): Pts =>
  Array.from({ length: 64 }, (_, i) => {
    const t = -Math.PI / 2 + (i / 64) * Math.PI * 2,
      r = f(t);
    return [r * Math.cos(t), r * Math.sin(t)];
  });
/** The same 64 angles cast at a closed outline that is star-shaped about the centre. */
const cast = (ring: Pts): Pts =>
  polar((t) => {
    const ux = Math.cos(t),
      uy = Math.sin(t);
    let r = 0;
    ring.forEach(([ax, ay], i) => {
      const [bx, by] = ring[(i + 1) % ring.length],
        ex = bx - ax,
        ey = by - ay,
        det = ex * uy - ux * ey;
      if (Math.abs(det) < 1e-9) return;
      const d = (ex * ay - ax * ey) / det,
        s = (ux * ay - uy * ax) / det;
      if (d > 0 && s >= -1e-9 && s <= 1 + 1e-9) r = Math.max(r, d);
    });
    return r;
  });
/** The outline where overlapping soft circles [x, y, r] merge, like the goo between bodies. */
const merge = (balls: number[][]): Pts =>
  polar((t) => {
    const ux = Math.cos(t),
      uy = Math.sin(t);
    for (let r = 30; r > 0; r -= 0.02) {
      let f = 0;
      for (const [x, y, s] of balls)
        f += (s * s) / ((r * ux - x) ** 2 + (r * uy - y) ** 2);
      if (f >= 1) return r;
    }
    return R;
  });
const SHAPES = {
  // spinner.tsx pebble, scaled from its 41-unit body to 17 px
  pebble: polar((t) => R + Math.cos(3 * t + 0.6) + 0.6 * Math.sin(5 * t)),
  // division's done cell: round, a little uneven
  done: polar(
    (t) => R + 0.6 + 0.7 * Math.cos(2 * t + 1.1) + 0.45 * Math.sin(3 * t + 0.3),
  ),
  // spinner.tsx STAR4, scaled the same way
  star: polar((t) => ((21 + 23 * Math.abs(Math.cos(2 * t)) ** 1.9) * R) / 41),
  needs: polar((t) => R - 0.6 + 3.2 * Math.cos(3 * t + 1.5 * Math.PI)),
  // droplet: a settled drop, point up, its weight in the belly
  drop: cast(
    Array.from({ length: 480 }, (_, i) => {
      const s = (i / 480) * Math.PI * 2;
      return [19.5 * Math.sin(s) * Math.sin(s / 2), -17.6 * Math.cos(s)];
    }),
  ),
  // droplet: the working drop hangs from the spine on a thin neck
  hang: merge([
    [0, 4.5, 11.8],
    [0, -9, 4.2],
    [0, -15.5, 1.8],
  ]),
  // division: the working cell, already pinched at the waist
  split: merge([
    [0, -8.5, 9.2],
    [0, 8.5, 9.2],
  ]),
};
type Shape = keyof typeof SHAPES;
/** Rest paint. The travel layer settles on exactly these outlines before it hands back. */
export const MARK_PATHS = Object.fromEntries(
  Object.entries(SHAPES).map(([name, pts]) => [name, outline(pts, true)]),
) as Record<Shape, string>;
/** The same 64 samples as points (viewBox -18..18), for layers that morph between marks. */
export const MARK_POINTS: Readonly<Record<Shape, readonly (readonly number[])[]>> =
  SHAPES;
export const CHECK_PATH = "M-6.4 .2L-2 4.6L6.6-4.6";
export const BANG_PATH = "M0-6.6V1";
/** Each character's working body and done mark. */
export const MARK_LOOKS: Readonly<
  Record<MilestoneTravel, { work: Shape; done: Shape }>
> = {
  seed: { work: "pebble", done: "star" },
  droplet: { work: "hang", done: "drop" },
  division: { work: "split", done: "done" },
};
/** Where the check or nucleus sits: a drop carries it low, in its belly. */
export const MARK_GLYPH_Y: Readonly<Record<Shape, number>> = {
  pebble: 0,
  done: 0,
  star: 0,
  needs: 0,
  drop: 4,
  hang: 5,
  split: 0,
};
const glyphY = (pts: Pts) =>
  MARK_GLYPH_Y[
    (Object.keys(SHAPES) as Shape[]).find((k) => SHAPES[k] === pts) ?? "pebble"
  ];
export type MarkDeco = { kind: "membrane" | "depth"; d: string };
/**
 * The inner line that gives a character its material: a cell's membrane follows its outline;
 * a drop's depth is a crescent low in the belly. Seed and the "needs" mark carry none.
 */
export function markDeco(
  travel: MilestoneTravel,
  pts: readonly (readonly number[])[],
  cy: number,
): MarkDeco | null {
  if (travel === "division")
    return {
      kind: "membrane",
      d: outline(
        pts.map(([x, y]) => [x * 0.74, y * 0.74]),
        true,
      ),
    };
  if (travel === "droplet")
    return {
      kind: "depth",
      d:
        "M" +
        pts
          .slice(18, 29)
          .map(([x, y]) => `${f2(x * 0.78)} ${f2(cy + (y - cy) * 0.78)}`)
          .join("L"),
    };
  return null;
}

/* ---------- durations ---------- */
type Timing = { kind: string; startedAt?: number; elapsedMs?: number };
const valid = (n: unknown): n is number =>
  typeof n === "number" && Number.isFinite(n) && n >= 0;
/**
 * Milliseconds to show: undefined before a running clock's first client sample,
 * null for timing that does not fit the state (never a guessed value).
 */
export function elapsedOf(
  timing: Timing,
  state: State,
  now: number | null,
): number | null | undefined {
  if (state === "upcoming") return null;
  if (timing.kind !== (state === "current" ? "running" : "frozen")) return null;
  if (timing.kind === "frozen")
    return valid(timing.elapsedMs) ? timing.elapsedMs : null;
  if (
    !valid(timing.startedAt) ||
    (timing.elapsedMs !== undefined && !valid(timing.elapsedMs))
  )
    return null;
  if (now === null) return undefined;
  return (timing.elapsedMs ?? 0) + Math.max(0, now - timing.startedAt);
}
/** Whole seconds as m:ss, then h:mm:ss; each entry is one digit run. */
export function elapsedParts(ms: number) {
  const s = Math.floor(ms / 1000),
    pad = (n: number) => String(n).padStart(2, "0"),
    h = Math.floor(s / 3600),
    m = Math.floor((s % 3600) / 60);
  return h ? [String(h), pad(m), pad(s % 60)] : [String(m), pad(s % 60)];
}

/* ---------- what a state change means for the body ---------- */
export type TravelPlan =
  | { kind: "none" }
  | { kind: "anchor" }
  | { kind: "handoff"; from: number; to: number }
  | { kind: "finish"; at: number }
  | { kind: "recoil"; at: number }
  | { kind: "retry"; at: number };
const isActive = (s: State) => s === "current" || s === "needs";
/**
 * Stable ids decide travel: the body parked at `at` hands off to a later sibling,
 * becomes its own done mark, recoils or recovers. Anything else only re-anchors.
 */
export function planTravel(
  prevIds: readonly string[],
  ids: readonly string[],
  states: readonly State[],
  at: number,
  needs: boolean,
): TravelPlan {
  if (prevIds.length !== ids.length || ids.some((id, i) => id !== prevIds[i]))
    return { kind: "anchor" };
  const next = states.findIndex(isActive);
  if (at < 0 || at >= states.length)
    return next < 0 ? { kind: "none" } : { kind: "anchor" };
  const here = states[at];
  if (here === "complete") {
    if (next < 0)
      return states.every((s) => s === "complete")
        ? { kind: "finish", at }
        : { kind: "anchor" };
    if (next > at && states.slice(at, next).every((s) => s === "complete"))
      return { kind: "handoff", from: at, to: next };
    return { kind: "anchor" };
  }
  if (next !== at) return { kind: "anchor" };
  if (here === "needs") return needs ? { kind: "none" } : { kind: "recoil", at };
  if (here === "current") return needs ? { kind: "retry", at } : { kind: "none" };
  return { kind: "anchor" };
}

/* ---------- one rAF loop for every path, steppable by the shared motion clock ---------- */
type Scene = { frame: (dt: number) => boolean };
const scenes = new Set<Scene>();
let clock: number | null = null,
  previous: number | null = null,
  raf = 0;
function stopLoop() {
  if (raf) cancelAnimationFrame(raf);
  raf = 0;
}
function tick(t: number) {
  // Real elapsed time: the shared spring caps one step at 0.1 s, so slow machines keep pace with the clock.
  const dt = previous === null ? 0 : Math.max(0, (t - previous) / 1000);
  previous = t;
  let active = false;
  scenes.forEach((s) => {
    active = s.frame(dt) || active;
  });
  return active;
}
function wake() {
  if (clock !== null || raf || !scenes.size || document.hidden) return;
  if (previous === null) previous = performance.now();
  raf = requestAnimationFrame((t) => {
    raf = 0;
    if (tick(t)) wake();
    else previous = null;
  });
}
if (typeof window !== "undefined")
  registerMotionClock((t) => {
    stopLoop();
    if (t === null) {
      clock = null;
      previous = null;
      wake();
    } else {
      if (clock === null) previous = t;
      clock = t;
      tick(t);
    }
  });

/* ---------- the scene: a private decorative layer that owns paint only during an episode ---------- */
const NS = "http://www.w3.org/2000/svg";
const EXPRESSIVE: [number, number] = [260, 0.682]; // motionTokens.spring.expressive as k and damping ratio
const clamp = (v: number, a = 0, b = 1) => Math.min(b, Math.max(a, v));
const lerpPts = (A: Pts, B: Pts, m: number) =>
  A.map((p, i) => [p[0] + (B[i][0] - p[0]) * m, p[1] + (B[i][1] - p[1]) * m]);
type Blob = {
  g: SVGGElement;
  shape: SVGPathElement;
  gl: SVGGElement;
  core: SVGCircleElement;
  check: SVGPathElement;
  dg: SVGGElement;
  deco: SVGPathElement;
  show: boolean;
  at: number;
  seg: number;
  l0: number;
  l1: number;
  st: number;
  p: Spring;
  oy: Spring;
  s: Spring;
  q: Spring;
  rot: Spring;
  m: Spring;
  co: Spring;
  A: Pts;
  B: Pts;
  /** Glyph height on A and on B; it rides the morph with the outline. */
  ga: number;
  gb: number;
  fill: Fill;
  glyph: Glyph;
  later?: { fill: Fill; glyph: Glyph };
};
type Seg = {
  track: SVGPathElement;
  ink: SVGPathElement;
  pts: number[][];
  cum: number[];
  L: number;
};
type Sync = {
  ids: readonly string[];
  states: readonly State[];
  travel: MilestoneTravel;
  axis: "x" | "y";
  allowed: boolean;
  /** The top-level list previews a newly chosen character by replaying its last handoff. */
  lead?: boolean;
};

function el<K extends keyof SVGElementTagNameMap>(
  tag: K,
  parent: Element,
  attrs: Record<string, string | number> = {},
) {
  const e = document.createElementNS(NS, tag);
  for (const k in attrs) e.setAttribute(k, String(attrs[k]));
  parent.appendChild(e);
  return e;
}
const memo = new WeakMap<Element, Record<string, string | null>>();
function attr(e: Element, k: string, v: string | null) {
  let c = memo.get(e);
  if (!c) memo.set(e, (c = {}));
  if (c[k] === v) return;
  c[k] = v;
  if (v === null) e.removeAttribute(k);
  else e.setAttribute(k, v);
}
const OWNED = "data-travel-owned";
const BLOB_SPRINGS = ["p", "oy", "s", "q", "rot", "m", "co"] as const;

/** A phase wait: the shared motion clock bounds it; `when` lets it end early once the springs settle. */
type Wait = { g: number; timer: MotionTimer; when?: () => boolean; r: () => void };

function createScene(host: HTMLElement, svg: SVGSVGElement, gooId: string) {
  const S = (k: number, z: number, x = 0): Spring => ({ x, v: 0, to: x, k, z });
  const tune = (s: Spring, k: number, z: number) => {
    s.k = k;
    s.z = z;
    return s;
  };
  const set = (s: Spring, x: number) => {
    s.x = s.to = x;
    s.v = 0;
  };
  const rest = (s: Spring) => s.x === s.to && s.v === 0;

  let ids: readonly string[] = [],
    states: readonly State[] = [],
    travel: MilestoneTravel = "seed",
    axis: "x" | "y" = "y";
  let C: number[][] = [],
    segs: Seg[] = [],
    rings: { el: SVGCircleElement; show: boolean }[] = [],
    ink: number[] = [],
    marks: Blob[] = [];
  let waits: Wait[] = [],
    hook: (() => void) | null = null,
    busy = false,
    gen = 0,
    painting = false,
    at = -1, // where the body is parked, or heading
    mood = false, // true while the body shows "needs one action"
    ep: { to: number; landed: boolean; passed: Set<number> } | null = null;
  // Index -> the exact element hidden, so a reorder mid-travel still unhides the right node.
  const owned = new Map<number, HTMLElement | SVGElement>(),
    ownedSegs = new Map<number, Element>();

  // layers, back to front: spine, rings, halo, gooey bodies, material lines, upright glyphs
  const defs = el("defs", svg);
  const filter = el("filter", defs, {
    id: gooId,
    filterUnits: "userSpaceOnUse",
    "color-interpolation-filters": "sRGB",
  });
  el("feGaussianBlur", filter, { in: "SourceGraphic", stdDeviation: 3.2 });
  el("feColorMatrix", filter, {
    values: "1 0 0 0 0  0 1 0 0 0  0 0 1 0 0  0 0 0 20 -8.5",
  });
  const gSpine = el("g", svg),
    gRings = el("g", svg),
    haloEl = el("circle", svg, { r: 22.5, class: "v-milestone-path__halo" }),
    gBlobs = el("g", svg),
    gNeck = el("g", gBlobs),
    gBody = el("g", gBlobs),
    gMarks = el("g", gBlobs),
    gDeco = el("g", svg),
    gGlyphs = el("g", svg);
  const neckEls = Array.from({ length: 9 }, () =>
    el("circle", gNeck, { class: "v-milestone-path__shape" }),
  );
  const neck = { n: 0, seg: 0, d: 0 };
  const halo = { s: S(220, 0.5, 1), danger: false, x: 0, y: 0 };
  const sep = S(90, 0.8);

  function makeBlob(layer: SVGGElement): Blob {
    const g = el("g", layer),
      shape = el("path", g, { class: "v-milestone-path__shape" }),
      dg = el("g", gDeco),
      deco = el("path", dg, { class: "v-milestone-path__deco" }),
      gl = el("g", gGlyphs, { class: "v-milestone-path__glyph" });
    const core = el("circle", gl, { class: "v-milestone-path__core", r: 3.2 });
    const check = el("path", gl, {
      class: "v-milestone-path__check",
      d: CHECK_PATH,
      pathLength: 1,
    });
    const bang = el("g", gl, { class: "v-milestone-path__bang" });
    el("path", bang, { d: BANG_PATH });
    el("circle", bang, { cy: 5.6, r: 1.6 });
    return {
      g, shape, gl, core, check, dg, deco, show: false, at: 0, seg: -1, l0: 0, l1: 1, st: 0,
      p: S(...EXPRESSIVE), oy: S(300, 0.5), s: S(260, 0.6, 1), q: S(300, 0.35),
      rot: S(300, 0.4), m: S(240, 0.6, 1), co: S(220, 0.6),
      A: SHAPES.pebble, B: SHAPES.pebble, ga: 0, gb: 0, fill: "pink", glyph: "core",
    };
  }
  const body = makeBlob(gBody);
  body.g.setAttribute("data-traveler", "");
  const springs = () => [
    halo.s,
    sep,
    ...[body, ...marks].flatMap((b) => BLOB_SPRINGS.map((k) => b[k])),
  ];
  const scene: Scene = { frame };

  /* geometry: marker centres, and the Milestone path connection scaled between them */
  const rows = () =>
    Array.from(host.querySelectorAll<HTMLElement>(":scope > ol > li"));
  const part = (i: number, name: "marker" | "connection") =>
    rows()[i]?.querySelector<HTMLElement | SVGElement>(
      `:scope > .v-milestone-path__${name}`,
    ) ?? null;
  // Along the spine; the S-curve bows to the right of a column and below a row.
  const along = () => (axis === "y" ? [0, 1] : [1, 0]);
  function sampleSeg(sg: Seg, P0: number[], P1: number[]) {
    const [nx, ny] = axis === "y" ? [1, 0] : [0, 1];
    const P = (t: number, off: number) => [
      P0[0] + (P1[0] - P0[0]) * t + nx * off,
      P0[1] + (P1[1] - P0[1]) * t + ny * off,
    ];
    // M18 0 C18 26 21 31 18 50 C15 69 18 75 18 100, scaled between the two marker centres
    const c = [P(0, 0), P(0.26, 0), P(0.31, 3), P(0.5, 0), P(0.69, -3), P(0.75, 0), P(1, 0)];
    sg.pts = [];
    sg.cum = [];
    sg.L = 0;
    for (const k of [0, 3])
      for (let i = k ? 1 : 0; i <= 24; i++) {
        const t = i / 24,
          u = 1 - t;
        const p = [0, 1].map(
          (j) =>
            u * u * u * c[k][j] +
            3 * u * u * t * c[k + 1][j] +
            3 * u * t * t * c[k + 2][j] +
            t * t * t * c[k + 3][j],
        );
        const last = sg.pts[sg.pts.length - 1];
        if (last) sg.L += Math.hypot(p[0] - last[0], p[1] - last[1]);
        sg.pts.push(p);
        sg.cum.push(sg.L);
      }
    const xy = (p: number[]) => `${f2(p[0])} ${f2(p[1])}`;
    const d = `M${xy(c[0])}C${xy(c[1])} ${xy(c[2])} ${xy(c[3])}C${xy(c[4])} ${xy(c[5])} ${xy(c[6])}`;
    sg.track.setAttribute("d", d);
    sg.ink.setAttribute("d", d);
    sg.ink.setAttribute("stroke-dasharray", `${f2(sg.L)} ${f2(sg.L + 4)}`);
    memo.delete(sg.ink);
  }
  function build(n: number) {
    for (const g of [gSpine, gRings, gMarks]) g.replaceChildren();
    for (const mk of marks) {
      mk.gl.remove();
      mk.dg.remove();
    }
    segs = Array.from({ length: Math.max(0, n - 1) }, () => ({
      track: el("path", gSpine, { class: "v-milestone-path__track" }),
      ink: el("path", gSpine, { class: "v-milestone-path__progress" }),
      pts: [],
      cum: [],
      L: 1,
    }));
    rings = Array.from({ length: n }, () => ({
      el: el("circle", gRings, { r: 5.5, class: "v-milestone-path__ring" }),
      show: false,
    }));
    ink = segs.map(() => 0);
    marks = Array.from({ length: n }, () => makeBlob(gMarks));
  }
  function measure() {
    const box = host.getBoundingClientRect();
    const items = rows();
    if (items.length !== marks.length) build(items.length);
    C = items.map((li) => {
      const r = (
        li.querySelector(":scope > .v-milestone-path__marker") ?? li
      ).getBoundingClientRect();
      return [r.left - box.left + r.width / 2, r.top - box.top + r.height / 2];
    });
    segs.forEach((sg, i) => sampleSeg(sg, C[i], C[i + 1]));
    rings.forEach((r, i) => {
      r.el.setAttribute("cx", f2(C[i][0]));
      r.el.setAttribute("cy", f2(C[i][1]));
    });
    filter.setAttribute("x", "-60");
    filter.setAttribute("y", "-60");
    filter.setAttribute("width", String(Math.ceil(box.width + 120)));
    filter.setAttribute("height", String(Math.ceil(box.height + 120)));
  }
  // A point `len` px along the spine from marker `seg`, continuing straight past either end.
  function pointAt(seg: number, len: number) {
    const [ax, ay] = along();
    let i = seg;
    while (i < segs.length - 1 && len > segs[i].L) len -= segs[i++].L;
    const sg = segs[i];
    if (!sg) return [C[seg][0] + ax * len, C[seg][1] + ay * len];
    if (len <= 0) return [C[i][0] + ax * len, C[i][1] + ay * len];
    if (len >= sg.L)
      return [C[i + 1][0] + ax * (len - sg.L), C[i + 1][1] + ay * (len - sg.L)];
    let k = 1;
    while (sg.cum[k] < len) k++;
    const t = (len - sg.cum[k - 1]) / (sg.cum[k] - sg.cum[k - 1] || 1);
    const [a, b] = [sg.pts[k - 1], sg.pts[k]];
    return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
  }
  const spanTo = (from: number, to: number) =>
    segs.slice(from, to).reduce((sum, sg) => sum + sg.L, 0);
  const lenOf = (b: Blob) => b.l0 + (b.l1 - b.l0) * b.p.x;
  function pos(b: Blob) {
    const [ax, ay] = along();
    const [x, y] = b.seg < 0 ? (C[b.at] ?? [0, 0]) : pointAt(b.seg, lenOf(b));
    return [x + ax * b.oy.x, y + ay * b.oy.x];
  }
  const currentPts = (b: Blob) => lerpPts(b.A, b.B, clamp(b.m.x, -0.25, 1.25));
  const gyOf = (b: Blob) => b.ga + (b.gb - b.ga) * clamp(b.m.x, -0.25, 1.25);
  function shapeAs(b: Blob, pts: Pts) {
    b.A = b.B = pts;
    b.ga = b.gb = glyphY(pts);
    set(b.m, 1);
  }

  /* paint */
  function drawBlob(b: Blob) {
    attr(b.g, "display", b.show ? null : "none");
    attr(b.gl, "display", b.show ? null : "none");
    attr(b.dg, "display", b.show ? null : "none");
    if (!b.show) return;
    const [x, y] = pos(b),
      s = Math.max(0, b.s.x),
      wide = (s * (1 + b.q.x)) / (1 + b.st * 0.75),
      tall = s * (1 - b.q.x) * (1 + b.st);
    const [sx, sy] = axis === "y" ? [wide, tall] : [tall, wide];
    const pose = `translate(${f2(x)} ${f2(y)}) scale(${f3(sx)} ${f3(sy)}) rotate(${f2(b.rot.x)})`;
    const pts = currentPts(b),
      gy = gyOf(b);
    attr(b.g, "transform", pose);
    attr(b.shape, "d", outline(pts, true));
    attr(b.shape, "data-fill", b.fill);
    // The material line keeps the body's pose; it shows on a settled working body or done mark.
    const deco = b.fill === "danger" ? null : markDeco(travel, pts, gy);
    attr(b.dg, "transform", pose);
    attr(b.deco, "d", deco?.d ?? null);
    attr(b.deco, "data-deco", deco?.kind ?? null);
    attr(b.deco, "data-fill", b.fill);
    attr(
      b.deco,
      "data-on",
      deco &&
        (b.glyph === "core" || b.glyph === "check") &&
        (b !== body || b.seg < 0 || !!ep?.landed)
        ? ""
        : null,
    );
    attr(b.gl, "transform", `translate(${f2(x)} ${f2(y)}) scale(${f3(s)})`);
    const a = (b.rot.x * Math.PI) / 180; // only the nucleus turns with the body; check and "!" stay upright
    attr(b.core, "cx", f2(Math.sin(a) * (b.co.x - gy)));
    attr(b.core, "cy", f2(-Math.cos(a) * (b.co.x - gy)));
    attr(b.check, "transform", gy ? `translate(0 ${f2(gy)})` : null);
    attr(b.gl, "data-glyph", b.glyph);
  }
  function draw() {
    segs.forEach((sg, i) => {
      const mine = ownedSegs.has(i);
      attr(sg.track, "display", mine ? null : "none");
      attr(sg.ink, "display", mine && ink[i] > 0.001 ? null : "none");
      attr(sg.ink, "stroke-dashoffset", f2(sg.L * (1 - ink[i])));
    });
    rings.forEach((r) => attr(r.el, "display", r.show ? null : "none"));
    neckEls.forEach((c, k) => {
      if (neck.n <= 0) return attr(c, "display", "none");
      const t = (k + 1) / (neckEls.length + 1),
        [x, y] = pointAt(neck.seg, neck.d * t);
      const r = R * 0.5 * neck.n ** 0.75 * (0.5 + 0.5 * (2 * t - 1) ** 2);
      attr(c, "display", null);
      attr(c, "cx", f2(x));
      attr(c, "cy", f2(y));
      attr(c, "r", f2(r));
      attr(c, "data-fill", body.fill);
    });
    if (body.show) [halo.x, halo.y] = pos(body);
    const hs = halo.s.x;
    attr(
      haloEl,
      "transform",
      `translate(${f2(halo.x)} ${f2(halo.y)}) scale(${f3(Math.max(0, hs))})`,
    );
    attr(haloEl, "opacity", painting ? f3(clamp((hs - 0.6) / 0.4)) : "0");
    attr(haloEl, "data-tone", halo.danger ? "danger" : null);
    drawBlob(body);
    marks.forEach(drawBlob);
  }

  /* the clock */
  function frame(dt: number) {
    if (!painting) return false;
    for (const s of springs()) if (!rest(s)) spring(s, dt);
    // Turns are in degrees: the shared 0.0008 snap would hold an invisible creep for about a second.
    for (const b of [body, ...marks])
      if (Math.abs(b.rot.to - b.rot.x) < 0.1 && Math.abs(b.rot.v) < 1) set(b.rot, b.rot.to);    hook?.();
    draw();
    for (const w of waits.slice()) if (w.g !== gen || w.when?.()) done(w);
    const active =
      waits.length > 0 || !!hook || springs().some((s) => !rest(s));
    if (!active && !busy) release(true);
    return active;
  }
  function done(w: Wait) {
    const i = waits.indexOf(w);
    if (i < 0) return;
    waits.splice(i, 1);
    cancelMotion(w.timer);
    w.r();
  }
  const wait = (ms: number, when?: () => boolean) =>
    new Promise<void>((r) => {
      const w: Wait = { g: gen, when, r, timer: scheduleMotion(() => done(w), ms) };
      waits.push(w);
      wake();
    });
  const sleep = (ms: number) => wait(ms);
  const until = (when: () => boolean, maxMs = 3000) => wait(maxMs, when);

  /* ownership: static markers hide only while this layer paints them */
  function own(from: number, to: number) {
    for (let i = from; i <= to; i++) {
      const marker = part(i, "marker");
      if (marker) {
        owned.set(i, marker);
        marker.setAttribute(OWNED, "");
      }
      const connection = i < to ? part(i, "connection") : null;
      if (connection) {
        ownedSegs.set(i, connection);
        connection.setAttribute(OWNED, "");
      }
    }
  }
  const turnOf = (i: number) =>
    parseFloat(part(i, "marker")?.style.getPropertyValue("--mp-turn") ?? "") ||
    0;
  function setTurn(i: number, deg: number) {
    const m = part(i, "marker");
    if (m) turn(m, deg);
  }
  function turn(m: HTMLElement | SVGElement, deg: number) {
    const d = ((deg % 360) + 360) % 360;
    if (d < 0.05 || d > 359.95) m.style.removeProperty("--mp-turn");
    else m.style.setProperty("--mp-turn", `${d.toFixed(2)}deg`);
  }
  /**
   * Hand every owned marker back to static paint. At rest the layer shows the same outline,
   * so `keep` carries its turn over; a cancelled beat drops to the upright rest paint.
   */
  function release(keep: boolean) {
    for (const [i, marker] of owned) {
      const b =
        body.show && body.seg < 0 && body.at === i
          ? body
          : marks[i]?.show
            ? marks[i]
            : null;
      turn(marker, keep && b ? b.rot.x : 0);
      marker.removeAttribute(OWNED);
    }
    for (const connection of ownedSegs.values()) connection.removeAttribute(OWNED);
    owned.clear();
    ownedSegs.clear();
    painting = false;
    hook = null;
    const pending = waits;
    waits = [];
    pending.forEach((w) => {
      cancelMotion(w.timer);
      w.r();
    });
    busy = false;
    neck.n = 0;
    ep = null;
    gBlobs.removeAttribute("filter");
    body.show = false;
    marks.forEach((mk) => (mk.show = false));
    rings.forEach((r) => (r.show = false));
    draw();
  }

  /* blobs start each beat as the rest paint of the item they stand on */
  function resetBlob(b: Blob) {
    b.seg = -1;
    b.st = 0;
    b.later = undefined;
    tune(b.p, ...EXPRESSIVE);
    set(b.p, 0);
    tune(b.oy, 300, 0.5);
    set(b.oy, 0);
    tune(b.s, 260, 0.6);
    set(b.s, 1);
    tune(b.q, 300, 0.35);
    set(b.q, 0);
    tune(b.m, 240, 0.6);
    set(b.m, 1);
    tune(b.rot, 300, 0.4);
    set(b.co, 0);
  }
  const doneShape = () => SHAPES[MARK_LOOKS[travel].done];
  const workShape = () => SHAPES[MARK_LOOKS[travel].work];
  const doneGlyph = (): Glyph => (travel === "seed" ? "none" : "check");
  /** Take over the static paint of items from..to (inclusive) and start a new beat. */
  function begin(from: number, to: number) {
    if (!painting) {
      painting = true;
      ink = segs.map(() => 0);
      neck.n = 0;
      set(sep, 0);
      resetBlob(body);
      set(body.rot, turnOf(at));
      body.show = true;
      body.at = at;
      shapeAs(body, mood ? SHAPES.needs : workShape());
      body.fill = mood ? "danger" : "pink";
      body.glyph = mood ? "bang" : "core";
      tune(halo.s, 220, 0.5);
      set(halo.s, 1);
      halo.danger = mood;
    }
    for (let i = from; i <= to; i++)
      if (!owned.has(i) && i !== at) rings[i].show = true;
    own(from, to);
    busy = true;
    return ++gen;
  }

  /* ---------- choreography shared by every character (ported from the step-travel prototype) ---------- */
  function handOff(mk: Blob, b: Blob) {
    // the step's mark takes over the body's exact look, so nothing pops
    mk.show = true;
    mk.seg = -1;
    mk.at = b.at;
    for (const k of ["oy", "s", "q", "rot"] as const)
      Object.assign(mk[k], { ...b[k] });
    mk.A = mk.B = currentPts(b);
    mk.ga = mk.gb = gyOf(b);
    set(mk.m, 1);
    mk.fill = b.fill;
    mk.glyph = b.glyph;
    mk.st = b.st;
    mk.later = undefined;
  }
  function morphTo(b: Blob, shape: Pts, k: number, z: number) {
    b.ga = gyOf(b);
    b.gb = glyphY(shape);
    b.A = currentPts(b);
    b.B = shape;
    set(b.m, 0);
    tune(b.m, k, z).to = 1;
  }
  function harden(mk: Blob) {
    morphTo(mk, doneShape(), 240, 0.6);
    mk.fill = "olive";
    tune(mk.s, 260, 0.45).to = 1;
    mk.glyph = "check";
  }
  const haloOut = () => {
    tune(halo.s, 420, 1).to = 0.6;
  };
  function haloBloom() {
    halo.danger = body.fill === "danger";
    set(halo.s, 0.6);
    tune(halo.s, 200, 0.5).to = 1;
  }
  function startTrack(b: Blob, seg: number, l0: number) {
    b.seg = seg;
    b.l0 = l0;
    b.l1 = spanTo(seg, ep!.to);
    tune(b.p, ...EXPRESSIVE);
    set(b.p, 0);
  }
  // 1. Anticipation: gather and squash, about 120 ms.
  async function anticipate(b: Blob) {
    tune(b.q, 900, 1).to = 0.13;
    tune(b.oy, 900, 1).to = -3;
    tune(b.s, 900, 1).to = 0.95;
    await sleep(120);
    tune(b.q, 300, 0.35).to = 0;
    tune(b.oy, 260, 0.55).to = 0;
    tune(b.s, 300, 0.5).to = 1;
  }
  // A step the body passes on a retargeted run blooms its done mark as the body goes by.
  function leaveMark(i: number) {
    const mk = marks[i];
    resetBlob(mk);
    mk.show = true;
    mk.at = i;
    shapeAs(mk, doneShape());
    mk.fill = "olive";
    mk.glyph = doneGlyph();
    set(mk.rot, 0);
    set(mk.s, 0.55);
    tune(mk.s, 260, 0.45).to = 1;
    mk.q.v -= 1.2;
  }
  // 2-3. Travel on the expressive spring; arrival squash settles in ~625 ms (k 300, z .35).
  function travelHook(b: Blob, extra?: (len: number) => void) {
    return () => {
      const e = ep!,
        len = lenOf(b),
        span = b.l1 - b.l0;
      let start = 0;
      for (let i = b.seg; i < e.to; i++) {
        ink[i] = clamp((len - start) / segs[i].L);
        start += segs[i].L;
        if (len > start - 9) {
          rings[i + 1].show = false;
          if (i + 1 < e.to && !e.passed.has(i + 1)) {
            e.passed.add(i + 1);
            leaveMark(i + 1);
          }
        }
      }
      if (!e.landed) b.st = Math.min(0.3, (Math.abs(b.p.v) * span) / 1900);
      else b.st *= 0.8;
      if (!e.landed && b.p.x >= 1) {
        e.landed = true;
        b.q.v += Math.min(4.2, Math.abs(b.p.v) * span * 0.0055);
        haloBloom();
        gBlobs.removeAttribute("filter"); // the goo joins bodies only while they travel
      }
      extra?.(len);
    };
  }
  // Park the body on its destination; any residual overshoot moves into oy, so nothing jumps.
  function park(b: Blob) {
    if (b.seg < 0 || !ep) return;
    b.oy.x += lenOf(b) - b.l1;
    b.oy.v += b.p.v * (b.l1 - b.l0);
    b.seg = -1;
    b.at = ep.to;
    b.st = 0;
    set(b.p, 0);
    hook = null;
    neck.n = 0;
    set(sep, 0);
    gBlobs.removeAttribute("filter");
  }
  function settled(g: number) {
    if (g !== gen) return;
    busy = false;
    reconcile();
    wake();
  }
  async function finishInPlace(mk: Blob, b: Blob, g: number) {
    // the last step has nowhere to go: the body becomes its own mark
    b.show = false;
    haloOut();
    if (travel === "seed") {
      morphTo(mk, SHAPES.star, 220, 0.55);
      mk.fill = "olive";
      mk.glyph = "none";
      tune(mk.rot, 170, 0.5).to = Math.ceil((mk.rot.x + 45) / 90) * 90;
    } else {
      harden(mk);
      mk.s.x = Math.min(mk.s.x, 0.9);
    }
    at = -1;
    await until(() => rest(mk.m) && rest(mk.s) && rest(mk.rot));
    settled(g);
  }

  /* droplet: a neck pulls along the spine, thins and snaps; the drop left behind blooms into the done mark */
  async function droplet(from: number, g: number) {
    const b = body,
      mk = marks[from];
    await anticipate(b);
    if (g !== gen) return;
    handOff(mk, b);
    mk.glyph = "none";
    if (!ep) return finishInPlace(mk, b, g);
    gBlobs.setAttribute("filter", `url(#${gooId})`);
    tune(mk.s, 300, 0.9).to = 0.56;
    haloOut();
    startTrack(b, from, 0);
    b.p.to = 1;
    neck.seg = from;
    let snap = false;
    hook = travelHook(b, (len) => {
      neck.d = len;
      neck.n = clamp(1 - len / (segs[from].L * 0.6));
      if (!snap && neck.n < 0.14 && len > 12) {
        snap = true;
        harden(mk);
        mk.q.v -= 2.4;
        b.q.v -= 1.2;
      }
    });
    await until(() => !!ep?.landed && rest(b.p) && rest(b.q));
    if (g !== gen) return;
    park(b);
    settled(g);
  }

  /* seed: the seed becomes the four-point star; a new seed buds off it and rolls to the next step */
  async function seed(from: number, g: number) {
    const b = body,
      mk = marks[from];
    await anticipate(b);
    if (g !== gen) return;
    handOff(mk, b);
    b.show = false;
    if (!ep) return finishInPlace(mk, b, g);
    haloOut();
    morphTo(mk, SHAPES.star, 220, 0.55);
    mk.fill = "olive";
    mk.glyph = "none";
    tune(mk.rot, 170, 0.5).to = Math.ceil((mk.rot.x + 45) / 90) * 90;
    tune(mk.s, 300, 0.5);
    mk.s.v += 1.4;
    await sleep(150);
    if (g !== gen) return;
    // the bud grows out from behind the star's lower point
    b.show = true;
    shapeAs(b, SHAPES.pebble);
    b.fill = "pink";
    b.glyph = "core";
    set(b.rot, 0);
    set(b.q, 0);
    set(b.oy, 0);
    set(b.s, 0);
    tune(b.s, 320, 0.7).to = 0.46;
    startTrack(b, from, 8);
    await sleep(170);
    if (g !== gen) return;
    b.p.to = 1;
    tune(b.s, 110, 0.85).to = 1;
    tune(b.co, 200, 0.8).to = 5.5; // the nucleus sits off-centre while it rolls, so the turn is visible
    let lastLen = lenOf(b);
    hook = travelHook(b, (len) => {
      // rolling: turn = distance / radius, so the overshoot rolls it back
      set(b.rot, b.rot.x + ((len - lastLen) / (R * Math.max(0.35, b.s.x))) * 57.2958);
      lastLen = len;
      if (ep?.landed && b.co.to) tune(b.co, 220, 0.6).to = 0;
    });
    await until(
      () => !!ep?.landed && rest(b.p) && rest(b.s) && rest(b.q) && rest(b.co),
    );
    if (g !== gen) return;
    park(b);
    settled(g);
  }

  /* division: the body elongates and pinches in two; one half hardens, the daughter travels */
  async function division(from: number, g: number) {
    const b = body,
      mk = marks[from];
    await anticipate(b);
    if (g !== gen) return;
    handOff(mk, b);
    if (!ep) {
      mk.glyph = "none";
      return finishInPlace(mk, b, g);
    }
    gBlobs.setAttribute("filter", `url(#${gooId})`);
    haloOut();
    tune(mk.s, 260, 0.9).to = 0.8;
    tune(b.s, 260, 0.9).to = 0.8;
    set(sep, 0);
    sep.to = 36;
    startTrack(b, from, 0);
    let pinched = false;
    const travelling = travelHook(b, () => {
      // The half keeps the body's colour until the goo lets go, so pink never blends into olive.
      if (!mk.later) return;
      const [x0, y0] = pos(mk),
        [x1, y1] = pos(b);
      if (Math.hypot(x1 - x0, y1 - y0) > R * (mk.s.x + b.s.x) + 8) {
        mk.fill = mk.later.fill;
        mk.glyph = mk.later.glyph;
        mk.later = undefined;
      }
    });
    hook = () => {
      if (pinched) return travelling();
      const e = clamp(sep.x / 36);
      b.l0 = sep.x * 0.82;
      set(mk.oy, -sep.x * 0.18);
      mk.st = b.st = 0.22 * Math.sin(Math.PI * e); // the cell elongates along the spine as it divides
      ink[from] = clamp(b.l0 / segs[from].L);
      if (sep.x > 30.5) {
        pinched = true;
        mk.q.x = -mk.st * 0.85;
        mk.st = 0; // the stretch snaps back as a wobble
        harden(mk);
        mk.later = { fill: "olive", glyph: "check" };
        mk.fill = b.fill;
        mk.glyph = "none";
        tune(mk.oy, 220, 0.6).to = 0;
        b.q.x = -b.st * 0.85;
        b.p.v = (sep.v * 0.82) / (b.l1 - b.l0);
        b.p.to = 1;
        tune(b.s, 140, 0.8).to = 1;
      }
    };
    await until(() => !!ep?.landed && rest(b.p) && rest(b.q) && rest(b.s));
    if (g !== gen) return;
    if (mk.later) {
      mk.fill = mk.later.fill;
      mk.glyph = mk.later.glyph;
      mk.later = undefined;
    }
    park(b);
    settled(g);
  }

  function run(from: number, to: number) {
    park(body);
    const g = begin(from, Math.max(from, to));
    ep = to < 0 ? null : { to, landed: false, passed: new Set() };
    if (to >= 0) at = to;
    if (body.fill === "danger") {
      // finished straight from needing an action: the traveller is working again
      morphTo(body, workShape(), 240, 0.55);
      body.fill = "pink";
      body.glyph = "core";
      halo.danger = false;
    }
    mood = false;
    void { seed, droplet, division }[travel](from, g);
  }
  /**
   * A newly chosen character introduces itself: the last done mark wakes back into the
   * working body, then hands off to the current step again. Only text-free paint moves.
   */
  async function replay() {
    const to = at;
    if (to < 1 || states[to] !== "current" || states[to - 1] !== "complete") return;
    const from = to - 1,
      b = body;
    at = from;
    mood = false;
    const g = begin(from, to);
    ep = { to, landed: false, passed: new Set() };
    at = to;
    shapeAs(b, doneShape());
    b.fill = "olive";
    b.glyph = doneGlyph();
    set(halo.s, 0.6);
    await sleep(60); // one painted frame of the done look, so the change below transitions
    if (g !== gen) return;
    morphTo(b, workShape(), 240, 0.6);
    b.fill = "pink";
    b.glyph = "core";
    haloBloom();
    await until(() => rest(b.m) && rest(halo.s), 700);
    if (g !== gen) return;
    void { seed, droplet, division }[travel](from, g);
  }
  function recoil() {
    park(body);
    const g = begin(at, at),
      b = body;
    mood = true;
    // a flinch back up the spine, a contraction and a shudder, then the danger tone and the needs shape
    tune(b.oy, 380, 0.42).v -= 240;
    tune(b.s, 260, 0.5).v -= 2.2;
    tune(b.q, 300, 0.35).v -= 1.6;
    tune(b.rot, 420, 0.3).v += 380;
    b.rot.to = Math.round(b.rot.x / 120) * 120;
    morphTo(b, SHAPES.needs, 260, 0.5);
    b.fill = "danger";
    b.glyph = "bang";
    halo.danger = true;
    tune(halo.s, 300, 0.4).v -= 2.5;
    void until(() => [b.oy, b.s, b.q, b.rot, b.m].every(rest)).then(() =>
      settled(g),
    );
  }
  function retry() {
    park(body);
    const g = begin(at, at),
      b = body;
    mood = false;
    morphTo(b, workShape(), 240, 0.55);
    // a drop or a cell comes back upright; the seed keeps the turn it shuddered to
    if (travel !== "seed") tune(b.rot, 220, 0.6).to = Math.round(b.rot.x / 360) * 360;
    b.fill = "pink";
    b.glyph = "core";
    b.q.v += 2.4;
    b.s.v += 1.2;
    haloBloom();
    void until(() => [b.oy, b.s, b.q, b.rot, b.m].every(rest)).then(() =>
      settled(g),
    );
  }

  // Instant: drop any beat in flight and show the static paint.
  function anchor() {
    gen++;
    if (painting) release(false);
    at = states.findIndex(isActive);
    mood = states[at] === "needs";
  }
  function act(plan: TravelPlan) {
    if (plan.kind === "anchor") return anchor();
    if (plan.kind === "none") return;
    const inFlight = !!ep && !ep.landed && busy;
    if (plan.kind === "handoff" && inFlight) {
      // retarget from the current position and velocity
      const b = body,
        e = ep!;
      e.to = plan.to;
      at = plan.to;
      for (let i = plan.from + 1; i <= plan.to; i++)
        if (!e.passed.has(i)) rings[i].show = true;
      own(plan.from, plan.to);
      if (b.seg >= 0) {
        const len = lenOf(b),
          v = b.p.v * (b.l1 - b.l0);
        b.l0 = len;
        b.l1 = spanTo(b.seg, plan.to);
        b.p.x = 0;
        b.p.v = v / Math.max(1, b.l1 - b.l0);
      }
      return;
    }
    if (inFlight) return; // the beat in flight lands first, then reconcile() catches up
    if (plan.kind === "handoff") return run(plan.from, plan.to);
    if (plan.kind === "finish") return run(plan.at, -1);
    if (plan.kind === "recoil") return recoil();
    retry();
  }
  function reconcile() {
    if (at >= 0) act(planTravel(ids, ids, states, at, mood));
  }

  return {
    sync(next: Sync) {
      const variant = next.travel !== travel;
      const same =
        next.axis === axis &&
        next.ids.length === ids.length &&
        next.ids.every((id, i) => id === ids[i]);
      const fresh = variant || !same;
      const instant = fresh || !next.allowed || document.hidden;
      const preview =
        variant && same && ids.length > 0 && !!next.lead && next.allowed && !document.hidden;
      const before = new Map(ids.map((id, i) => [id, states[i]]));
      const prevIds = ids;
      if (instant && painting) {
        gen++;
        release(false);
      }
      ids = next.ids;
      states = next.states;
      travel = next.travel;
      axis = next.axis;
      measure();
      const changed = ids.map(
        (id, i) => variant || before.get(id) !== states[i],
      );
      const plan: TravelPlan = instant
        ? { kind: "anchor" }
        : changed.some(Boolean)
          ? planTravel(prevIds, ids, states, at, mood)
          : { kind: "none" };
      // The layer sets the final turn of whatever it animates; everything else rests upright.
      const lo =
          plan.kind === "handoff" ? plan.from : "at" in plan ? plan.at : -1,
        hi = plan.kind === "handoff" ? plan.to : lo;
      changed.forEach(
        (c, i) => c && !owned.has(i) && (i < lo || i > hi) && setTurn(i, 0),
      );
      act(plan);
      if (preview) void replay();
      draw();
      wake();
    },
    measure() {
      if (!painting) return;
      measure();
      draw();
    },
    attach() {
      scenes.add(scene);
    },
    destroy() {
      gen++;
      if (painting) release(false);
      scenes.delete(scene);
      svg.replaceChildren();
    },
  };
}

/**
 * Drives the decorative travel layer for one sibling list. The caller renders the static
 * paint; this only borrows it while a beat plays and always hands back the same outline.
 */
export function useMilestoneTravel(
  host: React.RefObject<HTMLElement | null>,
  layer: React.RefObject<SVGSVGElement | null>,
  next: Sync,
) {
  const id = React.useId();
  const scene = React.useRef<ReturnType<typeof createScene> | null>(null);
  const sync = React.useEffectEvent(() => scene.current?.sync(next));
  React.useLayoutEffect(() => {
    if (!host.current || !layer.current) return;
    const s = createScene(
      host.current,
      layer.current,
      `mp-goo-${id.replace(/[^\w-]/g, "")}`,
    );
    s.attach();
    scene.current = s;
    const observer = new ResizeObserver(() => s.measure());
    observer.observe(host.current);
    return () => {
      observer.disconnect();
      s.destroy();
      scene.current = null;
    };
  }, [host, layer, id]);
  const key = `${next.ids.join("\u0001")}\u0002${next.states.join(",")}`;
  // Declared after the scene effect, so on mount the scene exists before its first sync.
  React.useLayoutEffect(() => {
    sync();
  }, [key, next.travel, next.axis, next.allowed, next.lead]);
}
