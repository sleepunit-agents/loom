"use client";

import * as React from "react";
import { useMorph } from "@/lib/cojeev-motion/use-morph";
import { cva } from "class-variance-authority";
import { cn } from "@/lib/utils";
import * as Primitive from "@radix-ui/react-alert-dialog";
import { useFlowAppearance } from "@/lib/cojeev-motion/use-flow";
import { Button } from "@/components/ui/button";
export type AlertDialogProps = React.ComponentProps<typeof Primitive.Root>;
export function AlertDialog(props: AlertDialogProps) {
  return <Primitive.Root {...props} />;
}
export type AlertDialogTriggerProps = React.ComponentProps<
  typeof Primitive.Trigger
>;
export function AlertDialogTrigger(props: AlertDialogTriggerProps) {
  return (
    <Primitive.Trigger
      data-slot="alert-dialog-trigger"
      data-part="trigger"
      data-dialog-open=""
      {...props}
    />
  );
}
export type AlertDialogPortalProps = React.ComponentProps<
  typeof Primitive.Portal
>;
export function AlertDialogPortal(props: AlertDialogPortalProps) {
  return <Primitive.Portal {...props} />;
}
export type AlertDialogOverlayProps = React.ComponentProps<
  typeof Primitive.Overlay
>;
export function AlertDialogOverlay({
  className,
  ref,
  ...props
}: AlertDialogOverlayProps) {
  const flowRef = useFlowAppearance<HTMLDivElement>(true, ref, "fade");
  return (
    <Primitive.Overlay
      ref={flowRef}
      data-slot="alert-dialog-overlay"
      data-part="overlay"
      className={cn(
        "v-scrim fixed inset-0 bg-[var(--v-scrim)] z-[calc(var(--z-dialog)-1)]",
        className,
      )}
      {...props}
    />
  );
}
export const alertdialogContentVariants = cva(
  "v-dialog [position:fixed] [inset:0] [margin:auto] [width:min(520px,calc(100%_-_48px))] [height:fit-content] [background:var(--v-canvas)] [border-radius:var(--r-sheet)] [padding:var(--s-8)] [z-index:var(--z-dialog)] [display:grid] [box-shadow:var(--shadow-float),inset_0_0_0_1px_var(--v-border)] [gap:var(--s-4)]",
);
export type AlertDialogContentProps = React.ComponentProps<
  typeof Primitive.Content
> & { showCloseButton?: boolean };
export function AlertDialogContent({
  className,
  ref,
  children,
  showCloseButton = false,
  ...props
}: AlertDialogContentProps) {
  const morphRef = useMorph<HTMLDivElement>("surfaces", ref);
  const flowRef = useFlowAppearance<HTMLDivElement>(true, morphRef, "enter");
  return (
    <Primitive.Portal>
      <AlertDialogOverlay />
      <Primitive.Content
        ref={flowRef}
        data-slot="alert-dialog-content"
        data-part="content"
        className={cn(alertdialogContentVariants(), className)}
        {...props}
      >
        {children}
        {showCloseButton && (
          <AlertDialogCancel
            aria-label="Close"
            className="absolute right-4 top-4"
          >
            ×
          </AlertDialogCancel>
        )}
      </Primitive.Content>
    </Primitive.Portal>
  );
}
export type AlertDialogHeaderProps = React.ComponentProps<"div">;
export function AlertDialogHeader({
  className,
  ...props
}: AlertDialogHeaderProps) {
  return (
    <div
      data-slot="alert-dialog-header"
      data-part="header"
      className={cn(
        "v-dialog__head flex items-start justify-between gap-[var(--s-4)]",
        className,
      )}
      {...props}
    />
  );
}
export type AlertDialogFooterProps = React.ComponentProps<"div">;
export function AlertDialogFooter({
  className,
  ...props
}: AlertDialogFooterProps) {
  return (
    <div
      data-slot="alert-dialog-footer"
      data-part="footer"
      className={cn(
        "v-dialog__actions flex gap-[var(--s-3)] justify-end mt-[var(--s-2)]",
        className,
      )}
      {...props}
    />
  );
}
export type AlertDialogTitleProps = React.ComponentProps<
  typeof Primitive.Title
>;
export function AlertDialogTitle({
  className,
  ...props
}: AlertDialogTitleProps) {
  return (
    <Primitive.Title
      data-slot="alert-dialog-title"
      data-part="title"
      className={cn(
        "v-section font-[family-name:var(--font-display)] text-[length:var(--fs-section)] leading-[1.15] tracking-[-0.01em] pt-1.5 font-medium",
        className,
      )}
      {...props}
    />
  );
}
export type AlertDialogDescriptionProps = React.ComponentProps<
  typeof Primitive.Description
>;
export function AlertDialogDescription({
  className,
  ...props
}: AlertDialogDescriptionProps) {
  return (
    <Primitive.Description
      data-slot="alert-dialog-description"
      data-part="description"
      className={cn(
        "v-body-2 text-[length:var(--fs-body)] leading-[1.5] text-[color:var(--v-text-2)]",
        className,
      )}
      {...props}
    />
  );
}
export type AlertDialogActionProps = React.ComponentProps<
  typeof Primitive.Action
>;
export function AlertDialogAction({
  asChild,
  children,
  ...props
}: AlertDialogActionProps) {
  return (
    <Primitive.Action
      data-slot="alert-dialog-action"
      data-part="action"
      asChild
      {...props}
    >
      {asChild ? children : <Button variant="danger">{children}</Button>}
    </Primitive.Action>
  );
}
export type AlertDialogCancelProps = React.ComponentProps<
  typeof Primitive.Cancel
>;
export function AlertDialogCancel({
  asChild,
  children,
  ...props
}: AlertDialogCancelProps) {
  return (
    <Primitive.Cancel
      data-slot="alert-dialog-cancel"
      data-part="action"
      asChild
      {...props}
    >
      {asChild ? children : <Button variant="secondary">{children}</Button>}
    </Primitive.Cancel>
  );
}
