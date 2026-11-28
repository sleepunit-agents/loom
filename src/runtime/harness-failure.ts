/** Reads why a harness run failed out of what the harness itself reported, for the adapters.
 *
 * Two things come out, and they go to different places (body-program.ts):
 *  - `why`, one of the fixed reasons (job-failure.ts), decided from structured signals only: an event's fixed
 *    fields (a subtype, an error class, an HTTP status, a reset time), the process's exit code and signal, and
 *    whether the body itself cut the run. It holds no words and may be kept on the job's row.
 *  - `said`, the harness's own last error text, cut to a bounded length. It may hold the conversation's words.
 *    It never leaves the body except as a sealed step for the conversation's own readers.
 * Codex reports an error as a message and nothing else, so its reasons are read from a few fixed phrases of
 * Codex's own in that message; the phrase is matched, never copied. */
import { HarnessFailed, harnessUnavailable, type HarnessEnd } from './body-harness.js';
import { failureSignal, type JobFailure } from './job-failure.js';

type Row = Record<string, unknown>;
const object = (value: unknown): Row => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Row : {};
const text = (value: unknown) => typeof value === 'string' ? value : '';
const status = (value: unknown) => typeof value === 'number' && Number.isInteger(value) && value >= 100 && value <= 599 ? value : undefined;
/** The most of a harness's own error text that is kept for the conversation's readers. */
export const FAILURE_SAID_MAX = 4_000;
const cut = (parts: string[]) => { const whole = parts.map(part => part.trim()).filter(Boolean).join('\n'); return whole.length > FAILURE_SAID_MAX ? whole.slice(0, FAILURE_SAID_MAX) + '\n[Cut]' : whole; };

/** The events of a stream that may have been cut anywhere: every whole line that is one, and nothing else. */
export function streamRows(output: Uint8Array): unknown[] {
  const rows: unknown[] = [];
  for (const line of Buffer.from(output.buffer, output.byteOffset, output.byteLength).toString('utf8').split(/\r?\n/)) {
    if (!line.trim()) continue;
    try { rows.push(JSON.parse(line)); } catch { /* a cut or foreign line is no event */ }
  }
  return rows;
}

/** What the process's own ending says, when the stream said nothing. */
function processFailure(end: HarnessEnd | undefined): JobFailure {
  if (!end) return { reason: 'unknown' };
  if (end.cut === 'output') return { reason: 'output-limit' };
  if (end.cut === 'pipes') return { reason: 'timed-out', limit: 'output-close' };
  if (end.signal) { const signal = failureSignal(end.signal); return { reason: 'killed', ...(signal ? { signal } : {}) }; }
  // A shell's word for a child a signal ended: 128 and the signal's number.
  if (end.exitCode !== null && end.exitCode > 128 && end.exitCode <= 128 + 64) { const signal = failureSignal(end.exitCode - 128); return { reason: 'killed', ...(signal ? { signal } : {}) }; }
  if (end.exitCode !== null && end.exitCode > 0 && end.exitCode <= 255) return { reason: 'harness-crashed', exitCode: end.exitCode };
  return { reason: 'unknown' };
}
function byStatus(code: number): JobFailure {
  if (code === 429) return { reason: 'rate-limited', status: code };
  if (code === 529) return { reason: 'overloaded', status: code };
  if (code === 401 || code === 403) return { reason: 'sign-in-needed', status: code };
  return { reason: 'api-error', status: code };
}
const failed = (why: JobFailure, said: string[], end: HarnessEnd | undefined) => end?.aborted ? harnessUnavailable() : new HarnessFailed(why, cut([...said, end?.stderr ?? '']) || undefined);

/** For a harness whose events say nothing of an error: why its process ended. */
export const exitFailure = (end: HarnessEnd): Error => failed(processFailure(end), [], end);

/** Claude Code's error classes for an answer that is an API error (its `error` field), by the reason each is. */
const CLAUDE_SIGN_IN = new Set(['authentication_failed', 'oauth_org_not_allowed', 'account_on_hold', 'verification_required', 'cloud_credential_error']);
const CLAUDE_USAGE = new Set(['usage_limit_reached', 'model_requires_usage_credits', 'long_context_credits_required']);
/** Why a Claude Code run failed. Read from: the final `result` (subtype, is_error, api_error_status, api_error,
 * terminal_reason); an `assistant` event that wraps an API error (error, api_error_status, api_error); a
 * `rate_limit_event` whose status is rejected (resetsAt); the last `api_retry`; then the process. */
export function claudeFailure(rows: readonly unknown[], end?: HarnessEnd): Error {
  let rejected: { resetsAt?: string } | undefined, kind = '', code: number | undefined, detail = '', subtype = '', terminal = '', retried: number | undefined;
  const said: string[] = [];
  for (const row of rows.map(object)) {
    if (row.type === 'rate_limit_event') {
      const info = object(row.rate_limit_info);
      if (info.status !== 'rejected') { rejected = undefined; continue; }
      const at = typeof info.resetsAt === 'number' && Number.isSafeInteger(info.resetsAt) && info.resetsAt > 0 && info.resetsAt < 1e11 ? new Date(info.resetsAt * 1000).toISOString() : undefined;
      rejected = at ? { resetsAt: at } : {};
    } else if (row.type === 'system' && row.subtype === 'api_retry') retried = status(row.error_status) ?? retried;
    else if (row.type === 'assistant' && (row.error || row.is_api_error_message)) {
      kind = text(row.error) || kind; code = status(row.api_error_status) ?? code; detail = text(row.api_error) || detail;
      const content = object(row.message).content;
      if (Array.isArray(content)) said.splice(0, said.length, content.map(object).filter(part => part.type === 'text').map(part => text(part.text)).join(''));
    } else if (row.type === 'result' && (row.is_error === true || row.subtype !== 'success')) {
      subtype = text(row.subtype); terminal = text(row.terminal_reason);
      code = status(row.api_error_status) ?? code; detail = text(row.api_error) || detail;
      const errors = Array.isArray(row.errors) ? row.errors.filter((item): item is string => typeof item === 'string') : [];
      const last = [text(row.result), ...errors].filter(Boolean);
      if (last.length) said.splice(0, said.length, ...last);
    }
  }
  const limited = rejected ? { reason: 'usage-limit' as const, ...rejected } : undefined;
  const why: JobFailure =
    end?.cut === 'output' ? { reason: 'output-limit' }
    : detail === 'message_over_context_limit' || terminal === 'prompt_too_long' ? { reason: 'context-too-large' }
    : subtype === 'error_max_turns' || terminal === 'max_turns' ? { reason: 'max-turns' }
    : CLAUDE_USAGE.has(detail) ? { reason: 'usage-limit', ...rejected }
    : (kind === 'rate_limit' || code === 429) ? limited ?? { reason: 'rate-limited', ...(code ? { status: code } : {}) }
    : kind === 'overloaded' || code === 529 ? { reason: 'overloaded', ...(code ? { status: code } : {}) }
    : CLAUDE_SIGN_IN.has(kind) || code === 401 || code === 403 ? { reason: 'sign-in-needed', ...(code ? { status: code } : {}) }
    : detail === 'stream_idle_timeout' ? { reason: 'timed-out', limit: 'stream-idle' }
    : code ? byStatus(code)
    : kind || detail ? { reason: 'api-error' }
    // The harness ended on a limit it was told of and said no more.
    : limited && (end?.exitCode ?? 0) !== 0 && !end?.signal ? limited
    : retried && !end?.signal && !end?.cut ? byStatus(retried)
    : processFailure(end);
  return failed(why, said, end);
}

/** Why a Codex run failed. Its `error` and `turn.failed` events carry a message only; a few phrases of Codex's
 * own are matched in it, then the process. */
export function codexFailure(rows: readonly unknown[], end?: HarnessEnd): Error {
  let message = '';
  for (const row of rows.map(object)) {
    if (row.type === 'error') message = text(row.message) || message;
    else if (row.type === 'turn.failed') message = text(object(row.error).message) || message;
  }
  const seen = /\b(?:last status|unexpected status|status code|http status)[: ]+(\d{3})\b/i.exec(message)?.[1];
  const why: JobFailure =
    end?.cut === 'output' ? { reason: 'output-limit' }
    : /\busage limit\b/i.test(message) ? { reason: 'usage-limit' }
    : /\bcontext (?:window|length)\b/i.test(message) ? { reason: 'context-too-large' }
    : status(Number(seen)) ? byStatus(Number(seen))
    : /\b(?:not logged in|logged out|sign in again|login required)\b/i.test(message) ? { reason: 'sign-in-needed' }
    : /\b(?:stream disconnected|stream closed|idle timeout)\b/i.test(message) ? { reason: 'timed-out', limit: 'stream-idle' }
    : processFailure(end);
  return failed(why, [message], end);
}
