"use client";

import * as React from "react";
import { useChoreography } from "@/lib/cojeev-motion/choreography";
import { useDisclosureHeight } from "@/lib/cojeev-motion/use-disclosure-height";
import { cva } from "class-variance-authority";
import { cn } from "@/lib/utils";
import { Icon } from "@/components/ui/icon";
import * as Primitive from "@radix-ui/react-collapsible";
export const collapsibleVariants = cva("v-collapsible");
export type CollapsibleAppearance = "inline" | "checklist" | "inspector";
export type CollapsibleProps = React.ComponentProps<typeof Primitive.Root> & {
  appearance?: CollapsibleAppearance;
};
export function Collapsible({
  className,
  appearance,
  ...props
}: CollapsibleProps) {
  const { quiet } = useChoreography();
  return (
    <Primitive.Root
      data-slot="collapsible"
      data-part="root"
      data-appearance={appearance}
      data-motion-quiet={quiet || undefined}
      className={cn(collapsibleVariants(), className)}
      {...props}
    />
  );
}
export type CollapsibleTriggerProps = React.ComponentProps<
  typeof Primitive.Trigger
> & { indicator?: React.ReactNode };
export function CollapsibleTrigger({
  className,
  children,
  indicator,
  ...props
}: CollapsibleTriggerProps) {
  return (
    <Primitive.Trigger
      data-slot="collapsible-trigger"
      data-part="trigger"
      className={cn(
        "inline-flex items-center gap-2 min-h-11 text-[length:var(--fs-control)] text-[color:var(--muted-foreground)]",
        className,
      )}
      {...props}
    >
      {props.asChild ? (
        children
      ) : (
        <>
          {children}
          {indicator ?? <CollapsibleIndicator />}
        </>
      )}
    </Primitive.Trigger>
  );
}
export type CollapsibleContentProps = React.ComponentProps<
  typeof Primitive.Content
>;
export function CollapsibleContent({
  className,
  ref,
  children,
  ...props
}: CollapsibleContentProps) {
  const contentRef = React.useRef<HTMLDivElement>(null);
  React.useImperativeHandle(ref, () => contentRef.current!);
  useDisclosureHeight(contentRef, props.style?.animationName);
  return (
    <Primitive.Content
      ref={contentRef}
      data-slot="collapsible-content"
      data-part="content"
      className={cn("v-collapsible__body text-[length:var(--fs-small)]", className)}
      {...props}
    >
      <div data-disclosure-inner>{children}</div>
    </Primitive.Content>
  );
}
export type CollapsibleIndicatorProps = React.ComponentProps<"svg">;
export function CollapsibleIndicator({
  className,
  ...props
}: CollapsibleIndicatorProps) {
  return (
    <Icon
      name="chevron-down"
      data-slot="collapsible-indicator"
      data-part="indicator"
      aria-hidden="true"
      viewBox="0 0 24 24"
      className={cn("v-icon v-chev", className)}
      {...props}
    />
  );
}

