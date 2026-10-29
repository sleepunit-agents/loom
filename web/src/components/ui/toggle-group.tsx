"use client";

import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";
import * as Primitive from "@radix-ui/react-toggle-group";
import { toggleVariants } from "@/components/ui/toggle";
import { useMorph } from "@/lib/cojeev-motion/use-morph";
import { useFlowGroup } from "@/lib/cojeev-motion/use-flow";
import { useFlowPress } from "@/lib/cojeev-motion/flow-press";
export const toggleGroupVariants = cva("inline-flex flex-wrap gap-2");
const ToggleGroupContext = React.createContext<
  VariantProps<typeof toggleVariants>
>({ variant: "default" });
export type ToggleGroupProps = React.ComponentProps<typeof Primitive.Root> &
  VariantProps<typeof toggleVariants>;
export function ToggleGroup({
  className,
  variant,
  ref,
  children,
  ...props
}: ToggleGroupProps) {
  const morphRef = useMorph<HTMLDivElement>("nav", ref);
  const flowRef = useFlowGroup<HTMLDivElement>(morphRef, {
    itemSelector: '[data-slot="toggle-group-item"]',
    activeSelector: '[aria-pressed="true"],[aria-checked="true"]',
  });
  return (
    <ToggleGroupContext.Provider value={{ variant }}>
      <Primitive.Root
        ref={flowRef}
        data-slot="toggle-group"
        data-part="root"
        data-togglegroup={props.type === "multiple" ? "multi" : "single"}
        data-flow={
          props.type === "multiple" ||
          !className?.split(/\s+/).includes("v-seg")
            ? "off"
            : undefined
        }
        className={cn(toggleGroupVariants(), className)}
        {...props}
      >
        {children}
      </Primitive.Root>
    </ToggleGroupContext.Provider>
  );
}
export type ToggleGroupItemProps = React.ComponentProps<typeof Primitive.Item> &
  VariantProps<typeof toggleVariants>;
export function ToggleGroupItem({
  className,
  asChild,
  variant,
  ref,
  ...props
}: ToggleGroupItemProps) {
  const inherited = React.useContext(ToggleGroupContext);
  const morphRef = useMorph<HTMLButtonElement>("buttons", ref);
  const pressRef = useFlowPress(morphRef);
  return (
    <Primitive.Item
      asChild={asChild}
      ref={asChild ? ref : pressRef}
      data-slot="toggle-group-item"
      data-part="item"
      className={cn(
        !asChild && toggleVariants({ variant: variant ?? inherited.variant }),
        className,
      )}
      {...props}
    />
  );
}
