/** Pure parsing of supplied harness metadata. Never reads transcripts or logins.
 * A future caller must authenticate the report and bind it to its account/job.
 * Prose is deliberately not evidence of a provider quota refusal.
 */
import { FULL, type UsageReading } from './quota.js';
type ObjectValue = Record<string, unknown>;
const object = (v: unknown): ObjectValue | undefined =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? v as ObjectValue : undefined;
export type Harness = 'claude' | 'codex';
export interface Refusal { readonly code: 'rate_limit' | 'billing_error' | 'usage_limit_exceeded' }

export function claudeRefusal(value: unknown): Refusal | null {
  const v = object(value);
  if (!v) return null;
  if ((v.type === 'assistant' && v.isApiErrorMessage === true || v.type === 'result' && v.is_error === true)
    && (v.error === 'rate_limit' || v.error === 'billing_error')) return { code: v.error };
  return v.type === 'rate_limit_event' && object(v.rate_limit_info)?.status === 'rejected'
    ? { code: 'rate_limit' } : null;
}
export function codexRefusal(value: unknown): Refusal | null {
  const v = object(value);
  const p = v?.type === 'event_msg' ? object(v.payload) : v;
  if (!p) return null;
  if (p.type === 'error') {
    const info = p.codex_error_info;
    const code = typeof info === 'string' ? info : Object.keys(object(info) ?? {})[0];
    if (code === 'usage_limit_exceeded') return { code };
  }
  return p.type === 'token_count' && object(p.rate_limits)?.rate_limit_reached_type
    ? { code: 'usage_limit_exceeded' } : null;
}

/** Last refusal unless later work, a new prompt or a coded nonquota failure
 * supersedes it. Generic failure/completion wrappers preserve the refusal.
 */
export function lastRefusal(harness: Harness, text: string): Refusal | null {
  let last: Refusal | null = null;
  for (const line of text.split('\n')) {
    let parsed: unknown;
    try { parsed = JSON.parse(line); } catch { continue; }
    const v = object(parsed);
    if (!v) continue;
    const got = harness === 'claude' ? claudeRefusal(v) : codexRefusal(v);
    if (got) { last = got; continue; }
    if (harness === 'claude') {
      const toolResult = object(v.message)?.content;
      if (v.error !== undefined && (v.type === 'assistant' && v.isApiErrorMessage === true || v.type === 'result' && v.is_error === true)
        || v.type === 'assistant' && v.isApiErrorMessage !== true
        || v.type === 'result' && !v.is_error && typeof v.result === 'string'
        || v.type === 'user' && !(Array.isArray(toolResult) && toolResult.some(c => object(c)?.type === 'tool_result'))) last = null;
    } else {
      const p = v.type === 'event_msg' ? object(v.payload) : v;
      if (p?.type === 'error' && p.codex_error_info !== undefined
        || v.type === 'item.completed' && object(v.item)?.type === 'agent_message'
        || v.type === 'response_item' || v.type === 'turn_context'
        || v.type === 'event_msg' && (p?.type === 'user_message' || p?.type === 'task_started')) last = null;
    }
  }
  return last;
}

/** Reset seconds: latest full window, otherwise earliest future reset.
 * Undefined asks nextQuotaHold for its bounded blind backoff. Clock is explicit.
 */
export function refusedUntil(reading: UsageReading | null | undefined, nowS: number): number | undefined {
  const resets = Object.entries(reading?.resets ?? {}).filter(([, value]) => Number.isFinite(value) && value > nowS);
  const full = resets.filter(([key]) => {
    const value = reading?.windows?.[key];
    return typeof value === 'number' && Number.isFinite(value) && value >= FULL;
  });
  return full.length ? Math.max(...full.map(([, value]) => value))
    : resets.length ? Math.min(...resets.map(([, value]) => value)) : undefined;
}
