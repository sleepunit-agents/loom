/** What loom last learned about each thing a machine's worker watches on it (`box_readings`), and the one
 * inbox item the machine's owner gets when a reading goes over a line. No model takes part. A worker sends
 * numbers and fixed words (machine-check.ts); what is a condition, and every sentence about it, is decided
 * and written here. loom also closes what it said: a later reading that is back under the line closes the
 * notice with what changed.
 *
 * A condition is one machine, one kind and one thing (which filesystem), and each time it is found is its
 * own occasion: a notice's source id names all four, so saying the same reading again raises nothing new,
 * and a notice its owner closed by hand is not sent again for the same occasion.
 *
 * This is the one writer of the table. The latest reading is kept and nothing before it.
 *
 * A machine that has stopped reporting changes nothing here. Its conditions and their notices stay as
 * they were, and its silence is its own notice (Machines.sweep) for the machines marked always on.
 *
 * A thing the worker names as unknown raises nothing and clears nothing: what was last read stands, with
 * the time it was read. But not for ever. Once a thing has been unknown for STALE_MS loom closes what it
 * said about it, saying that it can no longer be read, and marks the record stale; a later reading that is
 * over a line is then a new occasion. That is for one thing among others that are read. When every disk
 * of a machine is unknown at once, the worker is not seeing its filesystems, which says nothing of any
 * one of them: no disk's notice is closed, and after a day the owner gets one notice that the machine's
 * disks have not been readable, closed when any of them is read again.
 *
 * A filesystem is one thing. Two watched paths on it are one record under the name loom first knew it by.
 *
 * Nothing here knows that the reading came from a worker on the machine itself. `evaluate` turns numbers
 * into a level; the record and the notices go by the level alone. A reader on another host that reports a
 * fixed-word condition about a named machine (a hypervisor's "waiting on disk") would write the same row
 * with a kind of its own and a level it states, through an operation with its own credential. */
import { and, eq, isNotNull } from 'drizzle-orm';
import type { DataDatabase } from '../core/data/database.js';
import { boxAlertSettings, boxes, boxReadings } from '../core/data/schema.js';
import { householdTimezone } from '../core/data/household-settings.js';
import { DAY_MS } from '../core/day.js';
import { Conversations, lateMailWaits } from '../core/conversations/index.js';
import { MACHINE_CHECK_MS, type MachineReading } from './machine-check.js';

type Reading = typeof boxReadings.$inferSelect;
type Box = typeof boxes.$inferSelect;
export type AlertLines = Omit<typeof boxAlertSettings.$inferSelect, 'singleton'>;
/** The lines a household has until it sets its own: the columns' own defaults (schema.ts), named once here. */
export const ALERT_LINE_DEFAULTS: Readonly<AlertLines> = Object.freeze({
  diskPercent: boxAlertSettings.diskPercent.default as number,
  diskUrgentPercent: boxAlertSettings.diskUrgentPercent.default as number,
  diskFreeMib: boxAlertSettings.diskFreeMib.default as number,
  memoryFreeMib: boxAlertSettings.memoryFreeMib.default as number,
});
/** The household's lines, or the defaults while it has set none. */
export function alertLines(db: DataDatabase): AlertLines {
  const row = db.select().from(boxAlertSettings).get();
  if (!row) return { ...ALERT_LINE_DEFAULTS };
  const { singleton: _one, ...lines } = row;
  return lines;
}
/** Set the household's lines. The columns' checks refuse a line outside its range. */
export function setAlertLines(db: DataDatabase, lines: AlertLines): AlertLines {
  db.insert(boxAlertSettings).values({ singleton: 1, ...lines }).onConflictDoUpdate({ target: boxAlertSettings.singleton, set: lines }).run();
  return alertLines(db);
}
/** How far under a percent line a reading must be before a condition raised at that line is cleared. */
export const CLEAR_POINTS = 3;
/** How much more than a floor there must be before a condition raised under that floor is cleared. */
export const CLEAR_ROOM = 1.1;
/** A floor in mebibytes is asked only of something at least this many times its size: a disk smaller than
 * that is held to the percent line alone, or it would be under the floor however empty it was. */
const FLOOR_APPLIES = 2;
/** How long a thing may be unknown before loom closes what it said about it. */
export const STALE_MS = DAY_MS;
/** "Two readings in a row" means the one before was read no longer ago than this many of the worker's intervals. */
export const IN_A_ROW_INTERVALS = 3;
const MIB = 1024 * 1024;

type Level = Reading['level'];
type Values = Pick<Reading, 'usedPercent' | 'sizeMib' | 'freeMib' | 'answers'>;
const none: Values = { usedPercent: null, sizeMib: null, freeMib: null, answers: null };
/** A reading as loom keeps it: whole mebibytes, and a disk's fullness as `df` works it out, used over used
 * and available, rounded up to a whole percent (84.2% is 85%), because `df` is what an owner will hold a
 * notice against. That whole number is the one shown and the one held to the lines. In whole numbers
 * throughout: a fraction that is a hair over a whole percent in floating point must not round up a point. */
function values(reading: MachineReading): Values {
  if (reading.kind === 'containers') return { ...none, answers: reading.answers === true };
  const size = Math.floor((reading.sizeBytes ?? 0) / MIB), free = Math.min(size, Math.floor((reading.freeBytes ?? 0) / MIB));
  if (reading.kind === 'memory') return { ...none, sizeMib: size, freeMib: free };
  const bytes = reading.sizeBytes ?? 0, used = Math.max(0, bytes - (reading.freeBytes ?? 0));
  return { ...none, sizeMib: size, freeMib: free, usedPercent: bytes > 0 ? Math.min(100, Number((100n * BigInt(used) + BigInt(bytes) - 1n) / BigInt(bytes))) : 0 };
}
const floorOf = (floor: number, size: number) => size >= floor * FLOOR_APPLIES ? floor : 0;

/** What a reading is, given what the one before it was. A condition is raised at its line and cleared only
 * under it by a margin (CLEAR_POINTS, CLEAR_ROOM), so a reading that hovers at the line raises once and
 * stays raised. A disk is raised by the first reading over the line, since a disk does not fill and empty
 * between two readings. Memory and the container runtime do dip for a moment (a build, an engine being
 * restarted), so those are raised only by two readings in a row: `recent` says the one before was read
 * lately enough to count as the one before (IN_A_ROW_INTERVALS). An older one starts the count again. */
export function evaluate(kind: Reading['kind'], now: Values, before: Pick<Reading, 'level' | 'freeMib' | 'answers'> | undefined, lines: AlertLines, recent = true): Level {
  const was = before?.level ?? 'ok';
  if (kind === 'containers') return now.answers ? 'ok' : was !== 'ok' || (recent && before?.answers === false) ? 'raised' : 'ok';
  const size = now.sizeMib ?? 0, free = now.freeMib ?? 0;
  if (kind === 'memory') {
    const floor = floorOf(lines.memoryFreeMib, size);
    if (was !== 'ok') return free < floor * CLEAR_ROOM ? 'raised' : 'ok';
    return free < floor && recent && before?.freeMib != null && before.freeMib < floor ? 'raised' : 'ok';
  }
  const percent = now.usedPercent ?? 0, floor = floorOf(lines.diskFreeMib, size);
  if (percent >= lines.diskUrgentPercent || (was === 'urgent' && percent > lines.diskUrgentPercent - CLEAR_POINTS)) return 'urgent';
  if (percent >= lines.diskPercent || free < floor) return 'raised';
  return was !== 'ok' && (percent > lines.diskPercent - CLEAR_POINTS || free < floor * CLEAR_ROOM) ? 'raised' : 'ok';
}

/** An amount of room as a person reads it, in binary units, rounded down: never more room than there is. */
export function roomWords(mib: number): string {
  if (mib < 1024) return `${mib} MB`;
  const gb = mib / 1024;
  return `${gb < 10 ? Math.floor(gb * 10) / 10 : Math.floor(gb)} GB`;
}
// One notice per time a thing is found over a line, and one per time it is found over the urgent line: a
// notice already closed under an id is never sent again (Conversations.send), so each id names the occasion.
const raisedId = (row: Reading) => `machine-condition:${JSON.stringify([row.box, row.kind, row.thing, row.since])}`;
const urgentId = (row: Reading) => `machine-condition-urgent:${JSON.stringify([row.box, row.kind, row.thing, row.urgentSince])}`;
// One notice per time a machine's disks all became unreadable together.
const blindId = (box: string, since: string) => `machine-blind:${JSON.stringify([box, since])}`;
const where = (key: Pick<Reading, 'box' | 'kind' | 'thing'>) => and(eq(boxReadings.box, key.box), eq(boxReadings.kind, key.kind), eq(boxReadings.thing, key.thing));

type Numbers = Pick<Reading, 'kind' | 'thing' | 'level' | 'usedPercent' | 'sizeMib' | 'freeMib'>;
/** The sentence a machine's owner reads when a condition is raised. `row` is the record as just written:
 * the sentence names the line the reading is on the wrong side of, as the lines now are. Each is true of
 * its reading whichever way the condition came to be raised:
 * - urgent: sent only on reaching the urgent line, so the reading is at or over it.
 * - raised at or over the percent line, from fine or from urgent.
 * - raised under the free-room floor, which is only ever asked of a disk it applies to (floorOf).
 * - raised and under both, which only a disk coming down from urgent can be: it is inside the margin a
 *   line clears by, and the sentence says that and no more.
 * - memory: raised only under a floor that applies, which is then the household's own number. */
export function raisedWords(machine: string, row: Numbers, lines: AlertLines): string {
  if (row.kind === 'containers') return `${machine}: the container runtime is not answering.`;
  const free = roomWords(row.freeMib ?? 0);
  if (row.kind === 'memory') return `${machine}: ${free} of memory is available. Alerts under ${roomWords(lines.memoryFreeMib)}.`;
  const percent = row.usedPercent ?? 0, floor = floorOf(lines.diskFreeMib, row.sizeMib ?? 0);
  if (row.level === 'urgent') return `${machine}: ${row.thing} is ${percent}% full (${free} free). Urgent at ${lines.diskUrgentPercent}%.`;
  if (percent >= lines.diskPercent) return `${machine}: ${row.thing} is ${percent}% full (${free} free). Alerts at ${lines.diskPercent}%.`;
  if ((row.freeMib ?? 0) < floor) return `${machine}: ${row.thing} has ${free} free (${percent}% full). Alerts under ${roomWords(floor)} free.`;
  return `${machine}: ${row.thing} is ${percent}% full (${free} free). Not yet clear of the alert lines (${lines.diskPercent}%${floor ? `, ${roomWords(floor)} free` : ''}).`;
}
/** Why a notice is closed by a reading, as the sentence its reader finds on it. `before` is the record the
 * notice was open for and `row` the record as just written. There are two causes and the sentence says
 * which. The reading recovered: `before`, held to the lines as they now are, would still be raised, so it
 * is the numbers that moved, and the sentence names the line they are now clear of. Or the lines changed:
 * `before` would not be raised by the lines as they now are, so nothing about the machine got better, and
 * the sentence says the line moved (or is no longer asked of this machine) and what the reading is.
 * (A notice closed for any other reason, no longer watched or no longer readable, is not closed here.) */
export function clearedWords(before: Numbers, row: Numbers, lines: AlertLines): string {
  if (row.kind === 'containers') return 'The container runtime is answering again.';
  const free = roomWords(row.freeMib ?? 0), was = before.freeMib ?? 0;
  if (row.kind === 'memory') {
    const floor = floorOf(lines.memoryFreeMib, row.sizeMib ?? 0);
    if (!floor) return `The memory floor is now ${roomWords(lines.memoryFreeMib)}, which is not asked of a machine with ${roomWords(row.sizeMib ?? 0)} of memory; ${free} is available.`;
    if (was < floor * CLEAR_ROOM) return `${free} of memory is available, over the ${roomWords(floor)} floor.`;
    return `The memory floor is now ${roomWords(floor)}; ${free} of memory is available.`;
  }
  const percent = row.usedPercent ?? 0, full = before.usedPercent ?? 0, said = `${row.thing} is at ${percent}% (${free} free)`;
  // The urgent notice of a disk that is still raised: only the urgent line is spoken of.
  if (row.level !== 'ok') return full > lines.diskUrgentPercent - CLEAR_POINTS ? `${said}, under the ${lines.diskUrgentPercent}% line.` : `The urgent line is now ${lines.diskUrgentPercent}%; ${said}.`;
  const floor = floorOf(lines.diskFreeMib, row.sizeMib ?? 0), wasFloor = floorOf(lines.diskFreeMib, before.sizeMib ?? 0);
  if (full > lines.diskPercent - CLEAR_POINTS) return `${said}, under the ${lines.diskPercent}% line.`;
  if (floor && wasFloor && was < wasFloor * CLEAR_ROOM) return `${row.thing} has ${free} free (${percent}% full), over the ${roomWords(floor)} floor.`;
  return `The lines changed: alerts are now at ${lines.diskPercent}%${floor ? ` or under ${roomWords(floor)} free` : ''}; ${said}.`;
}

/** The reason a notice is closed with when its thing has been unknown for STALE_MS: that it can no longer
 * be read, and what the last reading was. `when` is the time of that reading as its reader's household writes times. */
export function staleWords(row: Reading, when: string): string {
  if (row.kind === 'containers') return `The container runtime can no longer be asked; last asked ${when}.`;
  if (row.kind === 'memory') return `Memory can no longer be read; last read ${when} with ${roomWords(row.freeMib ?? 0)} available.`;
  return `${row.thing} can no longer be read; last read ${when} at ${row.usedPercent}%.`;
}

export class MachineConditions {
  constructor(readonly db: DataDatabase, readonly now: () => string) {}

  private at(): string {
    const at = this.now();
    if (!Number.isFinite(Date.parse(at))) throw new Error('Invalid reading time');
    return at;
  }

  /** Say and close what the change from one record of a thing to the next makes true and untrue. */
  private settle(machine: Box | undefined, before: Reading | undefined, after: Reading | undefined, lines: AlertLines, at: string, gone = 'No longer watched'): void {
    const notices = new Conversations(this.db, () => at, lateMailWaits);
    // `after` is absent when the thing is no longer watched, and stale when it has been unknown too long:
    // neither is a reading that put anything right, and the reason says which.
    const why = (now: Reading | undefined) => now && !now.stale ? clearedWords(before!, now, lines) : gone;
    if (before && before.level !== 'ok' && (!after || after.level === 'ok')) notices.resolveSource('notice', raisedId(before), why(after));
    if (before?.level === 'urgent' && after?.level !== 'urgent') notices.resolveSource('notice', urgentId(before), why(after));
    if (!machine || !after || after.level === 'ok' || after.level === before?.level) return;
    // Over the urgent line there is one urgent notice, beside the one already open if the thing was raised
    // before. Back under it and still raised, the ordinary notice of this occasion is the one that stands:
    // sent now if the thing went straight to urgent, and otherwise still open (or closed by its reader).
    notices.send({ toKind: 'person', to: machine.owner, member: machine.owner, source: 'notice', sourceId: after.level === 'urgent' ? urgentId(after) : raisedId(after),
      fromKind: 'unknown', words: raisedWords(machine.name, after, lines), refs: [machine.id] });
  }

  /** A time in the household's zone as loom's screens say one ("Nov 19, 8:05 AM"; web/src/kit/time.ts), for the words of a notice. */
  private when(iso: string): string {
    return new Intl.DateTimeFormat('en-US', { timeZone: householdTimezone(this.db), month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(new Date(iso)).replace(/\u202f/g, ' ');
  }

  /** Since when every disk of a machine has been unknown, or nothing while any is read (or it has none).
   * That is one condition of the machine and not one of each disk: the worker cannot see its filesystems
   * (its reader is held up by one that does not answer), which says nothing about any one of them. */
  private blindSince(box: string): string | null {
    const disks = this.db.select().from(boxReadings).where(and(eq(boxReadings.box, box), eq(boxReadings.kind, 'disk'))).all();
    if (!disks.length || disks.some(disk => disk.unknownSince === null)) return null;
    return disks.map(disk => disk.unknownSince!).sort().at(-1)!;
  }

  /** Everything a worker watches on its machine, whole: a thing it no longer names is no longer watched,
   * and one it names as unknown keeps what was last read, since not knowing is not a fault. `everyMs` is how
   * often this worker reads. Says whether a state a person is shown changed: a condition raised or cleared,
   * the container runtime answering or not, a thing becoming unknown, readable again or stale, a thing
   * watched for the first time or no more. A reading that moves only numbers says no, and only such a
   * reading may be kept from waking every open window (Context.stampOnly). */
  read(box: string, readings: readonly MachineReading[], everyMs = MACHINE_CHECK_MS): { changed: boolean } {
    const at = this.at(), now = Date.parse(at);
    return this.db.transaction(() => {
      const machine = this.db.select().from(boxes).where(eq(boxes.id, box)).get();
      if (!machine || machine.revokedAt) throw new Error('Machine not available');
      const lines = alertLines(this.db), seen = new Set<string>(), notices = new Conversations(this.db, () => at, lateMailWaits);
      const name = (key: Pick<Reading, 'kind' | 'thing'>) => JSON.stringify([key.kind, key.thing]);
      const kept = new Set(this.db.select().from(boxReadings).where(eq(boxReadings.box, box)).all().map(name));
      const disk = (thing: string) => name({ kind: 'disk', thing });
      const blindBefore = this.blindSince(box);
      // A filesystem is one thing, whichever watched path the worker has stand for it this time. Where it
      // says path B is the same disk as path A, gives A's numbers, and loom knows the disk as B and knows
      // no A, the numbers are B's: the record and its open notice go on under the name they have.
      const numbered = new Set(readings.filter(reading => reading.kind === 'disk' && !reading.unknown && reading.sameAs === undefined).map(reading => reading.thing ?? ''));
      const knownAs = new Map<string, string>();
      for (const reading of readings) {
        const stands = reading.sameAs, thing = reading.thing ?? '';
        if (reading.kind === 'disk' && stands !== undefined && numbered.has(stands) && kept.has(disk(thing)) && !kept.has(disk(stands)) && !knownAs.has(stands)) knownAs.set(stands, thing);
      }
      const renamed = new Set(knownAs.values());
      // With no disk read at all, the worker is not seeing its filesystems: no one of them is given up on for that.
      const sees = numbered.size > 0;
      let changed = false;
      for (const reading of readings) {
        const thing = reading.kind === 'disk' ? reading.thing ?? '' : '';
        // The disk's numbers arrive under the other path, and are written to this record there.
        if (reading.sameAs !== undefined && renamed.has(thing)) continue;
        const key = { box, kind: reading.kind, thing: reading.sameAs === undefined ? knownAs.get(thing) ?? thing : thing };
        if (seen.has(name(key))) continue;
        seen.add(name(key));
        const before = this.db.select().from(boxReadings).where(where(key)).get();
        // A path that is the same disk as another, where loom has a record under each (two disks once, one
        // now: a mount that is not there) is not a reading of the disk this record was: it is unknown.
        if (reading.unknown || reading.sameAs !== undefined) {
          // Never read, or already given up on: there is nothing to keep and nothing more to close.
          if (!before || before.stale) continue;
          if (before.unknownSince === null) { this.db.update(boxReadings).set({ unknownSince: at }).where(where(key)).run(); changed = true; continue; }
          if (now - Date.parse(before.unknownSince) < STALE_MS || (key.kind === 'disk' && !sees)) continue;
          const after = this.db.update(boxReadings).set({ stale: true, level: 'ok', since: null, urgentSince: null }).where(where(key)).returning().get()!;
          this.settle(machine, before, after, lines, at, staleWords(before, this.when(before.readAt)));
          changed = true;
          continue;
        }
        const read = values(reading), age = before ? now - Date.parse(before.readAt) : NaN;
        const level = evaluate(key.kind, read, before, lines, age >= 0 && age <= IN_A_ROW_INTERVALS * everyMs);
        const next = { ...read, level, readAt: at, unknownSince: null, stale: false,
          since: level === 'ok' ? null : before && before.level !== 'ok' ? before.since : at,
          urgentSince: level !== 'urgent' ? null : before?.level === 'urgent' ? before.urgentSince : at };
        const after = before
          ? this.db.update(boxReadings).set(next).where(where(key)).returning().get()!
          : this.db.insert(boxReadings).values({ ...key, ...next }).returning().get();
        this.settle(machine, before, after, lines, at);
        if (!before || before.level !== after.level || before.answers !== after.answers || before.unknownSince !== null || before.stale) changed = true;
      }
      for (const row of this.db.select().from(boxReadings).where(eq(boxReadings.box, box)).all()) {
        if (seen.has(name(row))) continue;
        this.drop([row], lines, at); changed = true;
      }
      // The machine's own condition: every disk unknown, for a day. One notice for the occasion, closed
      // when any disk is read again (or none is watched any more). No disk's own notice is closed for it.
      const blind = this.blindSince(box);
      if (blindBefore !== null && blind !== blindBefore && notices.resolveSource('notice', blindId(box, blindBefore),
        this.db.select().from(boxReadings).where(and(eq(boxReadings.box, box), eq(boxReadings.kind, 'disk'))).get() ? 'Its disks are being read again.' : 'No longer watched').length) changed = true;
      if (blind !== null && now - Date.parse(blind) >= STALE_MS && notices.send({ toKind: 'person', to: machine.owner, member: machine.owner, source: 'notice', sourceId: blindId(box, blind),
        fromKind: 'unknown', words: `${machine.name}: its disks have not been readable since ${this.when(blind)}.`, refs: [machine.id] }).at === at) changed = true;
      return { changed };
    }, { behavior: 'immediate' });
  }

  private drop(rows: readonly Reading[], lines: AlertLines, at: string): boolean {
    for (const row of rows) { this.db.delete(boxReadings).where(where(row)).run(); this.settle(undefined, row, undefined, lines, at); }
    return rows.length > 0;
  }

  /** A machine taken out of the household reports no more, so nothing else would close what was said about
   * it: its readings are dropped and their notices closed. Says whether there were any. Nothing is raised
   * here; a condition is raised by the reading that finds it (read, above). */
  sweep(): boolean {
    const at = this.at();
    return this.db.transaction(() => {
      const rows = this.db.select({ reading: boxReadings }).from(boxReadings).innerJoin(boxes, eq(boxes.id, boxReadings.box)).where(isNotNull(boxes.revokedAt)).all().map(row => row.reading);
      const notices = new Conversations(this.db, () => at, lateMailWaits);
      for (const box of new Set(rows.map(row => row.box))) { const blind = this.blindSince(box); if (blind !== null) notices.resolveSource('notice', blindId(box, blind), 'No longer watched'); }
      return this.drop(rows, alertLines(this.db), at);
    }, { behavior: 'immediate' });
  }
}
