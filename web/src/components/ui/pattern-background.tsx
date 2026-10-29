import * as React from "react";
import { cn } from "@/lib/utils";
import type { PatternBackgroundVariant } from "@/lib/cojeev/subtle-backgrounds";

export type { PatternBackgroundVariant } from "@/lib/cojeev/subtle-backgrounds";

export type PatternBackgroundProps = Omit<React.ComponentProps<"span">, "children"> & {
  variant?: PatternBackgroundVariant;
  /** Distance between marks, in pixels (8–80). */
  spacing?: number;
  /** Decorative ink strength, from 0 to 1. */
  opacity?: number;
  color?: string;
};

/** Place inside a positioned, isolated surface. Never captures input or adds layout. */
const variants = new Set<PatternBackgroundVariant>(["dots", "grid", "contours", "weave", "pebbles", "sunwash", "folds", "sprouts", "none"]);
function PatternPaint({ variant, id, tile }: { variant: PatternBackgroundVariant; id: string; tile: number }) {
  if (variant === "dots" || variant === "grid" || variant === "none") return null;
  const tileId = `${id}-${variant}-tile`, scale = tile / 100;
  const common = { "data-slot": "pattern-background-svg", "data-pattern": variant, id: `${id}-${variant}`, "aria-hidden": true, focusable: false };
  const wrap = (paint: React.ReactNode) => <svg {...common}><defs><pattern id={tileId} data-slot="pattern-background-tile" patternUnits="userSpaceOnUse" x="50%" y="50%" patternTransform={`translate(${-tile / 2} ${-tile / 2})`} width={tile} height={tile}>{paint}</pattern></defs><rect width="100%" height="100%" fill={`url(#${tileId})`} /></svg>;
  const line = { fill: "none", stroke: "currentColor", vectorEffect: "non-scaling-stroke" as const };
  if (variant === "contours") return wrap(<g {...line} strokeWidth=".6" transform={`scale(${scale})`}><path d="M49 12C67 9 84 22 80 40C76 58 88 78 67 84C45 91 17 76 19 56C21 38 25 16 49 12Z" /><path d="M49 22C63 18 75 29 70 44C66 58 76 72 62 75C44 81 28 69 29 54C30 40 32 26 49 22Z" /><path d="M49 33C59 29 64 38 61 48C58 58 65 64 56 66C45 70 38 60 40 52C41 43 39 37 49 33Z" /></g>);
  if (variant === "weave") return wrap(<g {...line} strokeWidth=".8" strokeLinecap="round" transform={`scale(${scale})`}><path data-thread="horizontal" d="M0 25H69M81 25H100M0 75H19M31 75H100" /><path data-thread="vertical" d="M25 0V19M25 31V100M75 0V69M75 81V100" /></g>);
  if (variant === "pebbles") return wrap(<g {...line} strokeWidth=".8" transform={`scale(${scale})`}><path d="M14 17c-7-7 4-15 12-9 8 5 4 16-5 17-6 1-10-3-7-8Z" /><path d="M70 15c9-6 18 3 13 12-5 8-17 6-19-2-1-4 2-7 6-10Z" /><path d="M45 66c8-6 17 3 12 12-5 8-16 5-17-3-1-4 2-7 5-9Z" /></g>);
  if (variant === "sunwash") { const gradientId = `${id}-sunwash-gradient`; return wrap(<><radialGradient id={gradientId} gradientUnits="userSpaceOnUse" cx={tile / 2} cy={tile / 2} r={tile / 2}><stop stopColor="currentColor" stopOpacity=".65" /><stop offset=".55" stopColor="currentColor" stopOpacity=".18" /><stop offset="1" stopColor="currentColor" stopOpacity="0" /></radialGradient><rect width={tile} height={tile} fill={`url(#${gradientId})`} /></>); }
  if (variant === "folds") return wrap(<g transform={`scale(${scale})`} fill="currentColor"><path opacity=".2" d="M0 0h42L18 31 0 58ZM42 0h58L68 24 18 31ZM18 31l50-7 32 76H0Z" /><path opacity=".11" d="m18 31 24-31 26 24-19 76Z" /></g>);
  return wrap(<g {...line} strokeWidth=".85" strokeLinecap="round" transform={`scale(${scale})`}><path d="M18 78c2-13 2-25 0-37m0 16c-11-2-12-10-5-12 6 2 7 9 5 12Zm0-6c11-3 13-11 6-14-7 2-8 9-6 14ZM68 83c2-13 2-25 0-37m0 16c-11-2-12-10-5-12 6 2 7 9 5 12Zm0-6c11-3 13-11 6-14-7 2-8 9-6 14Z" /></g>);
}

export function PatternBackground({ variant = "dots", spacing = 24, opacity = 0.12, color = "var(--v-text-3)", className, style, ...props }: PatternBackgroundProps) {
  const pattern = variants.has(variant) ? variant : "dots";
  const safeSpacing = Number.isFinite(spacing) ? Math.max(8, Math.min(80, spacing)) : 24;
  const id = React.useId().replace(/:/g, "");
  return <span {...props} data-slot="pattern-background" data-pattern={pattern} aria-hidden="true"
    className={cn("v-pattern-background", className)}
    style={{ "--pattern-spacing": `${safeSpacing}px`, "--pattern-color": color, opacity: Number.isFinite(opacity) ? Math.max(0, Math.min(1, opacity)) : 0.12, ...style } as React.CSSProperties}
  ><PatternPaint variant={pattern} id={id} tile={safeSpacing * (pattern === "sunwash" ? 16 : pattern === "folds" ? 8 : 4)} /></span>;
}
