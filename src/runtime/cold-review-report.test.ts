import { expect, it } from 'vitest';
import { coldReviewReport, reviewOutcome } from './cold-review-report.js';

const report = { change: 'github:org/app#7', headCommit: 'a'.repeat(40), before: 'b'.repeat(64), after: 'b'.repeat(64),
  reply: 'No findings.\nVERDICT: CLEAR\n' };
it('binds the reviewer verdict to successful completion and matching tree fingerprints', () => {
  expect(reviewOutcome(0, report)).toEqual({ verdict: 'CLEAR', findings: report.reply });
  expect(reviewOutcome(0, { ...report, reply: '- MAJOR — missed case\nVERDICT: CLEAR' }).verdict).toBe('BLOCKING');
  expect(reviewOutcome(0, { ...report, reply: 'VERDICT: BLOCKING' }).verdict).toBe('BLOCKING');
  for (const outcome of [reviewOutcome(1, report), reviewOutcome(0), reviewOutcome(0, { ...report, after: 'c'.repeat(64) }),
    reviewOutcome(0, { ...report, reply: 'VERDICT: CLEAR\nunfinished' })]) {
    expect(outcome.verdict).toBe('NONE');
    expect(outcome.findings).not.toContain('VERDICT: CLEAR');
  }
  expect(coldReviewReport.safeParse({ ...report, before: '' }).success).toBe(false);
});
