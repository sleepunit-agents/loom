/** Why a failed job failed, in a small fixed set of reasons that carry no private words.
 *
 * A job's exit code says where it failed (job-exit.ts). This says why, where one of loom's own programs could
 * tell: the body, from structured signals of its harness (an event's fixed fields, the process's exit code and
 * signal, the container's memory counter), or the worker, for a body a signal ended. Nothing here is free text:
 * a reason is one of FAILED_REASONS, and its detail is a few bounded numbers, a signal's name from a fixed
 * list, a timestamp and a limit's name from a fixed list. That is why it may be kept on the job's row, which is
 * read more widely than a conversation is, where the harness's own error text may not (the text goes to the
 * conversation's own readers only: body-program.ts, the final `Harness` step).
 *
 * The one home of the list, of what a detail may hold, of the plain words said for each, and of what a reason
 * means for the next attempt (Jobs.retry). */
import { z } from 'zod';
import { BODY_EXIT } from './job-exit.js';

export const FAILED_REASONS = [
  /** The account's subscription window is used up. `resetsAt` when the harness said when it resets. */
  'usage-limit',
  /** The provider refused for now (HTTP 429) with no word of a used-up window. */
  'rate-limited',
  /** The provider was overloaded (HTTP 529). */
  'overloaded',
  /** Any other error from the provider's API, with its HTTP status when one was given. */
  'api-error',
  /** The conversation no longer fits the model's context. */
  'context-too-large',
  /** The harness reached its own limit of turns. */
  'max-turns',
  /** The harness printed more than the body reads from one run (body-harness.ts), and the body ended it. */
  'output-limit',
  /** A wait ran out; `limit` names which. */
  'timed-out',
  /** The harness is not signed in, or its sign-in was refused. */
  'sign-in-needed',
  /** The system's memory killer ended the harness, or the body. */
  'out-of-memory',
  /** A signal ended the harness, or the body; `signal` names it when it is a known one. */
  'killed',
  /** The harness stopped by itself with an error and gave no reason above; `exitCode` is its own. */
  'harness-crashed',
  /** The harness ended and nothing above could be read from it. */
  'unknown',
] as const;
export type FailedReason = typeof FAILED_REASONS[number];
/** The signals a failure may name. Any other is left out: the reason still says a signal ended it. */
export const FAILURE_SIGNALS = ['SIGHUP', 'SIGINT', 'SIGQUIT', 'SIGILL', 'SIGABRT', 'SIGBUS', 'SIGFPE', 'SIGKILL', 'SIGSEGV', 'SIGPIPE', 'SIGTERM'] as const;
export type FailureSignal = typeof FAILURE_SIGNALS[number];
const SIGNAL_NUMBERS: Readonly<Record<number, FailureSignal>> = { 1: 'SIGHUP', 2: 'SIGINT', 3: 'SIGQUIT', 4: 'SIGILL', 6: 'SIGABRT', 7: 'SIGBUS', 8: 'SIGFPE', 9: 'SIGKILL', 11: 'SIGSEGV', 13: 'SIGPIPE', 15: 'SIGTERM' };
/** The waits a `timed-out` failure may name: the model's answer stopped arriving; or the harness ended and
 * something it had started kept its output open past the body's wait for it (body-harness.ts). */
export const FAILURE_LIMITS = ['stream-idle', 'output-close'] as const;

/** What a failure's detail may hold, beside its reason. Each is optional and none is free text. */
const detail = {
  /** An HTTP status. */
  status: z.number().int().min(100).max(599).optional(),
  signal: z.enum(FAILURE_SIGNALS).optional(),
  /** A process's exit code. */
  exitCode: z.number().int().min(0).max(255).optional(),
  /** When a limit resets, as the harness reported it. */
  resetsAt: z.iso.datetime().optional(),
  limit: z.enum(FAILURE_LIMITS).optional(),
};
export const jobFailureDetail = z.object(detail).strict();
/** What a worker may report with a failed job's exit code (runtime.finish, `failed`), and what the body hands it. */
export const jobFailure = z.object({ reason: z.enum(FAILED_REASONS), ...detail }).strict();
export type JobFailure = z.infer<typeof jobFailure>;
export type JobFailureDetail = z.infer<typeof jobFailureDetail>;

/** The name of the signal a number is, when it is one a failure may name. */
export const failureSignal = (value: number | string | null | undefined): FailureSignal | undefined =>
  typeof value === 'number' ? SIGNAL_NUMBERS[value] : FAILURE_SIGNALS.find(name => name === value);

/** A job row's two columns as one failure; undefined when the row has none, or holds something this program
 * does not know (a reason from a later one). */
export function storedFailure(row: { failedReason: string | null; failedDetail: unknown }): JobFailure | undefined {
  if (!row.failedReason) return undefined;
  const found = jobFailure.safeParse({ ...(row.failedDetail && typeof row.failedDetail === 'object' ? row.failedDetail : {}), reason: row.failedReason });
  return found.success ? found.data : undefined;
}

/** Why an ended job failed, for saying it: what its row holds; or, for a job that failed in its harness with no
 * reason kept (the body could read none, or the job ended before reasons were kept), `unknown`. Undefined for a
 * job that did not fail, or failed at another stage: its exit code names that stage (job-exit.ts). */
export function failureOf(row: { state: string; exitCode: number | null; exitBy: string | null; failedReason: string | null; failedDetail: unknown }): JobFailure | undefined {
  if (row.state !== 'failed') return undefined;
  return storedFailure(row) ?? (row.exitBy === 'body' && row.exitCode === BODY_EXIT.harness ? { reason: 'unknown' } : undefined);
}

/** How the body hands its failure to the worker: one line of its error output, this prefix and the failure as
 * JSON. The worker keeps nothing else of a body's output, and keeps this only when it is exactly a failure
 * (readFailureLine): a body cannot pass words through it. */
const FAILURE_LINE = 'loom-job-failure ';
/** Longer than any failure's line; a longer line is no failure. */
const FAILURE_LINE_MAX = 400;
export const failureLine = (failure: JobFailure): string => FAILURE_LINE + JSON.stringify(jobFailure.parse(failure)) + '\n';
export function readFailureLine(line: string): JobFailure | undefined {
  if (!line.startsWith(FAILURE_LINE) || line.length > FAILURE_LINE_MAX) return undefined;
  try { const found = jobFailure.safeParse(JSON.parse(line.slice(FAILURE_LINE.length))); return found.success ? found.data : undefined; }
  catch { return undefined; }
}
/** Reads failure lines out of a body's output as it arrives, keeping no other part of it: at most one unfinished
 * line, bounded, and the last failure read. */
export function failureLines() {
  let partial = '', skipping = false, last: JobFailure | undefined;
  return {
    write(text: string) {
      const lines = text.split('\n');
      for (let index = 0; index < lines.length; index++) {
        const piece = lines[index], ended = index < lines.length - 1;
        if (!skipping && partial.length + piece.length <= FAILURE_LINE_MAX) partial += piece;
        else { skipping = true; partial = ''; }
        if (!ended) continue;
        if (!skipping) last = readFailureLine(partial.replace(/\r$/, '')) ?? last;
        partial = ''; skipping = false;
      }
    },
    failure: () => last,
  };
}

/** A reason for which the same job would fail the same way: it is not tried again (Jobs.retry).
 * `sign-in-needed` is not one: two bodies renewing one sign-in at the same moment can have one refused, and
 * the next attempt reads the sign-in the other just wrote (docs/accepted-tradeoffs.md, "Two bodies on one
 * account share one sign-in directory"). A sign-in that is truly gone spends the chain's attempts, as before. */
export const failsAgain = (failure: JobFailure | undefined): boolean =>
  !!failure && (failure.reason === 'context-too-large' || failure.reason === 'max-turns' || failure.reason === 'output-limit');
/** For a limit with a known reset time: when the next attempt may first run. Undefined for anything else. */
export const retryNotBefore = (failure: JobFailure | undefined): number | undefined =>
  failure && (failure.reason === 'usage-limit' || failure.reason === 'rate-limited') && failure.resetsAt ? Date.parse(failure.resetsAt) : undefined;

function clock(at: string, zone: string): string {
  try {
    return new Intl.DateTimeFormat('en-US', { timeZone: zone, month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(new Date(at))
      + (zone === 'UTC' ? ' UTC' : '');
  } catch { return at; }
}
/** A failure in plain words, built from its reason and numbers only: what the parent thread is told and what the
 * page shows. Times are said in `zone` (the household's); with none, in UTC. */
export function failureWords(failure: JobFailure, zone = 'UTC'): string {
  const status = failure.status ? ` (${failure.status})` : '';
  const resets = failure.resetsAt ? `; it resets ${clock(failure.resetsAt, zone)}` : '';
  switch (failure.reason) {
    case 'usage-limit': return `the model's usage limit was reached${resets}`;
    case 'rate-limited': return `the model's provider refused it for now, as too many requests${status}${resets}`;
    case 'overloaded': return `the model's provider was overloaded${status}`;
    case 'api-error': return `the harness stopped with an API error${status}`;
    case 'context-too-large': return 'the session grew too large for the model\'s context';
    case 'max-turns': return 'the harness reached its limit of turns';
    case 'output-limit': return 'the harness printed more than loom reads from one session, and loom ended it';
    case 'timed-out': return failure.limit === 'stream-idle' ? 'the model\'s answer stopped arriving and the wait ran out'
      : failure.limit === 'output-close' ? 'the harness ended, and something it had started kept its output open until the wait ran out' : 'a wait ran out';
    case 'sign-in-needed': return `the harness is not signed in, or its sign-in was refused${status}`;
    case 'out-of-memory': return 'the session ran out of memory';
    case 'killed': return `a signal ended the session${failure.signal ? ` (${failure.signal})` : ''}`;
    case 'harness-crashed': return `the harness stopped with an error of its own${failure.exitCode !== undefined ? ` (exit code ${failure.exitCode})` : ''}`;
    case 'unknown': return 'the harness ended without an answer and gave no reason loom could read';
  }
}
