"use client";

import * as React from "react";
import { usePresence } from "motion/react";
import { path as outline, spring, type Spring } from "@/lib/cojeev-motion/geometry";
import {
  cancelMotion,
  registerMotionClock,
  scheduleMotion,
  type MotionTimer,
} from "@/lib/cojeev-motion/clock";
import { createMotionLane } from "@/lib/cojeev-motion/choreography";
import { MARK_POINTS } from "@/lib/cojeev/milestone-travel";

export type ActivityLayout = "thread" | "ledger" | "bursts";
type Pts = readonly (readonly number[])[];
type Pair = readonly [number, number];

/* ---------- motion table: every spring is [stiffness, damping ratio] ---------- */
const SPR = {
  remove: [300, 1], // a removed row or label closes to zero
  restore: [260, 0.78], // a removal reversed before it finished
  markIn: [320, 0.6], // a revealed thread marker pops in
  markOut: [380, 0.8], // a removed thread marker folds away
  thread: {
    arrive: [210, 0.72], // the new row makes room; content fades in at 55 %
    threadUp: [150, 0.95], // the thread grows up to meet it from 80 %
    seed: [320, 0.6], // the seed appears
    morph: [220, 0.6], // seed to four-point star
    starGrow: [260, 0.5],
    spin: [170, 0.5],
    handoff: [380, 1], // the star yields to the avatar
    avatarIn: [340, 0.5],
    unfurl: [240, 0.85],
    threadDown: [220, 1],
  },
  ledger: { arrive: [300, 1], wash: [150, 1], unfurl: [300, 1] },
  bursts: {
    arrive: [240, 0.58], // the card stretches to take the new line
    gulp: [260, 0.45], // a closed burst takes a line without opening
    unfurl: [240, 0.62],
    open: [260, 0.62],
    close: [320, 0.9],
  },
} as const satisfies Record<string, unknown>;
const T = {
  bloomMorphAt: 170,
  unfurlStagger: 70,
  unfurlMax: 3,
  breathFor: 45000,
  waitMax: 4,
};
const GAP = 18; // thread clearance around a 28 px marker
const MARK_SCALE = 30 / 36; // marks paint their -18..18 outline at 30 px
const PEBBLE = MARK_POINTS.pebble,
  STAR = MARK_POINTS.star;

/*
 * One frame loop for every feed, steppable by the shared motion clock. It only drives what
 * must be measured every frame: box heights that chase their live content, and the thread
 * layer drawn from those boxes. Single values run on the shared motion lanes.
 */
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

/* ---------- helpers ---------- */
const NS = "http://www.w3.org/2000/svg";
const clamp = (v: number, a = 0, b = 1) => Math.min(b, Math.max(a, v));
const f2 = (n: number) => n.toFixed(2);
const S = ([k, z]: Pair, x = 0): Spring => ({ x, v: 0, to: x, k, z });
const tune = (s: Spring, [k, z]: Pair) => {
  s.k = k;
  s.z = z;
  return s;
};
const rest = (s: Spring) => s.x === s.to && s.v === 0;
/** A [stiffness, ratio] pair as a shared motion spring. */
const lane = ([k, z]: Pair, velocity = 0) => ({
  type: "spring" as const,
  stiffness: k,
  damping: 2 * Math.sqrt(k) * z,
  mass: 1,
  velocity,
  restDelta: 0.001,
  restSpeed: 0.01,
});
const lerpPts = (A: Pts, B: Pts, m: number) =>
  A.map((p, i) => [p[0] + (B[i][0] - p[0]) * m, p[1] + (B[i][1] - p[1]) * m]);
const hash = (s: string) => {
  let x = 2166136261;
  for (const c of s) x = Math.imul(x ^ c.charCodeAt(0), 16777619);
  return x >>> 0;
};
/** Natural height of a box the scene is sizing, read without a visible frame. */
function natural(el: HTMLElement) {
  const was = el.style.height;
  if (!was) return el.getBoundingClientRect().height;
  el.style.height = "";
  const h = el.getBoundingClientRect().height;
  el.style.height = was;
  return h;
}
const ROW = "[data-activity-entry]";
const LIST = ".v-activity-feed__list";
const markOf = (row: Element) =>
  row.querySelector<HTMLElement>(".v-activity-feed__mark");
/** A bursts row's own disclosure: every row sits inside one, so find-in-page can open it. */
export const foldOf = (row: Element) =>
  row.querySelector<HTMLDetailsElement>(
    ":scope > .v-activity-feed__card > details",
  );
const leaving = (el: Element) => el.hasAttribute("data-leaving");
type Side = "previousElementSibling" | "nextElementSibling";
/** The nearest box on one side that is staying. */
function beside(el: Element, side: Side) {
  let n = el[side];
  while (n && leaving(n)) n = n[side];
  return n instanceof HTMLElement ? n : null;
}
/** The rows of the card or run that holds a row, in order. */
function groupOf(row: HTMLElement) {
  let start = row;
  while (!start.hasAttribute("data-first")) {
    const up = beside(start, "previousElementSibling");
    if (!up?.matches(ROW)) break;
    start = up;
  }
  const out: HTMLElement[] = [];
  for (let r: HTMLElement | null = start; r?.matches(ROW); ) {
    out.push(r);
    if (r.hasAttribute("data-last")) break;
    r = beside(r, "nextElementSibling");
  }
  return out;
}

type Height = {
  s: Spring;
  start: number;
  to: number | "auto";
  onFrame?: (p: number) => void;
  done?: () => void;
};
type Owned = { owner?: HTMLElement };
type Anim = Owned & { tick: (dt: number) => boolean; done?: () => void };
type Wait = Owned & { when: () => boolean; run: () => void; left: number };
type Glide = Owned & { finish: () => void; cancel: () => void };
type Grow = { x: number; dir: "up" | "down" };
type Blob = {
  row: HTMLElement;
  s: Spring;
  m: Spring;
  rot: Spring;
  A: Pts;
  B: Pts;
  fill: "pink" | "olive";
  el: SVGPathElement;
};
export type ActivitySync = {
  layout: ActivityLayout;
  /** Visible entry ids in order. */
  ids: readonly string[];
  /** Ids revealed by the last Show more, consumed by this sync. */
  revealed: readonly string[];
  /** Brand entries keep the star as their mark. */
  brand: ReadonlySet<string>;
  allowed: boolean;
  breathe: boolean;
  layer: SVGSVGElement | null;
};

function createScene(host: HTMLElement) {
  let layout: ActivityLayout = "thread",
    layer: SVGSVGElement | null = null,
    spine: SVGGElement | null = null,
    seeds: SVGGElement | null = null,
    gen = 0,
    ids: string[] = [],
    brand: ReadonlySet<string> = new Set(),
    started = false,
    allowed = false,
    breatheOn = false,
    breathId: string | null = null,
    breathTimer: MotionTimer | null = null;
  const heights = new Map<HTMLElement, Height>();
  const anims = new Set<Anim>();
  const waits = new Set<Wait>();
  const glides = new Set<Glide>();
  const timers = new Set<MotionTimer>();
  const grow = new Map<string, Grow>();
  const blobs = new Set<Blob>();
  const markScale = new Map<HTMLElement, number>();
  /** Each box's height at its last rest paint, so a regroup can be absorbed without a jump. */
  const restHeights = new WeakMap<Element, number>();
  const known = new WeakSet<Element>();
  /** Boxes that have left: nothing may write to them again. */
  const gone = new WeakSet<Element>();
  const segments: SVGPathElement[] = [];

  const rowOf = (id: string) =>
    host.querySelector<HTMLElement>(
      `[data-activity-entry="${CSS.escape(id)}"]:not([data-leaving])`,
    );
  const boxes = () => {
    const list = host.querySelector(LIST);
    return list
      ? [...list.children].filter(
          (el): el is HTMLElement => el instanceof HTMLElement && !leaving(el),
        )
      : [];
  };
  const after = (ms: number, fn: () => void, owner?: HTMLElement) => {
    const g = gen;
    const timer = scheduleMotion(() => {
      timers.delete(timer);
      if (g !== gen || (owner && gone.has(owner))) return;
      fn();
      wake();
    }, ms);
    timers.add(timer);
  };
  const until = (when: () => boolean, fn: () => void, owner?: HTMLElement) => {
    const g = gen;
    waits.add({ when, run: () => g === gen && fn(), left: T.waitMax, owner });
    wake();
  };
  const run = (a: Anim) => {
    anims.add(a);
    wake();
    return a;
  };
  /** One value on a shared motion lane: interruptible, clock-steppable, finished by settle. */
  function glide(
    owner: HTMLElement | undefined,
    [from, to]: Pair,
    k: Pair,
    paint: (x: number) => void,
    done?: () => void,
    velocity = 0,
  ) {
    const m = createMotionLane(from, (x) => {
      paint(x);
      wake();
    });
    let over = false;
    const end = (complete: boolean) => {
      if (over) return;
      over = true;
      glides.delete(g);
      m.dispose();
      if (!complete) return;
      paint(to);
      done?.();
      wake();
    };
    const g: Glide = {
      owner,
      finish: () => end(true),
      cancel: () => end(false),
    };
    glides.add(g);
    paint(from);
    m.to(to, lane(k, velocity), () => end(true));
    wake();
    return g;
  }

  /* one height owner per box: interruptible, keeps velocity on retarget, "auto" chases the content */
  function animHeight(
    el: HTMLElement,
    o: {
      from?: number;
      to?: number | "auto";
      k: Pair;
      kick?: number;
      onFrame?: (p: number) => void;
      done?: () => void;
    },
  ) {
    let a = heights.get(el);
    if (!a) {
      const x = o.from ?? el.getBoundingClientRect().height;
      a = { s: S(o.k, x), start: x, to: "auto" };
      heights.set(el, a);
    } else if (o.from !== undefined) a.s.x = o.from;
    a.start = a.s.x;
    tune(a.s, o.k).v += o.kick ?? 0;
    a.to = o.to ?? "auto";
    a.onFrame = o.onFrame;
    a.done = o.done;
    el.setAttribute("data-moving", "");
    el.style.height = `${f2(Math.max(0, a.s.x))}px`;
    wake();
  }
  function hold(el: HTMLElement, h: number) {
    el.setAttribute("data-moving", "");
    el.style.height = `${f2(Math.max(0, h))}px`;
  }
  function stepHeight(el: HTMLElement, a: Height, dt: number) {
    const target = a.to === "auto" ? natural(el) : a.to;
    a.s.to = target;
    spring(a.s, dt);
    // Pixel boxes settle at a tenth of a pixel; the snap is invisible.
    if (Math.abs(a.s.to - a.s.x) < 0.1 && Math.abs(a.s.v) < 1) {
      a.s.x = a.s.to;
      a.s.v = 0;
    }
    el.style.height = `${f2(Math.max(0, a.s.x))}px`;
    // progress from where this episode started, so a box opening from a kept head reads 0 → 1
    const span = target - a.start;
    a.onFrame?.(Math.abs(span) > 0.5 ? clamp((a.s.x - a.start) / span) : 1);
    if (rest(a.s)) finishHeight(el, a);
  }
  function finishHeight(el: HTMLElement, a: Height) {
    heights.delete(el);
    a.onFrame?.(1);
    // A box closing to a number keeps it: its owner removes or re-renders the box next.
    if (a.to === "auto") {
      el.style.height = "";
      el.removeAttribute("data-moving");
    }
    a.done?.();
  }
  const release = (el: HTMLElement) => {
    heights.delete(el);
    el.style.height = "";
    el.removeAttribute("data-moving");
  };

  /* ---------- regrouping: a kept neighbour's change is absorbed by the box that moves ---------- */
  const restOf = (el: HTMLElement) => {
    const a = heights.get(el);
    return a && a.to !== "auto" ? a.to : natural(el);
  };
  function record() {
    for (const el of boxes()) restHeights.set(el, restOf(el));
  }
  /**
   * What a kept box lost (+) or gained (−) since its last rest paint: a run's head, a card's
   * edge or a day's gap passing to the arriving or leaving box beside it. Read once.
   */
  function drift(el: HTMLElement | null) {
    if (!el) return 0;
    const was = restHeights.get(el),
      now = restOf(el);
    restHeights.set(el, now);
    return was === undefined || Math.abs(was - now) < 0.5 ? 0 : was - now;
  }
  /** New rows with any new group label that arrived above them, in order. */
  function withLabels(rows: HTMLElement[]) {
    const out: HTMLElement[] = [];
    for (const row of rows) {
      const label = beside(row, "previousElementSibling");
      if (label && !label.matches(ROW) && !known.has(label) && !out.includes(label))
        out.push(label);
      out.push(row);
    }
    return out;
  }
  /** Where each new box starts: zero, plus whatever its kept neighbours just handed over. */
  function startsOf(set: HTMLElement[]) {
    const from = new Map(set.map((el) => [el, 0]));
    if (!set.length) return from;
    const first = set[0],
      last = set[set.length - 1];
    from.set(
      first,
      Math.max(0, drift(beside(first, "previousElementSibling"))),
    );
    from.set(
      last,
      (from.get(last) ?? 0) +
        Math.max(0, drift(beside(last, "nextElementSibling"))),
    );
    return from;
  }

  /* ---------- thread layer: the spine between marks and the blooming seed ---------- */
  function draw() {
    if (!layer || !spine || !seeds) return;
    if (layout !== "thread") {
      segments.forEach((p) => p.setAttribute("display", "none"));
      return;
    }
    const bb = layer.getBoundingClientRect();
    const pts: { key: string; x: number; y: number; ms: number }[] = [];
    // A leaving row has no place in the thread: its neighbours join directly.
    for (const row of host.querySelectorAll<HTMLElement>(
      `${ROW}:not([data-leaving])`,
    )) {
      const m = markOf(row);
      if (!m) continue;
      const rc = m.getBoundingClientRect();
      if (!rc.width) continue;
      pts.push({
        key: row.dataset.activityEntry ?? "",
        x: rc.left - bb.left + rc.width / 2,
        y: rc.top - bb.top + rc.height / 2,
        ms: clamp(markScale.get(row) ?? 1),
      });
    }
    let n = 0;
    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i],
        b = pts[i + 1];
      // the gap shrinks with a growing marker, so the thread meets the seed
      const y0 = a.y + GAP * a.ms,
        y1 = b.y - GAP * b.ms,
        D = y1 - y0;
      if (D < 3) continue;
      const key = `${a.key}>${b.key}`,
        gr = grow.get(key),
        g = gr ? clamp(gr.x) : 1;
      if (g <= 0.001) continue;
      const p =
        segments[n] ??
        (segments[n] = spine.appendChild(document.createElementNS(NS, "path")));
      n++;
      p.setAttribute("class", "v-activity-feed__spine");
      // two cubic halves, up to 3 px sideways, the side seeded by the pair
      const w = (hash(key) & 1 ? 1 : -1) * Math.min(3, D / 14),
        x = a.x,
        up = gr?.dir === "up",
        s = up ? y1 : y0,
        d = up ? -D : D;
      p.setAttribute(
        "d",
        `M${f2(x)} ${f2(s)}C${f2(x)} ${f2(s + 0.26 * d)} ${f2(x + w)} ${f2(s + 0.31 * d)} ${f2(x)} ${f2(s + 0.5 * d)}C${f2(x - w)} ${f2(s + 0.69 * d)} ${f2(x)} ${f2(s + 0.75 * d)} ${f2(x)} ${f2(s + d)}`,
      );
      if (gr) {
        const L = p.getTotalLength();
        p.setAttribute("stroke-dasharray", `${f2(L)} ${f2(L + 8)}`);
        p.setAttribute("stroke-dashoffset", f2(L * (1 - g)));
      } else {
        p.removeAttribute("stroke-dasharray");
        p.removeAttribute("stroke-dashoffset");
      }
      p.removeAttribute("display");
    }
    for (let i = n; i < segments.length; i++)
      segments[i].setAttribute("display", "none");
    for (const b of blobs) {
      const m = markOf(b.row);
      if (!m) continue;
      const rc = m.getBoundingClientRect(),
        x = rc.left - bb.left + rc.width / 2,
        y = rc.top - bb.top + rc.height / 2;
      b.el.setAttribute(
        "transform",
        `translate(${f2(x)} ${f2(y)}) scale(${(MARK_SCALE * Math.max(0, b.s.x)).toFixed(3)}) rotate(${f2(b.rot.x)})`,
      );
      b.el.setAttribute(
        "d",
        outline(lerpPts(b.A, b.B, clamp(b.m.x, -0.25, 1.25)), true),
      );
      b.el.setAttribute("data-fill", b.fill);
    }
  }
  function holdThread(key: string, dir: Grow["dir"]) {
    const gr: Grow = { x: 0, dir };
    grow.set(key, gr);
    return gr;
  }
  function releaseThread(key: string, gr: Grow, k: Pair) {
    glide(
      undefined,
      [gr.x, 1],
      k,
      (x) => (gr.x = x),
      () => {
        if (grow.get(key) === gr) grow.delete(key);
      },
    );
  }
  const scaleMark = (row: HTMLElement, scale: number) => {
    const m = markOf(row);
    if (m) m.style.transform = scale === 1 ? "" : `scale(${scale.toFixed(3)})`;
  };
  const setMark = (row: HTMLElement, scale: number) => {
    if (gone.has(row)) return;
    markScale.set(row, scale);
    scaleMark(row, scale);
  };
  const showMark = (row: HTMLElement) => {
    row.removeAttribute("data-mark");
    scaleMark(row, 1);
    markScale.delete(row);
  };
  /** The marker blooms from a seed through the four-point star; brand rows keep the star. */
  function bloom(row: HTMLElement, isBrand: boolean) {
    if (!seeds) return showMark(row);
    const P = SPR.thread;
    const b: Blob = {
      row,
      s: S(P.seed),
      m: S(P.morph),
      rot: S(P.spin),
      A: PEBBLE,
      B: PEBBLE,
      fill: "pink",
      el: seeds.appendChild(document.createElementNS(NS, "path")),
    };
    b.el.setAttribute("class", "v-activity-feed__seed");
    b.s.to = 0.62;
    blobs.add(b);
    const av = S(P.avatarIn);
    const drop = () => {
      blobs.delete(b);
      b.el.remove();
    };
    run({
      owner: row,
      tick: (dt) => {
        [b.s, b.m, b.rot, av].forEach((s) => spring(s, dt));
        if (av.x || av.v) scaleMark(row, av.x);
        setMark(row, Math.max(av.x, b.s.x * 0.9));
        return blobs.has(b) || !rest(av);
      },
      done: () => {
        drop();
        showMark(row);
      },
    });
    after(
      T.bloomMorphAt,
      () => {
        b.B = STAR;
        b.fill = "olive";
        b.m.to = 1;
        tune(b.s, P.starGrow).to = 1;
        b.rot.to = 90;
        until(
          () => b.m.x > 0.97 && Math.abs(b.s.x - 1) < 0.05,
          () => {
            if (isBrand) {
              until(
                () => rest(b.s) && rest(b.rot) && rest(b.m),
                () => {
                  row.removeAttribute("data-mark");
                  av.x = av.to = 1;
                  av.v = 0;
                  drop();
                },
                row,
              );
              return;
            }
            row.removeAttribute("data-mark");
            av.x = 0.35;
            av.to = 1;
            tune(b.s, P.handoff).to = 0;
            until(() => b.s.x < 0.02, drop, row);
          },
          row,
        );
      },
      row,
    );
  }
  function markIn(row: HTMLElement) {
    row.removeAttribute("data-mark");
    glide(
      row,
      [0.4, 1],
      SPR.markIn,
      (x) => setMark(row, x),
      () => showMark(row),
    );
  }
  /** The thread grows down from the marker above once it shows, then the marker pops in. */
  function threadIn(row: HTMLElement) {
    const id = row.dataset.activityEntry ?? "",
      prev = ids[ids.indexOf(id) - 1],
      key = `${prev}>${id}`,
      gr = grow.get(key);
    if (!gr) return markIn(row);
    const upper = prev !== undefined ? rowOf(prev) : null;
    until(
      () => !upper || !upper.hasAttribute("data-mark"),
      () => {
        releaseThread(key, gr, SPR.thread.threadDown);
        until(() => gr.x > 0.85, () => markIn(row), row);
      },
      row,
    );
  }

  function wash(row: HTMLElement) {
    const w = row.querySelector<HTMLElement>(".v-activity-feed__wash");
    if (!w) return;
    w.setAttribute("data-on", "");
    glide(
      row,
      [0, 1],
      SPR.ledger.wash,
      (x) => {
        w.style.clipPath = `inset(0 ${f2((1 - x) * 100)}% 0 0 round 8px)`;
      },
      () => {
        // the fade back runs in CSS within the shared draw duration
        w.style.clipPath = "";
        w.removeAttribute("data-on");
      },
    );
  }

  /* ---------- bursts: every row's disclosure follows its card ---------- */
  /** A row arriving in, or regrouped into, a card takes the card's open state. */
  function adoptCards() {
    if (layout !== "bursts") return;
    let card: HTMLElement[] = [];
    const settleCard = () => {
      const model = card.find((r) => known.has(r));
      const fold = model && foldOf(model);
      if (fold) {
        const open = fold.open && !fold.hasAttribute("data-closing");
        for (const r of card) {
          const d = foldOf(r);
          if (d && !d.hasAttribute("data-closing") && d.open !== open)
            d.open = open;
        }
      }
      card = [];
    };
    for (const el of boxes()) {
      if (!el.matches(ROW)) continue;
      if (el.hasAttribute("data-first") && card.length) settleCard();
      card.push(el);
      if (el.hasAttribute("data-last")) settleCard();
    }
    settleCard();
  }
  function openCard(row: HTMLElement) {
    const rows = groupOf(row);
    for (const r of rows) {
      const d = foldOf(r);
      if (!d) continue;
      d.removeAttribute("data-closing");
      if (!d.open) d.open = true;
      const a = heights.get(r);
      if (a && a.to !== "auto") release(r);
    }
  }

  /* ---------- arrival: a live prepend ---------- */
  function arrive(rows: HTMLElement[]) {
    const set = withLabels(rows);
    const from = startsOf(set);
    for (const el of set) {
      const start = from.get(el) ?? 0;
      if (!el.matches(ROW)) {
        const k =
          layout === "thread"
            ? SPR.thread.arrive
            : layout === "ledger"
              ? SPR.ledger.arrive
              : SPR.bursts.arrive;
        animHeight(el, { from: start, k });
        continue;
      }
      if (layout === "ledger") {
        animHeight(el, { from: start, k: SPR.ledger.arrive });
        wash(el);
        continue;
      }
      if (layout === "bursts") {
        const fold = foldOf(el);
        if (fold && !fold.open) {
          // a closed burst takes the line without opening
          animHeight(el, { from: start, k: SPR.bursts.gulp, kick: 160 });
          continue;
        }
        el.setAttribute("data-slide", "");
        animHeight(el, {
          from: start,
          k: SPR.bursts.arrive,
          onFrame: (p) => {
            if (p > 0.35) el.removeAttribute("data-slide");
          },
        });
        continue;
      }
      const id = el.dataset.activityEntry ?? "",
        next = ids[ids.indexOf(id) + 1],
        key = next !== undefined ? `${id}>${next}` : null,
        gr = key ? holdThread(key, "up") : null,
        isBrand = brand.has(id);
      el.setAttribute("data-mark", "hidden");
      el.setAttribute("data-arriving", "");
      setMark(el, 0);
      let shown = false,
        threaded = false;
      animHeight(el, {
        from: start,
        k: SPR.thread.arrive,
        onFrame: (p) => {
          if (!shown && p > 0.55) {
            shown = true;
            el.removeAttribute("data-arriving");
          }
          if (!threaded && p > 0.8) {
            threaded = true;
            if (!gr || !key) return bloom(el, isBrand);
            releaseThread(key, gr, SPR.thread.threadUp);
            until(() => gr.x > 0.85, () => bloom(el, isBrand), el);
          }
        },
      });
    }
  }

  /* ---------- Show more: at most three items unfurl with a short stagger ---------- */
  function unfurl(revealed: HTMLElement[]) {
    const set = withLabels(revealed.slice(0, T.unfurlMax));
    const from = startsOf(set);
    for (const el of set) {
      hold(el, from.get(el) ?? 0);
      if (!el.matches(ROW)) continue;
      if (layout === "bursts") el.setAttribute("data-slide", "");
      if (layout !== "thread") continue;
      const id = el.dataset.activityEntry ?? "",
        prev = ids[ids.indexOf(id) - 1];
      el.setAttribute("data-mark", "hidden");
      el.setAttribute("data-arriving", "");
      setMark(el, 0);
      if (prev !== undefined) holdThread(`${prev}>${id}`, "down");
    }
    const go = (el: HTMLElement) => {
      const start = from.get(el) ?? 0;
      if (!el.matches(ROW) || layout === "ledger")
        return animHeight(el, {
          from: start,
          k:
            layout === "thread"
              ? SPR.thread.unfurl
              : layout === "ledger"
                ? SPR.ledger.unfurl
                : SPR.bursts.unfurl,
        });
      if (layout === "bursts")
        return animHeight(el, {
          from: start,
          k: SPR.bursts.unfurl,
          onFrame: (p) => {
            if (p > 0.3) el.removeAttribute("data-slide");
          },
        });
      let shown = false,
        threaded = false;
      animHeight(el, {
        from: start,
        k: SPR.thread.unfurl,
        onFrame: (p) => {
          if (!shown && p > 0.5) {
            shown = true;
            el.removeAttribute("data-arriving");
          }
          if (threaded || p <= 0.6) return;
          threaded = true;
          threadIn(el);
        },
      });
    };
    set.forEach((el, i) =>
      i ? after(i * T.unfurlStagger, () => go(el), el) : go(el),
    );
  }

  /* ---------- breathing: only the newest live arrival, only while it can be seen ---------- */
  function applyBreath() {
    host
      .querySelectorAll("[data-breath]")
      .forEach((el) => el.removeAttribute("data-breath"));
    if (breathId === null || !breatheOn || ids[0] !== breathId) return;
    rowOf(breathId)?.setAttribute("data-breath", "");
  }
  function breathe(id: string) {
    cancelMotion(breathTimer);
    breathId = id;
    breathTimer = scheduleMotion(() => {
      breathTimer = null;
      breathId = null;
      applyBreath();
    }, T.breathFor);
  }

  /** A box that left: cancel everything it owned and let it go. */
  function forget(el: HTMLElement) {
    gone.add(el);
    heights.delete(el);
    markScale.delete(el);
    for (const g of [...glides]) if (g.owner === el) g.cancel();
    for (const a of [...anims]) if (a.owner === el) anims.delete(a);
    for (const w of [...waits]) if (w.owner === el) waits.delete(w);
    for (const b of [...blobs])
      if (b.row === el) {
        blobs.delete(b);
        b.el.remove();
      }
  }

  /** Finish every episode at its rest paint: used for quiet, hidden tabs and layout changes. */
  function settle() {
    gen++;
    timers.forEach(cancelMotion);
    timers.clear();
    waits.clear();
    const sized = [...heights];
    heights.clear();
    for (const [el, a] of sized) {
      if (a.to === "auto") {
        el.style.height = "";
        el.removeAttribute("data-moving");
      }
      a.done?.();
    }
    host
      .querySelectorAll<HTMLElement>("[data-moving]:not([data-leaving])")
      .forEach((el) => {
        el.style.height = "";
        el.removeAttribute("data-moving");
      });
    const running = [...anims];
    anims.clear();
    running.forEach((a) => a.done?.());
    [...glides].forEach((g) => g.finish());
    blobs.forEach((b) => b.el.remove());
    blobs.clear();
    grow.clear();
    markScale.clear();
    host
      .querySelectorAll<HTMLElement>(
        "[data-mark],[data-arriving],[data-slide]",
      )
      .forEach((el) => {
        el.removeAttribute("data-mark");
        el.removeAttribute("data-arriving");
        el.removeAttribute("data-slide");
      });
    host
      .querySelectorAll<HTMLElement>(".v-activity-feed__mark")
      .forEach((m) => (m.style.transform = ""));
    host
      .querySelectorAll<HTMLElement>(".v-activity-feed__wash[data-on]")
      .forEach((w) => {
        w.style.clipPath = "";
        w.removeAttribute("data-on");
      });
  }

  const scene: Scene = {
    frame(dt) {
      heights.forEach((a, el) => stepHeight(el, a, dt));
      anims.forEach((a) => {
        if (a.tick(dt)) return;
        anims.delete(a);
        a.done?.();
      });
      draw();
      waits.forEach((w) => {
        w.left -= dt;
        if (!w.when() && w.left > 0) return;
        waits.delete(w);
        w.run();
      });
      return (
        heights.size > 0 || anims.size > 0 || waits.size > 0 || glides.size > 0
      );
    },
  };

  return {
    sync(next: ActivitySync) {
      const relayout = next.layout !== layout;
      if (next.layer !== layer) {
        layer = next.layer;
        segments.length = 0;
        spine = seeds = null;
        if (layer) {
          layer.replaceChildren();
          spine = layer.appendChild(document.createElementNS(NS, "g"));
          seeds = layer.appendChild(document.createElementNS(NS, "g"));
        }
      }
      layout = next.layout;
      brand = next.brand;
      allowed = next.allowed;
      breatheOn = next.breathe;
      const before = new Set(ids);
      const hadRows = ids.length > 0;
      ids = [...next.ids];
      if (!relayout) adoptCards();
      if (!started || relayout || !allowed || document.hidden) {
        settle();
        if (relayout) breathId = null;
      } else {
        const fresh = ids.filter((id) => !before.has(id));
        const firstKept = ids.findIndex((id) => before.has(id));
        const top = firstKept < 0 ? ids.length : firstKept;
        const arrivals = fresh.filter((id) => ids.indexOf(id) < top);
        const shown = new Set(next.revealed);
        const reveals = fresh.filter(
          (id) => shown.has(id) && ids.indexOf(id) >= top,
        );
        const rows = (list: string[]) =>
          list.map(rowOf).filter((r): r is HTMLElement => !!r);
        // a bulk load or a first paint appears at rest; live prepends arrive
        if (arrivals.length && arrivals.length <= T.unfurlMax) {
          arrive(rows(arrivals));
          if (hadRows || arrivals.length === 1) breathe(arrivals[0]);
        }
        if (reveals.length) unfurl(rows(reveals));
      }
      started = true;
      for (const el of boxes()) known.add(el);
      record();
      applyBreath();
      draw();
      wake();
    },
    measure() {
      // At rest, any size change (a rewrap, a toggled burst, a caller's content) is the new rest.
      if (!heights.size) record();
      draw();
    },
    /** Close a removed box on a spring, then let presence unmount it. */
    leave(el: HTMLElement, done: () => void) {
      const finish = () => {
        forget(el);
        done();
      };
      if (!allowed || document.hidden || !el.isConnected) return finish();
      // the leaving box also takes whatever its neighbours just gained or lost
      const from =
        el.getBoundingClientRect().height +
        drift(beside(el, "previousElementSibling")) +
        drift(beside(el, "nextElementSibling"));
      if (layout === "thread" && el.matches(ROW))
        glide(
          el,
          [markScale.get(el) ?? 1, 0],
          SPR.markOut,
          (x) => setMark(el, Math.max(0, x)),
          undefined,
          2.5,
        );
      animHeight(el, {
        from: Math.max(0, from),
        to: 0,
        k: SPR.remove,
        done: finish,
      });
      draw();
    },
    /** A removal reversed while it was still closing. */
    stay(el: HTMLElement) {
      const a = heights.get(el);
      if (!a || a.to !== 0) return;
      a.done = undefined;
      for (const g of [...glides]) if (g.owner === el) g.cancel();
      animHeight(el, { k: SPR.restore });
      if (el.matches(ROW)) showMark(el);
    },
    /** Open or close a burst on a spring; every row's disclosure follows the head. */
    toggle(details: HTMLDetailsElement) {
      const row = details.closest<HTMLElement>(ROW);
      if (!row) return false;
      const rows = groupOf(row),
        folds = rows.map(foldOf);
      const closing = details.open && !details.hasAttribute("data-closing");
      if (!allowed || document.hidden) {
        rows.forEach((r) => heights.has(r) && release(r));
        folds.forEach((d) => {
          if (!d) return;
          d.removeAttribute("data-closing");
          d.open = !closing;
        });
        return true;
      }
      const from = rows.map((r) => r.getBoundingClientRect().height);
      if (closing) {
        folds.forEach((d) => d && (d.open = false));
        const to = rows.map(natural);
        folds.forEach((d) => {
          if (!d) return;
          d.open = true;
          d.setAttribute("data-closing", "");
        });
        let left = rows.length;
        rows.forEach((r, i) =>
          animHeight(r, {
            from: from[i],
            to: to[i],
            k: SPR.bursts.close,
            done: () => {
              if (--left) return;
              folds.forEach((d) => {
                if (!d) return;
                d.removeAttribute("data-closing");
                d.open = false;
              });
              rows.forEach(release);
            },
          }),
        );
      } else {
        folds.forEach((d) => {
          if (!d) return;
          d.removeAttribute("data-closing");
          d.open = true;
        });
        rows.forEach((r, i) =>
          animHeight(r, { from: from[i], k: SPR.bursts.open }),
        );
      }
      return true;
    },
    /** A disclosure opened natively (find in page, a fragment link): its whole card opens. */
    reveal(details: HTMLDetailsElement) {
      const row = details.closest<HTMLElement>(ROW);
      if (!row || !details.open || details.hasAttribute("data-closing")) return;
      if (groupOf(row).some((r) => foldOf(r)?.open === false)) openCard(row);
    },
    openCard,
    attach() {
      scenes.add(scene);
    },
    destroy() {
      settle();
      cancelMotion(breathTimer);
      scenes.delete(scene);
      layer?.replaceChildren();
    },
  };
}
export type ActivityScene = ReturnType<typeof createScene>;

/** Each feed's scene, shared with its rows' presence and its bursts' toggles. */
export const ActivitySceneContext = React.createContext<
  React.RefObject<ActivityScene | null>
>({ current: null });

/**
 * Drives one feed's decorative motion. React renders the rest paint; the scene only
 * borrows heights, marks and the thread layer while an episode plays.
 */
export function useActivityScene(
  host: React.RefObject<HTMLElement | null>,
  next: Omit<ActivitySync, "layer" | "revealed"> & {
    layer: React.RefObject<SVGSVGElement | null>;
    takeRevealed: () => readonly string[];
  },
) {
  const scene = React.useRef<ActivityScene | null>(null);
  const sync = React.useEffectEvent(() =>
    scene.current?.sync({
      ...next,
      layer: next.layer.current,
      revealed: next.takeRevealed(),
    }),
  );
  React.useLayoutEffect(() => {
    if (!host.current) return;
    const s = createScene(host.current);
    s.attach();
    scene.current = s;
    const observer = new ResizeObserver(() => s.measure());
    observer.observe(host.current);
    void document.fonts?.ready.then(() => scene.current === s && s.measure());
    return () => {
      observer.disconnect();
      s.destroy();
      scene.current = null;
    };
  }, [host]);
  const key = next.ids.join("\u0001");
  // Declared after the scene effect, so on mount the scene exists before its first sync.
  React.useLayoutEffect(() => {
    sync();
  }, [key, next.layout, next.allowed, next.breathe]);
  return scene;
}

/** Presence for one feed box: a removal closes on the scene's spring before unmounting. */
export function useActivityPresence<T extends HTMLElement>() {
  const [isPresent, safeToRemove] = usePresence();
  const scene = React.useContext(ActivitySceneContext);
  const ref = React.useRef<T>(null);
  // AnimatePresence registers an exit in its own layout effect, which runs after this
  // child's; an instant completion waits a microtask so the parent can hear it.
  const finish = React.useEffectEvent(() => {
    const remove = safeToRemove;
    queueMicrotask(() => remove?.());
  });
  React.useLayoutEffect(() => {
    const el = ref.current;
    if (isPresent) {
      if (el) scene.current?.stay(el);
      return;
    }
    if (!el || !scene.current) return finish();
    scene.current.leave(el, () => finish());
  }, [isPresent, scene]);
  return [ref, !isPresent] as const;
}
