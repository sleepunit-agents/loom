import { z } from 'zod';
import { COMMIT } from '../apps/merge-target.js';

const fingerprint = z.string().length(64).regex(/^[0-9a-f]+$/);
export const coldReviewReport = z.object({
  change: z.string().min(1).max(512),
  headCommit: z.string().length(40).regex(COMMIT),
  before: fingerprint,
  after: fingerprint,
  reply: z.string().max(64 * 1024),
}).strict();
export type ColdReviewReport = z.infer<typeof coldReviewReport>;

export function reviewOutcome(exit: number, report?: ColdReviewReport): { verdict: 'CLEAR' | 'BLOCKING' | 'NONE'; findings: string } {
  if (exit !== 0 || !report) return { verdict: 'NONE', findings: 'The reviewer did not finish successfully.' };
  if (report.before !== report.after) return { verdict: 'NONE', findings: 'The reviewed files changed during the round.' };
  const last = report.reply.trimEnd().split('\n').at(-1);
  if (last !== 'VERDICT: CLEAR' && last !== 'VERDICT: BLOCKING') return { verdict: 'NONE', findings: 'The reviewer did not return a final verdict.' };
  const blocking = last === 'VERDICT: BLOCKING' || /^-[ \t]+(?:CRITICAL|MAJOR)\b/m.test(report.reply);
  return { verdict: blocking ? 'BLOCKING' : 'CLEAR', findings: report.reply };
}
