"use client";

import * as React from "react";
import { controlRadiusStyle, type ControlRadius } from "@/lib/cojeev/control-appearance";
import {
  SelectorGlyph,
  selectorStyle,
  type SelectorShape,
  type SelectorTone,
  type SelectorSize,
  type SelectorIndicator,
} from "@/lib/cojeev/selector";
export type {
  SelectorShape,
  SelectorTone,
  SelectorSize,
  SelectorIndicator,
} from "@/lib/cojeev/selector";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";
import * as Primitive from "@radix-ui/react-radio-group";
import { useFlowGroup } from "@/lib/cojeev-motion/use-flow";
export const radioGroupVariants = cva("v-radios grid gap-2", {
  variants: { pictographic: { true: "v-iradios", false: "" } },
  defaultVariants: { pictographic: false },
});
const RadioStyleContext = React.createContext<{
  appearance?: "row" | "card" | "chip";
  pictographic: boolean;
  shape: SelectorShape;
  tone: SelectorTone;
  size?: SelectorSize;
  indicator?: SelectorIndicator;
  showIndicator?: boolean;
  value?: string;
  disabled?: boolean;
  cancelKeyboardNavigation: () => void;
}>({ pictographic: false, shape: "organic", tone: "pink", cancelKeyboardNavigation: () => {} });
export type RadioGroupProps = React.ComponentProps<typeof Primitive.Root> &
  VariantProps<typeof radioGroupVariants> & {
    shape?: SelectorShape;
    tone?: SelectorTone;
    size?: SelectorSize;
    indicator?: SelectorIndicator;
    showIndicator?: boolean;
    appearance?: "row" | "card" | "chip";
    radius?: ControlRadius;
  };
export function RadioGroup({
  className,
  pictographic = false,
  ref,
  children,
  shape = "organic",
  tone = "pink",
  size,
  indicator = "auto",
  showIndicator = true,
  appearance,
  radius,
  style,
  value: controlled,
  defaultValue,
  onValueChange,
  onKeyDownCapture,
  onPointerDownCapture,
  onClickCapture,
  onFocus,
  ...props
}: RadioGroupProps) {
  const [local, setLocal] = React.useState(defaultValue);
  const value = controlled ?? local;
  const keyboardNavigation = React.useRef<{ origin: HTMLElement; activated: boolean } | null>(null);
  const navigationExpiry = React.useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const cancelKeyboardNavigation = React.useCallback(() => {
    clearTimeout(navigationExpiry.current);
    keyboardNavigation.current = null;
  }, []);
  React.useEffect(() => cancelKeyboardNavigation, [cancelKeyboardNavigation]);
  const ownedRadio = (target: EventTarget | null, group: HTMLElement) => {
    if (!(target instanceof HTMLElement) || target.getAttribute("role") !== "radio") return null;
    return target.closest('[data-slot="radio-group"]') === group ? target : null;
  };
  const flowRef = useFlowGroup<HTMLDivElement>(ref, {
    itemSelector: '[data-slot="radio-group-item"]',
    activeSelector: '[data-state="checked"]',
  });
  return (
    <RadioStyleContext.Provider
      value={{
        pictographic: !!pictographic && !appearance,
        appearance,
        shape,
        tone,
        size,
        indicator,
        showIndicator,
        value,
        disabled: props.disabled,
        cancelKeyboardNavigation,
      }}
    >
      <Primitive.Root
        ref={flowRef}
        onKeyDownCapture={event => {
          cancelKeyboardNavigation();
          onKeyDownCapture?.(event);
          if (event.defaultPrevented || props.disabled || event.altKey || event.ctrlKey || event.metaKey) return;
          const origin = ownedRadio(event.target, event.currentTarget);
          const key = event.key;
          const navigationKey = ["Home", "End"].includes(key)
            || (props.orientation !== "horizontal" && ["ArrowUp", "ArrowDown"].includes(key))
            || (props.orientation !== "vertical" && ["ArrowLeft", "ArrowRight"].includes(key));
          if (!origin || !navigationKey) return;
          keyboardNavigation.current = { origin, activated: false };
          // Radix defers roving focus to a task. Retain keyboard intent through
          // that task even if a fast keyup has already cleared its document flag.
          navigationExpiry.current = setTimeout(() => {
            navigationExpiry.current = setTimeout(cancelKeyboardNavigation, 0);
          }, 0);
        }}
        onPointerDownCapture={event => { cancelKeyboardNavigation(); onPointerDownCapture?.(event); }}
        onClickCapture={event => {
          const navigation = keyboardNavigation.current;
          if (navigation && ownedRadio(event.target, event.currentTarget) !== navigation.origin) navigation.activated = true;
          onClickCapture?.(event);
        }}
        onFocus={event => {
          onFocus?.(event);
          const navigation = keyboardNavigation.current;
          const target = ownedRadio(event.target, event.currentTarget);
          if (!navigation || !target || target === navigation.origin) return;
          // A held arrow already clicks inside Radix's Item onFocus. The scoped
          // click marker prevents a second callback, including rejected controlled changes.
          if (!navigation.activated && !event.defaultPrevented && !props.disabled
            && target.getAttribute("aria-checked") !== "true" && !target.matches(":disabled,[data-disabled]")) {
            navigation.activated = true;
            target.click();
          }
          cancelKeyboardNavigation();
        }}
        data-slot="radio-group"
        data-part="root"
        data-appearance={appearance}
        style={{ ...controlRadiusStyle(radius), ...style }}
        value={value}
        onValueChange={(next) => {
          if (controlled === undefined) setLocal(next);
          onValueChange?.(next);
        }}
        data-flow-group={pictographic && !appearance ? "" : undefined}
        data-flow={pictographic && !appearance ? undefined : "off"}
        className={cn(radioGroupVariants({ pictographic: !!pictographic && !appearance }), className)}
        {...props}
      >
        {children}
      </Primitive.Root>
    </RadioStyleContext.Provider>
  );
}
export type RadioGroupItemProps = React.ComponentProps<
  typeof Primitive.Item
> & { appearance?: "row" | "card" | "chip"; radius?: ControlRadius; pictographic?: boolean; shape?: SelectorShape; tone?: SelectorTone; size?: SelectorSize; indicator?: SelectorIndicator; showIndicator?: boolean };
export function RadioGroupItem({
  className,
  pictographic,
  shape,
  tone,
  size,
  indicator,
  showIndicator,
  style,
  appearance,
  radius,
  children,
  ref,
  onKeyDown,
  ...props
}: RadioGroupItemProps) {
  const inherited = React.useContext(RadioStyleContext);
  const icon = !(appearance ?? inherited.appearance) && (pictographic ?? inherited.pictographic);
  const selectedShape = shape ?? inherited.shape;
  const selectedTone = tone ?? inherited.tone;
  return (
    <Primitive.Item
      ref={ref}
      onKeyDown={event => {
        onKeyDown?.(event);
        if (event.defaultPrevented) inherited.cancelKeyboardNavigation();
      }}
      data-slot="radio-group-item"
      data-part="item"
      data-appearance={appearance ?? inherited.appearance}
      data-selector-shape={selectedShape}
      style={selectorStyle(selectedTone, { ...controlRadiusStyle(radius), ...style }, size ?? inherited.size ?? (icon ? 16 : "default"))}
      data-pictographic={icon || undefined}
      className={cn(
        icon ? "v-iradio" : "v-radio inline-flex items-center gap-[var(--s-3)]",
        className,
      )}
      {...props}
    >
      <span data-slot="radio-group-indicator" data-part="indicator">
        <SelectorGlyph
          shape={selectedShape}
          tone={selectedTone}
          state={inherited.value === props.value}
          indicator={indicator ?? inherited.indicator}
          showIndicator={showIndicator ?? inherited.showIndicator}
          disabled={props.disabled || inherited.disabled}
        />
      </span>
      {children}
    </Primitive.Item>
  );
}
export type RadioGroupBodyProps = React.ComponentProps<"span">;
export function RadioGroupBody({ className, ...props }: RadioGroupBodyProps) {
  return (
    <span
      data-slot="radio-group-body"
      className={cn("v-radio__body", className)}
      {...props}
    />
  );
}
