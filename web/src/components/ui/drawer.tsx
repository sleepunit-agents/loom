"use client";

import * as React from "react";
import { useMorph } from "@/lib/cojeev-motion/use-morph";
import { cva } from "class-variance-authority";
import { cn } from "@/lib/utils";
import * as Primitive from "@radix-ui/react-dialog";
import { useFlowAppearance } from "@/lib/cojeev-motion/use-flow";
export type DrawerProps = React.ComponentProps<typeof Primitive.Root>;
export function Drawer(props: DrawerProps) {
  return <Primitive.Root {...props} />;
}
export type DrawerTriggerProps = React.ComponentProps<typeof Primitive.Trigger>;
export function DrawerTrigger(props: DrawerTriggerProps) {
  return (
    <Primitive.Trigger
      data-slot="drawer-trigger"
      data-part="trigger"
      data-drawer-open=""
      {...props}
    />
  );
}
export type DrawerPortalProps = React.ComponentProps<typeof Primitive.Portal>;
export function DrawerPortal(props: DrawerPortalProps) {
  return <Primitive.Portal {...props} />;
}
export type DrawerOverlayProps = React.ComponentProps<typeof Primitive.Overlay>;
export function DrawerOverlay({ className, ref, ...props }: DrawerOverlayProps) {
  const flowRef = useFlowAppearance<HTMLDivElement>(true, ref, "fade");
  return (
    <Primitive.Overlay
      ref={flowRef}
      data-slot="drawer-overlay"
      data-part="overlay"
      className={cn(
        "v-scrim fixed inset-0 bg-[var(--v-scrim)] z-[calc(var(--z-sheet)-1)]",
        className,
      )}
      {...props}
    />
  );
}
export const drawerContentVariants = cva(
  "v-drawer [position:fixed] [left:var(--s-4)] [right:var(--s-4)] [bottom:calc(var(--dock-h)_+_var(--s-4))] [background:var(--v-ink)] [color:var(--v-on-ink)] [border-radius:var(--r-sheet)] [padding:var(--s-6)_var(--s-5)_var(--s-12)] [z-index:var(--z-sheet)]",
);
export type DrawerContentProps = React.ComponentProps<
  typeof Primitive.Content
> & { showCloseButton?: boolean };
export function DrawerContent({
  className,
  ref,
  children,
  showCloseButton = false,
  ...props
}: DrawerContentProps) {
  const morphRef = useMorph<HTMLDivElement>("surfaces", ref);
  const flowRef = useFlowAppearance<HTMLDivElement>(true, morphRef, "slide-block");
  return (
    <Primitive.Portal>
      <DrawerOverlay />
      <Primitive.Content
        ref={flowRef}
        data-slot="drawer-content"
        data-part="content"
        className={cn(drawerContentVariants(), className)}
        {...props}
      >
        {children}
        {showCloseButton && (
          <DrawerClose aria-label="Close" className="absolute right-4 top-4">
            ×
          </DrawerClose>
        )}
      </Primitive.Content>
    </Primitive.Portal>
  );
}
export type DrawerHeaderProps = React.ComponentProps<"div">;
export function DrawerHeader({ className, ...props }: DrawerHeaderProps) {
  return (
    <div
      data-slot="drawer-header"
      data-part="header"
      className={cn(
        "v-dialog__head flex items-start justify-between gap-[var(--s-4)]",
        className,
      )}
      {...props}
    />
  );
}
export type DrawerFooterProps = React.ComponentProps<"div">;
export function DrawerFooter({ className, ...props }: DrawerFooterProps) {
  return (
    <div
      data-slot="drawer-footer"
      data-part="footer"
      className={cn(
        "v-dialog__actions flex gap-[var(--s-3)] justify-end mt-[var(--s-2)]",
        className,
      )}
      {...props}
    />
  );
}
export type DrawerTitleProps = React.ComponentProps<typeof Primitive.Title>;
export function DrawerTitle({ className, ...props }: DrawerTitleProps) {
  return (
    <Primitive.Title
      data-slot="drawer-title"
      data-part="title"
      className={cn(
        "v-dockpanel__title text-center text-[length:var(--fs-lead)] font-semibold mb-[var(--s-2)]",
        className,
      )}
      {...props}
    />
  );
}
export type DrawerDescriptionProps = React.ComponentProps<
  typeof Primitive.Description
>;
export function DrawerDescription({
  className,
  ...props
}: DrawerDescriptionProps) {
  return (
    <Primitive.Description
      data-slot="drawer-description"
      data-part="description"
      className={cn(
        "v-body-2 text-[length:var(--fs-body)] leading-[1.5] text-[color:var(--v-text-2)]",
        className,
      )}
      {...props}
    />
  );
}
export type DrawerCloseProps = React.ComponentProps<typeof Primitive.Close>;
export function DrawerClose(props: DrawerCloseProps) {
  return (
    <Primitive.Close
      data-slot="drawer-close"
      data-part="close"
      data-close=""
      {...props}
    />
  );
}
