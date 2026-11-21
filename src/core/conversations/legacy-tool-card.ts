import { z } from 'zod';

const time = z.iso.datetime({ offset: true });
const printableLine = /^[^\x00-\x1f\x7f-\x9f\u2028\u2029\p{Cf}]*$/u;
const shownText = /^(?:(?![\p{Cf}])[^\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f\u2028\u2029]|\x1b\[[0-9;]{0,30}m)*$/u;
export const legacyCardSummary = z.string().min(1).max(120).regex(printableLine);
export const legacyToolCard = z.object({
  tool: z.string().regex(/^[A-Za-z0-9_.:-]{1,64}$/),
  state: z.enum(['running', 'done', 'failed']),
  exit: z.number().int().min(-999999).max(999999).optional(),
  limit: z.number().int().min(1).max(86400).optional(),
  parent: z.string().regex(/^[A-Za-z0-9_.:-]{1,80}$/).optional(),
  t0: time.optional(),
  t1: time.optional(),
}).strict();

const privateParts = z.object({
  detail: z.string().max(4000).regex(shownText).refine(text => !text.includes('\x1b')).optional(),
  body: z.string().max(32000).regex(shownText).optional(),
  result: z.string().max(120).regex(printableLine).optional(),
  items: z.array(z.object({
    text: z.string().min(1).max(100).regex(printableLine),
    state: z.enum(['done', 'now', 'todo']),
  }).strict()).max(20).optional(),
}).strict();

export function legacyStepWords(text: string, tool: string) {
  const parts = privateParts.parse(JSON.parse(text));
  if (parts.body !== undefined && !['Edit', 'MultiEdit', 'Write', 'text'].includes(tool)) {
    throw Error('Unexpected private step body');
  }
  return parts;
}
