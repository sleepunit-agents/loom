import { jobUsage } from '../core/data/schema.js';
import { z } from 'zod';

const count = z.number().int().nonnegative();
const identifier = z.string().min(1).max(160).regex(/^[a-zA-Z0-9][a-zA-Z0-9_.:/@-]*$/);
const toolCounts = z.preprocess((raw, ctx) => {
  if (raw && typeof raw === 'object' && Object.keys(raw).length > 128) {
    ctx.addIssue({ code: 'custom', message: 'Too many tool names' });
    return z.NEVER;
  }
  return raw;
}, z.record(z.string().max(200).regex(/^[a-zA-Z0-9_.-]+$/), count));
export const usageReport = z.object({
  source: z.enum(jobUsage.source.enumValues).exclude(['program']),
  tokensIn: count.nullish(),
  tokensOut: count.nullish(),
  cacheRead: count.nullish(),
  cacheWritten: count.nullish(),
  modelCalls: count.nullish(),
  toolCalls: count.nullish(),
  tools: toolCounts.nullish(),
  largestContext: count.nullish(),
  wallMs: count.nullish(),
  harness: identifier.nullish(),
  model: identifier.nullish(),
}).strict().refine(({ source, wallMs: _wall, harness: _harness, model: _model, ...counters }) =>
  (source !== 'none') === Object.values(counters).some(value => value != null),
  { message: 'Usage source must agree with the presence of harness counters' },
).refine(({ tools, toolCalls }) => {
  if (!tools) return true;
  const total = Object.values(tools).reduce((sum, value) => sum + value, 0);
  return Number.isSafeInteger(total) && (toolCalls == null || toolCalls === total);
}, { message: 'Per-tool counts must agree with the tool total' });
export type UsageReport = z.infer<typeof usageReport>;
