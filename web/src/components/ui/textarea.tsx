"use client";
import * as React from "react";
import { cva } from "class-variance-authority";
import { cn } from "@/lib/utils";
import {
  controlRadiusStyle,
  type ControlAppearanceProps,
} from "@/lib/cojeev/control-appearance";
import { ElementScrollBar } from "@/components/ui/scroll-area";
import { assignMotionRef } from "@/lib/cojeev-motion/refs";
export const textareaVariants = cva(
  "v-textarea block w-full min-h-[128px] resize-y rounded-[var(--r-card)] [border:0] bg-[var(--input)] px-[var(--s-5)] py-[var(--s-4)] text-[length:var(--fs-body)] leading-[1.5] text-[color:var(--v-text)] [box-shadow:inset_0_0_0_1px_var(--v-edge)] outline-none placeholder:text-[color:var(--v-text-2)]",
);
export type TextareaProps = React.ComponentProps<"textarea"> &
  ControlAppearanceProps;
export function Textarea({
  className,
  radius,
  appearance,
  style,
  ...props
}: TextareaProps) {
  return (
    <textarea
      data-slot="textarea"
      data-appearance={appearance}
      style={{ ...style, ...controlRadiusStyle(radius) }}
      data-part="root"
      className={cn(textareaVariants(), className)}
      {...props}
    />
  );
}
export type TextareaScrollAreaProps = Omit<
  React.ComponentProps<"div">,
  "children"
> & {
  /** One Textarea (or compatible native editor). Its ref and attributes survive. */
  children: React.ReactElement<TextareaProps>;
};
export function TextareaScrollArea({
  children,
  className,
  ...props
}: TextareaScrollAreaProps) {
  const [element, setElement] = React.useState<HTMLTextAreaElement | null>(
    null,
  );
  const externalRef = children.props.ref;
  const ref = React.useCallback(
    (node: HTMLTextAreaElement | null) => {
      setElement(node);
      const release = assignMotionRef(externalRef, node);
      return () => {
        setElement(null);
        release();
      };
    },
    [externalRef],
  );
  return (
    <div
      data-slot="textarea-scroll-area"
      className={cn("v-textarea-scroll", className)}
      {...props}
    >
      {React.cloneElement(children, { ref })}
      <ElementScrollBar
        scrollElement={element}
        refreshKey={children.props.value ?? children.props.children}
      />
    </div>
  );
}
export type TextareaComposerProps = React.ComponentProps<"div"> &
  ControlAppearanceProps;
export function TextareaComposer({
  radius,
  appearance,
  style,
  className,
  ...props
}: TextareaComposerProps) {
  return (
    <div
      data-slot="textarea-composer"
      data-appearance={appearance}
      style={{ ...style, ...controlRadiusStyle(radius) }}
      data-part="root"
      className={cn(
        "v-composer grid gap-0 rounded-[var(--r-panel)] bg-[var(--input)] [box-shadow:inset_0_0_0_1px_var(--v-edge)]",
        className,
      )}
      {...props}
    />
  );
}
export type TextareaComposerBarProps = React.ComponentProps<"div">;
export function TextareaComposerBar({
  className,
  ...props
}: TextareaComposerBarProps) {
  return (
    <div
      data-slot="textarea-composer-bar"
      data-part="footer"
      className={cn(
        "v-composer__bar flex items-center gap-[var(--s-2)] pt-[var(--s-2)] pr-[var(--s-2)] pb-[var(--s-2)] pl-[var(--s-4)]",
        className,
      )}
      {...props}
    />
  );
}
export type TextareaCountProps = React.ComponentProps<"span"> & {
  value: string;
  maxLength?: number;
};
export function TextareaCount({
  value,
  maxLength,
  className,
  ...props
}: TextareaCountProps) {
  return (
    <span
      data-slot="textarea-count"
      className={cn(
        "v-composer__count text-[length:var(--fs-meta)] text-[color:var(--v-text-2)] tabular-nums",
        className,
      )}
      {...props}
    >
      {value.length}
      {maxLength !== undefined && ` / ${maxLength}`}
    </span>
  );
}
