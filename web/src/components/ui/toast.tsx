"use client";

import * as React from "react";
import { useMorph } from "@/lib/cojeev-motion/use-morph";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import * as Primitive from "@radix-ui/react-toast";
import { useFlowAppearance } from "@/lib/cojeev-motion/use-flow";
export const toastVariants = cva(
  "v-toast [display:flex] [align-items:center] [gap:var(--s-3)] [padding:var(--s-3)_var(--s-4)] [border-radius:var(--r-card-sm)] [background:var(--v-ink)] [color:var(--v-on-ink)] [font-size:var(--fs-control)]",
  {
    variants: { variant: { default: "", cream: "-cream", danger: "-danger" } },
    defaultVariants: { variant: "default" },
  },
);
export type ToastProviderProps = React.ComponentProps<
  typeof Primitive.Provider
>;
export function ToastProvider(props: ToastProviderProps) {
  return <Primitive.Provider duration={5000} {...props} />;
}
export type ToastViewportProps = React.ComponentProps<
  typeof Primitive.Viewport
>;
export function ToastViewport({ className, ...props }: ToastViewportProps) {
  return (
    <Primitive.Viewport
      data-slot="toast-viewport"
      data-part="viewport"
      className={cn(
        "v-toaster fixed right-[var(--s-6)] bottom-[var(--s-6)] grid gap-[var(--s-2)] z-[var(--z-toast)] w-[min(380px,calc(100%-48px))]",
        className,
      )}
      {...props}
    />
  );
}
export type ToastProps = React.ComponentProps<typeof Primitive.Root> &
  VariantProps<typeof toastVariants> & {
    durable?: boolean;
    appearance?: "compact" | "actionable" | "receipt";
  };
export function Toast({
  className,
  variant,
  appearance,
  durable,
  duration,
  ref,
  ...props
}: ToastProps) {
  const morphRef = useMorph<HTMLLIElement>("surfaces", ref);
  const flowRef = useFlowAppearance<HTMLLIElement>(
    props.open ?? true,
    morphRef,
    "enter",
  );
  return (
    <Primitive.Root
      ref={flowRef}
      data-slot="toast"
      data-part="root"
      data-appearance={appearance}
      duration={durable ? Infinity : duration}
      className={cn(toastVariants({ variant }), className)}
      {...props}
    />
  );
}
export type ToastTitleProps = React.ComponentProps<typeof Primitive.Title>;
export function ToastTitle({ className, ...props }: ToastTitleProps) {
  return (
    <Primitive.Title
      data-slot="toast-title"
      data-part="title"
      className={cn("font-medium", className)}
      {...props}
    />
  );
}
export type ToastDescriptionProps = React.ComponentProps<
  typeof Primitive.Description
>;
export function ToastDescription({
  className,
  ...props
}: ToastDescriptionProps) {
  return (
    <Primitive.Description
      data-slot="toast-description"
      data-part="description"
      className={cn("flex-1", className)}
      {...props}
    />
  );
}
export type ToastActionProps = React.ComponentProps<typeof Primitive.Action>;
export function ToastAction({
  className,
  asChild,
  children,
  ...props
}: ToastActionProps) {
  return (
    <Primitive.Action
      data-slot="toast-action"
      data-part="action"
      className={className}
      asChild
      {...props}
    >
      {asChild ? (
        children
      ) : (
        <Button size="sm" variant="outline">
          {children}
        </Button>
      )}
    </Primitive.Action>
  );
}

export type ToastCloseProps = React.ComponentProps<typeof Primitive.Close>;
export function ToastClose({
  className,
  children,
  asChild,
  ...props
}: ToastCloseProps) {
  return (
    <Primitive.Close
      data-slot="toast-close"
      data-part="close"
      aria-label="Dismiss"
      className={className}
      asChild
      {...props}
    >
      {asChild ? (
        children
      ) : (
        <Button
          variant="ghost"
          style={{ minWidth: 44, minHeight: 44, padding: 0 }}
        >
          {children ?? <Icon name="x" size="sm" aria-hidden="true" />}
        </Button>
      )}
    </Primitive.Close>
  );
}

export function ToastIndicator({
  className,
  ...props
}: React.ComponentProps<"span">) {
  return (
    <span
      data-slot="toast-indicator"
      aria-hidden="true"
      className={cn("v-toast__indicator", className)}
      {...props}
    >
      <Icon name="check" size="sm" />
    </span>
  );
}
