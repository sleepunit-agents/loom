"use client";

import * as React from "react";
import { controlRadiusStyle, type ControlRadius } from "@/lib/cojeev/control-appearance";
import { useChoreography } from "@/lib/cojeev-motion/choreography";
import { useMorph } from "@/lib/cojeev-motion/use-morph";
import { cva } from "class-variance-authority";
import { cn } from "@/lib/utils";
import * as Primitive from "@radix-ui/react-switch";
export const switchVariants = cva(
  "v-switch [position:relative] [display:inline-block] [border-radius:var(--r-pill)] [flex:none] [cursor:pointer] [width:48px] [height:28px] [background:var(--v-beige)] [box-shadow:inset_0_0_0_1px_var(--v-edge)]",
);
export type SwitchProps = React.ComponentProps<typeof Primitive.Root> & { appearance?: "capsule" | "rocker" | "latch"; radius?: ControlRadius };
export function Switch({ className, ref, appearance = "capsule", radius, style, checked, defaultChecked, onCheckedChange, ...props }: SwitchProps) {
  const face = React.useRef<HTMLSpanElement>(null);
  const morphRef = useMorph<HTMLSpanElement>("controls", face);
  const [local, setLocal] = React.useState(defaultChecked ?? false);
  const selected = checked ?? local;
  const { quiet } = useChoreography();
  React.useEffect(() => {
    const surface = face.current, owner = surface?.parentElement;
    if (!surface || !owner) return;
    const controller = new AbortController();
    for (const type of ["pointerenter", "pointerleave", "pointerdown", "pointercancel", "keydown", "keyup", "focusin", "focusout"]) {
      owner.addEventListener(type, event => {
        if (event.target === surface || owner.matches(":disabled")) return;
        const forwarded = event instanceof KeyboardEvent ? new KeyboardEvent(type, { key: event.key }) : new Event(type);
        surface.dispatchEvent(forwarded);
      }, { signal: controller.signal });
    }
    return () => controller.abort();
  }, []);
  return (
    <Primitive.Root
      ref={ref}
      data-slot="switch"
      data-part="root"
      data-appearance={appearance}
      data-motion-quiet={quiet || undefined}
      style={{ ...controlRadiusStyle(radius), ...style }}
      className={cn(switchVariants(), className)}
      checked={selected}
      onCheckedChange={next => { if (checked === undefined) setLocal(next); onCheckedChange?.(next); }}
      {...props}
    >
      <span ref={morphRef} data-slot="switch-face" data-appearance={appearance} data-state={selected ? "checked" : "unchecked"} data-disabled={props.disabled ? "" : undefined} aria-hidden="true" aria-disabled={props.disabled || undefined} data-motion={quiet || props.disabled ? "off" : undefined} className={cn(switchVariants(), className?.split(/\s+/).filter(name => ["-olive", "-blue", "-yellow", "-ink", "-sm"].includes(name)))}>
      {appearance === "rocker" ? <span data-slot="switch-rocker" aria-hidden="true"><span>O</span><span>I</span></span> : appearance === "latch" ? <span data-slot="switch-latch" aria-hidden="true"><span data-mark="off">OFF</span><span data-mark="on">ON</span></span> : <Primitive.Thumb data-slot="switch-thumb" data-part="thumb" />}
      </span>
    </Primitive.Root>
  );
}
export type SwitchRowProps = React.ComponentProps<"label">;
export function SwitchRow({ className, ...props }: SwitchRowProps) {
  return (
    <label
      data-slot="switch-row"
      className={cn("v-switchrow", className)}
      {...props}
    />
  );
}
