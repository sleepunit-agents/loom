"use client";

import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";
import * as Primitive from "@radix-ui/react-toggle";
import { useMorph } from "@/lib/cojeev-motion/use-morph";
import { useFlowPress } from "@/lib/cojeev-motion/flow-press";
import {
  controlRadiusStyle,
  type ControlRadius,
} from "@/lib/cojeev/control-appearance";
export const toggleVariants = cva(
  "v-toggle [place-items:center] [border-radius:var(--r-pill)] [font-size:var(--fs-control)] [display:inline-flex] [align-items:center] [justify-content:center] [height:40px] [min-width:40px] [padding:0_var(--s-4)] [gap:var(--s-2)] [background:var(--v-canvas)] [color:var(--v-text-2)] [font-weight:var(--fw-medium)] [box-shadow:inset_0_0_0_1px_var(--v-edge)] [cursor:pointer]",
  {
    variants: {
      variant: {
        default: "",
        pressed: "-pressed",
        pink: "-pink",
        circle: "-circle w-10 px-0 rounded-full text-[length:var(--fs-meta)] font-semibold",
      },
    },
    defaultVariants: { variant: "default" },
  },
);
export type ToggleProps = React.ComponentProps<typeof Primitive.Root> &
  VariantProps<typeof toggleVariants> & {
    appearance?: "tool" | "bookmark" | "preference";
    radius?: ControlRadius;
  };
export function Toggle({
  ref,
  className,
  variant,
  appearance,
  radius,
  style,
  ...props
}: ToggleProps) {
  const morphRef = useMorph<HTMLButtonElement>("buttons", ref);
  const flowRef = useFlowPress(morphRef);
  return (
    <Primitive.Root
      ref={flowRef}
      data-slot="toggle"
      data-part="root"
      data-toggle=""
      data-appearance={appearance}
      data-morph={appearance ? "both" : undefined}
      data-r={appearance ? "css" : undefined}
      className={cn(toggleVariants({ variant }), className)}
      style={{ ...controlRadiusStyle(radius), ...style }}
      {...props}
    />
  );
}
export type ToggleWellProps = React.ComponentProps<"div">;
export function ToggleWell({ className, ...props }: ToggleWellProps) {
  return (
    <div
      data-slot="toggle-well"
      className={cn("v-togglewell", className)}
      {...props}
    />
  );
}
