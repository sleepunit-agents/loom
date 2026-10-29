"use client";
import { useMorph } from "@/lib/cojeev-motion/use-morph";
import * as React from "react";
import * as AvatarPrimitive from "@radix-ui/react-avatar";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";

const AvatarVariants = cva(
  "v-avatar [width:40px] [height:40px] [border-radius:50%] [object-fit:cover] [background:var(--c,var(--v-beige))] [display:inline-grid] [place-items:center] [font-size:var(--fs-small)] [font-weight:var(--fw-semibold)] [flex:none] [color:var(--v-text)] [box-shadow:0_0_0_2px_var(--v-canvas)] [font-family:var(--font-display)] [letter-spacing:.01em]",
  {
    variants: {
      variant: {
        default: "",
        square: "-square [border-radius:var(--r-card-sm)]",
        pink: "-pink [--c:var(--v-pink)] [color:var(--v-on-accent)]",
        yellow: "-yellow [--c:var(--v-yellow)] [color:var(--v-on-accent)]",
        olive: "-olive [--c:var(--v-olive)] [color:var(--v-on-accent)]",
        blue: "-blue [--c:var(--v-blue)] [color:var(--v-on-accent)]",
        ink: "-ink [--c:var(--v-ink)] [color:var(--v-on-ink)]",
        sm: "-sm [width:28px] [height:28px] [font-size:var(--fs-caps)]",
      },
      size: {
        default: "",
        sm: "-sm [width:28px] [height:28px] [font-size:var(--fs-caps)]",
        lg: "-lg [width:110px] [height:110px] [font-size:34px] [letter-spacing:-.01em]",
      },
    },
    defaultVariants: { variant: "default", size: "default" },
  },
);
export type AvatarProps = React.ComponentProps<"span"> &
  VariantProps<typeof AvatarVariants> & {
    shape?: "circle" | "rounded" | "pebble";
  };
export function Avatar({
  ref: externalMorphRef,
  className,
  variant,
  size,
  shape,
  ...props
}: AvatarProps) {
  const ownedMorphRef = useMorph<HTMLSpanElement>("controls", externalMorphRef);
  return (
    <AvatarPrimitive.Root
      ref={ownedMorphRef}
      data-slot="avatar"
      data-part="root"
      data-avatar-shape={shape}
      className={cn(AvatarVariants({ variant, size }), className)}
      {...props}
    />
  );
}

const AvatarGroupVariants = cva(
  "v-avatar-stack [display:inline-flex] [align-items:center]",
  {
    variants: { variant: { default: "" }, size: { default: "" } },
    defaultVariants: { variant: "default", size: "default" },
  },
);
export type AvatarGroupProps = React.ComponentProps<"span"> &
  VariantProps<typeof AvatarGroupVariants>;
export function AvatarGroup({
  className,
  variant,
  size,
  ...props
}: AvatarGroupProps) {
  return (
    <span
      data-slot="avatar-group"
      data-part="group"
      className={cn(AvatarGroupVariants({ variant, size }), className)}
      {...props}
    />
  );
}

const AvatarWrapperVariants = cva(
  "v-avatar-wrap [position:relative] [display:inline-block]",
  {
    variants: { variant: { default: "" }, size: { default: "" } },
    defaultVariants: { variant: "default", size: "default" },
  },
);
export type AvatarWrapperProps = React.ComponentProps<"span"> &
  VariantProps<typeof AvatarWrapperVariants>;
export function AvatarWrapper({
  className,
  variant,
  size,
  ...props
}: AvatarWrapperProps) {
  return (
    <span
      data-slot="avatar-wrapper"
      data-part="wrapper"
      className={cn(AvatarWrapperVariants({ variant, size }), className)}
      {...props}
    />
  );
}

const AvatarEditVariants = cva("v-edit ", {
  variants: { variant: { default: "" }, size: { default: "" } },
  defaultVariants: { variant: "default", size: "default" },
});
export type AvatarEditProps = React.ComponentProps<"button"> &
  VariantProps<typeof AvatarEditVariants>;
export function AvatarEdit({
  className,
  variant,
  size,
  ...props
}: AvatarEditProps) {
  return (
    <Button
      type="button"
      variant="secondary"
      aria-label="Edit avatar"
      data-stable-hit=""
      data-flow="off"
      data-slot="avatar-edit"
      data-part="edit"
      className={cn(AvatarEditVariants({ variant, size }), className)}
      {...props}
    />
  );
}

const AvatarHexVariants = cva(
  "v-hex [width:32px] [height:32px] [display:inline-grid] [place-items:center] [font-size:var(--fs-caps)] [font-weight:var(--fw-bold)] [background:var(--c,var(--v-blue))] [clip-path:polygon(25%_6.7%,75%_6.7%,100%_50%,75%_93.3%,25%_93.3%,0_50%)] [flex:none] [color:var(--v-on-accent)] [filter:drop-shadow(0_0_0_var(--v-canvas))]",
  {
    variants: { variant: { default: "" }, size: { default: "" } },
    defaultVariants: { variant: "default", size: "default" },
  },
);
export type AvatarHexProps = React.ComponentProps<"span"> &
  VariantProps<typeof AvatarHexVariants>;
export function AvatarHex({
  ref: externalMorphRef,
  className,
  variant,
  size,
  ...props
}: AvatarHexProps) {
  const ownedMorphRef = useMorph<HTMLSpanElement>("controls", externalMorphRef);
  return (
    <span
      ref={ownedMorphRef}
      data-slot="avatar-hex"
      data-part="hex"
      className={cn(AvatarHexVariants({ variant, size }), className)}
      {...props}
    />
  );
}

const AvatarHexGroupVariants = cva(
  "v-hexgroup [display:flex] [gap:0] [align-items:center]",
  {
    variants: { variant: { default: "" }, size: { default: "" } },
    defaultVariants: { variant: "default", size: "default" },
  },
);
export type AvatarHexGroupProps = React.ComponentProps<"span"> &
  VariantProps<typeof AvatarHexGroupVariants>;
export function AvatarHexGroup({
  className,
  variant,
  size,
  ...props
}: AvatarHexGroupProps) {
  return (
    <span
      data-slot="avatar-hex-group"
      data-part="hex-group"
      className={cn(AvatarHexGroupVariants({ variant, size }), className)}
      {...props}
    />
  );
}

const AvatarMoreVariants = cva("v-more ", {
  variants: { variant: { default: "" }, size: { default: "" } },
  defaultVariants: { variant: "default", size: "default" },
});
export type AvatarMoreProps = React.ComponentProps<"span"> &
  VariantProps<typeof AvatarMoreVariants>;
export function AvatarMore({
  className,
  variant,
  size,
  ...props
}: AvatarMoreProps) {
  return (
    <span
      data-slot="avatar-more"
      data-part="more"
      className={cn(AvatarMoreVariants({ variant, size }), className)}
      {...props}
    />
  );
}

export type AvatarImageProps = React.ComponentProps<
  typeof AvatarPrimitive.Image
>;
export function AvatarImage({ className, ...props }: AvatarImageProps) {
  return (
    <AvatarPrimitive.Image
      data-slot="avatar-image"
      className={cn("h-full w-full rounded-[inherit] object-cover", className)}
      {...props}
    />
  );
}
export type AvatarFallbackProps = React.ComponentProps<
  typeof AvatarPrimitive.Fallback
>;
export function AvatarFallback(props: AvatarFallbackProps) {
  return (
    <AvatarPrimitive.Fallback
      data-slot="avatar-fallback"
      data-part="fallback"
      {...props}
    />
  );
}
