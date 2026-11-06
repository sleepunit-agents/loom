"use client";

import * as React from "react";
import { motion, useInView } from "motion/react";
import { cn } from "@/lib/utils";
import { useChoreography } from "@/lib/cojeev-motion/choreography";

export type AgentStatus = "idle" | "thinking" | "working" | "needs-input" | "complete" | "error";
export type AgentStateProps = Omit<React.ComponentProps<"div">, "children"> & {
  status?: AgentStatus;
  size?: "sm" | "md" | "lg";
  label?: string;
  description?: string;
};

const stateLabels: Record<AgentStatus, string> = {
  idle: "Ready when you are", thinking: "Thinking", working: "Working",
  "needs-input": "Your decision", complete: "Complete", error: "Needs attention",
};

// Equal cubic topology lets Motion interpolate a folded fluid silhouette without
// a second animation clock. Each state remains recognizable when motion is off.
const silhouettes: Record<AgentStatus, string> = {
  idle: "M90 24C116 17 151 32 153 60C157 84 139 96 124 116C111 135 81 141 59 126C34 113 22 85 32 61C43 36 65 31 90 24Z",
  thinking: "M90 18C120 27 132 19 148 51C163 78 141 92 135 116C127 146 94 137 68 129C40 123 18 98 30 70C40 48 66 7 90 18Z",
  working: "M90 17C114 11 156 41 151 65C146 85 165 110 134 123C106 140 85 121 61 131C34 140 17 94 30 71C44 47 68 25 90 17Z",
  "needs-input": "M90 27C121 20 147 29 145 61C143 82 162 111 134 125C108 138 91 114 65 127C35 140 28 101 31 76C34 48 62 33 90 27Z",
  complete: "M90 24C118 24 145 36 150 63C155 91 134 116 112 125C87 137 63 128 47 113C29 95 25 69 40 47C53 28 66 24 90 24Z",
  error: "M90 30C113 7 131 35 147 54C167 77 135 93 139 117C142 142 105 128 83 132C55 139 18 117 28 89C37 65 60 40 90 30Z",
};

export function AgentState({ status = "idle", size = "md", label, description, className, ...props }: AgentStateProps) {
  const id = React.useId().replace(/:/g, "");
  const ref = React.useRef<HTMLDivElement>(null);
  const inView = useInView(ref, { margin: "40px" });
  const { quiet, transition } = useChoreography();
  const [visible, setVisible] = React.useState(true);
  React.useEffect(() => {
    const update = () => setVisible(document.visibilityState !== "hidden");
    update();
    document.addEventListener("visibilitychange", update);
    return () => document.removeEventListener("visibilitychange", update);
  }, []);
  const active = !quiet && inView && visible && (status === "thinking" || status === "working");
  const contour = silhouettes[status];
  const alternate = silhouettes[status === "thinking" ? "working" : "thinking"];
  const pathAnimation = active ? { d: [contour, alternate, contour] } : { d: contour };
  const fieldTransition = active ? { duration: status === "working" ? 5 : 7, repeat: Infinity, ease: "easeInOut" as const } : transition;
  return (
    <div ref={ref} data-slot="agent-state" data-status={status} data-size={size} data-animated={active || undefined} className={cn("v-agent-state", className)} role="status" aria-live="polite" aria-atomic="true" {...props}>
      <svg className="v-agent-state__field" viewBox="0 0 180 160" fill="none" aria-hidden="true" focusable="false">
        <defs>
          <radialGradient id={`${id}-body`} cx=".3" cy=".2" r=".85">
            <stop stopColor="var(--agent-light)" />
            <stop offset=".5" stopColor="var(--agent-base)" />
            <stop offset="1" stopColor="var(--agent-deep)" />
          </radialGradient>
          <radialGradient id={`${id}-fold`} cx=".65" cy=".22" r=".8">
            <stop stopColor="var(--cream-fixed)" stopOpacity=".84" />
            <stop offset=".4" stopColor="var(--agent-light)" stopOpacity=".7" />
            <stop offset="1" stopColor="var(--agent-deep)" stopOpacity=".2" />
          </radialGradient>
          <linearGradient id={`${id}-rim`} x1="30" y1="30" x2="138" y2="134" gradientUnits="userSpaceOnUse">
            <stop stopColor="var(--cream-fixed)" stopOpacity=".92" />
            <stop offset=".48" stopColor="var(--agent-light)" stopOpacity=".2" />
            <stop offset="1" stopColor="var(--agent-deep)" stopOpacity=".8" />
          </linearGradient>
          <clipPath id={`${id}-clip`}>
            <motion.path initial={false} d={contour} animate={pathAnimation} transition={fieldTransition} />
          </clipPath>
        </defs>
        <ellipse cx="92" cy="139" rx="43" ry="5" fill="var(--agent-deep)" opacity=".12" />
        <motion.path initial={false} d={contour} animate={pathAnimation} transition={fieldTransition} fill={`url(#${id}-body)`} />
        <g clipPath={`url(#${id}-clip)`}>
          <motion.g initial={false} animate={active ? { rotate: [0, 12, -6, 0], x: [0, 5, -3, 0] } : { rotate: 0, x: 0 }} transition={active ? { duration: 10, repeat: Infinity, ease: "easeInOut" } : transition} style={{ transformOrigin: "90px 80px" }}>
            <path d="M15 61C51 32 81 110 128 89C165 72 142 24 105 14C163 7 181 113 125 142C74 168 20 125 15 61Z" fill={`url(#${id}-fold)`} />
            <path d="M26 48C64 18 59 134 119 110C147 99 132 71 155 47" stroke={`url(#${id}-rim)`} strokeWidth="1.2" />
            <path d="M30 44C69 19 58 139 125 111C151 99 136 69 159 43" stroke={`url(#${id}-rim)`} strokeWidth=".65" opacity=".75" />
            <path d="M35 42C74 26 64 143 131 109C154 97 141 65 162 40" stroke={`url(#${id}-rim)`} strokeWidth=".5" opacity=".5" />
            <path d="M24 92C47 78 93 148 139 118" stroke="var(--agent-deep)" strokeOpacity=".25" strokeWidth="14" />
          </motion.g>
        </g>
        <motion.path initial={false} d={contour} animate={pathAnimation} transition={fieldTransition} stroke={`url(#${id}-rim)`} strokeWidth="1.2" />
        <g className="v-agent-state__mark" stroke="var(--ink-fixed)" strokeWidth="2.3" strokeLinecap="round" strokeLinejoin="round">
          {status === "complete" ? <path d="m77 79 9 9 19-21" /> : status === "error" ? <><path d="M90 66v16" /><path d="M90 91h.01" /></> : status === "needs-input" ? <><path d="M84 72a7 7 0 0 1 14 0c0 5-8 6-8 11" /><path d="M90 92h.01" /></> : <><path d="M77 77v5M101 77v5" /><path d={status === "idle" ? "M84 91q6 4 12 0" : "M85 91h10"} /></>}
        </g>
      </svg>
      <div className="v-agent-state__copy"><span className="v-agent-state__label">{label ?? stateLabels[status]}</span>{description && <span className="v-agent-state__description">{description}</span>}</div>
    </div>
  );
}
