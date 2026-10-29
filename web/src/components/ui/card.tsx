"use client";

import * as React from "react";
import { useMorph } from "@/lib/cojeev-motion/use-morph";
import { useDepth } from "@/lib/cojeev-motion/use-depth";
import { assignMotionRef } from "@/lib/cojeev-motion/refs";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";
import { Button, type ButtonProps } from "@/components/ui/button";
import { useChoreography } from "@/lib/cojeev-motion/choreography";

const cardVariants = cva(
  "v-card relative min-w-0 content-start overflow-hidden rounded-[var(--r-card)] p-[var(--card-pad)] bg-[var(--card)] text-[color:var(--card-foreground)]",
  {
    variants: {
      variant: {
        default: "",
        pink: "-pink bg-[var(--v-pink)] text-[color:var(--v-on-accent)] [--wm:var(--v-pink-deep)] [--muted-foreground:var(--muted-foreground-ink)]",
        yellow:
          "-yellow bg-[var(--v-yellow)] text-[color:var(--v-on-accent)] [--wm:var(--v-yellow-deep)] [--muted-foreground:var(--muted-foreground-ink)]",
        olive:
          "-olive bg-[var(--v-olive)] text-[color:var(--v-on-accent)] [--wm:var(--v-olive-deep)] [--muted-foreground:var(--muted-foreground-ink)]",
        blue: "-blue bg-[var(--v-blue)] text-[color:var(--v-on-accent)] [--wm:var(--v-blue-deep)] [--muted-foreground:var(--muted-foreground-ink)]",
        ink: "-ink bg-[var(--v-ink)] text-[color:var(--v-on-ink)]",
        cream:
          "-cream bg-[var(--card-2)] [--muted-foreground:var(--muted-foreground-tinted)]",
        featured:
          "-featured bg-[var(--v-canvas)] [box-shadow:inset_0_0_0_var(--bw-featured)_var(--v-pink)]",
        panel: "-panel",
        lift: "-lift hover:[transform:translateY(-1px)] hover:[box-shadow:var(--shadow-lift)]",
      },
      size: {
        default: "",
        sm: "-sm rounded-[var(--r-card-sm)] p-[var(--s-4)]",
      },
      lift: {
        true: "-lift hover:[transform:translateY(-1px)] hover:[box-shadow:var(--shadow-lift)]",
        false: "",
      },
    },
    compoundVariants: [
      { variant: "panel", className: "rounded-[var(--r-panel)]" },
    ],
    defaultVariants: { variant: "default", size: "default", lift: false },
  },
);

export type CardAppearance = "editorial" | "project" | "collection";
type CardProps = React.ComponentProps<"div"> &
  VariantProps<typeof cardVariants> & { appearance?: CardAppearance };
function Card({
  ref: externalRef,
  className,
  variant,
  size,
  lift,
  appearance,
  onPointerMove,
  onPointerLeave,
  onFocus,
  onBlur,
  ...props
}: CardProps) {
  const { quiet } = useChoreography();
  const host = React.useRef<HTMLDivElement>(null);
  const attach = React.useCallback(
    (node: HTMLDivElement | null) => {
      host.current = node;
      const release = assignMotionRef(externalRef, node);
      return () => {
        host.current = null;
        release();
      };
    },
    [externalRef],
  );
  const morphRef = useMorph<HTMLDivElement>("cards", attach);
  const depth = useDepth(host, Boolean(lift || variant === "lift"));
  return (
    <div
      ref={morphRef}
      data-slot="card"
      data-part="root"
      data-state="rest"
      data-appearance={appearance}
      data-motion-quiet={quiet || undefined}
      data-depth={depth.active ? "on" : undefined}
      className={cn(cardVariants({ variant, size, lift }), className)}
      {...props}
      onPointerMove={(event) => {
        onPointerMove?.(event);
        if (!event.defaultPrevented) depth.onPointerMove(event);
      }}
      onPointerLeave={(event) => {
        onPointerLeave?.(event);
        depth.onPointerLeave();
      }}
      onFocus={(event) => {
        onFocus?.(event);
        if (!event.defaultPrevented) depth.onFocus();
      }}
      onBlur={(event) => {
        onBlur?.(event);
        depth.onBlur(event);
      }}
    />
  );
}
function CardHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-header"
      data-part="header"
      className={cn(
        "v-card__head flex min-w-0 items-start justify-between gap-[var(--s-3)] mb-[var(--s-4)]",
        className,
      )}
      {...props}
    />
  );
}
function CardTitle({ className, ...props }: React.ComponentProps<"h3">) {
  return (
    <h3
      data-slot="card-title"
      data-part="title"
      className={cn(
        "v-card__title text-[length:var(--fs-reading)] font-semibold leading-[1.2] tracking-[-.012em]",
        className,
      )}
      {...props}
    />
  );
}
function CardContent({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-content"
      className={cn("min-w-0 grid gap-[var(--s-3)]", className)}
      {...props}
    />
  );
}
function CardDescription({ className, ...props }: React.ComponentProps<"p">) {
  return (
    <p
      data-slot="card-description"
      className={cn("v-body-2", className)}
      {...props}
    />
  );
}
function CardFooter({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-footer"
      className={cn(
        "flex min-w-0 flex-wrap items-center gap-[var(--s-3)] mt-[var(--s-5)]",
        className,
      )}
      {...props}
    />
  );
}
function CardWatermark({ className, ...props }: React.ComponentProps<"span">) {
  return (
    <span
      data-slot="card-watermark"
      data-part="watermark"
      aria-hidden="true"
      className={cn("v-wm v-shape", className)}
      {...props}
    />
  );
}
function CardCover({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-cover"
      className={cn("v-card__cover", className)}
      {...props}
    />
  );
}
/** Keep card actions as real Cojeev buttons rather than making the whole card a moving hit area. */
function CardAction({ className, ...props }: ButtonProps) {
  return (
    <Button
      size="default"
      variant="outline"
      className={cn("v-card__action", className)}
      style={{
        minHeight: 44,
        background: "var(--v-canvas)",
        color: "var(--v-text)",
      }}
      {...props}
    />
  );
}
export {
  Card,
  CardHeader,
  CardTitle,
  CardContent,
  CardDescription,
  CardFooter,
  CardWatermark,
  CardCover,
  CardAction,
  cardVariants,
};
export type { CardProps };
