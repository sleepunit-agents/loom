"use client";
import { useMorph } from "@/lib/cojeev-motion/use-morph";
import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { useFlowGroup } from "@/lib/cojeev-motion/use-flow";
import { useFlowPress } from "@/lib/cojeev-motion/flow-press";
import { cn } from "@/lib/utils";
import {
  controlRadiusStyle,
  type ControlRadius,
} from "@/lib/cojeev/control-appearance";

const ItemVariants = cva(
  "v-item [display:flex] [align-items:center] [gap:var(--s-4)] [padding:var(--row-pad)] [border-radius:var(--r-card-sm)] [background:var(--card-2)] [min-height:var(--item-h)] [text-align:left] [width:100%] [transition:background_var(--t-micro)]",
  {
    variants: {
      variant: {
        default: "",
        selected:
          "-selected [background:var(--sel-bg)] [--muted-foreground:var(--muted-foreground-ink)] [color:var(--sel-ink)] [box-shadow:inset_0_0_0_1px_var(--sel-edge)]",
        flat: "-flat [background:transparent] [padding:var(--s-3)_0] [min-height:56px] [border-radius:0]",
      },
      size: { default: "" },
    },
    defaultVariants: { variant: "default", size: "default" },
  },
);
export type ItemProps = React.ComponentProps<"button"> &
  VariantProps<typeof ItemVariants> & {
    as?: React.ElementType;
    appearance?: "ledger" | "cover" | "detail";
    radius?: ControlRadius;
  };
export function Item({
  ref: externalMorphRef,
  as: Tag = "button",
  className,
  variant,
  size,
  appearance,
  radius,
  style,
  ...props
}: ItemProps) {
  const ownedMorphRef = useMorph<HTMLButtonElement>("nav", externalMorphRef);
  const pressRef = useFlowPress(ownedMorphRef);
  return (
    <Tag
      ref={pressRef}
      data-slot="item-item"
      data-part="item"
      data-appearance={appearance}
      data-morph={appearance ? "both" : undefined}
      data-r={appearance ? "css" : undefined}
      type={Tag === "button" ? "button" : undefined}
      className={cn(ItemVariants({ variant, size }), className)}
      style={{ ...controlRadiusStyle(radius), ...style }}
      {...props}
    />
  );
}

const ItemGroupVariants = cva("v-list [display:grid] [gap:var(--s-2)]", {
  variants: {
    variant: {
      default: "",
      grouped:
        "-grouped [gap:0] [background:var(--card)] [border-radius:var(--r-card)] [padding:var(--s-2)]",
    },
    size: { default: "" },
  },
  defaultVariants: { variant: "default", size: "default" },
});
export type ItemGroupProps = React.ComponentProps<"div"> &
  VariantProps<typeof ItemGroupVariants> & { as?: React.ElementType };
export function ItemGroup({
  as: Tag = "div",
  ref: externalRef,
  className,
  variant,
  size,
  ...props
}: ItemGroupProps) {
  const ref = useFlowGroup<HTMLDivElement>(externalRef);
  const ownedMorphRef = useMorph<HTMLDivElement>("cards", ref);
  return (
    <Tag
      ref={ownedMorphRef}
      data-slot="item"
      data-part="root"
      className={cn(ItemGroupVariants({ variant, size }), className)}
      {...props}
    />
  );
}

const ItemContentVariants = cva(
  "v-item__body [flex:1] [min-width:0] [display:grid] [gap:2px]",
  {
    variants: { variant: { default: "" }, size: { default: "" } },
    defaultVariants: { variant: "default", size: "default" },
  },
);
export type ItemContentProps = React.ComponentProps<"div"> &
  VariantProps<typeof ItemContentVariants> & { as?: React.ElementType };
export function ItemContent({
  as: Tag = "div",
  className,
  variant,
  size,
  ...props
}: ItemContentProps) {
  return (
    <Tag
      data-slot="item-content"
      data-part="content"
      className={cn(ItemContentVariants({ variant, size }), className)}
      {...props}
    />
  );
}

const ItemTitleVariants = cva(
  "v-item__title [font-size:var(--fs-reading)] [font-weight:var(--fw-semibold)] [line-height:1.25] [display:-webkit-box] [-webkit-line-clamp:2] [-webkit-box-orient:vertical] [overflow:hidden]",
  {
    variants: { variant: { default: "" }, size: { default: "" } },
    defaultVariants: { variant: "default", size: "default" },
  },
);
export type ItemTitleProps = React.ComponentProps<"div"> &
  VariantProps<typeof ItemTitleVariants> & { as?: React.ElementType };
export function ItemTitle({
  as: Tag = "div",
  className,
  variant,
  size,
  ...props
}: ItemTitleProps) {
  return (
    <Tag
      data-slot="item-title"
      data-part="title"
      className={cn(ItemTitleVariants({ variant, size }), className)}
      {...props}
    />
  );
}

const ItemDescriptionVariants = cva(
  "v-item__sub [font-size:var(--fs-meta)] [color:var(--muted-foreground)] [line-height:1.3]",
  {
    variants: { variant: { default: "" }, size: { default: "" } },
    defaultVariants: { variant: "default", size: "default" },
  },
);
export type ItemDescriptionProps = React.ComponentProps<"div"> &
  VariantProps<typeof ItemDescriptionVariants> & { as?: React.ElementType };
export function ItemDescription({
  as: Tag = "div",
  className,
  variant,
  size,
  ...props
}: ItemDescriptionProps) {
  return (
    <Tag
      data-slot="item-description"
      data-part="description"
      className={cn(ItemDescriptionVariants({ variant, size }), className)}
      {...props}
    />
  );
}

const ItemTrailingVariants = cva(
  "v-time [display:inline-flex] [align-items:center] [white-space:nowrap] [flex:none] [height:26px] [padding:0_var(--s-3)] [border-radius:var(--r-pill)] [font-size:var(--fs-meta)] [font-weight:var(--fw-medium)] [font-variant-numeric:tabular-nums] [background:var(--v-canvas)]",
  {
    variants: {
      variant: {
        default: "",
        blue: "-blue [background:var(--v-blue)] [color:var(--v-on-accent)]",
        pink: "-pink [background:var(--v-pink)] [color:var(--v-on-accent)]",
        olive: "-olive [background:var(--v-olive)] [color:var(--v-on-accent)]",
        yellow:
          "-yellow [background:var(--v-yellow)] [color:var(--v-on-accent)]",
      },
      size: { default: "" },
    },
    defaultVariants: { variant: "default", size: "default" },
  },
);
export type ItemTrailingProps = React.ComponentProps<"span"> &
  VariantProps<typeof ItemTrailingVariants> & { as?: React.ElementType };
export function ItemTrailing({
  ref: externalMorphRef,
  as: Tag = "span",
  className,
  variant,
  size,
  ...props
}: ItemTrailingProps) {
  const ownedMorphRef = useMorph<HTMLSpanElement>("pills", externalMorphRef);
  return (
    <Tag
      ref={ownedMorphRef}
      data-slot="item-trailing"
      data-part="trailing"
      className={cn(ItemTrailingVariants({ variant, size }), className)}
      {...props}
    />
  );
}
