"use client";
import { useMorph } from "@/lib/cojeev-motion/use-morph";
import * as React from "react";
import { AnimatePresence, motion, useIsPresent } from "motion/react";
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
  CardFooter,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from "@/components/ui/select";
import { MotionPresence, MotionSurface } from "@/components/ui/presence";
import { ChartTooltip } from "@/components/ui/chart-tooltip";
import { useChoreography } from "@/lib/cojeev-motion/choreography";
import {
  chartColor,
  chartColors,
  distinctColors,
  clamp,
  finiteValue,
  type ChartPoint,
  type ChartSeries,
  type ChartColor,
} from "@/lib/cojeev/chart-geometry";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
  TableCaption,
  TableContainer,
} from "@/components/ui/table";
export type {
  ChartPoint,
  ChartSeries,
  ChartSlice,
  ChartColor,
} from "@/lib/cojeev/chart-geometry";

export type ChartDatasetSelectProps = {
  value: string;
  onValueChange: (value: string) => void;
  options: readonly { value: string; label: string }[];
  label?: string;
  disabled?: boolean;
};
/** The same accessible, custom-scrolling selector ships with the chart family. */
export function ChartDatasetSelect({
  value,
  onValueChange,
  options,
  label = "Sample data",
  disabled,
}: ChartDatasetSelectProps) {
  const id = React.useId();
  return (
    <div className="v-chart-control">
      <Label id={`${id}-label`} htmlFor={id}>
        {label}
      </Label>
      <Select value={value} onValueChange={onValueChange} disabled={disabled}>
        <SelectTrigger id={id} aria-labelledby={`${id}-label`}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {options.map((option) => (
            <SelectItem key={option.value} value={option.value}>
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

export type ChartDatum = {
  label: string;
  value: number | null;
  note?: string;
  variant?: "default" | "ink" | "dash" | "pink";
};
export type ChartContainerProps = React.ComponentProps<"figure">;
export function ChartContainer({ className, ...props }: ChartContainerProps) {
  return (
    <figure
      data-slot="chart-container"
      className={cn("min-w-0", className)}
      {...props}
    />
  );
}
export const chartVariants = cva(
  "v-bars flex items-end gap-[var(--s-2)] h-[var(--h,88px)]",
);
export type ChartProps = React.ComponentProps<"div"> & {
  data?: ChartDatum[];
  max?: number;
  showTable?: boolean;
  caption?: string;
};
export function Chart({
  data,
  max,
  showTable = true,
  caption = "Chart data",
  className,
  children,
  ...props
}: ChartProps) {
  const ceiling =
    max ??
    Math.max(
      1,
      ...(data ?? []).map((d) => (Number.isFinite(d.value) ? d.value! : 0)),
    );
  return (
    <>
      <div
        data-slot="chart"
        data-part="root"
        className={cn(chartVariants(), className)}
        aria-label={data ? caption : undefined}
        role={data ? "img" : undefined}
        {...props}
      >
        {children ??
          data?.map((item, index) => (
            <ChartBar
              key={index}
              value={item.value ?? 0}
              max={ceiling}
              variant={item.value === null ? "dash" : item.variant}
              aria-label={`${item.label}: ${item.value ?? "missing"}`}
              title={`${item.label}: ${item.value ?? "missing"}`}
            />
          ))}
      </div>
      {data && showTable && <ChartDataTable data={data} caption={caption} />}
    </>
  );
}
export const chartBarVariants = cva(
  "flex-1 max-w-[16px] rounded-[var(--r-pill)] bg-[var(--wm,var(--v-beige))] h-[var(--p)] min-h-[8px]",
  {
    variants: {
      variant: {
        default: "",
        ink: "-ink bg-[var(--v-ink)]",
        dash: "-dash bg-transparent border border-dashed border-[var(--v-ink)]",
        pink: "-pink bg-[var(--v-pink)]",
      },
    },
    defaultVariants: { variant: "default" },
  },
);
export type ChartBarProps = React.ComponentProps<"i"> &
  VariantProps<typeof chartBarVariants> & { value: number; max?: number };
export function ChartBar({
  value,
  max = 100,
  variant,
  className,
  style,
  ...props
}: ChartBarProps) {
  return (
    <i
      data-slot="chart-bar"
      data-part="item"
      data-missing={variant === "dash" ? "" : undefined}
      className={cn(chartBarVariants({ variant }), className)}
      style={
        {
          "--p": `${Math.max(0, Math.min(100, max > 0 && Number.isFinite(value) && Number.isFinite(max) ? (value / max) * 100 : 0))}%`,
          ...style,
        } as React.CSSProperties
      }
      {...props}
    />
  );
}
export type ChartAxisProps = React.ComponentProps<"div">;
export function ChartAxis({ className, ...props }: ChartAxisProps) {
  return (
    <div
      data-slot="chart-axis"
      data-part="label"
      className={cn(
        "v-axis flex justify-between text-[length:var(--fs-caps)] text-[color:var(--muted-foreground)] mt-[var(--s-2)] tabular-nums",
        className,
      )}
      {...props}
    />
  );
}
export type ChartLineProps = React.ComponentProps<"svg"> & {
  data?: ChartDatum[];
  showTable?: boolean;
  caption?: string;
};
export function ChartLine({
  className,
  data,
  showTable = true,
  caption = "Line chart data",
  children,
  ...props
}: ChartLineProps) {
  const titleId = React.useId();
  return (
    <>
      <svg
        data-slot="chart-line"
        data-part="root"
        className={cn("v-line w-full h-[var(--h,120px)]", className)}
        viewBox="0 0 300 100"
        role="img"
        aria-labelledby={titleId}
        {...props}
      >
        <title id={titleId}>{caption}</title>
        {children}
      </svg>
      {data && showTable && <ChartDataTable caption={caption} data={data} />}
    </>
  );
}
export type ChartLinePathProps = React.ComponentProps<"path"> & {
  variant?: "hist" | "next" | "cross";
};
export function ChartLinePath({
  variant = "hist",
  className,
  ...props
}: ChartLinePathProps) {
  return (
    <path
      data-slot="chart-line-path"
      className={cn(`-${variant}`, className)}
      {...props}
    />
  );
}
export type ChartRingSegment = {
  label: string;
  value: number;
  color: "yellow" | "pink" | "blue" | "olive" | "ink" | "beige";
};
export type ChartRingProps = React.ComponentProps<"div"> & {
  segments: ChartRingSegment[];
  strokeWidth?: number;
  gap?: number;
  unit?: string;
  showTable?: boolean;
  draw?: boolean;
  caption?: string;
};
export function ChartRing({
  ref: externalMorphRef,
  segments,
  strokeWidth = 12,
  gap = 6,
  unit = "",
  showTable = true,
  draw,
  className,
  children,
  caption = "Ring chart",
  ...props
}: ChartRingProps) {
  const clean = segments.filter((s) => Number.isFinite(s.value) && s.value > 0);
  const total = clean.reduce((sum, s) => sum + s.value, 0);
  const width = Math.max(
    1,
    Math.min(49, Number.isFinite(strokeWidth) ? strokeWidth : 12),
  );
  const r = 50 - width / 2;
  const circumference = 2 * Math.PI * r;
  const arcs = clean.map((segment, index) => ({
    segment,
    offset:
      (clean.slice(0, index).reduce((sum, s) => sum + s.value, 0) / total) *
      circumference,
    length: Math.max(
      0,
      (circumference * segment.value) / total -
        (Number.isFinite(gap) ? Math.max(0, gap) : 6),
    ),
  }));
  const ownedMorphRef = useMorph<HTMLDivElement>("surfaces", externalMorphRef);
  return (
    <>
      <div
        ref={ownedMorphRef}
        data-slot="chart-ring"
        data-part="root"
        data-empty={total ? undefined : ""}
        data-segs={clean.map((s) => `${s.color}:${s.value}`).join(",")}
        data-sw={width}
        className={cn(
          "v-ring relative grid place-items-center w-[min(100%,var(--sz,240px))] max-w-full h-auto aspect-square min-w-0 shrink",
          draw && "-draw",
          className,
        )}
        {...props}
      >
        {total > 0 ? (
          <svg
            viewBox="0 0 100 100"
            role="img"
            aria-label={`${caption} — total ${total.toFixed(total % 1 ? 1 : 0)} ${unit}${showTable ? "; a data table follows" : `; ${clean.map((segment) => `${segment.label}: ${segment.value} ${unit}`).join(", ")}`}`}
          >
            <circle
              className="-track"
              cx="50"
              cy="50"
              r={r}
              style={{ "--sw": width } as React.CSSProperties}
            />
            {arcs.map(({ segment, offset, length }, index) => (
              <circle
                key={index}
                cx="50"
                cy="50"
                r={r}
                stroke={`var(--v-${segment.color})`}
                style={{ "--sw": width } as React.CSSProperties}
                strokeDasharray={`${length} ${circumference}`}
                strokeDashoffset={-offset}
              />
            ))}
          </svg>
        ) : (
          <p className="v-meta">No data to plot.</p>
        )}
        {children ?? (
          <ChartRingCenter>
            <span data-total="" className="v-hero">
              {total ? total.toFixed(total % 1 ? 1 : 0) : "—"}
            </span>
            {unit && <span className="v-caption">{unit}</span>}
          </ChartRingCenter>
        )}
      </div>
      {showTable && (
        <ChartDataTable
          caption={`${caption} — ${unit}`}
          data={clean.map((s) => ({
            label: s.label,
            value: s.value,
            note: `${Math.round((s.value / total) * 100)}%`,
          }))}
        />
      )}
    </>
  );
}
export type ChartRingCenterProps = React.ComponentProps<"div">;
export function ChartRingCenter({ className, ...props }: ChartRingCenterProps) {
  return (
    <div
      data-slot="chart-ring-center"
      className={cn(
        "v-ring__c absolute grid justify-items-center gap-[2px]",
        className,
      )}
      {...props}
    />
  );
}
export type ChartRankedRowProps = React.ComponentProps<"div">;
export function ChartRankedRow({ className, ...props }: ChartRankedRowProps) {
  return (
    <div
      data-slot="chart-ranked-row"
      className={cn(
        "v-prow flex items-center gap-[var(--s-4)] min-h-[var(--utility)]",
        className,
      )}
      {...props}
    />
  );
}
export type ChartRankedLabelProps = React.ComponentProps<"div">;
export function ChartRankedLabel({
  className,
  ...props
}: ChartRankedLabelProps) {
  return (
    <div
      data-slot="chart-ranked-label"
      className={cn("v-prow__lab flex-1 min-w-0 grid gap-[var(--s-2)]", className)}
      {...props}
    />
  );
}
export type ChartRankedValueProps = React.ComponentProps<"span">;
export function ChartRankedValue({
  className,
  ...props
}: ChartRankedValueProps) {
  return (
    <span
      data-slot="chart-ranked-value"
      className={cn(
        "v-prow__val text-[length:var(--fs-title)] font-bold tabular-nums whitespace-nowrap",
        className,
      )}
      {...props}
    />
  );
}
export type ChartDataTableProps = {
  data: ChartDatum[];
  caption?: string;
  visuallyHidden?: boolean;
};
export function ChartDataTable({
  data,
  caption = "Chart data",
  visuallyHidden = true,
}: ChartDataTableProps) {
  const hasNotes = data.some((item) => item.note || item.value === null);
  const content = (
    <Table
      data-slot="chart-data-table"
      className={visuallyHidden ? "v-sr" : undefined}
    >
      <TableCaption>{caption}</TableCaption>
      <TableHeader>
        <TableRow>
          <TableHead>Label</TableHead>
          <TableHead numeric>Value</TableHead>
          {hasNotes && <TableHead>Note</TableHead>}
        </TableRow>
      </TableHeader>
      <TableBody>
        {data.map((item, index) => (
          <TableRow key={index}>
            <TableCell>{item.label}</TableCell>
            <TableCell numeric>{item.value ?? "—"}</TableCell>
            {hasNotes && (
              <TableCell>
                {item.note ?? (item.value === null ? "Not observed" : "")}
              </TableCell>
            )}
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
  return visuallyHidden ? (
    content
  ) : (
    <TableContainer aria-label={`${caption} values`} className="v-chart-values">
      {content}
    </TableContainer>
  );
}

export type ChartFrameProps = {
  data: ChartPoint[];
  series: ChartSeries[];
  caption?: string;
  description?: string;
  showTable?: boolean;
  tableVisible?: boolean;
  valueFormatter?: (value: number) => string;
  className?: string;
  legendMode?: "series" | "points";
  interaction?: "x" | "columns" | "y" | "radar" | "shape";
  emptyMessage?: string;
  /** Independent of the data's line/bar/shape geometry. */
  appearance?: "analysis" | "brief" | "ledger";
  /** An explicit source measure; it does not change when a legend series is hidden. */
  summary?: { label: string; value: React.ReactNode; detail?: string };
  /** loom: the plot's height in CSS px (300 by default). */
  plotHeight?: number;
  children: (plot: ChartPlotState) => React.ReactNode;
};
export type ChartPlotState = {
  width: number;
  height: number;
  left: number;
  right: number;
  top: number;
  bottom: number;
  data: ChartPoint[];
  series: ChartSeries[];
  active: number | null;
  id: string;
  inspect: (index: number) => void;
};

function ChartPlotSvg(props: React.ComponentProps<typeof motion.svg>) {
  const present = useIsPresent();
  return (
    <motion.svg
      {...props}
      tabIndex={present ? props.tabIndex : -1}
      aria-hidden={present ? props["aria-hidden"] : true}
      style={{
        ...props.style,
        pointerEvents: present ? props.style?.pointerEvents : "none",
      }}
    />
  );
}

/** Shared composition, focus model, legend and semantic fallback for the chart suite. */
export function ChartFrame({
  data,
  series,
  caption = "Chart",
  description,
  showTable = true,
  tableVisible = false,
  valueFormatter = (value) => value.toLocaleString(),
  className,
  legendMode = "series",
  interaction = "x",
  emptyMessage = "No observations to plot.",
  appearance,
  summary,
  plotHeight,
  children,
}: ChartFrameProps) {
  const { quiet, transition } = useChoreography();
  const id = React.useId().replace(/:/g, "");
  const plotRef = React.useRef<HTMLDivElement>(null);
  const [width, setWidth] = React.useState(640);
  const [active, setActive] = React.useState<number | null>(null);
  const [keyboardMode, setKeyboardMode] = React.useState(false);
  const [pointer, setPointer] = React.useState({ x: 80, y: 60 });
  const [hidden, setHidden] = React.useState<string[]>([]);
  const [tableState, setTableState] = React.useState({
    prop: tableVisible,
    visible: tableVisible,
  });
  if (tableState.prop !== tableVisible)
    setTableState({ prop: tableVisible, visible: tableVisible });
  const table =
    tableState.prop === tableVisible ? tableState.visible : tableVisible;
  const tableShown = showTable && (appearance === "ledger" || table);
  const measure = summary ?? {
    label: "Source observations",
    value: data.length,
    detail: "Includes rows with missing values.",
  };
  // loom: no two series share a colour (chart-geometry distinctColors).
  const resolved = distinctColors(series);
  const legend =
    legendMode === "points"
      ? data.map((point, index) => ({
          key: `point-${index}`,
          label: point.label,
          color:
            (point.color as ChartColor | undefined) ??
            chartColors[index % chartColors.length],
        }))
      : resolved;
  const visibleSeries =
    legendMode === "series"
      ? resolved.filter((item) => !hidden.includes(item.key))
      : resolved;
  const visibleData: ChartPoint[] =
    legendMode === "points"
      ? data
          .map((point, index) => ({ ...point, color: legend[index].color }))
          .filter((_, index) => !hidden.includes(`point-${index}`))
      : data;
  // loom: shorter where asked (a chart in a page's side column).
  const height = plotHeight ?? 300;
  const left = interaction === "y" ? Math.min(100, width * 0.27) : 42,
    right = width - 18,
    top = 24,
    bottom = height - 42;
  const current = active !== null ? visibleData[active] : undefined;
  const hasValues =
    visibleData.length > 0 &&
    visibleSeries.some((item) =>
      visibleData.some((point) => finiteValue(point[item.key]) !== null),
    );
  React.useLayoutEffect(() => {
    const node = plotRef.current;
    if (!node) return;
    const measure = () => {
      // Hidden preview panels report zero. Keep the last useful viewBox until
      // reveal, and leave room for both axis gutters in very narrow containers.
      if (node.clientWidth > 0) setWidth(Math.max(64, node.clientWidth));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  const inspect = (index: number) =>
    setActive(Math.round(clamp(index, 0, visibleData.length - 1)));
  const tooltip = current
    ? {
        label: current.label,
        items: visibleSeries.map((item) => ({
          label: item.label,
          value: finiteValue(current[item.key]),
          color:
            legendMode === "points"
              ? (current.color as ChartColor)
              : item.color,
        })),
      }
    : null;
  const tableData = data.flatMap((point) =>
    resolved.map((item) => ({
      label:
        resolved.length === 1 ? point.label : `${point.label} · ${item.label}`,
      value: finiteValue(point[item.key]),
    })),
  );
  const keyboard = (event: React.KeyboardEvent<SVGSVGElement>) => {
    if (event.key === "Escape") {
      setActive(null);
      return;
    }
    if (
      ![
        "ArrowRight",
        "ArrowLeft",
        "ArrowUp",
        "ArrowDown",
        "Home",
        "End",
      ].includes(event.key)
    )
      return;
    event.preventDefault();
    const next =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? visibleData.length - 1
          : (active ?? 0) +
            (["ArrowLeft", "ArrowUp"].includes(event.key) ? -1 : 1);
    const index = Math.round(clamp(next, 0, visibleData.length - 1));
    inspect(index);
    setPointer({
      x:
        left +
        ((right - left) * (index + 0.5)) / Math.max(1, visibleData.length),
      y: height * 0.36,
    });
  };
  return (
    <ChartContainer
      className={cn("v-chart-frame", className)}
      data-appearance={appearance}
      data-table-visible={tableShown}
      aria-labelledby={`${id}-title`}
      aria-describedby={description ? `${id}-description` : undefined}
    >
      <AnimatePresence initial={!quiet}>
        <motion.div
          key="chart"
          initial={quiet ? false : { opacity: 0, y: 6 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: quiet ? 0 : -4 }}
          transition={transition}
        >
          <Card>
            <CardHeader className="v-chart-frame__header">
              <CardTitle id={`${id}-title`}>{caption}</CardTitle>
              {description && (
                <CardDescription id={`${id}-description`}>
                  {description}
                </CardDescription>
              )}
            </CardHeader>
            {appearance === "brief" && (
              <div className="v-chart-summary">
                <span>{measure.label}</span>
                <strong>{measure.value}</strong>
                {measure.detail && <p>{measure.detail}</p>}
                <span className="v-chart-summary__scope">
                  Source measure · not filtered by the legend
                </span>
              </div>
            )}
            <CardContent className="v-chart-frame__content">
              <div
                className="v-chart-legend"
                role="group"
                aria-label={`${caption} visible data`}
              >
                <MotionPresence>
                  {legend.map((item) => (
                    <MotionSurface key={item.key} asChild preset="fade">
                      <Button
                        variant="ghost"
                        size="sm"
                        aria-pressed={!hidden.includes(item.key)}
                        className="v-chart-legend__item"
                        onClick={() => {
                          setHidden((items) =>
                            items.includes(item.key)
                              ? items.filter((key) => key !== item.key)
                              : [...items, item.key],
                          );
                          setActive(null);
                        }}
                      >
                        <span
                          className="v-chart-key"
                          style={{ background: chartColor(item.color) }}
                          aria-hidden="true"
                        />
                        {item.label}
                      </Button>
                    </MotionSurface>
                  ))}
                </MotionPresence>
              </div>
              <div
                ref={plotRef}
                className="v-chart-plot"
                data-slot="chart-plot"
                style={{ height }}
                onPointerLeave={() => setActive(null)}
              >
                <AnimatePresence initial={false} mode="wait">
                  {hasValues ? (
                    <ChartPlotSvg
                      key="plot"
                      viewBox={`0 0 ${width} ${height}`}
                      role="group"
                      tabIndex={0}
                      aria-label={`${caption}. Use arrow keys to inspect observations; Escape dismisses the tooltip.`}
                      aria-describedby={current ? `${id}-tooltip` : undefined}
                      className="v-chart-svg"
                      data-slot="chart-svg"
                      initial={quiet ? false : { opacity: 0 }}
                      animate={{ opacity: 1 }}
                      exit={{ opacity: 0 }}
                      transition={transition}
                      onFocus={() => {
                        setKeyboardMode(true);
                        if (active === null) {
                          inspect(0);
                          setPointer({ x: left, y: top });
                        }
                      }}
                      onBlur={() => {
                        setKeyboardMode(false);
                        setActive(null);
                      }}
                      onKeyDown={keyboard}
                      onPointerMove={(event) => {
                        setKeyboardMode(false);
                        const box = event.currentTarget.getBoundingClientRect();
                        const x =
                            ((event.clientX - box.left) * width) / box.width,
                          y = ((event.clientY - box.top) * height) / box.height;
                        setPointer({ x, y });
                        if (interaction === "x")
                          inspect(
                            Math.round(
                              ((x - left) / (right - left)) *
                                Math.max(0, visibleData.length - 1),
                            ),
                          );
                        if (interaction === "columns")
                          inspect(
                            Math.floor(
                              ((x - left) / (right - left)) *
                                visibleData.length,
                            ),
                          );
                        if (interaction === "y")
                          inspect(
                            Math.floor(
                              ((y - top) / (bottom - top)) * visibleData.length,
                            ),
                          );
                        if (interaction === "radar") {
                          const angle =
                            (Math.atan2(y - height / 2, x - width / 2) +
                              Math.PI / 2 +
                              Math.PI * 2) %
                            (Math.PI * 2);
                          inspect(
                            Math.round(
                              (angle / (Math.PI * 2)) * visibleData.length,
                            ) % visibleData.length,
                          );
                        }
                      }}
                    >
                      {children({
                        width,
                        height,
                        left,
                        right,
                        top,
                        bottom,
                        data: visibleData,
                        series: visibleSeries,
                        active,
                        id,
                        inspect,
                      })}
                    </ChartPlotSvg>
                  ) : (
                    <motion.div
                      key="empty"
                      className="v-chart-empty"
                      initial={{ opacity: 0 }}
                      animate={{ opacity: 1 }}
                      exit={{ opacity: 0 }}
                      transition={transition}
                    >
                      <span className="v-chart-key" aria-hidden="true" />
                      {hidden.length
                        ? "Choose a legend item to show its data."
                        : emptyMessage}
                    </motion.div>
                  )}
                </AnimatePresence>
                <span
                  className="v-sr"
                  role="status"
                  aria-live="polite"
                  aria-atomic="true"
                >
                  {keyboardMode && current
                    ? `${current.label}. ${visibleSeries.map((item) => `${item.label}: ${finiteValue(current[item.key]) === null ? "No observation" : valueFormatter(finiteValue(current[item.key])!)}`).join(". ")}`
                    : ""}
                </span>
                <ChartTooltip
                  id={`${id}-tooltip`}
                  active={tooltip}
                  position={pointer}
                  bounds={{ width, height }}
                  valueFormatter={valueFormatter}
                />
              </div>
            </CardContent>
            <CardFooter className="v-chart-frame__footer">
              <span>Hover to explore · Arrow keys to inspect</span>
              {showTable && appearance !== "ledger" && (
                <Button
                  variant="ghost"
                  size="sm"
                  aria-expanded={tableShown}
                  aria-controls={`${id}-data`}
                  onClick={() =>
                    setTableState((value) => ({
                      ...value,
                      visible: !value.visible,
                    }))
                  }
                >
                  {tableShown ? "Hide data" : "Show data"}
                </Button>
              )}
            </CardFooter>
            {showTable && (
              <div
                id={`${id}-data`}
                className={tableShown ? "v-chart-frame__table" : undefined}
              >
                <ChartDataTable
                  data={tableData}
                  caption={caption}
                  visuallyHidden={!tableShown}
                />
              </div>
            )}
          </Card>
        </motion.div>
      </AnimatePresence>
    </ChartContainer>
  );
}

