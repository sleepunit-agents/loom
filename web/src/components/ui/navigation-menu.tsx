"use client";
import { scrollAreaListChildren } from "@/components/ui/scroll-area";

import * as React from "react";
import { useMorph } from "@/lib/cojeev-motion/use-morph";
import { cva } from "class-variance-authority";
import { cn } from "@/lib/utils";
import * as Primitive from "@radix-ui/react-navigation-menu";
import {
  useFlowAppearance,
  useFlowGroup,
} from "@/lib/cojeev-motion/use-flow";
import { MotionPresence } from "@/components/ui/presence";
import { usePresence } from "motion/react";
import {
  createMotionLane,
  motionTokens,
  useChoreography,
} from "@/lib/cojeev-motion/choreography";
import { assignMotionRef } from "@/lib/cojeev-motion/refs";
import {
  adornItem,
  itemText,
  type ItemAdornmentItemProps,
} from "@/components/ui/item-adornment";
import { StateChevron } from "@/components/ui/animated-icon";
const NavigationValueContext = React.createContext("");
const NavigationItemContext = React.createContext("");
export const navigationMenuVariants = cva("v-nav [display:grid] [gap:2px]");
export type NavigationMenuProps = React.ComponentProps<
  typeof Primitive.Root
> & {
  /** Grouped destinations, a preview shelf, or a compact disclosure menu. */
  appearance?: "directory" | "shelf" | "compact";
};
export function NavigationMenu({
  className,
  ref,
  orientation = "vertical",
  value,
  defaultValue = "",
  onValueChange,
  appearance,
  onPointerOverCapture,
  onClickCapture,
  onKeyDownCapture,
  ...props
}: NavigationMenuProps) {
  const [localValue, setLocalValue] = React.useState(defaultValue);
  const selected = value ?? localValue;
  // Radix can still deliver a delayed hover-open after a click/Escape close.
  // Only a fresh pointer entry or explicit activation may reopen that menu.
  const dismissed = React.useRef(false);
  const flowRef = useFlowGroup<HTMLElement>(ref, {
    itemSelector: ".v-nav__item",
    activeSelector: '[aria-current="page"]',
  });
  return (
    <NavigationValueContext.Provider value={selected}>
      <Primitive.Root
        ref={flowRef}
        orientation={orientation}
        value={selected}
        onValueChange={(next) => {
          if (next && dismissed.current) return;
          if (!next) dismissed.current = true;
          if (value === undefined) setLocalValue(next);
          onValueChange?.(next);
        }}
        onPointerOverCapture={(event) => {
          onPointerOverCapture?.(event);
          if (event.defaultPrevented) return;
          const target =
            event.target instanceof Element
              ? event.target.closest('[data-slot="navigation-menu-trigger"]')
              : null;
          if (
            target &&
            !(
              event.relatedTarget instanceof Node &&
              target.contains(event.relatedTarget)
            )
          )
            dismissed.current = false;
        }}
        onClickCapture={(event) => {
          onClickCapture?.(event);
          if (!event.defaultPrevented) dismissed.current = false;
        }}
        onKeyDownCapture={(event) => {
          onKeyDownCapture?.(event);
          if (!event.defaultPrevented && event.key === "Escape")
            dismissed.current = true;
          else if (
            !event.defaultPrevented &&
            (event.key === "Enter" || event.key === " ")
          )
            dismissed.current = false;
        }}
        data-slot="navigation-menu"
        data-appearance={appearance}
        data-part="root"
        className={cn(navigationMenuVariants(), className)}
        {...props}
      />
    </NavigationValueContext.Provider>
  );
}
export type NavigationMenuListProps = React.ComponentProps<
  typeof Primitive.List
>;
export function NavigationMenuList({
  className,
  ...props
}: NavigationMenuListProps) {
  return (
    <Primitive.List
      data-slot="navigation-menu-list"
      className={cn("grid", className)}
      {...props}
    />
  );
}
export type NavigationMenuItemProps = React.ComponentProps<
  typeof Primitive.Item
>;
export function NavigationMenuItem({
  value,
  ...props
}: NavigationMenuItemProps) {
  const generated = React.useId();
  const itemValue = value ?? generated;
  return (
    <NavigationItemContext.Provider value={itemValue}>
      <Primitive.Item
        value={itemValue}
        data-slot="navigation-menu-item"
        {...props}
      />
    </NavigationItemContext.Provider>
  );
}
export type NavigationMenuLinkProps = React.ComponentProps<
  typeof Primitive.Link
> &
  ItemAdornmentItemProps;
export function NavigationMenuLink({
  className,
  children,
  adornment,
  adornmentId,
  active,
  ref,
  ...props
}: NavigationMenuLinkProps) {
  const morphRef = useMorph<HTMLAnchorElement>("nav", ref);
  return (
    <Primitive.Link
      ref={morphRef}
      data-slot="navigation-menu-link"
      data-part="item"
      active={active}
      aria-current={active ? "page" : undefined}
      className={cn("v-nav__item", className)}
      {...props}
    >
      {adornItem(
        children,
        adornment,
        adornmentId ?? props.href ?? itemText(children),
        props.asChild,
      )}
    </Primitive.Link>
  );
}
export type NavigationMenuGroupProps = React.ComponentProps<"div">;
export function NavigationMenuGroup({
  className,
  ...props
}: NavigationMenuGroupProps) {
  return (
    <div
      data-slot="navigation-menu-group"
      data-part="group"
      className={cn("v-nav__group", className)}
      {...props}
    />
  );
}
export type NavigationMenuCountProps = React.ComponentProps<"span">;
export function NavigationMenuCount({
  className,
  ref,
  ...props
}: NavigationMenuCountProps) {
  const morphRef = useMorph<HTMLSpanElement>("pills", ref);
  return (
    <span
      ref={morphRef}
      data-slot="navigation-menu-count"
      data-part="indicator"
      className={cn("v-nav__count", className)}
      {...props}
    />
  );
}
export type NavigationMenuTriggerProps = React.ComponentProps<
  typeof Primitive.Trigger
> &
  ItemAdornmentItemProps & { chevron?: boolean };
export function NavigationMenuTrigger({
  className,
  children,
  adornment,
  adornmentId,
  chevron = true,
  ...props
}: NavigationMenuTriggerProps) {
  const selected = React.useContext(NavigationValueContext);
  const itemValue = React.useContext(NavigationItemContext);
  return (
    <Primitive.Trigger
      type="button"
      data-slot="navigation-menu-trigger"
      data-part="trigger"
      className={cn("v-nav__item", className)}
      {...props}
    >
      {adornItem(
        children,
        adornment,
        adornmentId ?? itemText(children),
        props.asChild,
        chevron ? <StateChevron open={selected === itemValue} /> : null,
      )}
    </Primitive.Trigger>
  );
}
export type NavigationMenuContentProps = React.ComponentProps<
  typeof Primitive.Content
>;
export function NavigationMenuContent({
  ref,
  forceMount,
  children,
  ...props
}: NavigationMenuContentProps) {
  const selected = React.useContext(NavigationValueContext);
  const itemValue = React.useContext(NavigationItemContext);
  const open = selected === itemValue;
  const content = (
    <Primitive.Content
      ref={ref}
      forceMount
      data-state={open ? "open" : "closed"}
      data-slot="navigation-menu-content"
      data-part="content"
      {...props}
    >
      {scrollAreaListChildren(children, props.asChild)}
    </Primitive.Content>
  );
  // Radix registers viewport content through a separate mounter. Retain that
  // actual registration until the surface exits, then let Radix unregister it.
  if (forceMount) return content;
  return (
    <MotionPresence>
      {open && (
        <NavigationMenuRetainedContent key={itemValue} ref={ref} {...props}>
          {scrollAreaListChildren(children, props.asChild)}
        </NavigationMenuRetainedContent>
      )}
    </MotionPresence>
  );
}
function NavigationMenuRetainedContent({
  ref,
  ...props
}: NavigationMenuContentProps) {
  const [host, setHost] = React.useState<HTMLDivElement | null>(null);
  const [present, safeToRemove] = usePresence();
  const { quiet, transition } = useChoreography();
  const attach = React.useCallback(
    (node: HTMLDivElement | null) => {
      setHost(node);
      const release = assignMotionRef(ref, node);
      return () => {
        setHost(null);
        release();
      };
    },
    [ref],
  );
  React.useLayoutEffect(() => {
    if (!host) return;
    // The native viewport renders its registered node outside this component's
    // React subtree. Drive that actual node, and release its registration only
    // when this Motion lane completes; no elapsed-time unmount approximation.
    const lane = createMotionLane(
      Number.parseFloat(host.style.opacity || (present ? "0" : "1")),
      (value) => {
        host.style.opacity = String(Math.max(0, Math.min(1, value)));
        host.style.scale = String(0.975 + 0.025 * value);
      },
    );
    lane.jump(lane.get());
    const finish = () => {
      if (!present) safeToRemove?.();
    };
    if (quiet) lane.jump(present ? 1 : 0);
    else
      lane.to(
        present ? 1 : 0,
        present
          ? transition
          : {
              duration: motionTokens.duration.exit,
              ease: [...motionTokens.ease.exit],
            },
        finish,
      );
    return () => lane.dispose();
  }, [host, present, quiet, transition, safeToRemove]);
  // AnimatePresence records its exiting keys in a parent layout effect. Quiet
  // paint is synchronous, but removal must run after that registration commits.
  React.useEffect(() => {
    if (quiet && !present) safeToRemove?.();
  }, [quiet, present, safeToRemove]);
  return (
    <Primitive.Content
      {...props}
      ref={attach}
      forceMount
      data-slot="navigation-menu-content"
      data-part="content"
      data-state={present ? "open" : "closed"}
      data-motion-exiting={!present ? "true" : undefined}
      inert={!present || props.inert || undefined}
      aria-hidden={!present ? true : props["aria-hidden"]}
    />
  );
}
export type NavigationMenuViewportProps = React.ComponentProps<
  typeof Primitive.Viewport
>;
export function NavigationMenuViewport({
  ref,
  ...props
}: NavigationMenuViewportProps) {
  const selected = React.useContext(NavigationValueContext);
  const flowRef = useFlowAppearance<HTMLDivElement>(!!selected, ref, "fade");
  return (
    <Primitive.Viewport
      ref={flowRef}
      data-slot="navigation-menu-viewport"
      data-part="viewport"
      {...props}
    />
  );
}
export type NavigationMenuIndicatorProps = React.ComponentProps<
  typeof Primitive.Indicator
>;
export function NavigationMenuIndicator(props: NavigationMenuIndicatorProps) {
  return (
    <Primitive.Indicator
      data-slot="navigation-menu-indicator"
      data-part="indicator"
      {...props}
    />
  );
}

export type NavigationMenuLabelProps = React.ComponentProps<"span">;
export function NavigationMenuLabel({
  className,
  ...props
}: NavigationMenuLabelProps) {
  return (
    <span
      data-slot="navigation-menu-label"
      className={cn("v-nav__label", className)}
      {...props}
    />
  );
}
