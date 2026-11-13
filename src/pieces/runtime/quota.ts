/** Internal quota arithmetic. Inputs are metadata, never provider credentials.
 * No operation calls this yet. The future caller owns authorization, report
 * validation, account grouping, persistence and committed notifications.
 * Times in readings/holds are seconds; the explicit server clock is milliseconds.
 */
export const FULL = 0.97;
export const HOLD_DEFAULT_S = 30 * 60;
export const HOLD_MAX_S = 8 * 86400;
export interface UsageReading {
  readonly windows?: Readonly<Record<string, number>>;
  readonly resets?: Readonly<Record<string, number>>;
  readonly checked?: number;
}
export type Usage = Readonly<Record<string, unknown>>;
export interface QuotaHold {
  readonly until: number;
  readonly at: number;
  readonly blind?: number;
  readonly why?: string;
}
const windowOk = (key: string): boolean => /^[0-9]+[hd](_[a-z0-9]+)?$/.test(key);
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const checkedOf = (r: UsageReading): number => finite(r.checked) ? r.checked : 0;

/** Newest per window, fuller on a tie. Sorting makes future-reset carry-forward
 * independent of box enumeration or whether a house or box reported first.
 * Unread sources add nothing. The input arrays and reports are never changed.
 */
export function mergeUsage(readings: readonly (UsageReading | undefined | null)[]): Record<string, number> {
  const usage: Record<string, number> = {};
  const at: Record<string, number> = {};
  const ordered = readings.filter((r): r is UsageReading => r != null)
    .slice().sort((a, b) => checkedOf(a) - checkedOf(b));
  for (const reading of ordered) {
    const time = checkedOf(reading);
    for (const [window, value] of Object.entries(reading.windows ?? {})) {
      if (!windowOk(window) || !finite(value)) continue;
      if (at[window] !== undefined && at[window] === time && usage[window] >= value) continue;
      at[window] = time;
      usage[window] = value;
      const resetKey = `reset_${window}`;
      const previous = usage[resetKey];
      delete usage[resetKey];
      const reset = reading.resets?.[window];
      if (finite(reset)) usage[resetKey] = reset;
      else if (finite(previous) && previous > time) usage[resetKey] = previous;
    }
    usage.checked = Math.max(usage.checked ?? 0, time);
  }
  return usage;
}
const windowNow = (usage: Usage, window: string, nowS: number): unknown => {
  const reset = usage[`reset_${window}`];
  return finite(reset) && reset <= nowS ? 0 : usage[window];
};
const relevantWindows = (usage: Usage, window?: string): string[] =>
  Object.keys(usage).filter((key) => windowOk(key) && (!key.includes('_') || key === window));

/** Unread accounts have room. General windows and the requested model window
 * must all have room; a provider refusal overrides a low usage reading.
 */
export function hasRoom(usage: Usage, window: string | undefined, nowMs: number): boolean {
  const nowS = Math.floor(nowMs / 1000);
  if (finite(usage.held) && usage.held > nowS) return false;
  return relevantWindows(usage, window).every((key) => {
    const value = windowNow(usage, key, nowS);
    return finite(value) && value < FULL;
  });
}

/** Latest blocker, or null if already roomy or any full window has no reset.
 * Call hasRoom too: null alone cannot distinguish room from an unknown reset.
 */
export function roomAt(usage: Usage, window: string | undefined, nowMs: number): number | null {
  if (hasRoom(usage, window, nowMs)) return null;
  const nowS = Math.floor(nowMs / 1000);
  const times: number[] = [];
  if (finite(usage.held) && usage.held > nowS) times.push(usage.held);
  for (const key of relevantWindows(usage, window)) {
    const value = windowNow(usage, key, nowS);
    if (finite(value) && value < FULL) continue;
    const reset = usage[`reset_${key}`];
    if (!finite(reset)) return null;
    times.push(reset);
  }
  return times.length ? Math.max(...times) : null;
}

/** Calculate one account's next hold after a structured provider refusal.
 * Previous must belong to that same authenticated account. No key lookup or
 * account selection happens here. The caller stores it in its transaction.
 */
export function nextQuotaHold(
  previous: QuotaHold | undefined,
  refusal: { readonly until?: number; readonly why?: string },
  nowMs: number,
): QuotaHold {
  const nowS = Math.floor(nowMs / 1000);
  const known = finite(refusal.until) && refusal.until > nowS;
  const recent = previous && previous.at > nowS - 86400;
  const blind = known ? 0 : recent ? (previous.blind ?? 0) + 1 : 0;
  const end = Math.min(nowS + HOLD_MAX_S, known ? Math.floor(refusal.until!)
    : nowS + HOLD_DEFAULT_S * 2 ** Math.min(blind, 12));
  return {
    until: Math.max(end, previous && previous.until > nowS ? previous.until : 0),
    at: nowS,
    ...(known ? {} : { blind }),
    ...(refusal.why ? { why: refusal.why.slice(0, 200) } : {}),
  };
}
