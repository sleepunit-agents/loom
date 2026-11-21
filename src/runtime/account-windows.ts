/** Trusted provider adapter seam. Provider calls happen outside transactions;
 * only validated observations enter the shared account/window rows. */
import {DAY_MS} from '../core/day.js';
import { accountCompletion, accountObservationCommitted } from './account-completion.js';
import { eq, lte } from 'drizzle-orm';
import type { DataDatabase } from '../core/data/database.js';
import { accountWeekReadings, modelAccounts, modelAccountWindows } from '../core/data/schema.js';
import { accountUsageUnavailable } from './account-usage.js';
import { accountCapacity, type QuotaWindow } from './quota.js';

type Identity = { account: string; owner: string; provider: string };
export type UsageProvider = (identity: Readonly<Identity>) => Promise<readonly QuotaWindow[]>;

export function readAccountWindows(db: DataDatabase, account: string): QuotaWindow[] {
  return db.select().from(modelAccountWindows).where(eq(modelAccountWindows.account, account)).all()
    .map(row => ({ name: row.window, usage: row.usage, readAt: row.usageReadAt,
      resetsAt: row.resetsAt, durationMs: row.durationMs, reserve: row.reserve }));
}

/** The summary on `model_accounts` (usage, read time, reset, has room) is worked out from the windows.
 * Not exported: recordAccountWindows is its one caller, so the summary can never be written without them.
 * `has_room` has one other writer, accountUsageUnavailable, which sets it false when a provider read fails
 * and changes no window. So do not work `has_room` out again from the windows: that would reopen admission
 * after a failed read (currentAccountCapacity reads both). */
function recordSummary(db: DataDatabase, input: {
  account: string; owner: string; provider: string; windows: readonly QuotaWindow[]; now: string;
}) {
  const capacity = accountCapacity(input.windows, input.now);
  const readings = input.windows.map(window => window.readAt).filter((at): at is string => at !== null);
  const oldest = readings.length === input.windows.length && readings.length
    ? Math.min(...readings.map(Date.parse)) : null;
  const usageReadAt = oldest === null || readings.some(at => Date.parse(at) > Date.parse(input.now))
    ? null : new Date(oldest).toISOString();
  const resetsAt = input.windows.length && input.windows.every(window => window.resetsAt !== null) ? new Date(Math.min(...input.windows.map(window => Date.parse(window.resetsAt!)))).toISOString() : null;
  const usage = capacity.windows.length && capacity.windows.every(window => window.estimatedUsage !== null)
    ? Math.min(1, Math.max(...capacity.windows.map(window => window.estimatedUsage!))) : null;
  const result = db.transaction(() => {
    const before = db.select().from(modelAccounts).where(eq(modelAccounts.id, input.account)).get();
    if (!before || before.owner !== input.owner || before.provider !== input.provider) throw new Error('Account changed during refresh');
    // An older asynchronous refresh must not replace a more recent reading.
    if (usageReadAt !== null && before.usageReadAt !== null && Date.parse(usageReadAt) < Date.parse(before.usageReadAt))
      return { recorded: false as const, account: before };
    const account = db.update(modelAccounts).set({ usage, usageReadAt, resetsAt, hasRoom: capacity.hasRoom, usageReadSucceeded: true })
      .where(eq(modelAccounts.id, input.account)).returning().get()!;
    return { recorded: true as const, account };
  }, { behavior: 'immediate' });
  return result;
}

function recordWeekReadings(db: DataDatabase, account: string, windows: readonly QuotaWindow[], now: string) {
  const at = Date.parse(now), week = 7 * DAY_MS;
  db.delete(accountWeekReadings).where(lte(accountWeekReadings.resetsAt, new Date(at).toISOString())).run();
  for (const row of windows) {
    if (row.durationMs !== week || row.usage === null || !row.readAt || !row.resetsAt) continue;
    const read = Date.parse(row.readAt), reset = Date.parse(row.resetsAt);
    if (read > at || reset <= at || read < reset - week || read >= reset) continue;
    db.insert(accountWeekReadings).values({
      account, window: row.name, resetsAt: new Date(reset).toISOString(),
      readAt: new Date(read).toISOString(), usage: row.usage,
    }).onConflictDoUpdate({
      target: [accountWeekReadings.account, accountWeekReadings.window, accountWeekReadings.resetsAt, accountWeekReadings.readAt],
      set: {usage: row.usage},
    }).run();
  }
}

/** A provider response is the complete set of active limits. An older reading
 * of any retained window cannot erase newer observations of that window. A caller
 * enclosing this in its own transaction publishes accountObservationCommitted
 * after the outer commit (the shared operation and refresh owners do so). */
export function recordAccountWindows(db: DataDatabase, identity: Identity, windows: readonly QuotaWindow[], now: string) {
  accountCapacity(windows, now); // validate the whole response before changing rows
  if (new Set(windows.map(row => row.name)).size !== windows.length) throw new Error('Duplicate quota window');
  const recorded = db.transaction(() => {
    const before = readAccountWindows(db, identity.account);
    if (windows.some(row => row.readAt !== null && before.some(old => old.name === row.name
      && old.readAt !== null && Date.parse(old.readAt) <= Date.parse(now)
      && Date.parse(old.readAt) > Date.parse(row.readAt!)))) return false;
    const result = recordSummary(db, { ...identity, windows, now });
    if (!result.recorded) return false;
    // Include the last installed reading when upgrading a household midweek.
    recordWeekReadings(db, identity.account, [...before, ...windows], now);
    db.delete(modelAccountWindows).where(eq(modelAccountWindows.account, identity.account)).run();
    for (const row of windows) db.insert(modelAccountWindows).values({ account: identity.account,
      window: row.name, usage: row.usage, usageReadAt: row.readAt === null ? null : new Date(row.readAt).toISOString(),
      resetsAt: row.resetsAt === null ? null : new Date(row.resetsAt).toISOString(),
      durationMs: row.durationMs, reserve: row.reserve ?? 0.05 }).run();
    return true;
  }, { behavior: 'immediate' });
  if (recorded && !db.$client.inTransaction) accountObservationCommitted(db, identity.account);
  return recorded;
}

/** Re-evaluate aging observations without treating them as a successful refresh.
 * Failed provider reads latch hasRoom=false until a later successful reading. */
export function currentAccountCapacity(db: DataDatabase, account: string, now: string) {
  const row = db.select().from(modelAccounts).where(eq(modelAccounts.id, account)).get();
  let capacity;
  try { capacity = accountCapacity(readAccountWindows(db, account), now); }
  catch { capacity = accountCapacity([], now); }
  return { ...capacity, hasRoom: Boolean(row?.hasRoom) && capacity.hasRoom };
}

export async function refreshAccountWindows(db: DataDatabase, account: string, provider: UsageProvider, now: () => string) {
  const row = db.select().from(modelAccounts).where(eq(modelAccounts.id, account)).get();
  if (!row) throw new Error('Unknown account');
  const identity = { account, owner: row.owner, provider: row.provider };
  const completion = accountCompletion(db, account);
  const snapshot = JSON.stringify({ row, windows: readAccountWindows(db, account) });
  const unchanged = () => accountCompletion(db, account) === completion && snapshot === JSON.stringify({
    row: db.select().from(modelAccounts).where(eq(modelAccounts.id, account)).get(),
    windows: readAccountWindows(db, account),
  });
  let windows: readonly QuotaWindow[];
  try {
    windows = await provider(Object.freeze(identity));
    accountCapacity(windows, now());
    if (new Set(windows.map(row => row.name)).size !== windows.length || windows.some(row => row.usage !== null && row.usage > 1))
      throw new Error('Invalid provider response');
  }
  catch {
    const applied = db.transaction(() => unchanged() && accountUsageUnavailable(db, identity));
    if (applied) accountObservationCommitted(db, account);
    return { refreshed: false };
  }
  const result = db.transaction(() => ({ refreshed: unchanged() && recordAccountWindows(db, identity, windows, now()) }), { behavior: 'immediate' });
  if (result.refreshed) accountObservationCommitted(db, account);
  return result;
}
