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
  for (const line of ['loom-job-failure {"reason":"unknown","words":"PRIVATE"}', 'loom-job-failure PRIVATE', ' loom-job-failure {"reason":"unknown"}', 'loom-job-failure {"reason":"unknown"}' + ' '.repeat(1_200), 'PRIVATE'])
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

// How an `unknown` failure ended, counted (FailureEnding): the most a run can say of itself, with every field at its longest.
const ending = { reason: 'unknown', exitCode: 0, signal: 'SIGTERM', result: 'error_max_structured_output_retries', isError: false, resultEmpty: true, stopReason: 'model_context_window_exceeded', finalText: false,
  numTurns: 1_000_000_000, toolCalls: 1_000_000_000, stdoutBytes: 1_000_000_000, stdoutLines: 1_000_000_000, unparsedLines: 1_000_000_000, partialLine: false, quietMs: 1_000_000_000, compacted: false, refusal: 'second-result',
  events: { assistant: 1_000_000_000, user: 1_000_000_000, system: 1_000_000_000, result: 1_000_000_000, rateLimit: 1_000_000_000, stream: 1_000_000_000, other: 1_000_000_000 } } as const;
it('admits how an unknown failure ended as counts, fixed choices and yes or no, and nothing else', () => {
  expect(jobFailure.parse(ending)).toEqual(ending);
  // The fullest one still travels from the body to the worker as its one line, and is read back from a row.
  expect(readFailureLine(failureLine(ending).trimEnd())).toEqual(ending);
  const { reason, ...detail } = ending;
  expect(storedFailure({ failedReason: reason, failedDetail: detail })).toEqual(ending);
  for (const bad of [{ result: 'PRIVATE' }, { stopReason: 'PRIVATE' }, { refusal: 'PRIVATE' }, { isError: 'PRIVATE' }, { resultEmpty: 'yes' }, { finalText: 1 }, { partialLine: 'PRIVATE' }, { compacted: 'PRIVATE' },
    { numTurns: 'PRIVATE' }, { numTurns: -1 }, { numTurns: 1.5 }, { toolCalls: 1_000_000_001 }, { stdoutBytes: '12' }, { stdoutLines: -3 }, { unparsedLines: null }, { quietMs: 'PRIVATE' },
    { events: { assistant: 1, note: 'PRIVATE' } }, { events: { assistant: 'PRIVATE' } }, { events: 'PRIVATE' }, { events: { PRIVATE: 1 } }, { lastLine: 'PRIVATE' }, { said: 'PRIVATE' }])
    expect(jobFailure.safeParse({ reason: 'unknown', ...bad }).success, JSON.stringify(bad)).toBe(false);
});
it('says an unknown failure by what was counted of its ending, where that is known', () => {
  expect(failureWords({ reason: 'unknown', exitCode: 0, result: 'none', toolCalls: 177 })).toBe('the harness exited 0 with no final result after 177 tool calls');
  expect(failureWords({ reason: 'unknown', exitCode: 0, result: 'none', toolCalls: 1, partialLine: true })).toBe('the harness exited 0 with no final result after 1 tool call, its last line cut off');
  expect(failureWords({ reason: 'unknown', exitCode: 0, result: 'success', resultEmpty: true, toolCalls: 0 })).toBe('the harness exited 0 with a final result loom could not take as an answer (an empty one) after 0 tool calls');
  expect(failureWords({ reason: 'unknown', exitCode: 0, result: 'success', isError: true, resultEmpty: true })).toBe('the harness exited 0 with a final result loom could not take as an answer (an error)');
  expect(failureWords({ reason: 'unknown', exitCode: 0, result: 'success', toolCalls: 12 })).toBe('the harness exited 0 with a final result loom could not take as an answer (a success) after 12 tool calls');
  expect(failureWords({ reason: 'unknown', result: 'error_during_execution' })).toBe('the harness ended with a final result loom could not take as an answer (error during execution)');
  expect(failureWords({ reason: 'unknown', result: 'other' })).toBe('the harness ended with a final result loom could not take as an answer (of a kind loom does not know)');
  expect(failureWords({ reason: 'unknown', exitCode: 0 })).toBe('the harness ended without an answer and gave no reason loom could read');
  const job = { state: 'failed' as const, exitCode: BODY_EXIT.harness as number | null, exitBy: 'body' as const, failedReason: 'unknown', failedDetail: { exitCode: 0, result: 'none', toolCalls: 177 } };
  expect(reviewEndReason(job, 'UTC')).toBe('body harness: the harness exited 0 with no final result after 177 tool calls');
});
