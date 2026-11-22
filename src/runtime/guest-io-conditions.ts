import { randomUUID } from 'node:crypto';
import { and, eq, isNotNull, lte, or } from 'drizzle-orm';
import { Conversations, lateMailWaits } from '../core/conversations/index.js';
import type { DataDatabase } from '../core/data/database.js';
import { DAY_MS } from '../core/day.js';
import { boxes, guestIoReadings } from '../core/data/schema.js';
import { MACHINE_CHECK_MS } from './machine-reading-time.js';
import type { GuestPressureReading } from './guest-io-pressure.js';

const HIGH = 4000;
const SUSTAINED_MINUTES = 15;
const SUSTAINED_MS = SUSTAINED_MINUTES * 60_000;
const MAX_GAP_MS = MACHINE_CHECK_MS * 1.5;

/** One report replaces the reporting host's watch list. Unknown interrupts a
 * pending duration but only a measured recovery can close a notice as recovered. */
export function recordGuestPressure(db: DataDatabase, box: string, readings: readonly GuestPressureReading[], at: string) {
  const machine = db.select().from(boxes).where(eq(boxes.id, box)).get();
  if (!machine) throw new Error('Unknown machine');
  const mail = new Conversations(db, () => at, lateMailWaits);
  const previous = new Map(db.select().from(guestIoReadings).where(eq(guestIoReadings.box, box)).all().map(row => [row.guest, row]));
  let changed = false;
  for (const sample of readings) {
    const guest = sample.guest, before = previous.get(guest);
    previous.delete(guest);
    let notice = before?.notice ?? null, highSince: string | null = null;
    const value = 'ioHundredths' in sample ? sample.ioHundredths : null;
    if (value !== null && value >= HIGH) {
      const gap = before ? Date.parse(at) - Date.parse(before.observedAt) : Infinity;
      highSince = gap >= 0 && gap <= MAX_GAP_MS ? before?.highSince ?? at : at;
      if (!notice && Date.parse(at) - Date.parse(highSince) >= SUSTAINED_MS) {
        notice = 'guest-io-' + randomUUID();
        mail.send({ toKind: 'person', to: machine.owner, member: machine.owner, fromKind: 'unknown',
          source: 'notice', sourceId: notice, refs: [box],
          words: `${machine.name}: CT ${guest} has been waiting on disk for at least ${HIGH / 100}% of the time for ${SUSTAINED_MINUTES} minutes. Latest reading: ${value / 100}%.` });
        changed = true;
      }
    } else if (value !== null && notice) {
      mail.resolveSource('notice', notice, `CT ${guest} is waiting on disk ${value / 100}% of the time, below ${HIGH / 100}%.`);
      notice = null;
      changed = true;
    }
    // An unreadable cgroup still belongs to the watch list. Keep the last
    // measured time so repeated unknowns cannot keep an old notice open forever.
    const observedAt = value === null ? before?.observedAt ?? at : at;
    const row = { box, guest, observedAt, ioHundredths: value, highSince, notice };
    db.insert(guestIoReadings).values(row).onConflictDoUpdate({ target: [guestIoReadings.box, guestIoReadings.guest], set: row }).run();
  }
  for (const row of previous.values()) {
    if (row.notice) {
      mail.resolveSource('notice', row.notice, `CT ${row.guest} is no longer watched on ${machine.name}.`);
      changed = true;
    }
    db.delete(guestIoReadings).where(and(eq(guestIoReadings.box, box), eq(guestIoReadings.guest, row.guest))).run();
  }
  return changed;
}

export function sweepGuestPressure(db: DataDatabase, at: string) {
  const cutoff = new Date(Date.parse(at) - DAY_MS).toISOString();
  const rows = db.select({ reading: guestIoReadings, revoked: boxes.revokedAt }).from(guestIoReadings)
    .innerJoin(boxes, eq(guestIoReadings.box, boxes.id))
    .where(or(isNotNull(boxes.revokedAt), lte(guestIoReadings.observedAt, cutoff))).all();
  const mail = new Conversations(db, () => at, lateMailWaits);
  for (const { reading, revoked } of rows) {
    if (reading.notice) mail.resolveSource('notice', reading.notice, revoked
      ? 'Machine was removed from the household.' : `No disk-wait measurement for CT ${reading.guest} for a day.`);
    db.delete(guestIoReadings).where(and(eq(guestIoReadings.box, reading.box), eq(guestIoReadings.guest, reading.guest))).run();
  }
  return rows.length > 0;
}
