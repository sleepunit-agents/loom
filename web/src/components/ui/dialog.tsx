"use client";

import * as React from "react";
import { useMorph } from "@/lib/cojeev-motion/use-morph";
import { cva } from "class-variance-authority";
import { cn } from "@/lib/utils";
import * as Primitive from "@radix-ui/react-dialog";
import { useFlowAppearance } from "@/lib/cojeev-motion/use-flow";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { ScrollArea, type ScrollAreaProps } from "@/components/ui/scroll-area";
export type DialogProps = React.ComponentProps<typeof Primitive.Root>;
export function Dialog(props: DialogProps) {
  return <Primitive.Root {...props} />;
}
export type DialogTriggerProps = React.ComponentProps<typeof Primitive.Trigger>;
export function DialogTrigger(props: DialogTriggerProps) {
  return (
    <Primitive.Trigger
      data-slot="dialog-trigger"
      data-part="trigger"
      data-dialog-open=""
      {...props}
    />
  );
}
export type DialogPortalProps = React.ComponentProps<typeof Primitive.Portal>;
export function DialogPortal(props: DialogPortalProps) {
  return <Primitive.Portal {...props} />;
}
export type DialogOverlayProps = React.ComponentProps<typeof Primitive.Overlay>;
export function DialogOverlay({
  className,
  ref,
  ...props
}: DialogOverlayProps) {
  const flowRef = useFlowAppearance<HTMLDivElement>(true, ref, "fade");
  return (
    <Primitive.Overlay
      ref={flowRef}
      data-slot="dialog-overlay"
      data-part="overlay"
      className={cn(
        "v-scrim fixed inset-0 bg-[var(--v-scrim)] z-[calc(var(--z-dialog)-1)]",
        className,
      )}
      {...props}
    />
  );
}
export const dialogContentVariants = cva(
  "v-dialog [position:fixed] [inset:0] [margin:auto] [width:min(520px,calc(100%_-_48px))] [height:fit-content] [background:var(--v-canvas)] [border-radius:var(--r-sheet)] [padding:var(--s-8)] [z-index:var(--z-dialog)] [display:grid] [box-shadow:var(--shadow-float),inset_0_0_0_1px_var(--v-border)] [gap:var(--s-4)]",
);
export type DialogContentProps = React.ComponentProps<
  typeof Primitive.Content
> & {
  showCloseButton?: boolean;
  appearance?: "confirmation" | "editor" | "exhibit";
};
export function DialogContent({
  className,
  ref,
  children,
  showCloseButton = false,
  appearance,
  ...props
}: DialogContentProps) {
  const morphRef = useMorph<HTMLDivElement>("surfaces", ref);
  const flowRef = useFlowAppearance<HTMLDivElement>(true, morphRef, "enter");
  return (
    <Primitive.Portal>
      <DialogOverlay />
      <Primitive.Content
        ref={flowRef}
        data-slot="dialog-content"
        data-part="content"
        data-appearance={appearance}
        data-morph={appearance ? "both" : undefined}
        data-r={appearance ? "css" : undefined}
        data-stable-hit=""
        className={cn(dialogContentVariants(), className)}
        {...props}
      >
        {children}
        {showCloseButton && (
          <DialogClose asChild>
            <Button
              variant="ghost"
              aria-label="Close"
              className="v-dialog__close"
            >
              <Icon name="x" />
            </Button>
          </DialogClose>
        )}
      </Primitive.Content>
    </Primitive.Portal>
  );
}
/** Bounded body; header and actions remain reachable while native content scrolls. */
export function DialogBody({
  className,
  viewportProps,
  ...props
}: ScrollAreaProps) {
  return (
    <ScrollArea
      variant="plain"
      type="always"
      className={cn("v-dialog__body", className)}
      viewportProps={{ tabIndex: -1, ...viewportProps }}
      {...props}
    />
  );
}
export type DialogHeaderProps = React.ComponentProps<"div">;
export function DialogHeader({ className, ...props }: DialogHeaderProps) {
  return (
    <div
      data-slot="dialog-header"
      data-part="header"
      className={cn(
        "v-dialog__head flex items-start justify-between gap-[var(--s-4)]",
        className,
      )}
      {...props}
    />
  );
}
export type DialogFooterProps = React.ComponentProps<"div">;
export function DialogFooter({ className, ...props }: DialogFooterProps) {
  return (
    <div
      data-slot="dialog-footer"
      data-part="footer"
      className={cn(
        "v-dialog__actions flex gap-[var(--s-3)] justify-end mt-[var(--s-2)]",
        className,
      )}
      {...props}
    />
  );
}
export type DialogTitleProps = React.ComponentProps<typeof Primitive.Title>;
export function DialogTitle({ className, ...props }: DialogTitleProps) {
  return (
    <Primitive.Title
      data-slot="dialog-title"
      data-part="title"
      className={cn(
        "v-section font-[family-name:var(--font-display)] text-[length:var(--fs-section)] leading-[1.15] tracking-[-0.01em] pt-1.5 font-medium",
        className,
      )}
      {...props}
    />
  );
}
export type DialogDescriptionProps = React.ComponentProps<
  typeof Primitive.Description
>;
export function DialogDescription({
  className,
  ...props
}: DialogDescriptionProps) {
  return (
    <Primitive.Description
      data-slot="dialog-description"
      data-part="description"
      className={cn(
        "v-body-2 text-[length:var(--fs-body)] leading-[1.5] text-[color:var(--v-text-2)]",
        className,
      )}
      {...props}
    />
  );
}
export type DialogCloseProps = React.ComponentProps<typeof Primitive.Close>;
export function DialogClose(props: DialogCloseProps) {
  return (
    <Primitive.Close
      data-slot="dialog-close"
      data-part="close"
      data-close=""
      {...props}
    />
  );
}
