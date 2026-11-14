/** One provider observation for a subscription's allowance. Windows belong to
 * the account, never to the agent or machine using it. No credential values. */
export interface QuotaWindow {
  name: string;
  usage: number | null;
  readAt: string | null;
  resetsAt: string;
  durationMs: number;
  reserve?: number;
}
export interface WindowCapacity {
  name: string;
  estimatedUsage: number | null;
  forecast: number | null;
  hasRoom: boolean;
  reserveLent: boolean;
}
export type AccountLevel = 'plenty' | 'getting full' | 'almost full';
export interface AccountCapacity {
  hasRoom: boolean;
  level: AccountLevel;
  /** Private diagnostics; the query door exposes only label/level to others. */
  windows: WindowCapacity[];
}

function time(value: string): number {
  const result = Date.parse(value);
  if (!Number.isFinite(result)) throw new Error('Invalid quota time');
  return result;
}

/** Pure calculation; the shared schema owns storage and the caller owns refresh.
 * Project the observed average rate forward, so an aging observation does not
 * keep granting its old headroom. The reserve starts at 5%; in the final 10%
 * of a window it can be lent if that rate forecasts usage strictly below 100%.
 * Missing, future or expired observations cannot establish available capacity.
 * In particular, passing a reset never fabricates a fresh provider reading.
 */
export function accountCapacity(windows: readonly QuotaWindow[], now: string): AccountCapacity {
  const current = time(now);
  const results = windows.map((window): WindowCapacity => {
    const reset = time(window.resetsAt), reserve = window.reserve ?? 0.05;
    if (!window.name || !Number.isFinite(window.durationMs) || window.durationMs <= 0
      || !Number.isFinite(reserve) || reserve < 0 || reserve >= 1
      || (window.usage !== null && (!Number.isFinite(window.usage) || window.usage < 0))) {
      throw new Error('Invalid quota window');
    }
    const start = reset - window.durationMs;
    const read = window.readAt === null ? null : time(window.readAt);
    if (read !== null && (read < start || read >= reset)) throw new Error('Quota observation outside its window');
    const unavailable: WindowCapacity = { name: window.name, estimatedUsage: null, forecast: null, hasRoom: false, reserveLent: false };
    if (read === null || window.usage === null || read > current || current >= reset || current < start) return unavailable;
    const elapsed = read - start;
    // At the very beginning no elapsed sample exists to establish a rate.
    // The observed amount is usable, but cannot justify lending a reserve.
    const rate = elapsed > 0 ? window.usage / elapsed : null;
    const estimatedUsage = rate === null ? window.usage : Math.max(window.usage, rate * (current - start));
    const forecast = rate === null ? null : rate * window.durationMs;
    const normalRoom = estimatedUsage < 1 - reserve;
    // Compare the observed fraction directly with elapsed time: computing a
    // rate first can round an exact 100% forecast just below one.
    const lendable = current >= reset - window.durationMs * 0.1 && elapsed > 0
      && window.usage < elapsed / window.durationMs;
    const reserveLent = !normalRoom && estimatedUsage < 1 && lendable;
    return { name: window.name, estimatedUsage, forecast, hasRoom: normalRoom || reserveLent, reserveLent };
  });
  const hasRoom = results.length > 0 && results.every(window => window.hasRoom);
  const usage = results.reduce((maximum, window) => Math.max(maximum, window.estimatedUsage ?? 1), 0);
  const level: AccountLevel = !results.length || usage >= 0.85 ? 'almost full' : usage >= 0.5 ? 'getting full' : 'plenty';
  return { hasRoom, level, windows: results };
}
