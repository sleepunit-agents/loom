"use client";
import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";
import { useMorph } from "@/lib/cojeev-motion/use-morph";
import { Button } from "@/components/ui/button";

const AlertVariants = cva(
  "v-alert [display:grid] [gap:0_var(--s-4)] [align-items:start] [padding:var(--s-4)_var(--s-5)_var(--s-4)_var(--s-4)] [border-radius:var(--r-card)] [background:var(--v-beige)] [grid-template-columns:40px_minmax(0,1fr)] [position:relative] [overflow:hidden] [isolation:isolate]",
  {
    variants: {
      variant: {
        default: "",
        info: "-info [background:var(--status-info-bg)] [--muted-foreground:var(--muted-foreground-tinted)] [color:var(--v-on-accent)] [--hue-ink:var(--status-info-ink)]",
        ok: "-ok [background:var(--status-ok-bg)] [--muted-foreground:var(--muted-foreground-tinted)] [color:var(--v-on-accent)] [--hue-ink:var(--status-ok-ink)]",
        warn: "-warn [background:var(--status-warn-bg)] [--muted-foreground:var(--muted-foreground-tinted)] [color:var(--v-on-accent)] [--hue-ink:var(--status-warn-ink)]",
        danger:
          "-danger [background:var(--status-danger-bg)] [--muted-foreground:var(--muted-foreground-tinted)] [--hue-ink:var(--status-danger-ink)]",
        pink: "-pink [background:var(--v-pink)] [--muted-foreground:var(--muted-foreground-ink)] [color:var(--v-on-accent)] [--hue:var(--v-paper)] [--hue-deep:var(--v-pink-deep)]",
      },
      size: { default: "" },
    },
    defaultVariants: { variant: "default", size: "default" },
  },
);
export type AlertPresentation = "note" | "banner" | "dispatch";
export type AlertProps = React.ComponentProps<"div"> &
  VariantProps<typeof AlertVariants> & {
    as?: React.ElementType;
    presentation?: AlertPresentation;
  };
export function Alert({
  as: Tag = "div",
  className,
  variant,
  size,
  ref,
  presentation,
  ...props
}: AlertProps) {
  const ownedRef = useMorph<HTMLDivElement>("cards", ref);
  return (
    <Tag
      ref={ownedRef}
      data-slot="alert"
      data-part="root"
      data-presentation={presentation}
      data-tone={variant ?? "default"}
      data-morph={presentation ? "none" : undefined}
      role="alert"
      className={cn(AlertVariants({ variant, size }), className)}
      {...props}
    />
  );
}

const AlertBodyVariants = cva(
  "v-alert__body [display:grid] [gap:3px] [flex:1] [padding-top:var(--s-2)] [min-width:0] [position:relative] [z-index:1]",
  {
    variants: { variant: { default: "" }, size: { default: "" } },
    defaultVariants: { variant: "default", size: "default" },
  },
);
export type AlertBodyProps = React.ComponentProps<"div"> &
  VariantProps<typeof AlertBodyVariants> & { as?: React.ElementType };
export function AlertBody({
  as: Tag = "div",
  className,
  variant,
  size,
  ...props
}: AlertBodyProps) {
  return (
    <Tag
      data-slot="alert-body"
      data-part="body"
      className={cn(AlertBodyVariants({ variant, size }), className)}
      {...props}
    />
  );
}

const AlertTitleVariants = cva(
  "v-alert__title [font-weight:var(--fw-semibold)] [font-size:var(--fs-body)] [line-height:1.3] [letter-spacing:-.005em]",
  {
    variants: { variant: { default: "" }, size: { default: "" } },
    defaultVariants: { variant: "default", size: "default" },
  },
);
export type AlertTitleProps = React.ComponentProps<"div"> &
  VariantProps<typeof AlertTitleVariants> & { as?: React.ElementType };
export function AlertTitle({
  as: Tag = "div",
  className,
  variant,
  size,
  ...props
}: AlertTitleProps) {
  return (
    <Tag
      data-slot="alert-title"
      data-part="title"
      className={cn(AlertTitleVariants({ variant, size }), className)}
      {...props}
    />
  );
}

const AlertDescriptionVariants = cva(
  "v-alert__text [font-size:var(--fs-small)] [color:var(--muted-foreground)] [line-height:1.45]",
  {
    variants: { variant: { default: "" }, size: { default: "" } },
    defaultVariants: { variant: "default", size: "default" },
  },
);
export type AlertDescriptionProps = React.ComponentProps<"div"> &
  VariantProps<typeof AlertDescriptionVariants> & { as?: React.ElementType };
export function AlertDescription({
  as: Tag = "div",
  className,
  variant,
  size,
  ...props
}: AlertDescriptionProps) {
  return (
    <Tag
      data-slot="alert-description"
      data-part="description"
      className={cn(AlertDescriptionVariants({ variant, size }), className)}
      {...props}
    />
  );
}

const AlertKickerVariants = cva(
  "v-alert__kicker [font-size:var(--fs-caps)] [font-weight:var(--fw-semibold)] [letter-spacing:.08em] [text-transform:uppercase] [color:var(--hue-ink,var(--alert-ink))] [margin-bottom:2px]",
  {
    variants: { variant: { default: "" }, size: { default: "" } },
    defaultVariants: { variant: "default", size: "default" },
  },
);
export type AlertKickerProps = React.ComponentProps<"div"> &
  VariantProps<typeof AlertKickerVariants> & { as?: React.ElementType };
export function AlertKicker({
  as: Tag = "div",
  className,
  variant,
  size,
  ...props
}: AlertKickerProps) {
  return (
    <Tag
      data-slot="alert-kicker"
      data-part="kicker"
      className={cn(AlertKickerVariants({ variant, size }), className)}
      {...props}
    />
  );
}

const AlertIconVariants = cva("v-alert__blob ", {
  variants: { variant: { default: "" }, size: { default: "" } },
  defaultVariants: { variant: "default", size: "default" },
});
export type AlertIconProps = React.ComponentProps<"span"> &
  VariantProps<typeof AlertIconVariants> & { as?: React.ElementType };
export function AlertIcon({
  as: Tag = "span",
  className,
  variant,
  size,
  ref,
  ...props
}: AlertIconProps) {
  const ownedRef = useMorph<HTMLSpanElement>("icons", ref);
  return (
    <Tag
      ref={ownedRef}
      data-slot="alert-icon"
      data-part="icon"
      data-morph="fill"
      data-shape="pebble"
      data-tier="blob"
      className={cn(AlertIconVariants({ variant, size }), className)}
      {...props}
    />
  );
}

const AlertActionsVariants = cva(
  "v-alert__actions [display:flex] [gap:var(--s-2)] [margin-top:var(--s-3)] [flex-wrap:wrap]",
  {
    variants: { variant: { default: "" }, size: { default: "" } },
    defaultVariants: { variant: "default", size: "default" },
  },
);
export type AlertActionsProps = React.ComponentProps<"div"> &
  VariantProps<typeof AlertActionsVariants> & { as?: React.ElementType };
export function AlertActions({
  as: Tag = "div",
  className,
  variant,
  size,
  ...props
}: AlertActionsProps) {
  return (
    <Tag
      data-slot="alert-footer"
      data-part="footer"
      className={cn(AlertActionsVariants({ variant, size }), className)}
      {...props}
    />
  );
}

const AlertCloseVariants = cva("v-alert__close ", {
  variants: { variant: { default: "" }, size: { default: "" } },
  defaultVariants: { variant: "default", size: "default" },
});
export type AlertCloseProps = React.ComponentProps<"button"> &
  VariantProps<typeof AlertCloseVariants> & { as?: React.ElementType };
export function AlertClose({
  as: Tag = "button",
  className,
  variant,
  size,
  ...props
}: AlertCloseProps) {
  return (
    <Button
      asChild
      variant="ghost"
      data-morph="none"
      data-flow="off"
      data-stable-hit=""
    >
      <Tag
        type="button"
        aria-label="Dismiss alert"
        data-slot="alert-close"
        data-part="close"
        className={cn(AlertCloseVariants({ variant, size }), className)}
        {...props}
      />
    </Button>
  );
}
