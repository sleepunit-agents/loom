"use client";
import { useMorph } from "@/lib/cojeev-motion/use-morph";
import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva } from "class-variance-authority";
import { cn } from "@/lib/utils";
import { Icon } from "@/components/ui/icon";
import { Button } from "@/components/ui/button";
import { useFlowGroup } from "@/lib/cojeev-motion/use-flow";
const SidebarContext = React.createContext<{
  open: boolean;
  setOpen: (open: boolean) => void;
} | null>(null);
export function useSidebar() {
  const context = React.useContext(SidebarContext);
  if (!context)
    throw new Error("Sidebar parts must be inside Sidebar or SidebarProvider");
  return context;
}
export type SidebarProviderProps = {
  children: React.ReactNode;
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
};
export function SidebarProvider({
  children,
  open,
  defaultOpen = true,
  onOpenChange,
}: SidebarProviderProps) {
  const [local, setLocal] = React.useState(defaultOpen);
  return (
    <SidebarContext.Provider
      value={{
        open: open ?? local,
        setOpen: (next) => {
          if (open === undefined) setLocal(next);
          onOpenChange?.(next);
        },
      }}
    >
      {children}
    </SidebarContext.Provider>
  );
}
export const sidebarVariants = cva(
  "v-sidebar relative self-stretch flex shrink-0 flex-col gap-[var(--s-2)] w-[var(--sidebar-w)] min-h-0 max-h-none bg-[var(--v-structure)] text-[color:var(--on-structure)] rounded-[var(--r-panel)] pt-[var(--s-6)] px-[var(--s-4)] pb-[var(--s-5)]",
);
export type SidebarProps = React.ComponentProps<"aside"> & {
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** Container layout fills its parent; viewport layout follows the authored standalone rail. */
  layout?: "container" | "viewport";
  appearance?: "folio" | "index" | "drawer";
};
export function Sidebar({
  open,
  defaultOpen = true,
  onOpenChange,
  layout = "container",
  appearance,
  ...props
}: SidebarProps) {
  const parent = React.useContext(SidebarContext);
  return parent && open === undefined && onOpenChange === undefined ? (
    <SidebarRail
      data-layout={layout}
      data-appearance={appearance}
      data-morph={appearance ? "both" : undefined}
      data-r={appearance ? "css" : undefined}
      {...props}
    />
  ) : (
    <SidebarProvider
      open={open}
      defaultOpen={defaultOpen}
      onOpenChange={onOpenChange}
    >
      <SidebarRail
        data-layout={layout}
        data-appearance={appearance}
        data-morph={appearance ? "both" : undefined}
        data-r={appearance ? "css" : undefined}
        {...props}
      />
    </SidebarProvider>
  );
}
function SidebarRail({
  ref: externalMorphRef,
  className,
  ...props
}: React.ComponentProps<"aside">) {
  const sidebar = useSidebar();
  const ownedMorphRef = useMorph<HTMLElement>("surfaces", externalMorphRef);
  return (
    <aside
      ref={ownedMorphRef}
      data-slot="sidebar"
      data-part="root"
      data-state={sidebar.open ? "expanded" : "collapsed"}
      className={cn(
        sidebarVariants(),
        !sidebar.open && "-mini w-[var(--sidebar-w-mini)]",
        className,
      )}
      {...props}
    />
  );
}
export type SidebarHeaderProps = React.ComponentProps<"div">;
export function SidebarHeader({ className, ...props }: SidebarHeaderProps) {
  return (
    <div
      data-slot="sidebar-header"
      data-part="header"
      className={cn(
        "v-brand relative flex items-center justify-center gap-[var(--s-2)] h-[56px] mb-[var(--s-6)] font-[family-name:var(--font-display)] text-[30px] font-medium tracking-[-.02em] text-[color:var(--sidebar-foreground)]",
        className,
      )}
      {...props}
    />
  );
}
export type SidebarTriggerProps = React.ComponentProps<"button">;
export function SidebarTrigger({
  ref: externalMorphRef,
  className,
  children,
  onClick,
  ...props
}: SidebarTriggerProps) {
  const sidebar = useSidebar();
  return (
    <Button
      ref={externalMorphRef}
      data-slot="sidebar-trigger"
      data-part="trigger"
      data-rail-collapse=""
      type="button"
      variant="ghost"
      aria-expanded={sidebar.open}
      aria-label={sidebar.open ? "Collapse the rail" : "Expand the rail"}
      className={cn(
        "v-collapse relative ml-auto shrink-0 grid place-items-center size-[44px] p-0 [border-radius:50%] text-[length:var(--fs-small)] font-[family-name:var(--font-text)] font-medium leading-none tracking-normal",
        className,
      )}
      onClick={(event) => {
        onClick?.(event);
        if (!event.defaultPrevented) sidebar.setOpen(!sidebar.open);
      }}
      {...props}
    >
      {children ?? (
        <Icon name={sidebar.open ? "chevron-left" : "chevron-right"} />
      )}
    </Button>
  );
}
export type SidebarContentProps = React.ComponentProps<"nav">;
export function SidebarContent({
  ref,
  className,
  ...props
}: SidebarContentProps) {
  const flowRef = useFlowGroup<HTMLElement>(ref);
  return (
    <nav
      ref={flowRef}
      data-slot="sidebar-content"
      data-part="viewport"
      aria-label="Destinations"
      className={cn("v-nav grid gap-[2px]", className)}
      {...props}
    />
  );
}
export type SidebarGroupLabelProps = React.ComponentProps<"div">;
export function SidebarGroupLabel({
  className,
  ...props
}: SidebarGroupLabelProps) {
  return (
    <div
      data-slot="sidebar-group-label"
      className={cn(
        "v-nav__group text-[length:var(--fs-small)] text-[color:var(--sidebar-muted)] pt-[var(--s-4)] px-[var(--s-3)] pb-[var(--s-2)]",
        className,
      )}
      {...props}
    />
  );
}
export type SidebarMenuButtonProps = React.ComponentProps<"a"> & {
  asChild?: boolean;
  isActive?: boolean;
  label?: string;
};
export function SidebarMenuButton({
  ref: externalMorphRef,
  className,
  asChild,
  isActive,
  label,
  ...props
}: SidebarMenuButtonProps) {
  const Comp = asChild ? Slot : "a";
  const accessibleLabel = label ?? getSidebarText(props.children);
  const ownedMorphRef = useMorph<HTMLAnchorElement>("nav", externalMorphRef);
  return (
    <Comp
      ref={ownedMorphRef}
      data-slot="sidebar-menu-button"
      data-state={isActive ? "active" : "inactive"}
      aria-current={isActive ? "page" : undefined}
      aria-label={accessibleLabel || undefined}
      className={cn(
        "v-nav__item relative flex items-center gap-[var(--s-4)] h-[var(--nav-row)] pl-[var(--s-5)] pr-[var(--s-3)] rounded-[var(--r-md)] text-[color:var(--sidebar-foreground)] text-[length:var(--fs-body)] no-underline",
        className,
      )}
      {...props}
    />
  );
}
export type SidebarMenuLabelProps = React.ComponentProps<"span">;
export function SidebarMenuLabel({
  className,
  ...props
}: SidebarMenuLabelProps) {
  return (
    <span
      data-slot="sidebar-menu-label"
      className={cn(
        "v-nav__label flex-1 min-w-0 overflow-hidden text-ellipsis whitespace-nowrap",
        className,
      )}
      {...props}
    />
  );
}
export type SidebarFooterProps = React.ComponentProps<"div">;
export function SidebarFooter({ className, ...props }: SidebarFooterProps) {
  return (
    <div
      data-slot="sidebar-footer"
      data-part="footer"
      className={cn("v-sidebar__foot mt-auto grid gap-[2px]", className)}
      {...props}
    />
  );
}
export type SidebarMenuBadgeProps = React.ComponentProps<"span">;
export function SidebarMenuBadge({
  ref: externalMorphRef,
  className,
  ...props
}: SidebarMenuBadgeProps) {
  const ownedMorphRef = useMorph<HTMLSpanElement>("pills", externalMorphRef);
  return (
    <span
      ref={ownedMorphRef}
      data-slot="sidebar-menu-badge"
      className={cn(
        "v-nav__count grid place-items-center min-w-[18px] h-[18px] px-[var(--s-1)] rounded-[var(--r-pill)] bg-[var(--v-pink)] text-[color:var(--v-on-accent)] text-[length:var(--fs-caps)] font-bold",
        className,
      )}
      {...props}
    />
  );
}

function getSidebarText(children: React.ReactNode): string {
  return React.Children.toArray(children)
    .map((child) =>
      typeof child === "string" || typeof child === "number"
        ? String(child)
        : React.isValidElement<{ children?: React.ReactNode }>(child)
          ? getSidebarText(child.props.children)
          : "",
    )
    .filter(Boolean)
    .join(" ");
}
