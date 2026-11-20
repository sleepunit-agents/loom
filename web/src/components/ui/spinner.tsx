// loom's one loader (t-1925 B; Jonathan, 2026-11-06: "one size everywhere and a thematic one"): four neon segments
// that light in turn, a scanline sweeping a meter. Three sizes, each in px and never from the text around it
// (styles/cojeev/spinner.css): sm 16 (in a button, beside a field), md 24 (in an icon's place), lg 40 (a page or a
// pane on its way). Its colour is --loom-load-c, else Neon's pink; a button's is its own ink. Under reduced motion
// (access.ts) the segments stand still, half lit. A status a screen reader announces, with its label or "Working".
import * as React from "react";
import { cn } from "@/lib/utils";

export type SpinnerSize = "sm" | "md" | "lg";
export type SpinnerProps = React.ComponentProps<"span"> & {
  size?: SpinnerSize;
  label?: string;
};

export function Spinner({ className, size = "md", label, children, ...props }: SpinnerProps) {
  const caption = label ?? ((props as Record<string, unknown>)["data-label"] as string | undefined);
  return (
    <span role="status" aria-label={caption || "Working"} data-slot="spinner" data-size={size}
      className={cn("loom-load", className)} {...props}>
      <i aria-hidden /><i aria-hidden /><i aria-hidden /><i aria-hidden />
      {children}
    </span>
  );
}
