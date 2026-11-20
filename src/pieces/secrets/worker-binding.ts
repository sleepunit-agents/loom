/** Shared value-free assignment schema for central admission and worker input. */
import { z } from 'zod';

export const secretInputBindingSchema=z.object({agent:z.string().min(1).max(100),job:z.uuid(),runner:z.string().min(1).max(200),
  box:z.string().min(1).max(200),claimedAt:z.number().finite(),service:z.string().min(1).max(200).optional()}).strict();
export type SecretInputBinding=z.infer<typeof secretInputBindingSchema>;
