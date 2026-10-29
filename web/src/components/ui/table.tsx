"use client";
import * as React from "react";
import { cva } from "class-variance-authority";
import { cn } from "@/lib/utils";
import { ScrollArea, ScrollBar } from "@/components/ui/scroll-area";
import { assignMotionRef } from "@/lib/cojeev-motion/refs";
export const tableVariants = cva("v-table w-full border-collapse text-[length:var(--fs-small)]");
export type TableContainerProps = React.ComponentProps<"div">;
export function TableContainer({
  ref,
  className,
  onScroll,
  children,
  ...props
}: TableContainerProps) {
  const element = React.useRef<HTMLDivElement>(null);
  const mark = React.useCallback(() => {
    const el = element.current;
    if (!el) return;
    const room = el.scrollWidth - el.clientWidth;
    if (room < 2) el.removeAttribute("data-scrollable");
    else {
      const rtl = getComputedStyle(el).direction === "rtl";
      const travelled = rtl ? -el.scrollLeft : el.scrollLeft;
      el.dataset.scrollable = travelled >= room - 14 ? "end" : "more";
    }
  }, []);
  React.useLayoutEffect(() => {
    const el = element.current;
    if (!el) return;
    const resize = new ResizeObserver(mark);
    const observe = () => {
      resize.disconnect();
      resize.observe(el);
      Array.from(el.children).forEach((child) => resize.observe(child));
      mark();
    };
    const mutation = new MutationObserver(observe);
    mutation.observe(el, { childList: true, subtree: true });
    observe();
    return () => {
      resize.disconnect();
      mutation.disconnect();
    };
  }, [mark]);
  const mergeRef = React.useCallback(
    (node: HTMLDivElement | null) => {
      element.current = node;
      const release = assignMotionRef(ref, node);
      return () => {
        element.current = null;
        release();
      };
    },
    [ref],
  );
  return (
    <ScrollArea
      dir={
        props.dir === "rtl" ? "rtl" : props.dir === "ltr" ? "ltr" : undefined
      }
      variant="plain"
      className="v-table-scroll v-table-wrap"
      viewportProps={{
        ...props,
        ...{ "data-slot": "table-container", "data-part": "viewport" },
        ref: mergeRef,
        className: cn("v-table-viewport", className),
        onScroll: (event) => {
          mark();
          onScroll?.(event);
        },
      }}
      viewportWrapper={(viewport) => (
        <>
          {viewport}
          <ScrollBar orientation="horizontal" />
        </>
      )}
    >
      {children}
    </ScrollArea>
  );
}
export type TableProps = React.ComponentProps<"table"> & {
  appearance?: "ledger" | "rich" | "comparison";
};
export function Table({ className, appearance, ...props }: TableProps) {
  return (
    <table
      data-slot="table"
      data-appearance={appearance}
      data-part="root"
      className={cn(tableVariants(), className)}
      {...props}
    />
  );
}
export type TableHeaderProps = React.ComponentProps<"thead">;
export function TableHeader(props: TableHeaderProps) {
  return <thead data-slot="table-header" {...props} />;
}
export type TableBodyProps = React.ComponentProps<"tbody">;
export function TableBody(props: TableBodyProps) {
  return <tbody data-slot="table-body" {...props} />;
}
export type TableFooterProps = React.ComponentProps<"tfoot">;
export function TableFooter(props: TableFooterProps) {
  return <tfoot data-slot="table-footer" {...props} />;
}
export type TableRowProps = React.ComponentProps<"tr">;
export function TableRow(props: TableRowProps) {
  return <tr data-slot="table-row" {...props} />;
}
export type TableHeadProps = React.ComponentProps<"th"> & { numeric?: boolean };
export function TableHead({ className, numeric, ...props }: TableHeadProps) {
  return (
    <th
      data-slot="table-head"
      scope="col"
      className={cn(
        "h-[44px] px-[var(--s-3)] py-0 text-left text-[length:var(--fs-caps)] font-semibold tracking-[.07em] uppercase text-[color:var(--v-text-2)] whitespace-nowrap",
        numeric && "-num text-right tabular-nums",
        className,
      )}
      {...props}
    />
  );
}
export type TableCellProps = React.ComponentProps<"td"> & { numeric?: boolean };
export function TableCell({ className, numeric, ...props }: TableCellProps) {
  return (
    <td
      data-slot="table-cell"
      className={cn(
        "h-[60px] px-[var(--s-3)] py-0 align-middle text-[length:var(--fs-control)] whitespace-nowrap",
        numeric && "-num text-right tabular-nums font-semibold",
        className,
      )}
      {...props}
    />
  );
}
export type TableCaptionProps = React.ComponentProps<"caption">;
export function TableCaption({ className, ...props }: TableCaptionProps) {
  return (
    <caption
      data-slot="table-caption"
      className={cn(
        "text-[length:var(--fs-meta)] text-[color:var(--v-text-2)]",
        className,
      )}
      {...props}
    />
  );
}
