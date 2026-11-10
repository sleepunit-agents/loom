"use client";

import { AnimatePresence, m } from "motion/react";
import { ChartFrame, type ChartFrameProps } from "@/components/ui/chart";
import { useChartMotion } from "@/lib/cojeev/use-chart-motion";
import { areaPath, chartColor, chartDomain, finiteValue, linePath, scaleValue, stackChartData, type Curve, type PlotPoint } from "@/lib/cojeev/chart-geometry";

export type CartesianChartProps = Omit<ChartFrameProps, "children" | "legendMode" | "interaction">;
export function CartesianChart({ kind, variant, ...props }: CartesianChartProps & { kind: "area" | "bar" | "line"; variant: string }) {
  const { quiet, transition, geometryTransition } = useChartMotion();
  const stacked = variant === "stacked", horizontal = kind === "bar" && variant === "horizontal";
  const curve: Curve = variant === "smooth" || variant === "step" ? variant : "linear";
  return <ChartFrame {...props} interaction={horizontal ? "y" : kind === "bar" ? "columns" : "x"}>{plot => {
    const { data, series, left, right, top, bottom, active, id } = plot;
    const domain = chartDomain(data, series, stacked);
    const y = (value: number) => scaleValue(value, domain, bottom, top);
    const xValue = (value: number) => scaleValue(value, domain, left, right);
    const x = (index: number) => data.length === 1 ? (left + right) / 2 : left + index / Math.max(1, data.length - 1) * (right - left);
    const ticks = Array.from({ length: 5 }, (_, index) => domain[0] + (domain[1] - domain[0]) * index / 4);
    const stacks = stackChartData(data, series);
    const row = (bottom - top) / Math.max(1, data.length), column = (right - left) / Math.max(1, data.length);
    const labelEvery = Math.max(1, Math.ceil(data.length / Math.max(2, Math.floor((right - left) / 65))));
    const cursor = horizontal ? { x1: left, x2: right, y1: top + row * ((active ?? 0) + .5), y2: top + row * ((active ?? 0) + .5) } : { x1: kind === "bar" ? left + column * ((active ?? 0) + .5) : x(active ?? 0), x2: kind === "bar" ? left + column * ((active ?? 0) + .5) : x(active ?? 0), y1: top, y2: bottom };
    return <>
      <defs><clipPath id={`${id}-plot-clip`}><rect x={left - 5} y={top - 5} width={right - left + 10} height={bottom - top + 10} /></clipPath>
        {series.map((item, index) => <linearGradient key={item.key} id={`${id}-fill-${index}`} x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor={chartColor(item.color)} stopOpacity=".58" /><stop offset="100%" stopColor={chartColor(item.color)} stopOpacity=".05" /></linearGradient>)}
      </defs>
      <g className="v-chart-grid" aria-hidden="true">{ticks.map((tick, index) => horizontal ? <g key={index}><line x1={xValue(tick)} x2={xValue(tick)} y1={top} y2={bottom} /><text x={xValue(tick)} y={bottom + 24} textAnchor="middle">{Number(tick.toPrecision(2)).toLocaleString()}</text></g> : <g key={index}><line x1={left} x2={right} y1={y(tick)} y2={y(tick)} /><text x={left - 10} y={y(tick) + 4} textAnchor="end">{Number(tick.toPrecision(2)).toLocaleString()}</text></g>)}</g>
      <g className="v-chart-axis" aria-hidden="true">{data.map((point, index) => horizontal ? <text key={index} x={left - 10} y={top + row * (index + .5) + 4} textAnchor="end">{point.label.length > 12 ? `${point.label.slice(0, 11)}…` : point.label}</text> : index % labelEvery === 0 || index === data.length - 1 ? <text key={index} x={kind === "bar" ? left + column * (index + .5) : x(index)} y={bottom + 26} textAnchor={kind === "bar" ? "middle" : index === 0 ? "start" : index === data.length - 1 ? "end" : "middle"}>{point.label.length > 12 ? `${point.label.slice(0, 11)}…` : point.label}</text> : null)}</g>
      <g clipPath={`url(#${id}-plot-clip)`}>
        <AnimatePresence initial={false}>
          {active !== null && <m.line key="cursor" className="v-chart-crosshair" {...cursor} initial={quiet ? false : { ...cursor, opacity: 0 }} animate={{ ...cursor, opacity: 1 }} exit={{ opacity: 0 }} transition={transition} />}
        </AnimatePresence>
        <AnimatePresence initial={!quiet}>
          {series.map((item, seriesIndex) => {
            const color = chartColor(item.color, seriesIndex);
            const points: (PlotPoint | null)[] = data.map((point, index) => {
              const value = finiteValue(point[item.key]); if (value === null) return null;
              return { x: x(index), y: y(stacked ? stacks[index][seriesIndex]!.end : value) };
            });
            const bottoms = data.map((point, index) => finiteValue(point[item.key]) === null ? null : ({ x: x(index), y: y(stacked ? stacks[index][seriesIndex]!.start : 0) }));
            const path = linePath(points, curve), fill = areaPath(points, bottoms, curve);
            return <m.g key={item.key} initial={quiet ? false : { opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={transition}>
              {kind === "bar" ? <AnimatePresence initial={!quiet}>{data.map((point, index) => {
                const value = finiteValue(point[item.key]); if (value === null) return null;
                const start = stacked ? stacks[index][seriesIndex]!.start : 0, end = stacked ? stacks[index][seriesIndex]!.end : value;
                const band = (horizontal ? row : column) * .72;
                const thickness = stacked ? band : band / Math.max(1, series.length);
                const offset = stacked ? 0 : seriesIndex * thickness;
                const geometry = horizontal ? { x: Math.min(xValue(start), xValue(end)), y: top + row * index + row * .14 + offset, width: Math.abs(xValue(end) - xValue(start)), height: Math.max(1, thickness - (stacked ? 0 : 3)) } : { x: left + column * index + column * .14 + offset, y: Math.min(y(start), y(end)), width: Math.max(1, thickness - (stacked ? 0 : 3)), height: Math.abs(y(end) - y(start)) };
                return <m.rect key={`${point.label}-${index}`} data-slot="chart-mark" fill={color} rx={stacked ? 2 : 5}
                  initial={quiet ? false : horizontal ? { ...geometry, width: 0, opacity: 0 } : { ...geometry, y: y(start), height: 0, opacity: 0 }} animate={{ ...geometry, opacity: active === null || active === index ? 1 : .48 }} exit={{ opacity: 0 }} transition={{ ...transition, width: geometryTransition, height: geometryTransition }}
                  onPointerEnter={() => plot.inspect(index)} />;
              })}</AnimatePresence> : <>
                <AnimatePresence initial={!quiet}>
                  {kind === "area" && fill && <m.path key="area" data-slot="chart-mark" d={fill} fill={`url(#${id}-fill-${seriesIndex})`} initial={quiet ? false : { d: fill, opacity: 0 }} animate={{ d: fill, opacity: 1 }} exit={{ opacity: 0 }} transition={transition} />}
                  {path && <m.path key="line" data-slot="chart-mark" d={path} fill="none" stroke={color} strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" initial={quiet ? false : { d: path, pathLength: 0 }} animate={{ d: path, pathLength: 1 }} exit={{ pathLength: 0, opacity: 0 }} transition={{ ...transition, pathLength: geometryTransition }} />}
                </AnimatePresence>
                <AnimatePresence initial={!quiet}>{points.map((point, index) => point && (data.length === 1 || active === index) ? <m.circle key={`${data[index].label}-${index}`} cx={point.x} cy={point.y} r={active === index ? 5 : 3} fill={color} stroke="var(--card)" strokeWidth="2" initial={quiet ? false : { cx: point.x, cy: point.y, scale: 0, opacity: 0 }} animate={{ cx: point.x, cy: point.y, scale: 1, opacity: 1 }} exit={{ scale: 0, opacity: 0 }} transition={transition} /> : null)}</AnimatePresence>
              </>}
            </m.g>;
          })}
        </AnimatePresence>
      </g>
    </>;
  }}</ChartFrame>;
}

