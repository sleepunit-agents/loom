"use client";
import { useMorph } from "@/lib/cojeev-motion/use-morph";
import * as React from "react";
import { cva } from "class-variance-authority";
import { cn } from "@/lib/utils";
import { Button, type ButtonProps } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
const ScrollerContext = React.createContext<{
  detached: boolean;
  jump: () => void;
} | null>(null);
export const messageScrollerVariants = cva(
  "v-scroller relative grid content-start auto-rows-min min-w-0 gap-[var(--s-3)] max-h-[var(--h,360px)] overflow-y-auto overflow-x-hidden p-[var(--s-4)] bg-[var(--card)] rounded-[var(--r-card)] overscroll-contain",
);
export type MessageScrollerProps = React.ComponentProps<"div"> & {
  followThreshold?: number;
  onAtBottomChange?: (atBottom: boolean) => void;
  /** Auto shows the custom rail only when content actually overflows. */
  scrollbarType?: React.ComponentProps<typeof ScrollArea>["type"];
};
export function MessageScroller({
  ref,
  className,
  children,
  followThreshold = 24,
  scrollbarType = "always",
  onAtBottomChange,
  onScroll,
  style,
  ...props
}: MessageScrollerProps) {
  const element = React.useRef<HTMLDivElement>(null);
  const attached = React.useRef(true);
  const [detached, setDetached] = React.useState(false);
  const callback = React.useRef(onAtBottomChange);
  React.useEffect(() => {
    callback.current = onAtBottomChange;
  }, [onAtBottomChange]);
  const mark = React.useCallback(() => {
    const el = element.current;
    if (!el) return;
    const bottom =
      el.scrollHeight - el.scrollTop - el.clientHeight <=
      Math.max(1, Number.isFinite(followThreshold) ? followThreshold : 24);
    if (attached.current !== bottom) {
      attached.current = bottom;
      setDetached(!bottom);
      callback.current?.(bottom);
    }
  }, [followThreshold]);
  const jump = React.useCallback(() => {
    const el = element.current;
    if (el) {
      // Streaming follows instantly. Smooth CSS scrolling fires intermediate
      // scroll events, which can incorrectly detach a reader already at the end.
      el.scrollTo({ top: el.scrollHeight, behavior: "instant" });
      mark();
    }
  }, [mark]);
  React.useLayoutEffect(() => {
    const el = element.current;
    if (!el) return;
    jump();
    const follow = () => {
      if (attached.current) jump();
    };
    const resize = new ResizeObserver(follow);
    const observe = () => {
      resize.disconnect();
      resize.observe(el);
      for (const child of el.children) resize.observe(child);
      follow();
    };
    const mutation = new MutationObserver(observe);
    mutation.observe(el, {
      childList: true,
      subtree: true,
      characterData: true,
    });
    observe();
    return () => {
      mutation.disconnect();
      resize.disconnect();
    };
  }, [jump]);
  const attach = React.useCallback((node: HTMLDivElement | null) => {
    element.current = node;
    if (typeof ref === "function") return ref(node);
    if (ref) ref.current = node;
  }, [ref]);
  const ownedMorphRef = useMorph<HTMLDivElement>("surfaces", attach);
  return (
    <ScrollerContext.Provider value={{ detached, jump }}>
      <ScrollArea className="v-message-scroll-root" style={style} type={scrollbarType} viewportProps={{
        ref:ownedMorphRef,
        "data-slot":"message-scroller",
        "data-part":"viewport",
        "data-scroller":"",
        "data-state":detached ? "detached" : "attached",
        tabIndex:0,
        className:cn(messageScrollerVariants(),detached && "-detached",className),
        onScroll(event) {mark();onScroll?.(event)},
        ...props,
      } as React.ComponentProps<typeof ScrollArea>["viewportProps"]}>
        <div className="v-scroller__content">{children}</div>
      </ScrollArea>
    </ScrollerContext.Provider>
  );
}
export type MessageScrollerJumpProps = ButtonProps;
export function MessageScrollerJump({
  className,
  children,
  onClick,
  ...props
}: MessageScrollerJumpProps) {
  const scroller = React.useContext(ScrollerContext);
  return (
    <Button
      data-slot="message-scroller-jump"
      data-part="trigger"
      className={cn(
        "v-scroller__jump sticky bottom-0 justify-self-center",
        className,
      )}
      variant="secondary"
      size="sm"
      hidden={!scroller?.detached}
      onClick={(event) => {
        onClick?.(event);
        if (!event.defaultPrevented) scroller?.jump();
      }}
      {...props}
    >
      {children ?? "Jump to latest"}
    </Button>
  );
}
