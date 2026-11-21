import { z } from 'zod';

// The legacy writer kept the reason in plaintext alongside the retry state.
// Only the fixed fields belong in durable metadata in the new home.
export const noticeInfo = z.object({
  error: z.enum(['no-runtime', 'refused', 'start-failed', 'busy', 'start-retry', 'loop', 'post-failed', 'no-reply', 'no-age', 'unreachable']),
  attempt: z.number().int().min(1).max(1000).optional(),
  settled: z.boolean().optional(),
  retry_at: z.iso.datetime({ offset: true }).optional(),
}).strict();
const archivedNotice = noticeInfo.extend({ reason: z.string().max(300).optional() });

export function legacyNotice(json: string) {
  const { reason, ...info } = archivedNotice.parse(JSON.parse(json));
  return { reason, info };
}
