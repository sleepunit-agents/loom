/** Structured observations only; provider credentials never enter this schema. */
import { z } from 'zod';
export const quotaWindows = z.array(z.object({
  name: z.string().min(1), usage: z.number().min(0).max(1).nullable(),
  readAt: z.string().datetime({ offset: true }).nullable(),
  resetsAt: z.string().datetime({ offset: true }).nullable(),
  durationMs: z.number().positive(), reserve: z.number().min(0).max(1).optional(),
}).strict()).max(128);
