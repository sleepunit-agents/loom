import { z } from 'zod';

const count = z.number().int().nonnegative();
const identifier = z.string().min(1).max(160).regex(/^[a-zA-Z0-9][a-zA-Z0-9_.:/@-]*$/);
export const usageReport = z.object({
  source: z.enum(['report', 'transcript', 'none']),
  tokensIn: count.nullish(),
  tokensOut: count.nullish(),
  cacheRead: count.nullish(),
  cacheWritten: count.nullish(),
  modelCalls: count.nullish(),
  toolCalls: count.nullish(),
  tools: z.record(z.string().max(200).regex(/^[a-zA-Z0-9_.-]+$/), count).refine(value => Object.keys(value).length <= 128).nullish(),
  largestContext: count.nullish(),
  wallMs: count.nullish(),
  harness: identifier.nullish(),
  model: identifier.nullish(),
}).strict();
export type UsageReport = z.infer<typeof usageReport>;
