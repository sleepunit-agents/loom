"use client";

import * as React from "react";
import { cn } from "@/lib/utils";
import { useLivingShader, type FieldMotionProps } from "@/lib/cojeev/living-shader";

export type ContourFieldProps = Omit<React.ComponentProps<"div">, "children" | "ref"> & FieldMotionProps;

/** Quiet topographic lines on the inherited paper. Decorative, with a still fallback. */
export function ContourField({ speed = 1, intensity = 1, tone = "cool", paused = false, className, style, ...props }: ContourFieldProps) {
  const { host: hostRef, canvas: canvasRef, status, tone: safeTone, intensity: safeIntensity, moving } = useLivingShader("contour", { speed, intensity, tone, paused });
  return (
    <div {...props} ref={hostRef} data-slot="contour-field" data-tone={safeTone} data-renderer={status} data-moving={moving ? "true" : "false"} className={cn("v-contour-field", className)} style={{ ...style, "--field-intensity": safeIntensity } as React.CSSProperties} aria-hidden="true" inert>
      <span data-slot="field-fallback" />
      <canvas ref={canvasRef} data-slot="field-canvas" aria-hidden="true" />
    </div>
  );
}
