import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { WorkerExitBy } from './job-exit.js';
import { MESSAGE_WORDS_MAX } from '../core/conversations/words.js';
import { SHA256_HEX } from '../core/sha256-hex.js';
import { COMMIT } from '../apps/merge-target.js';

const fingerprint = z.string().length(64).regex(SHA256_HEX);
export const coldReviewReport = z.object({
  change: z.string().min(1).max(512),
  headCommit: z.string().length(40).regex(COMMIT),
  before: fingerprint,
  after: fingerprint,
  reply: z.string().max(MESSAGE_WORDS_MAX).refine(reply => !/\p{Surrogate}/u.test(reply), 'Invalid Unicode in reviewer reply'),
}).strict();
export type ColdReviewReport = z.infer<typeof coldReviewReport>;

export function reviewOutcome(exit: number, report?: ColdReviewReport, exitBy?: WorkerExitBy): { verdict: 'CLEAR' | 'BLOCKING' | 'NONE'; findings: string } {
  // Preserve receipt identity for discarded output without exposing the failed reply.
  const incomplete = (reason: string) => ({ verdict: 'NONE' as const, findings: report
    ? reason + '\nReviewer reply SHA-256: ' + createHash('sha256').update(report.reply).digest('hex')
    : reason });
  if (exit !== 0 || !report || exitBy !== 'runner') return incomplete('The reviewer did not finish successfully.');
  if (report.before !== report.after) return incomplete('The reviewed files changed during the round.');
  const last = report.reply.trimEnd().split('\n').at(-1);
  if (last !== 'VERDICT: CLEAR' && last !== 'VERDICT: BLOCKING') return incomplete('The reviewer did not return a final verdict.');
  const blocking = last === 'VERDICT: BLOCKING' || /^[ \t]*[-*+][ \t]+(?:CRITICAL|MAJOR)\b/m.test(report.reply);
  return { verdict: blocking ? 'BLOCKING' : 'CLEAR', findings: report.reply };
}
