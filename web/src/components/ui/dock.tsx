"use client";

import * as React from "react";
import { cn } from "@/lib/utils";
import { useChoreography } from "@/lib/cojeev-motion/choreography";
import { assignMotionRef } from "@/lib/cojeev-motion/refs";
import { ScrollArea, ScrollBar } from "@/components/ui/scroll-area";

export type DockVariant = "glass" | "shelf" | "rail";

export type DockItem = {
  value: string;
  label: string;
  icon: React.ReactNode;
  disabled?: boolean;
  badge?: React.ReactNode;
  onSelect?: (value: string) => void;
};

export type DockProps = Omit<
  React.ComponentProps<"nav">,
  "children" | "defaultValue" | "onChange"
> & {
  items: DockItem[];
  variant?: DockVariant;
  value?: string;
  defaultValue?: string;
  onValueChange?: (value: string) => void;
  /** Base icon-button size, clamped to 32–72 CSS pixels. */
  itemSize?: number;
  /** Interaction strength, clamped to 1–2. Glass and shelf use the full scale; rail maps it to a restrained 1–1.12 response. */
  magnification?: number;
};

const bounded = (
  value: number | undefined,
  fallback: number,
  low: number,
  high: number,
) =>
  Number.isFinite(value)
    ? Math.max(low, Math.min(high, value as number))
    : fallback;

const firstEnabledValue = (items: DockItem[]) =>
  items.find((item) => !item.disabled)?.value;

/**
 * A labelled action launcher with macOS-inspired proximity response.
 * It changes local application state through callbacks; it never launches native apps.
 */
export function Dock({
  items,
  variant = "glass",
  value,
  defaultValue,
  onValueChange,
  itemSize: requestedItemSize = 52,
  magnification: requestedMagnification = 1.65,
  className,
  style,
  ref,
  dir,
  onPointerMove,
  onPointerLeave,
  onPointerDownCapture,
  onPointerUpCapture,
  onPointerCancelCapture,
  onFocusCapture,
  onBlurCapture,
  onKeyDown,
  ...props
}: DockProps) {
  const itemSize = bounded(requestedItemSize, 52, 32, 72);
  const magnification = bounded(requestedMagnification, 1.65, 1, 2);
  const [uncontrolledValue, setUncontrolledValue] = React.useState(
    defaultValue ?? firstEnabledValue(items),
  );
  const activeValue = value ?? uncontrolledValue;
  const [focusIndex, setFocusIndex] = React.useState<number | null>(null);
  const [pointerIndex, setPointerIndex] = React.useState<number | null>(null);
  const [scales, setScales] = React.useState<number[]>(() =>
    items.map(() => 1),
  );
  const buttons = React.useRef<Array<HTMLButtonElement | null>>([]);
  const root = React.useRef<HTMLElement | null>(null);
  const [inheritedDirection, setInheritedDirection] = React.useState<
    "ltr" | "rtl"
  >("ltr");
  const scrollDirection =
    dir === "rtl" || dir === "ltr" ? dir : inheritedDirection;
  React.useLayoutEffect(() => {
    if (dir === "rtl" || dir === "ltr" || !root.current) return;
    const read = () =>
      setInheritedDirection(
        getComputedStyle(root.current!).direction === "rtl" ? "rtl" : "ltr",
      );
    read();
    const observer = new MutationObserver(read);
    for (
      let node: HTMLElement | null = root.current;
      node;
      node = node.parentElement
    )
      observer.observe(node, { attributes: true, attributeFilter: ["dir"] });
    return () => observer.disconnect();
  }, [dir]);
  const pointerPress = React.useRef(false);
  const { quiet } = useChoreography();
  const attach = React.useCallback(
    (node: HTMLElement | null) => {
      root.current = node;
      return assignMotionRef(ref, node);
    },
    [ref],
  );

  const scaleForDistance = React.useCallback(
    (distance: number, reach: number) => {
      if (quiet || distance >= reach) return 1;
      const influence = (Math.cos((Math.PI * distance) / reach) + 1) / 2;
      return 1 + (magnification - 1) * influence;
    },
    [magnification, quiet],
  );

  const focusScales = React.useCallback(
    (index: number | null) => {
      if (index === null || quiet) return items.map(() => 1);
      return items.map((_, candidate) => {
        const distance = Math.abs(candidate - index);
        if (distance === 0) return magnification;
        if (distance === 1) return 1 + (magnification - 1) * 0.34;
        return 1;
      });
    },
    [items, magnification, quiet],
  );

  const select = (item: DockItem) => {
    if (item.disabled) return;
    if (value === undefined) setUncontrolledValue(item.value);
    onValueChange?.(item.value);
    item.onSelect?.(item.value);
  };

  const moveFocus = (from: number, direction: 1 | -1) => {
    if (!items.some((item) => !item.disabled)) return;
    let candidate = from;
    for (let count = 0; count < items.length; count += 1) {
      candidate = (candidate + direction + items.length) % items.length;
      if (!items[candidate]?.disabled) {
        buttons.current[candidate]?.focus();
        return;
      }
    }
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLElement>) => {
    onKeyDown?.(event);
    if (event.defaultPrevented) return;
    const target =
      event.target instanceof Element
        ? event.target.closest<HTMLButtonElement>("button[data-dock-index]")
        : null;
    if (!target) return;
    const index = Number(target.dataset.dockIndex);
    const direction = getComputedStyle(event.currentTarget).direction;
    let movement: 1 | -1 | undefined;
    if (variant === "rail") {
      if (event.key === "ArrowDown") movement = 1;
      if (event.key === "ArrowUp") movement = -1;
    } else {
      if (event.key === "ArrowRight") movement = direction === "rtl" ? -1 : 1;
      if (event.key === "ArrowLeft") movement = direction === "rtl" ? 1 : -1;
    }
    if (movement) {
      event.preventDefault();
      moveFocus(index, movement);
      return;
    }
    if (event.key === "Home" || event.key === "End") {
      event.preventDefault();
      const indices = items
        .map((item, itemIndex) => (item.disabled ? -1 : itemIndex))
        .filter((indexValue) => indexValue >= 0);
      buttons.current[
        event.key === "Home" ? indices[0] : indices.at(-1)!
      ]?.focus();
    }
  };

  const handlePointerMove = (event: React.PointerEvent<HTMLElement>) => {
    onPointerMove?.(event);
    if (event.defaultPrevented || quiet || event.pointerType === "touch")
      return;
    const axis = variant === "rail" ? "y" : "x";
    const pointer = axis === "x" ? event.clientX : event.clientY;
    const reach = itemSize * 1.7;
    let closest = { index: -1, distance: Number.POSITIVE_INFINITY };
    const next = items.map((item, index) => {
      if (item.disabled) return 1;
      const bounds = buttons.current[index]?.getBoundingClientRect();
      const center = bounds
        ? axis === "x"
          ? bounds.left + bounds.width / 2
          : bounds.top + bounds.height / 2
        : Number.POSITIVE_INFINITY;
      const distance = Math.abs(pointer - center);
      if (distance < closest.distance) closest = { index, distance };
      return scaleForDistance(distance, reach);
    });
    setPointerIndex(closest.distance <= reach ? closest.index : null);
    setScales(next);
  };

  const handlePointerLeave = (event: React.PointerEvent<HTMLElement>) => {
    onPointerLeave?.(event);
    pointerPress.current = false;
    setPointerIndex(null);
    setScales(focusScales(focusIndex));
  };

  const handleFocusCapture = (event: React.FocusEvent<HTMLElement>) => {
    onFocusCapture?.(event);
    const target =
      event.target instanceof Element
        ? event.target.closest<HTMLButtonElement>("button[data-dock-index]")
        : null;
    if (!target) return;
    const index = Number(target.dataset.dockIndex);
    setFocusIndex(index);
    setScales(focusScales(index));
    if (!pointerPress.current)
      target.scrollIntoView({
        block: "nearest",
        inline: variant === "rail" ? "nearest" : "center",
        behavior: "auto",
      });
  };

  const handleBlurCapture = (event: React.FocusEvent<HTMLElement>) => {
    onBlurCapture?.(event);
    if (event.currentTarget.contains(event.relatedTarget as Node | null))
      return;
    pointerPress.current = false;
    setFocusIndex(null);
    setScales(items.map(() => 1));
  };

  const tabValue = items.some(
    (item) => item.value === activeValue && !item.disabled,
  )
    ? activeValue
    : firstEnabledValue(items);
  const customStyle = {
    ...style,
    "--dock-item-size": `${itemSize}px`,
    "--dock-magnification": magnification,
    "--dock-reserved-lift": `${Math.round((magnification - 1) * itemSize * 1.42)}px`,
  } as React.CSSProperties;

  return (
    <nav
      {...props}
      ref={attach}
      dir={dir}
      data-slot="dock"
      data-variant={variant}
      data-motion={quiet ? "off" : "on"}
      aria-label={
        props["aria-label"] ?? (props["aria-labelledby"] ? undefined : "Dock")
      }
      className={cn("v-dock", className)}
      style={customStyle}
      onPointerMove={handlePointerMove}
      onPointerLeave={handlePointerLeave}
      onPointerDownCapture={(event) => {
        onPointerDownCapture?.(event);
        pointerPress.current = !event.defaultPrevented;
      }}
      onPointerUpCapture={(event) => {
        onPointerUpCapture?.(event);
        pointerPress.current = false;
      }}
      onPointerCancelCapture={(event) => {
        onPointerCancelCapture?.(event);
        pointerPress.current = false;
      }}
      onFocusCapture={handleFocusCapture}
      onBlurCapture={handleBlurCapture}
      onKeyDown={handleKeyDown}
    >
      <ScrollArea
        variant="plain"
        className="v-dock__scroll"
        dir={scrollDirection}
        viewportProps={{
          role: undefined,
          "aria-label": undefined,
          tabIndex: -1,
        }}
        viewportWrapper={(viewport) => (
          <>
            {viewport}
            <ScrollBar orientation="horizontal" />
          </>
        )}
      >
        <div data-part="stage">
          {variant === "glass" && (
            <span data-part="glass-lens" aria-hidden="true" />
          )}
          {variant === "shelf" && (
            <>
              <span data-part="shelf-plane" aria-hidden="true" />
              <span data-part="shelf-edge" aria-hidden="true" />
            </>
          )}
          {variant === "rail" && (
            <span data-part="rail-spine" aria-hidden="true" />
          )}
          <div
            role="toolbar"
            aria-orientation={variant === "rail" ? "vertical" : "horizontal"}
            data-part="items"
          >
            {items.map((item, index) => {
              const proximityScale = scales[index] ?? 1;
              const scale =
                variant === "rail"
                  ? 1 + (proximityScale - 1) * 0.12
                  : proximityScale;
              const engaged = pointerIndex === index || focusIndex === index;
              return (
                <span
                  key={item.value}
                  data-part="lane"
                  data-active={item.value === activeValue || undefined}
                  data-engaged={engaged || undefined}
                >
                  <button
                    ref={(node) => {
                      buttons.current[index] = node;
                    }}
                    type="button"
                    data-part="item"
                    data-dock-index={index}
                    disabled={item.disabled}
                    aria-label={item.label}
                    aria-pressed={item.value === activeValue}
                    tabIndex={
                      !item.disabled && item.value === tabValue ? 0 : -1
                    }
                    onClick={() => select(item)}
                    style={
                      {
                        "--dock-item-scale": scale,
                        "--dock-item-lift": `${(scale - 1) * itemSize * (variant === "shelf" ? 0.25 : variant === "rail" ? 0.45 : 0.42)}px`,
                        zIndex: Math.round(scale * 100),
                      } as React.CSSProperties
                    }
                  >
                    <span data-part="visual" aria-hidden="true">
                      <span data-part="icon">{item.icon}</span>
                      {item.badge !== undefined && (
                        <span data-part="badge">{item.badge}</span>
                      )}
                    </span>
                    <span data-part="label" aria-hidden="true">
                      {item.label}
                    </span>
                  </button>
                  <span data-part="active-indicator" aria-hidden="true" />
                </span>
              );
            })}
          </div>
        </div>
      </ScrollArea>
    </nav>
  );
}
