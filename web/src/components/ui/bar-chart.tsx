"use client";
import { CartesianChart, type CartesianChartProps } from "@/lib/cojeev/chart-cartesian";
export type BarChartProps = CartesianChartProps & { variant?: "grouped" | "stacked" | "horizontal" };
export function BarChart({ variant = "grouped", caption = "Bar chart", ...props }: BarChartProps) { return <CartesianChart {...props} caption={caption} kind="bar" variant={variant} />; }

