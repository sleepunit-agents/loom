import { expect, it } from 'vitest';
import { reviewEndReason } from '../core/conversations/review-result.js';
import { BODY_EXIT, WORKER_EXIT } from './job-exit.js';
import { FAILED_REASONS, failsAgain, failureLine, failureLines, failureOf, failureSignal, failureWords, jobFailure, readFailureLine, retryNotBefore, storedFailure, type JobFailure } from './job-failure.js';

it('admits only a fixed reason with bounded detail, and no text', () => {
  for (const reason of FAILED_REASONS) expect(jobFailure.safeParse({ reason }).success).toBe(true);
  expect(jobFailure.parse({ reason: 'api-error', status: 529, signal: 'SIGKILL', exitCode: 137, resetsAt: '2026-11-28T01:00:00.000Z', limit: 'stream-idle' })).toBeTruthy();
  for (const bad of [{ reason: 'because PRIVATE' }, { reason: 'unknown', note: 'PRIVATE' }, { reason: 'api-error', status: 99 }, { reason: 'api-error', status: 600 }, { reason: 'api-error', status: '529' },
    { reason: 'killed', signal: 'SIGPRIVATE' }, { reason: 'harness-crashed', exitCode: 256 }, { reason: 'harness-crashed', exitCode: 1.5 }, { reason: 'usage-limit', resetsAt: 'at seven, PRIVATE' },
    { reason: 'usage-limit', resetsAt: '2026-11-28 01:00' }, { reason: 'timed-out', limit: 'PRIVATE' }, {}, 'usage-limit', null])
    expect(jobFailure.safeParse(bad).success).toBe(false);
});
it('says every reason in plain words built from the reason and its numbers', () => {
  const said = (failure: JobFailure, zone?: string) => failureWords(failure, zone);
  expect(said({ reason: 'usage-limit', resetsAt: '2026-11-28T01:00:00.000Z' }, 'America/Chicago')).toBe('the model\'s usage limit was reached; it resets Nov 27, 7:00 PM');
  expect(said({ reason: 'usage-limit', resetsAt: '2026-11-28T01:00:00.000Z' })).toBe('the model\'s usage limit was reached; it resets Nov 28, 1:00 AM UTC');
  expect(said({ reason: 'usage-limit' })).toBe('the model\'s usage limit was reached');
  expect(said({ reason: 'out-of-memory' })).toBe('the session ran out of memory');
  expect(said({ reason: 'overloaded', status: 529 })).toBe('the model\'s provider was overloaded (529)');
  expect(said({ reason: 'api-error', status: 500 })).toBe('the harness stopped with an API error (500)');
  expect(said({ reason: 'sign-in-needed', status: 401 })).toBe('the harness is not signed in, or its sign-in was refused (401)');
  expect(said({ reason: 'killed', signal: 'SIGTERM' })).toBe('a signal ended the session (SIGTERM)');
  expect(said({ reason: 'harness-crashed', exitCode: 3 })).toBe('the harness stopped with an error of its own (exit code 3)');
  for (const reason of FAILED_REASONS) expect(said({ reason })).toMatch(/^[a-z][^\n]{10,140}[a-z)]$/);
});
it('carries a failure from the body to the worker as one line that can hold nothing else', () => {
  const failure = { reason: 'rate-limited', status: 429 } as const;
  expect(failureLine(failure)).toBe('loom-job-failure {"reason":"rate-limited","status":429}\n');
  expect(readFailureLine(failureLine(failure).trimEnd())).toEqual(failure);
  expect(() => failureLine({ reason: 'PRIVATE' } as never)).toThrow();
  for (const line of ['loom-job-failure {"reason":"unknown","words":"PRIVATE"}', 'loom-job-failure PRIVATE', ' loom-job-failure {"reason":"unknown"}', 'loom-job-failure {"reason":"unknown"}' + ' '.repeat(400), 'PRIVATE'])
    expect(readFailureLine(line)).toBeUndefined();
  const lines = failureLines();
  lines.write('PRIVATE ' + 'x'.repeat(5_000)); lines.write(' loom-job-failure {"reason":"max-turns"}\nloom-job-fail'); expect(lines.failure()).toBeUndefined();
  lines.write('ure {"reason":"killed","signal":"SIGKILL"}\r\nPRIVATE\nloom-job-failure {"reason":"unknown"'); expect(lines.failure()).toEqual({ reason: 'killed', signal: 'SIGKILL' });
});
it('reads a job row\'s failure, calls a harness failure with none kept unknown, and guesses nothing for another stage', () => {
  const row = { state: 'failed', exitCode: BODY_EXIT.harness as number, exitBy: 'body' as string | null, failedReason: null as string | null, failedDetail: null as unknown };
  expect(failureOf({ ...row, failedReason: 'api-error', failedDetail: { status: 529 } })).toEqual({ reason: 'api-error', status: 529 });
  expect(failureOf(row)).toEqual({ reason: 'unknown' });
  expect(failureOf({ ...row, exitCode: BODY_EXIT.mail })).toBeUndefined(); expect(failureOf({ ...row, exitBy: 'runner' })).toBeUndefined(); expect(failureOf({ ...row, exitBy: null })).toBeUndefined();
  expect(failureOf({ ...row, state: 'done', failedReason: 'api-error' })).toBeUndefined();
  // A reason from a later program, or a detail that is not one, reads as none kept.
  expect(storedFailure({ failedReason: 'a-later-reason', failedDetail: null })).toBeUndefined();
  expect(storedFailure({ failedReason: 'api-error', failedDetail: { words: 'PRIVATE' } })).toBeUndefined();
  expect(failureSignal(9)).toBe('SIGKILL'); expect(failureSignal('SIGTERM')).toBe('SIGTERM'); expect(failureSignal(64)).toBeUndefined(); expect(failureSignal('SIGPRIVATE')).toBeUndefined();
});
it('knows which reasons the same job would fail on again, and which name a time to wait for', () => {
  expect(FAILED_REASONS.filter(reason => failsAgain({ reason }))).toEqual(['context-too-large', 'max-turns', 'output-limit']);
  expect(failsAgain(undefined)).toBe(false);
  expect(retryNotBefore({ reason: 'usage-limit', resetsAt: '2026-11-28T01:00:00.000Z' })).toBe(Date.parse('2026-11-28T01:00:00.000Z'));
  expect(retryNotBefore({ reason: 'rate-limited', resetsAt: '2026-11-28T01:00:00.000Z' })).toBe(Date.parse('2026-11-28T01:00:00.000Z'));
  expect(retryNotBefore({ reason: 'usage-limit' })).toBeUndefined(); expect(retryNotBefore({ reason: 'overloaded' })).toBeUndefined(); expect(retryNotBefore(undefined)).toBeUndefined();
});
it('tells the parent thread why in plain words after the stage, from the reason and its numbers only', () => {
  const job = { state: 'failed' as const, exitCode: BODY_EXIT.harness as number | null, exitBy: 'body' as 'body' | 'worker' | null, failedReason: null as string | null, failedDetail: null as Record<string, string | number> | null };
  expect(reviewEndReason({ ...job, failedReason: 'usage-limit', failedDetail: { resetsAt: '2026-11-28T01:00:00.000Z' } }, 'America/Chicago')).toBe('body harness: the model\'s usage limit was reached; it resets Nov 27, 7:00 PM');
  expect(reviewEndReason({ ...job, failedReason: 'api-error', failedDetail: { status: 529 } }, 'UTC')).toBe('body harness: the harness stopped with an API error (529)');
  expect(reviewEndReason({ ...job, exitCode: WORKER_EXIT.killed, exitBy: 'worker', failedReason: 'out-of-memory' }, 'UTC')).toBe('body killed: the session ran out of memory');
  expect(reviewEndReason(job, 'UTC')).toBe('body harness: the harness ended without an answer and gave no reason loom could read');
  expect(reviewEndReason({ ...job, exitCode: WORKER_EXIT.build, exitBy: 'worker' }, 'UTC')).toBe('worker build');
  expect(reviewEndReason({ ...job, state: 'lost', failedReason: 'api-error' }, 'UTC')).toBe('worker contact was lost');
  expect(reviewEndReason({ ...job, exitBy: null }, 'UTC')).toBe('the job ended without returning findings');
});
