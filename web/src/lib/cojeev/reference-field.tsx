"use client";

import * as React from "react";
import { frame, cancelFrame } from "motion";
import { useMotionVisibility } from "@/lib/cojeev-motion/use-motion-visibility";
import { cn } from "@/lib/utils";
import { createFieldPainter, type FieldKind } from "@/lib/cojeev/reference-field-paint";
import { boundedCount, boundedNumber } from "@/lib/cojeev/reference-effect-geometry";

export type ReferenceFieldProps = React.ComponentProps<"div"> & {
  /** Stop movement while retaining a composed, meaningful still frame. */
  paused?: boolean;
  tone?: "pink" | "olive" | "blue" | "yellow";
  speed?: number;
  count?: number;
  /** Height of the local effect stage, in CSS pixels. */
  height?: number;
  /** Optional texture for the elastic sheet or ripple. */
  src?: string;
  /** Optional image cards for the trail. Decorative; describe their subject nearby. */
  images?: readonly string[];
};

/** One scoped paint surface shared by the actual field/cursor components. */
export function ReferenceField({ kind, paused = false, tone = "pink", speed = 1, count = 18, height = 320, src, images, className, style, children, ref, ...props }: ReferenceFieldProps & { kind: FieldKind }) {
  const host = React.useRef<HTMLDivElement>(null), canvas = React.useRef<HTMLCanvasElement>(null);
  const { enabled, inView } = useMotionVisibility(host);
  const running = enabled && inView && !paused;
  const safeCount = boundedCount(count, 18, 64), safeSpeed = boundedNumber(speed, 1, .1, 3);
  const state = React.useRef({ running, speed: safeSpeed });
  React.useLayoutEffect(() => { state.current = { running, speed: safeSpeed }; }, [running, safeSpeed]);
  const painter = React.useRef<ReturnType<typeof createFieldPainter> | null>(null);
  const imagesKey = JSON.stringify(images ?? []);

  React.useEffect(() => {
    const element = host.current, surface = canvas.current;
    if (!element || !surface) return;
    const context = surface.getContext("2d");
    if (!context) { element.dataset.renderState = "unavailable"; return; }
    const renderer = createFieldPainter(kind, context, safeCount);
    painter.current = renderer;
    const assets = (src ? [src] : JSON.parse(imagesKey) as string[]).slice(0, 12).map(url => {
      const image = new Image();
      image.onload = () => { renderer.invalidate(); renderer.draw(0, false); };
      image.onerror = () => { element.dataset.assetState = "fallback"; };
      image.src = url; return image;
    });
    renderer.images = assets;
    let appearanceKey = "";
    const repaint = () => {
      const css = getComputedStyle(element);
      const palette = ["--v-pink", "--v-olive", "--v-blue", "--v-yellow"].map((key, i) => css.getPropertyValue(key).trim() || ["#f5b8db", "#9aab63", "#b6caeb", "#f5d867"][i]);
      const nextKey = JSON.stringify([palette, css.color]);
      if (appearanceKey === nextKey) return;
      appearanceKey = nextKey;
      renderer.palette = palette; renderer.ink = css.color;
      renderer.invalidate(); renderer.draw(0, false);
    };
    const resize = () => {
      const width = Math.max(1, element.clientWidth), h = Math.max(1, element.clientHeight);
      const ratio = Math.min(window.devicePixelRatio || 1, 2, Math.sqrt(900000 / (width * h)));
      surface.width = Math.round(width * ratio); surface.height = Math.round(h * ratio);
      context.setTransform(ratio, 0, 0, ratio, 0, 0);
      renderer.resize(width, h);
      renderer.tone = ["pink", "olive", "blue", "yellow"].indexOf(tone);
      repaint();
      renderer.draw(0, false);
      element.dataset.renderState = "ready";
    };
    const observer = new ResizeObserver(resize); observer.observe(element);
    const theme = new MutationObserver(repaint);
    for (let ancestor: Element | null = element; ancestor; ancestor = ancestor.parentElement) {
      theme.observe(ancestor, { attributes: true, attributeFilter: ["data-mode", "data-palette", "data-contrast", "class", "style"] });
    }
    window.addEventListener("cojeev:appearancechange", repaint);
    const point = (event: PointerEvent | MouseEvent) => {
      const box = element.getBoundingClientRect();
      return { x: (event.clientX - box.left) * element.clientWidth / Math.max(1, box.width), y: (event.clientY - box.top) * element.clientHeight / Math.max(1, box.height) };
    };
    const move = (event: PointerEvent) => { if (state.current.running) renderer.move(point(event)); };
    const leave = () => renderer.leave();
    const click = (event: MouseEvent) => {
      if (!state.current.running) return;
      // A keyboard-activated child button has no pointer coordinates.
      const p = event.detail === 0 ? { x: element.clientWidth / 2, y: element.clientHeight / 2 } : point(event);
      renderer.click(p);
    };
    element.addEventListener("pointermove", move, { passive: true });
    element.addEventListener("pointerleave", leave);
    element.addEventListener("click", click);
    resize();
    return () => {
      observer.disconnect(); theme.disconnect(); window.removeEventListener("cojeev:appearancechange", repaint); assets.forEach(asset => { asset.onload = null; asset.onerror = null; });
      element.removeEventListener("pointermove", move); element.removeEventListener("pointerleave", leave); element.removeEventListener("click", click);
      painter.current = null;
    };
  }, [kind, safeCount, src, imagesKey, tone]);

  React.useEffect(() => {
    const renderer = painter.current;
    if (!renderer) return;
    if (!running) { renderer.draw(0, false); return; }
    const tick = ({ delta }: { delta: number }) => renderer.draw(Math.min(delta, 33) * state.current.speed, true);
    frame.update(tick, true);
    return () => cancelFrame(tick);
  }, [running, kind, safeCount, src, imagesKey, tone]);

  return <div {...props} ref={React.useCallback((node: HTMLDivElement | null) => { host.current = node; if (typeof ref === "function") return ref(node); if (ref) ref.current = node; }, [ref])}
    className={cn(`v-${kind}`, className)} data-slot={kind} data-running={running ? "true" : "false"} data-tone={tone}
    style={{ position: "relative", isolation: "isolate", overflow: "hidden", minWidth: 0, width: "100%", height: boundedNumber(height, 320, 120, 1000), borderRadius: "var(--r-panel)", color: "var(--v-text)", background: "var(--v-beige)", ...style }}>
    <canvas ref={canvas} aria-hidden="true" style={{ position: "absolute", inset: 0, width: "100%", height: "100%", pointerEvents: "none" }} />
    {children && <div style={{ position: "relative", zIndex: 1, minHeight: "100%", display: "grid", placeItems: "center", padding: 24, pointerEvents: "none" }}><div style={{ pointerEvents: "auto", maxWidth: "100%" }}>{children}</div></div>}
  </div>;
}
