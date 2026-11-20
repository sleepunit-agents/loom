import { expect, it } from 'vitest';
import { coldReviewReport, reviewOutcome } from './cold-review-report.js';

const report = { change: 'github:org/app#7', headCommit: 'a'.repeat(40), before: 'b'.repeat(64), after: 'b'.repeat(64),
  reply: 'No findings.\nVERDICT: CLEAR\n' };
it('binds the reviewer verdict to successful completion and matching tree fingerprints', () => {
  expect(reviewOutcome(0, report, 'runner')).toEqual({ verdict: 'CLEAR', findings: report.reply });
  for (const severity of ['CRITICAL', 'MAJOR']) {
    expect(reviewOutcome(0, { ...report, reply: `- ${severity} — missed case\nVERDICT: CLEAR` }, 'runner').verdict).toBe('BLOCKING');
  }
  expect(reviewOutcome(0, { ...report, reply: 'VERDICT: BLOCKING' }, 'runner').verdict).toBe('BLOCKING');
  for (const outcome of [reviewOutcome(1, report, 'runner'), reviewOutcome(0, report), reviewOutcome(0, report, 'worker'), reviewOutcome(0), reviewOutcome(0, { ...report, after: 'c'.repeat(64) }, 'runner'),
    reviewOutcome(0, { ...report, reply: 'VERDICT: CLEAR\nunfinished' }, 'runner')]) {
    expect(outcome.verdict).toBe('NONE');
    expect(outcome.findings).not.toContain('VERDICT: CLEAR');
  }
  expect(coldReviewReport.safeParse({ ...report, before: '' }).success).toBe(false);
});
