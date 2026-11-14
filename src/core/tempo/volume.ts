import { and, eq, lte, ne } from 'drizzle-orm';
import type { DataDatabase } from '../data/database.js';
import { inbox, tempoSettings } from '../data/schema.js';
import type { Clock } from '../clock.js';

export type Recipient = { kind: 'person' | 'agent'; id: string };
export type Volume = 'full' | 'dim' | 'mute';
export const defaultTimings = Object.freeze({ settleSeconds: 5, dimDays: 1, muteDays: 7 });
export type Timings = { settleSeconds: number; dimDays: number; muteDays: number };
const day = 86_400_000;

/** Trusted in-process API. External callers must pass through the household door.
 * Inbox owns content and answers; Tempo owns only volume and its timings. */
export class InboxVolume {
  constructor(private db: DataDatabase, private clock: Clock) {}

  timings(who: Recipient): Timings {
    const row = this.db.select().from(tempoSettings).where(and(eq(tempoSettings.whoKind, who.kind), eq(tempoSettings.who, who.id))).get();
    return row ? { settleSeconds: row.settleSeconds, dimDays: row.dimDays, muteDays: row.muteDays } : { ...defaultTimings };
  }

  setTimings(who: Recipient, patch: Partial<Timings>): Timings {
    const value = { ...this.timings(who), ...patch };
    if (!Number.isSafeInteger(value.settleSeconds) || value.settleSeconds < 0 ||
        !Number.isSafeInteger(value.dimDays) || value.dimDays <= 0 ||
        !Number.isSafeInteger(value.muteDays) || value.muteDays <= 0 ||
        !Number.isFinite(this.clock.now() + Math.max(value.dimDays, value.muteDays) * day) ||
        this.clock.now() + Math.max(value.dimDays, value.muteDays) * day > 8.64e15) throw new Error('Invalid Tempo timings');
    const key = and(eq(tempoSettings.whoKind, who.kind), eq(tempoSettings.who, who.id));
    if (Object.entries(defaultTimings).every(([k, v]) => value[k as keyof Timings] === v)) this.db.delete(tempoSettings).where(key).run();
    else this.db.insert(tempoSettings).values({ whoKind: who.kind, who: who.id, ...value }).onConflictDoUpdate({ target: [tempoSettings.whoKind, tempoSettings.who], set: value }).run();
    return value;
  }

  set(who: Recipient, item: string, volume: Volume, until?: string): void {
    if (!['full', 'dim', 'mute'].includes(volume)) throw new Error('Invalid volume');
    const now = this.clock.now();
    const settings = this.timings(who);
    const end = volume === 'full' ? null : new Date(until === undefined ? now + (volume === 'dim' ? settings.dimDays : settings.muteDays) * day : until);
    if (end && (!Number.isFinite(end.getTime()) || end.getTime() <= now)) throw new Error('Quiet time must end in the future');
    const result = this.db.update(inbox).set({ volume, quietUntil: end?.toISOString() ?? null }).where(and(eq(inbox.id, item), eq(inbox.toKind, who.kind), eq(inbox.to, who.id))).run();
    if (!result.changes) throw new Error('Inbox item not found for recipient');
  }

  /** Call alongside an actual content change, never a read or a volume edit.
   * Explicitly addressing the recipient breaks either quiet level. */
  changed(who: Recipient, item: string, askedByName = false): void {
    this.db.update(inbox).set({ volume: 'full', quietUntil: null }).where(and(
      eq(inbox.id, item), eq(inbox.toKind, who.kind), eq(inbox.to, who.id),
      askedByName ? ne(inbox.volume, 'full') : eq(inbox.volume, 'dim'),
    )).run();
  }

  /** Run at startup and each quiet deadline. Returns the next deadline. */
  expire(): number | undefined {
    this.db.update(inbox).set({ volume: 'full', quietUntil: null }).where(and(ne(inbox.volume, 'full'), lte(inbox.quietUntil, new Date(this.clock.now()).toISOString()))).run();
    return this.db.select({ until: inbox.quietUntil }).from(inbox).where(ne(inbox.volume, 'full')).all()
      .reduce<number | undefined>((next, row) => row.until === null ? next : Math.min(next ?? Infinity, Date.parse(row.until)), undefined);
  }
}
