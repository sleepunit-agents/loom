"use client";

import * as React from "react";
import { cn } from "@/lib/utils";
import { createMotionLane, useChoreography } from "@/lib/cojeev-motion/choreography";
import { useMotionVisibility } from "@/lib/cojeev-motion/use-motion-visibility";

export type LivingLinkProps = Omit<React.ComponentProps<"a">, "href"> & {
  href: string;
  /** Anchors have no native disabled attribute: remove href and leave an announced label. */
  disabled?: boolean;
  direction?: "forward" | "up-right";
  /** Directional ink reveals or a soft pigment wash; contour preserves the original resting mark. */
  treatment?: "contour" | "underline-start" | "underline-end" | "underline-center" | "wash-up" | "wash-across";
  tone?: "pink" | "olive" | "blue" | "yellow";
};

/** A native link with an original ink contour. Motion never owns navigation. */
export function LivingLink({
  href, disabled = false, direction = "up-right", treatment = "contour", tone = "blue", children, className, ref,
  onPointerEnter, onPointerLeave, onFocus, onBlur, onClickCapture, onAuxClickCapture,
  "aria-disabled": ariaDisabled, tabIndex, ...props
}: LivingLinkProps) {
  const host = React.useRef<HTMLAnchorElement>(null);
  const lane = React.useRef<ReturnType<typeof createMotionLane> | null>(null);
  const [hovered, setHovered] = React.useState(false);
  const [focused, setFocused] = React.useState(false);
  const [localQuiet, setLocalQuiet] = React.useState(false);
  const { quiet, transition } = useChoreography();
  const { enabled, inView } = useMotionVisibility(host);
  const blocked = disabled || ariaDisabled === true || ariaDisabled === "true";
  const active = !blocked && (hovered || focused);
  const still = quiet || localQuiet || !enabled || !inView;
  const bindRef = React.useCallback((element: HTMLAnchorElement | null) => {
    host.current = element;
    if (typeof ref === "function") return ref(element);
    if (ref) ref.current = element;
  }, [ref]);

  React.useEffect(() => {
    const element = host.current;
    if (!element) return;
    const painter = createMotionLane(0, value => element.style.setProperty("--link-motion", String(Math.max(0, Math.min(1, value)))));
    lane.current = painter;
    return () => { painter.dispose(); lane.current = null; };
  }, []);
  React.useEffect(() => {
    const element = host.current;
    if (!element) return;
    const update = () => setLocalQuiet(Boolean(element.closest('[data-flow="off"],[data-no-glide]')));
    const observer = new MutationObserver(update);
    for (let ancestor: HTMLElement | null = element; ancestor; ancestor = ancestor.parentElement) {
      observer.observe(ancestor, { attributes: true, attributeFilter: ["data-flow", "data-no-glide"] });
    }
    update();
    return () => observer.disconnect();
  }, []);
  React.useEffect(() => {
    if (still) lane.current?.jump(active ? 1 : 0);
    else lane.current?.to(active ? 1 : 0, transition);
  }, [active, still, transition]);

  return <a {...props} ref={bindRef} href={blocked ? undefined : href} role={blocked ? "link" : props.role}
    data-slot="living-link" data-direction={direction} data-treatment={treatment} data-tone={tone} data-active={active} data-quiet={still}
    aria-disabled={blocked || undefined} tabIndex={blocked ? -1 : tabIndex} className={cn("v-living-link", className)}
    onClickCapture={event => { if (blocked) { event.preventDefault(); event.stopPropagation(); return; } onClickCapture?.(event); }}
    onAuxClickCapture={event => { if (blocked) { event.preventDefault(); event.stopPropagation(); return; } onAuxClickCapture?.(event); }}
    onPointerEnter={event => { onPointerEnter?.(event); if (!event.defaultPrevented && event.pointerType !== "touch") setHovered(true); }}
    onPointerLeave={event => { onPointerLeave?.(event); setHovered(false); }}
    onFocus={event => { onFocus?.(event); if (!event.defaultPrevented) setFocused(true); }}
    onBlur={event => { onBlur?.(event); setFocused(false); }}>
    <span className="v-living-link__words">{children}<svg className="v-living-link__ink" viewBox="0 0 120 12" preserveAspectRatio="none" aria-hidden="true"><path d="M2 8C22 3 37 11 58 7S94 9 118 4" /></svg></span>
    <span className="v-living-link__arrow" aria-hidden="true"><span className="v-living-link__arrow-window">{["outgoing", "incoming"].map(part => <svg key={part} data-arrow={part} viewBox="0 0 20 20"><path d={direction === "forward" ? "M3 10H16M11 5L16 10L11 15" : "M5 15L15 5M6 5H15V14"} /></svg>)}</span></span>
  </a>;
}
