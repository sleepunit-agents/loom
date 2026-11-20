import { createHash } from 'node:crypto';
import { z } from 'zod';
import { usageReport } from './usage-report.js';
import type { WorkerExitBy } from './job-exit.js';
import { MESSAGE_WORDS_MAX } from '../core/conversations/words.js';
import { SHA256_HEX } from '../core/sha256-hex.js';
import { COMMIT } from '../apps/merge-target.js';

const fingerprint = z.string().length(64).regex(SHA256_HEX);
const reviewerReply = z.string().max(MESSAGE_WORDS_MAX).refine(reply => !/\p{Surrogate}/u.test(reply), 'Invalid Unicode in reviewer reply');
export const coldReviewReport = z.object({
  change: z.string().min(1).max(512),
  headCommit: z.string().length(40).regex(COMMIT),
  usage: usageReport.optional(),
  before: fingerprint,
  after: fingerprint,
  reply: z.union([reviewerReply, z.object({ discardedSha256: fingerprint }).strict()]),
}).strict();
export type ColdReviewReport = z.infer<typeof coldReviewReport>;

/** Convert unusable model text before it reaches the bounded HTTP door, so measured work can still be filed. */
export function boundedReviewReport(report: ColdReviewReport): ColdReviewReport {
  if (typeof report.reply !== 'string' || reviewerReply.safeParse(report.reply).success) return report;
  const digest = createHash('sha256').update(report.reply, 'utf16le').digest('hex');
  return { ...report, reply: { discardedSha256: digest } };
}

export function reviewOutcome(exit: number, report?: ColdReviewReport, exitBy?: WorkerExitBy): { verdict: 'CLEAR' | 'BLOCKING' | 'NONE'; findings: string } {
  const failed = 'The reviewer did not finish successfully.';
  if (!report) return { verdict: 'NONE', findings: failed };
  const reply = report.reply;
  if (typeof reply !== 'string') return { verdict: 'NONE', findings:
    'The worker discarded unusable reviewer text. Discarded reply SHA-256: ' + reply.discardedSha256 };
  // Preserve receipt identity for discarded output without exposing the failed reply.
  const incomplete = (reason: string) => ({ verdict: 'NONE' as const,
    findings: reason + '\nReviewer reply SHA-256: ' + createHash('sha256').update(reply).digest('hex') });
  if (exit !== 0 || exitBy !== 'runner') return incomplete(failed);
  if (report.before !== report.after) return incomplete('The reviewed files changed during the round.');
  const last = reply.trimEnd().split('\n').at(-1);
  if (last !== 'VERDICT: CLEAR' && last !== 'VERDICT: BLOCKING') return incomplete('The reviewer did not return a final verdict.');
  const blocking = last === 'VERDICT: BLOCKING' || /^[ \t]*[-*+][ \t]+(?:CRITICAL|MAJOR)\b/m.test(reply);
  return { verdict: blocking ? 'BLOCKING' : 'CLEAR', findings: reply };
}
