"use client";
import * as React from "react";
import { cva } from "class-variance-authority";
import { cn } from "@/lib/utils";
import { Disk, IconButton } from "@/components/ui/icon";
export const attachmentVariants = cva(
  "v-attach flex items-center gap-[var(--s-3)] min-h-[56px] pl-[var(--s-2)] pr-[var(--s-3)] py-[var(--s-2)] [border-radius:var(--r-pill)] bg-[var(--card)]",
);
export type AttachmentProps = React.ComponentProps<"div">;
export function Attachment({ className, ...props }: AttachmentProps) {
  return (
    <div
      data-slot="attachment"
      data-part="root"
      className={cn(attachmentVariants(), className)}
      {...props}
    />
  );
}
export type AttachmentTypeProps = React.ComponentProps<"span">;
export function AttachmentType({
  ref,
  className,
  ...props
}: AttachmentTypeProps) {
  return (
    <Disk
      ref={ref}
      data-slot="attachment-type"
      className={cn(
        "v-disk inline-grid place-items-center shrink-0 [width:40px] [height:40px] [border-radius:50%] [background:var(--v-ink)] [color:var(--v-on-ink)] text-[length:var(--fs-caps)] font-bold tracking-[.04em]",
        className,
      )}
      {...props}
    />
  );
}
export type AttachmentNameProps = React.ComponentProps<"span">;
export function AttachmentName({ className, ...props }: AttachmentNameProps) {
  return (
    <span
      data-slot="attachment-name"
      data-part="title"
      className={cn(
        "v-attach__name flex-1 min-w-0 overflow-hidden text-ellipsis whitespace-nowrap font-medium text-[length:var(--fs-body)] leading-[1.25]",
        className,
      )}
      {...props}
    />
  );
}
export type AttachmentMetaProps = React.ComponentProps<"span">;
export function AttachmentMeta({ className, ...props }: AttachmentMetaProps) {
  return (
    <span
      data-slot="attachment-meta"
      data-part="description"
      className={cn(
        "v-attach__meta block mt-[2px] text-[length:var(--fs-meta)] text-[color:var(--muted-foreground)]",
        className,
      )}
      {...props}
    />
  );
}
export type AttachmentActionsProps = React.ComponentProps<"span">;
export function AttachmentActions({
  className,
  ...props
}: AttachmentActionsProps) {
  return (
    <span
      data-slot="attachment-actions"
      data-part="footer"
      className={cn("v-actions flex gap-[var(--s-2)]", className)}
      {...props}
    />
  );
}
export type AttachmentActionProps = React.ComponentProps<"button">;
export function AttachmentAction({
  ref,
  className,
  ...props
}: AttachmentActionProps) {
  return (
    <IconButton
      ref={ref}
      type="button"
      data-slot="attachment-action"
      className={cn(
        "v-ibtn inline-grid place-items-center shrink-0 [width:36px] [height:36px] [border-radius:50%] [background:var(--v-canvas)] [box-shadow:inset_0_0_0_1px_var(--v-border)]",
        className,
      )}
      {...props}
    />
  );
}
