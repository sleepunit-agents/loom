"use client";

import * as React from "react";
import { AnimatePresence, motion } from "motion/react";
import { shapeContour, signatureShapePaths } from "@/lib/cojeev/signature-shapes";
import { useChoreography } from "@/lib/cojeev-motion/choreography";
import { useMorph } from "@/lib/cojeev-motion/use-morph";

export type SelectorShape =
  "organic" | "rounded" | "circle" | "pebble" | "leaf" | "flower";
export type SelectorTone = "pink" | "blue" | "olive" | "yellow";
/** Numeric sizes are clamped to 16–64px; the containing control keeps its hit area. */
export type SelectorSize = "sm" | "default" | "lg" | number;
export type SelectorIndicator = "auto" | "dot" | "check" | "diamond" | "flower";
export function selectorSize(size: SelectorSize = "default") {
  return typeof size === "number"
    ? Math.min(64, Math.max(16, Number.isFinite(size) ? size : 28))
    : ({ sm: 20, default: 28, lg: 36 }[size] ?? 28);
}
export const selectorShapes: SelectorShape[] = [
  "organic",
  "pebble",
  "rounded",
  "circle",
  "leaf",
  "flower",
];
export const selectorTones: SelectorTone[] = [
  "pink",
  "blue",
  "olive",
  "yellow",
];
const contour = (radius: (angle: number) => number) =>
  shapeContour((angle) => [
    50 + radius(angle) * Math.cos(angle),
    50 + radius(angle) * Math.sin(angle),
  ]);
const paths: Record<SelectorShape, string> = {
  organic: contour((t) => 41 + 1.1 * Math.cos(3 * t + 0.6)),
  rounded: contour(
    (t) =>
      40 /
      Math.pow(Math.abs(Math.cos(t)) ** 5 + Math.abs(Math.sin(t)) ** 5, 1 / 5),
  ),
  circle: contour(() => 41),
  pebble: signatureShapePaths["pebble-soft"],
  leaf: shapeContour((t) => {
    const x = 38 * Math.cos(t),
      y = 30 * Math.sin(t) * (1 + 0.22 * Math.cos(t));
    return [50 + (x - y) * 0.707, 50 + (x + y) * 0.707];
  }),
  flower: contour((t) => 37 + 5 * Math.cos(5 * t - Math.PI / 2)),
};
export function selectorStyle(
  tone: SelectorTone,
  style?: React.CSSProperties,
  size: SelectorSize = "default",
): React.CSSProperties {
  return {
    "--selector-accent": `var(--v-${tone})`,
    "--selector-size": `${selectorSize(size)}px`,
    ...style,
  } as React.CSSProperties;
}
/** A single silhouette/mark renderer for native and Radix selection semantics. */
export function SelectorGlyph({
  shape = "organic",
  tone = "pink",
  state,
  kind = "radio",
  disabled = false,
  indicator = "auto",
  showIndicator = true,
}: {
  shape?: SelectorShape;
  tone?: SelectorTone;
  state: boolean | "indeterminate";
  kind?: "checkbox" | "radio";
  disabled?: boolean;
  indicator?: SelectorIndicator;
  showIndicator?: boolean;
}) {
  const { quiet, transition } = useChoreography();
  const surface = React.useRef<HTMLSpanElement>(null);
  const morphRef = useMorph<HTMLSpanElement>("controls", surface);
  React.useEffect(() => {
    const node = surface.current;
    const owner = node?.closest('[role="checkbox"], [role="radio"], label');
    if (!node || !owner) return;
    const controller = new AbortController();
    for (const type of ["keydown", "keyup"] as const)
      owner.addEventListener(
        type,
        (event) => {
          const key = (event as KeyboardEvent).key;
          if (key === " " || key === "Enter")
            node.dispatchEvent(new KeyboardEvent(type, { key }));
        },
        { signal: controller.signal },
      );
    for (const type of ["focusin", "focusout"] as const)
      owner.addEventListener(
        type,
        () => node.dispatchEvent(new FocusEvent(type)),
        { signal: controller.signal },
      );
    return () => controller.abort();
  }, []);
  const active = state === true || state === "indeterminate";
  const mark = indicator === "auto" ? (kind === "checkbox" ? "check" : "dot") : indicator;
  const strokeWidth = active && !showIndicator ? 2.5 : active ? 1.25 : 1.5;
  const fill = disabled
    ? "var(--v-disabled-face)"
    : active
      ? `var(--v-${tone})`
      : "var(--v-canvas)";
  const ink = disabled ? "var(--v-disabled-ink)" : "var(--v-on-accent)";
  const stroke = disabled
    ? "var(--v-disabled-edge)"
    : active
      ? ink
      : "var(--v-text-2)";
  const mappedShape = {
    rounded: "squircle",
    circle: "circle",
    pebble: "pebble",
    leaf: "leaf",
    flower: "flower-5",
  };
  return (
    <span
      data-slot="selector-glyph"
      data-selector-shape={shape}
      data-selector-tone={tone}
      data-selector-indicator={showIndicator ? mark : "none"}
      data-state={state === "indeterminate" ? "indeterminate" : active ? "checked" : "unchecked"}
      data-motion-quiet={quiet || undefined}
      aria-hidden="true"
      style={{
        display: "inline-grid",
        position: "relative",
        placeItems: "center",
        width: "var(--selector-size,28px)",
        height: "var(--selector-size,28px)",
        flexShrink: 0,
      }}
    >
      <span
        ref={morphRef}
        data-slot="selector-surface-host"
        data-morph="both"
        data-tier="tile"
        data-shape={shape === "organic" ? undefined : mappedShape[shape]}
        data-depth={shape === "organic" ? 0.018 : 0}
        data-lobes={shape === "organic" ? 3 : 0}
        data-asym=".1"
        data-sw={strokeWidth}
        data-motion={quiet || disabled ? "off" : undefined}
        aria-disabled={disabled || undefined}
        style={
          {
            position: "absolute",
            width: "calc(var(--selector-size,28px) - 4px)",
            height: "calc(var(--selector-size,28px) - 4px)",
            borderRadius: "48% 52% 50% 50%",
            "--mfill": fill,
            "--mstroke": stroke,
          } as React.CSSProperties
        }
      />
      <motion.svg
        data-slot="selector-drawing"
        aria-hidden="true"
        focusable="false"
        viewBox="0 0 100 100"
        width="100%"
        height="100%"
        style={{ display: "block", overflow: "visible", flexShrink: 0 }}
      >
        <motion.path
          data-slot="selector-surface"
          d={paths[shape]}
          initial={false}
          animate={{ d: paths[shape], scale: 1 }}
          transition={transition}
          fill={fill}
          stroke={
            disabled
              ? "var(--v-disabled-edge)"
              : active
                ? ink
                : "var(--v-text-2)"
          }
          strokeWidth={strokeWidth}
          vectorEffect="non-scaling-stroke"
        />
        <AnimatePresence initial={false}>
          {active && showIndicator && (
            <motion.g
              key={`${state}-${mark}`}
              data-slot="selector-mark"
              initial={quiet ? false : { opacity: 0, scale: 0.55 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: quiet ? 1 : 0.55 }}
              transition={transition}
              style={{ transformOrigin: "50px 50px" }}
            >
              {state === "indeterminate" ? (
                <path
                  d="M32 50H68"
                  stroke={ink}
                  strokeWidth="9"
                  strokeLinecap="round"
                />
              ) : mark === "check" ? (
                <path
                  d="M28 50 43 65 73 35"
                  fill="none"
                  stroke={ink}
                  strokeWidth="8"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              ) : mark === "diamond" ? (
                <path d="M50 29 71 50 50 71 29 50Z" fill={ink} />
              ) : mark === "flower" ? (
                <path d={paths.flower} transform="translate(28 28) scale(.44)" fill={ink} />
              ) : (
                <circle cx="50" cy="50" r="13" fill={ink} />
              )}
            </motion.g>
          )}
        </AnimatePresence>
      </motion.svg>
    </span>
  );
}
