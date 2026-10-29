"use client";

import * as React from "react";
import { controlRadiusStyle, type ControlRadius } from "@/lib/cojeev/control-appearance";
import {
  SelectorGlyph,
  selectorStyle,
  type SelectorShape,
  type SelectorTone,
  type SelectorSize,
  type SelectorIndicator,
} from "@/lib/cojeev/selector";
export type {
  SelectorShape,
  SelectorTone,
  SelectorSize,
  SelectorIndicator,
} from "@/lib/cojeev/selector";
import { cva } from "class-variance-authority";
import { cn } from "@/lib/utils";
import * as Primitive from "@radix-ui/react-checkbox";
export const checkboxVariants = cva(
  "v-check [display:inline-flex] [cursor:pointer] [background:none] [gap:var(--s-3)] [align-items:center] [font-size:var(--fs-body)] [box-shadow:none] [border:0]",
);
export type CheckboxProps = React.ComponentProps<typeof Primitive.Root> & {
  appearance?: "row" | "card" | "chip";
  radius?: ControlRadius;
  shape?: SelectorShape;
  tone?: SelectorTone;
  size?: SelectorSize;
  indicator?: SelectorIndicator;
  showIndicator?: boolean;
};
export function Checkbox({
  className,
  children,
  ref,
  shape = "organic",
  tone = "pink",
  size = "default",
  indicator = "auto",
  showIndicator = true,
  style,
  appearance,
  radius,
  checked: controlled,
  defaultChecked = false,
  onCheckedChange,
  ...props
}: CheckboxProps) {
  const [local, setLocal] = React.useState<boolean | "indeterminate">(
    defaultChecked,
  );
  const checked = controlled ?? local;
  return (
    <Primitive.Root
      ref={ref}
      data-slot="checkbox"
      data-part="root"
      data-appearance={appearance}
      data-selector-shape={shape}
      style={selectorStyle(tone, { ...controlRadiusStyle(radius), ...style }, size)}
      checked={checked}
      onCheckedChange={(next) => {
        if (controlled === undefined) setLocal(next);
        onCheckedChange?.(next);
      }}
      className={cn(checkboxVariants(), className)}
      {...props}
    >
      <span data-slot="checkbox-indicator" data-part="indicator">
        <SelectorGlyph
          shape={shape}
          tone={tone}
          state={checked}
          indicator={indicator}
          showIndicator={showIndicator}
          kind="checkbox"
          disabled={props.disabled}
        />
      </span>
      {children}
    </Primitive.Root>
  );
}
export type CheckboxGroupProps = React.ComponentProps<"div">;
export function CheckboxGroup({ className, ...props }: CheckboxGroupProps) {
  return (
    <div
      data-slot="checkbox-group"
      className={cn("v-checks grid gap-2", className)}
      {...props}
    />
  );
}
export type CheckboxBodyProps = React.ComponentProps<"span">;
export function CheckboxBody({ className, ...props }: CheckboxBodyProps) {
  return (
    <span
      data-slot="checkbox-body"
      className={cn("v-check__body grid gap-0.5 min-w-0", className)}
      {...props}
    />
  );
}
