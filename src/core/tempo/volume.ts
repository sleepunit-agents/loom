import { and, eq, ne, sql } from 'drizzle-orm';
import type { DataDatabase } from '../data/database.js';
import { inbox, tempoSettings } from '../data/schema.js';
import type { Clock } from '../clock.js';

export type Recipient = { kind: 'person' | 'agent'; id: string };
export type Volume = 'full' | 'dim' | 'mute';
export type Timings = { settleSeconds: number; dimDays: number; muteDays: number };
/** What a person or agent has until they change it: the columns' own defaults, read from the schema. */
export const defaultTimings: Readonly<Timings> = Object.freeze({ settleSeconds: tempoSettings.settleSeconds.default as number,
  dimDays: tempoSettings.dimDays.default as number, muteDays: tempoSettings.muteDays.default as number });
/** The one read of someone's timings: their row, or the defaults when they have none. */
export function readTimings(db: DataDatabase, who: Recipient): Timings {
  const row = db.select().from(tempoSettings).where(and(eq(tempoSettings.whoKind, who.kind), eq(tempoSettings.who, who.id))).get();
  return row ? { settleSeconds: row.settleSeconds, dimDays: row.dimDays, muteDays: row.muteDays } : { ...defaultTimings };
}
const day = 86_400_000;
/** How long new mail may settle before it is shown (none to a day), and how long dim and mute may last (a day
 * to ten years). The one statement of both: a household change is held to them where it is filed, and
 * `setTimings` holds every caller to them. */
export const SETTLE_SECONDS_MAX = 86_400, QUIET_DAYS_MAX = 3650;
const within = (value: number, min: number, max: number) => Number.isSafeInteger(value) && value >= min && value <= max;
export const validTimings = (value: Timings) => within(value.settleSeconds, 0, SETTLE_SECONDS_MAX)
  && within(value.dimDays, 1, QUIET_DAYS_MAX) && within(value.muteDays, 1, QUIET_DAYS_MAX);

/** Trusted in-process API. External callers must pass through the household door.
 * Inbox owns content and answers; Tempo owns only volume and its timings. */
export class InboxVolume {
  constructor(private db: DataDatabase, private clock: Clock) {}

  timings(who: Recipient): Timings { return readTimings(this.db, who); }

  setTimings(who: Recipient, patch: Partial<Timings>): Timings {
    const value = { ...this.timings(who), ...patch };
    if (!validTimings(value) || this.clock.now() + Math.max(value.dimDays, value.muteDays) * day > 8.64e15) throw new Error('Invalid Tempo timings');
    const key = and(eq(tempoSettings.whoKind, who.kind), eq(tempoSettings.who, who.id));
    if (Object.entries(defaultTimings).every(([k, v]) => value[k as keyof Timings] === v)) this.db.delete(tempoSettings).where(key).run();
    else this.db.insert(tempoSettings).values({ whoKind: who.kind, who: who.id, ...value }).onConflictDoUpdate({ target: [tempoSettings.whoKind, tempoSettings.who], set: value }).run();
    return value;
  }

  set(who: Recipient, item: string, volume: Volume, until?: string): void {
    if (!inbox.volume.enumValues.includes(volume)) throw new Error('Invalid volume');
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
    inboxContentChanged(this.db, who, item, askedByName);
  }

  /** Run at startup and each quiet deadline. Returns the next deadline;
   * notify subscriptions after an expiration actually changes stored volume. */
  expire(changed?: () => void): number | undefined {
    // Shared UTC columns allow both whole seconds and milliseconds. Compare
    // instants: lexical ordering would leave 18:00:00Z after 18:00:00.000Z,
    // repeatedly arming the timer at an already elapsed quiet deadline.
    const expired = this.db.update(inbox).set({ volume: 'full', quietUntil: null }).where(and(ne(inbox.volume, 'full'),
      sql`julianday(${inbox.quietUntil}) <= julianday(${new Date(this.clock.now()).toISOString()})`,
    )).run().changes;
    const next = this.db.select({ until: inbox.quietUntil }).from(inbox).where(ne(inbox.volume, 'full')).all()
      .reduce<number | undefined>((next, row) => row.until === null ? next : Math.min(next ?? Infinity, Date.parse(row.until)), undefined);
    if (expired) changed?.();
    return next;
  }
}

/** Shared content producers call this within their own atomic write. */
export function inboxContentChanged(db: DataDatabase, who: Recipient, item: string, askedByName = false): void {
  db.update(inbox).set({ volume: 'full', quietUntil: null }).where(and(
    eq(inbox.id, item), eq(inbox.toKind, who.kind), eq(inbox.to, who.id),
    askedByName ? ne(inbox.volume, 'full') : eq(inbox.volume, 'dim'),
  )).run();
}
