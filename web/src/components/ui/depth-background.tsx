"use client";

import * as React from "react";
import { animate, motion, useMotionValue, useScroll, useSpring, useTransform, type MotionValue } from "motion/react";
import { cn } from "@/lib/utils";
import { assignMotionRef } from "@/lib/cojeev-motion/refs";
import { motionTokens, trackMotion, useChoreography } from "@/lib/cojeev-motion/choreography";
import { useMotionVisibility } from "@/lib/cojeev-motion/use-motion-visibility";

export type DepthBackgroundVariant = "pollen" | "contour" | "orbital";
export type DepthBackgroundProps = Omit<React.ComponentProps<"div">, "children"> & {
  variant?: DepthBackgroundVariant;
  /** Relative piece count, bounded to .35–2. */
  density?: number;
  /** Motion strength, bounded to 0–2; zero preserves the still artwork. */
  intensity?: number;
  seed?: number | string;
};
type DepthPiece = { x: number; y: number; size: number; layer: number; color: number; angle: number; phase: number; shape: number };
const palette = ["var(--v-pink)", "var(--v-olive)", "var(--v-blue)", "var(--v-yellow)"];
const planes = [
  { name: "far", z: -340, speed: .36, opacity: .22 },
  { name: "middle", z: -70, speed: .68, opacity: .34 },
  { name: "near", z: 145, speed: 1, opacity: .32 },
];
const bounded = (value: number, minimum: number, maximum: number, fallback: number) => Number.isFinite(value) ? Math.max(minimum, Math.min(maximum, value)) : fallback;

/** Stable geometry for SSR, hydration and consumer screenshots. No render-time randomness. */
export function depthBackgroundPoints(variant: DepthBackgroundVariant, density = 1, seed: number | string = "cojeev") {
  let hash = 2166136261;
  for (const char of String(seed)) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
  const next = () => {
    hash = (hash + 0x6d2b79f5) | 0;
    let value = Math.imul(hash ^ hash >>> 15, 1 | hash);
    value ^= value + Math.imul(value ^ value >>> 7, 61 | value);
    return ((value ^ value >>> 14) >>> 0) / 4294967296;
  };
  const count = variant === "contour" ? Math.max(3, Math.round(3 * bounded(density, .35, 2, 1)) + 1) : Math.round((variant === "pollen" ? 42 : 24) * bounded(density, .35, 2, 1));
  return Array.from({ length: count }, (_, index): DepthPiece => {
    const layer = index % 3;
    let x = next() * 100, y = next() * 100;
    // Keep the reading centre clear through composition, rather than a gradient cloud.
    if (x > 22 && x < 78 && y > 18 && y < 84) x = x < 50 ? 5 + next() * 17 : 78 + next() * 17;
    if (variant === "contour") {
      x = index % 2 ? 103 + next() * 10 : -12 + next() * 10;
      y = 12 + (index % 3) * 37 + next() * 14;
    }
    return {
      x, y, layer, color: index % palette.length,
      size: variant === "contour" ? 68 + next() * 25 : variant === "pollen" ? [5, 11, 25][layer] + next() * [5, 8, 17][layer] : [15, 28, 44][layer] + next() * 10,
      angle: next() * 360, phase: next() * Math.PI * 2, shape: index % 4,
    };
  });
}

const contour = "M315 54C398 35 486 86 513 163C541 243 514 267 541 327C570 393 516 494 433 503C359 511 346 555 268 535C186 514 209 472 135 458C64 444 38 370 68 306C99 242 41 201 93 130C141 63 226 75 315 54Z";
function ContourGraphic({ shape }: { shape: number }) {
  return <svg viewBox="0 0 600 600" fill="none" className="v-depth-background__contour">
    {Array.from({ length: 9 }, (_, index) => <g key={index} transform={`translate(300 300) scale(${1 - index * .075} ${1 - index * .067}) rotate(${index * (shape % 2 ? 3 : -2)}) translate(-300 -300)`}>
      <path d={contour} stroke={palette[(index + shape) % palette.length]} strokeWidth={index === 0 ? 3 : 1.7} />
    </g>)}
    <path d="M112 421C178 452 200 477 259 477" stroke="currentColor" strokeWidth="10" strokeLinecap="round" opacity=".45" />
  </svg>;
}
function OrbitalGraphic({ shape }: { shape: number }) {
  return <svg viewBox="0 0 64 64" fill="none" stroke="currentColor" strokeWidth="1.4" className="v-depth-background__orbital">
    {shape === 0 ? <><ellipse cx="32" cy="32" rx="27" ry="11" transform="rotate(-28 32 32)" /><ellipse cx="32" cy="32" rx="11" ry="27" transform="rotate(-28 32 32)" /><circle cx="32" cy="32" r="4" fill="currentColor" stroke="none" /><circle cx="55" cy="20" r="3" fill="currentColor" stroke="none" /></>
      : shape === 1 ? <><path d="M32 5Q35 26 59 32Q37 36 32 59Q28 36 5 32Q28 27 32 5Z" /><circle cx="32" cy="32" r="9" /><path d="M45 9L48 15M11 47L17 50" /></>
      : shape === 2 ? <><circle cx="32" cy="32" r="21" /><path d="M32 3V10M32 54V61M3 32H10M54 32H61M12 12L17 17M47 47L52 52" /><circle cx="32" cy="32" r="9" strokeDasharray="2 5" /><circle cx="50" cy="20" r="4" fill="currentColor" stroke="none" /></>
      : <><rect x="15" y="15" width="34" height="34" rx="9" transform="rotate(28 32 32)" /><path d="M7 24L57 40M24 7L40 57" /><circle cx="32" cy="32" r="5" fill="currentColor" stroke="none" /></>}
  </svg>;
}
type FieldMotion = { phase: MotionValue<number>; scroll: MotionValue<number>; pointerX: MotionValue<number>; pointerY: MotionValue<number>; width: MotionValue<number>; height: MotionValue<number>; active: boolean; intensity: number };
function Piece({ piece, variant, field }: { piece: DepthPiece; variant: DepthBackgroundVariant; field: FieldMotion }) {
  const plane = planes[piece.layer];
  const position = useTransform(() => {
    if (!field.active) return { x: 0, y: 0, rotation: piece.angle };
    const phase = field.phase.get() * Math.PI * 2 + piece.phase;
    const px = piece.x / 100 * field.width.get(), py = piece.y / 100 * field.height.get();
    const dx = px - field.pointerX.get(), dy = py - field.pointerY.get(), distance = Math.hypot(dx, dy);
    const force = Math.max(0, 1 - distance / 190) ** 2 * 38 * plane.speed;
    const repelX = distance > 1 ? dx / distance * force : Math.cos(piece.phase) * force;
    const repelY = distance > 1 ? dy / distance * force : Math.sin(piece.phase) * force;
    const amplitude = variant === "contour" ? 17 : variant === "orbital" ? 9 : 13;
    return {
      x: (Math.sin(phase) * amplitude * plane.speed + repelX) * field.intensity,
      y: (Math.cos(phase * 2) * amplitude * .65 * plane.speed + (field.scroll.get() - .5) * -100 * plane.speed + repelY) * field.intensity,
      rotation: piece.angle + Math.sin(phase) * (variant === "orbital" ? 12 : 3) * field.intensity,
    };
  });
  const x = useTransform(position, value => value.x), y = useTransform(position, value => value.y), rotate = useTransform(position, value => value.rotation);
  const blur = variant === "pollen" ? [1.6, .2, 4.5][piece.layer] : variant === "contour" ? [1.1, 0, .3][piece.layer] : [.9, 0, .55][piece.layer];
  return <motion.span className="v-depth-background__piece" data-depth-layer={plane.name}
    style={{ left: `${piece.x}%`, top: `${piece.y}%`, width: variant === "contour" ? `${piece.size}%` : piece.size, x, y, z: plane.z, rotate, color: palette[piece.color], opacity: variant === "contour" ? plane.opacity * .8 : plane.opacity, filter: `blur(${blur}px)` }}>
    {variant === "contour" ? <ContourGraphic shape={piece.shape} /> : variant === "orbital" ? <OrbitalGraphic shape={piece.shape} /> : <svg viewBox="0 0 48 48" className="v-depth-background__pollen"><path d={piece.shape % 2 ? "M25 5C37 4 45 14 41 28C38 40 24 46 13 39C2 32 5 20 10 13C14 7 18 5 25 5Z" : "M24 7C35 7 42 15 41 25C40 36 32 42 22 41C12 40 6 32 7 22C8 12 15 7 24 7Z"} fill="currentColor" /></svg>}
  </motion.span>;
}

/** A decorative perspective field. Mount inside a positioned section, behind its content. */
export function DepthBackground({ variant = "pollen", density = 1, intensity = 1, seed = "cojeev", className, ref, ...props }: DepthBackgroundProps) {
  const host = React.useRef<HTMLDivElement | null>(null);
  const attach = React.useCallback((element: HTMLDivElement | null) => { host.current = element; const release = assignMotionRef(ref, element); return () => { host.current = null; release(); }; }, [ref]);
  const { quiet } = useChoreography(), { enabled, inView } = useMotionVisibility(host);
  const strength = bounded(intensity, 0, 2, 1), active = !quiet && enabled && inView && strength > 0;
  const phase = useMotionValue(0), width = useMotionValue(1000), height = useMotionValue(700);
  const pointerX = useSpring(-10000, motionTokens.spring.responsive), pointerY = useSpring(-10000, motionTokens.spring.responsive);
  const { scrollYProgress } = useScroll({ target: host, offset: ["start end", "end start"] });
  const scroll = useSpring(.5, motionTokens.spring.gentle);
  const pieces = React.useMemo(() => depthBackgroundPoints(variant, density, seed), [variant, density, seed]);
  React.useEffect(() => {
    const element = host.current; if (!element) return;
    const measure = () => { width.set(element.clientWidth); height.set(element.clientHeight); };
    const observer = new ResizeObserver(measure); observer.observe(element); measure();
    return () => observer.disconnect();
  }, [width, height]);
  React.useEffect(() => {
    if (!active) { scroll.jump(.5); pointerX.jump(-10000); pointerY.jump(-10000); return; }
    const start = phase.get();
    const controls = animate(phase, start + 1, { duration: variant === "contour" ? 48 : 32, ease: "linear", repeat: Infinity });
    const release = trackMotion(controls);
    scroll.set(scrollYProgress.get());
    const unsubscribe = scrollYProgress.on("change", value => scroll.set(value));
    const pointer = (event: PointerEvent) => {
      if (event.pointerType === "touch") return;
      const rect = host.current?.getBoundingClientRect(); if (!rect) return;
      const x = event.clientX - rect.left, y = event.clientY - rect.top;
      if (x < 0 || x > rect.width || y < 0 || y > rect.height) { pointerX.set(-10000); pointerY.set(-10000); return; }
      pointerX.set(x); pointerY.set(y);
    };
    const leave = () => { pointerX.set(-10000); pointerY.set(-10000); };
    window.addEventListener("pointermove", pointer, { passive: true });
    document.addEventListener("pointerleave", leave);
    return () => { release(); unsubscribe(); scroll.stop(); pointerX.stop(); pointerY.stop(); window.removeEventListener("pointermove", pointer); document.removeEventListener("pointerleave", leave); };
  }, [active, variant, phase, scroll, scrollYProgress, pointerX, pointerY]);
  const field = { phase, scroll, pointerX, pointerY, width, height, active, intensity: strength };
  return <div {...props} ref={attach} data-slot="depth-background" data-variant={variant} data-active={active} data-quiet={quiet || strength === 0} aria-hidden="true" inert className={cn("v-depth-background", className)}>
    <div className="v-depth-background__scene">{pieces.map((piece, index) => <Piece key={`${variant}-${index}`} piece={piece} variant={variant} field={field} />)}</div>
  </div>;
}
