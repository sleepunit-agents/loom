/** Trusted provider adapter seam. Provider calls happen outside transactions;
 * only validated observations enter the shared account/window rows. */
import { eq } from 'drizzle-orm';
import type { DataDatabase } from '../core/data/database.js';
import { modelAccounts, modelAccountWindows } from '../core/data/schema.js';
import { recordAccountUsage, accountUsageUnavailable } from './account-usage.js';
import { accountCapacity, type QuotaWindow } from './quota.js';

type Identity = { account: string; owner: string; provider: string };
export type UsageProvider = (identity: Readonly<Identity>) => Promise<readonly QuotaWindow[]>;

export function readAccountWindows(db: DataDatabase, account: string): QuotaWindow[] {
  return db.select().from(modelAccountWindows).where(eq(modelAccountWindows.account, account)).all()
    .map(row => ({ name: row.window, usage: row.usage, readAt: row.usageReadAt,
      resetsAt: row.resetsAt, durationMs: row.durationMs, reserve: row.reserve }));
}

/** A provider response is the complete set of active limits. An older reading
 * of any retained window cannot erase newer observations of that window. */
export function recordAccountWindows(db: DataDatabase, identity: Identity, windows: readonly QuotaWindow[], now: string) {
  accountCapacity(windows, now); // validate the whole response before changing rows
  if (new Set(windows.map(row => row.name)).size !== windows.length) throw new Error('Duplicate quota window');
  return db.transaction(() => {
    const before = readAccountWindows(db, identity.account);
    if (windows.some(row => row.readAt !== null && before.some(old => old.name === row.name
      && old.readAt !== null && Date.parse(old.readAt) <= Date.parse(now)
      && Date.parse(old.readAt) > Date.parse(row.readAt!)))) return false;
    const result = recordAccountUsage(db, { ...identity, windows, now });
    if (!result.recorded) return false;
    db.delete(modelAccountWindows).where(eq(modelAccountWindows.account, identity.account)).run();
    for (const row of windows) db.insert(modelAccountWindows).values({ account: identity.account,
      window: row.name, usage: row.usage, usageReadAt: row.readAt, resetsAt: row.resetsAt,
      durationMs: row.durationMs, reserve: row.reserve ?? 0.05 }).run();
    return true;
  }, { behavior: 'immediate' });
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
  const snapshot = JSON.stringify({ row, windows: readAccountWindows(db, account) });
  const unchanged = () => snapshot === JSON.stringify({
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
    db.transaction(() => { if (unchanged()) accountUsageUnavailable(db, identity); });
    return { refreshed: false };
  }
  return db.transaction(() => ({ refreshed: unchanged() && recordAccountWindows(db, identity, windows, now()) }), { behavior: 'immediate' });
}
