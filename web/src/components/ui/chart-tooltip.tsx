"use client";

import * as React from "react";
import { AnimatePresence, motion } from "motion/react";
import { Card } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import {
  motionTokens,
  useChoreography,
} from "@/lib/cojeev-motion/choreography";
import {
  chartColor,
  tooltipPosition,
  type ChartColor,
} from "@/lib/cojeev/chart-geometry";

export type ChartTooltipItem = {
  label: string;
  value: number | null;
  color?: ChartColor;
};
export type ChartTooltipProps = {
  id?: string;
  active?: { label: string; items: ChartTooltipItem[] } | null;
  position?: { x: number; y: number };
  bounds?: { width: number; height: number };
  valueFormatter?: (value: number) => string;
  className?: string;
  /** Compare original series, show their known subtotal, or rank them by value. */
  presentation?: "compare" | "summary" | "ranked";
};

/** A controlled tooltip shared by every chart; coordinates are local to its plot. */
export function ChartTooltip({
  id,
  active,
  position = { x: 0, y: 0 },
  bounds = { width: 320, height: 280 },
  valueFormatter = (value) => value.toLocaleString(),
  className,
  presentation = "compare",
}: ChartTooltipProps) {
  const { quiet, transition } = useChoreography();
  const ref = React.useRef<HTMLDivElement>(null);
  const [size, setSize] = React.useState({ width: 220, height: 100 });
  React.useLayoutEffect(() => {
    const node = ref.current;
    if (!node) return;
    const measure = () =>
      setSize({ width: node.offsetWidth, height: node.offsetHeight });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, [active?.label, active?.items.length]);
  const target = tooltipPosition(
    position.x,
    position.y,
    bounds.width,
    bounds.height,
    Math.min(size.width, bounds.width - 16),
    size.height,
  );
  const rows = (active?.items ?? []).map((item, index) => ({ ...item, index }));
  if (presentation === "ranked")
    rows.sort((a, b) =>
      a.value === null
        ? b.value === null
          ? 0
          : 1
        : b.value === null
          ? -1
          : b.value - a.value,
    );
  const known = rows.filter((item) => item.value !== null),
    subtotal = known.reduce((sum, item) => sum + (item.value ?? 0), 0);
  // A tooltip is not an interactive scrollport. Keep a bounded visual summary;
  // assistive text retains every value and the chart owns its full data table.
  const rowLimit = Math.max(
    0,
    Math.min(
      6,
      Math.floor(
        (bounds.height - 80 - (presentation === "summary" ? 52 : 0)) / 32,
      ),
    ),
  );
  const visibleRows = rows.slice(0, rowLimit),
    remaining = rows.slice(rowLimit);
  return (
    <AnimatePresence initial={!quiet}>
      {active && (
        <motion.div
          key="tooltip"
          ref={ref}
          id={id}
          role="tooltip"
          data-slot="chart-tooltip"
          data-presentation={presentation}
          className={cn("v-chart-tooltip", className)}
          initial={
            quiet
              ? false
              : { opacity: 1, scale: 0.97, x: target.x, y: target.y }
          }
          animate={{ opacity: 1, scale: 1, x: target.x, y: target.y }}
          exit={{ opacity: 0, scale: quiet ? 1 : 0.98 }}
          transition={{
            ...transition,
            x: {
              type: "tween",
              duration: quiet ? 0 : motionTokens.duration.quick,
              ease: [...motionTokens.ease.enter],
            },
            y: {
              type: "tween",
              duration: quiet ? 0 : motionTokens.duration.quick,
              ease: [...motionTokens.ease.enter],
            },
          }}
          style={{
            width: Math.min(220, Math.max(1, bounds.width - 16)),
            maxHeight: Math.max(1, bounds.height - 16),
          }}
        >
          <Card className="v-chart-tooltip__card" data-morph="none">
            <div className="v-chart-tooltip__label">{active.label}</div>
            {presentation === "summary" && (
              <div className="v-chart-tooltip__total">
                <span>
                  {known.length === rows.length ? "Total" : "Known subtotal"}
                </span>
                <strong>
                  {known.length ? valueFormatter(subtotal) : "Not observed"}
                </strong>
              </div>
            )}
            {visibleRows.map((item, index) => (
              <div
                key={`${item.label}-${item.index}`}
                className="v-chart-tooltip__row"
              >
                {presentation === "ranked" ? (
                  <span
                    className="v-chart-tooltip__rank"
                    aria-label={`Rank ${index + 1}`}
                  >
                    {String(index + 1).padStart(2, "0")}
                  </span>
                ) : null}
                <span
                  className="v-chart-key"
                  style={{ background: chartColor(item.color, item.index) }}
                  aria-hidden="true"
                />
                <span>{item.label}</span>
                <strong>
                  {item.value === null
                    ? "No observation"
                    : valueFormatter(item.value)}
                </strong>
              </div>
            ))}
            {!!remaining.length && (
              <>
                <span className="v-chart-tooltip__empty" aria-hidden="true">
                  +{remaining.length} more series
                </span>
                <span className="sr-only">
                  {remaining
                    .map(
                      (item) =>
                        `${item.label}: ${item.value === null ? "No observation" : valueFormatter(item.value)}`,
                    )
                    .join("; ")}
                </span>
              </>
            )}
            {!rows.length && (
              <span className="v-chart-tooltip__empty">
                No observations for this point.
              </span>
            )}
          </Card>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

