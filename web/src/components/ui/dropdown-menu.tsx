"use client";
import { scrollAreaListChildren } from "@/components/ui/scroll-area";

import * as React from "react";
import { useMorph } from "@/lib/cojeev-motion/use-morph";
import { cva } from "class-variance-authority";
import { cn } from "@/lib/utils";
import * as Primitive from "@radix-ui/react-dropdown-menu";
import {
  useFlowAppearance,
  useFlowGroup,
} from "@/lib/cojeev-motion/use-flow";

import { adornItem, adornMenuItem, itemText, type ItemAdornmentItemProps } from "@/components/ui/item-adornment";
import { StateChevron, AnimatedIcon } from "@/components/ui/animated-icon";

export type DropdownMenuProps = React.ComponentProps<typeof Primitive.Root>;
export function DropdownMenu(props: DropdownMenuProps) {
  return <Primitive.Root {...props} />;
}
export type DropdownMenuPortalProps = React.ComponentProps<
  typeof Primitive.Portal
>;
export function DropdownMenuPortal(props: DropdownMenuPortalProps) {
  return <Primitive.Portal {...props} />;
}
export type DropdownMenuGroupProps = React.ComponentProps<
  typeof Primitive.Group
>;
export function DropdownMenuGroup(props: DropdownMenuGroupProps) {
  return <Primitive.Group data-slot="dropdown-menu-group" {...props} />;
}
export type DropdownMenuRadioGroupProps = React.ComponentProps<
  typeof Primitive.RadioGroup
>;
export function DropdownMenuRadioGroup(props: DropdownMenuRadioGroupProps) {
  return (
    <Primitive.RadioGroup data-slot="dropdown-menu-radiogroup" {...props} />
  );
}
export type DropdownMenuSubProps = React.ComponentProps<typeof Primitive.Sub>;
export function DropdownMenuSub(props: DropdownMenuSubProps) {
  return <Primitive.Sub {...props} />;
}
export type DropdownMenuTriggerProps = React.ComponentProps<
  typeof Primitive.Trigger
> & { chevron?: boolean };
export function DropdownMenuTrigger({
  className,
  children,
  chevron = false,
  ref,
  ...props
}: DropdownMenuTriggerProps) {
  return (
    <Primitive.Trigger
      ref={ref}
      data-slot="dropdown-menu-trigger"
      data-part="trigger"
      data-menu=""
      className={cn("", className)}
      {...props}
    >{adornItem(children, false, "", props.asChild, chevron ? <StateChevron /> : null)}</Primitive.Trigger>
  );
}
export const dropdownmenuContentVariants = cva(
  "v-menu [background:var(--popover)] [border-radius:var(--r-card-sm)] [padding:var(--s-2)] [min-width:200px] [box-shadow:var(--shadow-float)] [border:1px_solid_var(--v-border)] [display:grid] [gap:2px]",
);
export type DropdownMenuContentProps = React.ComponentProps<
  typeof Primitive.Content
>;
export function DropdownMenuContent({
  className,
  ref,
  children,
  sideOffset = 6,
  ...props
}: DropdownMenuContentProps) {
  const morphRef = useMorph<HTMLDivElement>("surfaces", ref);
  const groupRef = useFlowGroup<HTMLDivElement>(morphRef, {
    itemSelector: ".v-menu__item",
    activeSelector: "[data-highlighted]",
  });
  const flowRef = useFlowAppearance<HTMLDivElement>(true, groupRef, "grow");
  return (
    <Primitive.Portal>
      <Primitive.Content
        ref={flowRef}
        data-slot="dropdown-menu-content"
        data-part="content"
        sideOffset={sideOffset}
        className={cn(dropdownmenuContentVariants(), className)}
        {...props}
      >
        {scrollAreaListChildren(children, props.asChild)}
      </Primitive.Content>
    </Primitive.Portal>
  );
}
export type DropdownMenuSubContentProps = React.ComponentProps<
  typeof Primitive.SubContent
>;
export function DropdownMenuSubContent({
  className,
  children,
  ref,
  ...props
}: DropdownMenuSubContentProps) {
  const morphRef = useMorph<HTMLDivElement>("surfaces", ref);
  const groupRef = useFlowGroup<HTMLDivElement>(morphRef, {
    itemSelector: ".v-menu__item",
    activeSelector: "[data-highlighted]",
  });
  const flowRef = useFlowAppearance<HTMLDivElement>(true, groupRef, "grow");
  return (
    <Primitive.Portal>
      <Primitive.SubContent
        ref={flowRef}
        data-slot="dropdown-menu-sub-content"
        data-part="content"
        className={cn(dropdownmenuContentVariants(), className)}
        {...props}
      >{scrollAreaListChildren(children, props.asChild)}</Primitive.SubContent>
    </Primitive.Portal>
  );
}
export type DropdownMenuItemProps = React.ComponentProps<
  typeof Primitive.Item
> & { variant?: "default" | "danger"; inset?: boolean } & ItemAdornmentItemProps;
export function DropdownMenuItem({
  className,
  children,
  adornment,
  adornmentId,
  variant,
  inset,
  ref,
  ...props
}: DropdownMenuItemProps) {
  const morphRef = useMorph<HTMLDivElement>("nav", ref);
  return (
    <Primitive.Item
      ref={morphRef}
      data-slot="dropdown-menu-item"
      data-part="item"
      data-inset={inset || undefined}
      className={cn(
        "v-menu__item flex items-center gap-[var(--s-3)] min-h-10 px-[var(--s-3)] rounded-[var(--r-md)] text-[length:var(--fs-control)] w-full text-left whitespace-nowrap outline-none",
        variant === "danger" && "-danger",
        className,
      )}
      {...props}
    >{adornMenuItem(children, adornment, adornmentId ?? props.textValue ?? props.id ?? itemText(children), props.asChild)}</Primitive.Item>
  );
}
export type DropdownMenuSubTriggerProps = React.ComponentProps<
  typeof Primitive.SubTrigger
> & { inset?: boolean } & ItemAdornmentItemProps;
export function DropdownMenuSubTrigger({
  className,
  adornment,
  adornmentId,
  inset,
  children,
  ref,
  ...props
}: DropdownMenuSubTriggerProps) {
  const morphRef = useMorph<HTMLDivElement>("nav", ref);
  return (
    <Primitive.SubTrigger
      ref={morphRef}
      data-slot="dropdown-menu-sub-trigger"
      data-part="item"
      data-inset={inset || undefined}
      className={cn("v-menu__item", className)}
      {...props}
    >
      {adornMenuItem(children, adornment, adornmentId ?? props.textValue ?? props.id ?? itemText(children), props.asChild, <StateChevron direction="right" />)}
    </Primitive.SubTrigger>
  );
}
export type DropdownMenuCheckboxItemProps = React.ComponentProps<
  typeof Primitive.CheckboxItem
> & ItemAdornmentItemProps;
export function DropdownMenuCheckboxItem({
  className,
  adornment,
  adornmentId,
  children,
  ref,
  ...props
}: DropdownMenuCheckboxItemProps) {
  const morphRef = useMorph<HTMLDivElement>("nav", ref);
  return (
    <Primitive.CheckboxItem
      ref={morphRef}
      data-slot="dropdown-menu-checkbox-item"
      data-part="item"
      className={cn("v-menu__item", className)}
      {...props}
    >
      {adornMenuItem(children, adornment, adornmentId ?? props.textValue ?? props.id ?? itemText(children), props.asChild, <span className="v-menu__check" aria-hidden="true"><Primitive.ItemIndicator data-slot="dropdown-menu-item-indicator" data-part="indicator"><AnimatedIcon name="check" preset="validation" /></Primitive.ItemIndicator></span>)}
    </Primitive.CheckboxItem>
  );
}
export type DropdownMenuRadioItemProps = React.ComponentProps<
  typeof Primitive.RadioItem
> & ItemAdornmentItemProps;
export function DropdownMenuRadioItem({
  className,
  adornment,
  adornmentId,
  children,
  ref,
  ...props
}: DropdownMenuRadioItemProps) {
  const morphRef = useMorph<HTMLDivElement>("nav", ref);
  return (
    <Primitive.RadioItem
      ref={morphRef}
      data-slot="dropdown-menu-radio-item"
      data-part="item"
      className={cn("v-menu__item", className)}
      {...props}
    >
      {adornMenuItem(children, adornment, adornmentId ?? props.textValue ?? props.id ?? itemText(children), props.asChild, <span className="v-menu__check" aria-hidden="true"><Primitive.ItemIndicator data-slot="dropdown-menu-item-indicator" data-part="indicator"><AnimatedIcon name="dot" preset="validation" /></Primitive.ItemIndicator></span>)}
    </Primitive.RadioItem>
  );
}
export type DropdownMenuLabelProps = React.ComponentProps<
  typeof Primitive.Label
>;
export function DropdownMenuLabel({
  className,
  ...props
}: DropdownMenuLabelProps) {
  return (
    <Primitive.Label
      data-slot="dropdown-menu-label"
      data-part="group"
      className={cn("v-menu__group", className)}
      {...props}
    />
  );
}
export type DropdownMenuSeparatorProps = React.ComponentProps<
  typeof Primitive.Separator
>;
export function DropdownMenuSeparator({
  className,
  ...props
}: DropdownMenuSeparatorProps) {
  return (
    <Primitive.Separator
      data-slot="dropdown-menu-separator"
      data-part="separator"
      className={cn("v-menu__sep", className)}
      {...props}
    />
  );
}
export type DropdownMenuShortcutProps = React.ComponentProps<"span">;
export function DropdownMenuShortcut({
  className,
  ...props
}: DropdownMenuShortcutProps) {
  return (
    <span
      data-slot="dropdown-menu-shortcut"
      className={cn(
        "ml-auto text-[length:var(--fs-caps)] text-[color:var(--muted-foreground)]",
        className,
      )}
      {...props}
    />
  );
}
