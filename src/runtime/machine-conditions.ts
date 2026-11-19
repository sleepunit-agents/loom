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
 * over a line is then a new occasion.
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
/** A reading as loom keeps it: whole mebibytes, and a disk's fullness as a whole percent rounded down, so
 * that the number shown and the number held to the line are the same number. */
function values(reading: MachineReading): Values {
  if (reading.kind === 'containers') return { ...none, answers: reading.answers === true };
  const size = Math.floor((reading.sizeBytes ?? 0) / MIB), free = Math.min(size, Math.floor((reading.freeBytes ?? 0) / MIB));
  if (reading.kind === 'memory') return { ...none, sizeMib: size, freeMib: free };
  const bytes = reading.sizeBytes ?? 0, used = Math.max(0, bytes - (reading.freeBytes ?? 0));
  return { ...none, sizeMib: size, freeMib: free, usedPercent: bytes > 0 ? Math.min(100, Math.floor(100 * used / bytes)) : 0 };
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

/** An amount of room as a person reads it. The units are binary, written as `df -h` writes them. */
export function roomWords(mib: number): string {
  if (mib < 1024) return `${mib} MB`;
  const gb = mib / 1024;
  return `${gb < 10 ? Math.floor(gb * 10) / 10 : Math.floor(gb)} GB`;
}
// One notice per time a thing is found over a line, and one per time it is found over the urgent line: a
// notice already closed under an id is never sent again (Conversations.send), so each id names the occasion.
const raisedId = (row: Reading) => `machine-condition:${JSON.stringify([row.box, row.kind, row.thing, row.since])}`;
const urgentId = (row: Reading) => `machine-condition-urgent:${JSON.stringify([row.box, row.kind, row.thing, row.urgentSince])}`;
const where = (key: Pick<Reading, 'box' | 'kind' | 'thing'>) => and(eq(boxReadings.box, key.box), eq(boxReadings.kind, key.kind), eq(boxReadings.thing, key.thing));

/** Whether a disk is raised for its free room and not for how full it is: the notice then speaks of the floor.
 * Never for a disk too small to be held to the floor (floorOf): the notice says only what is true of that disk. */
const underFloor = (row: Reading, lines: AlertLines) => (row.usedPercent ?? 0) < lines.diskPercent && (row.freeMib ?? 0) < floorOf(lines.diskFreeMib, row.sizeMib ?? 0);
/** The sentence a machine's owner reads when a condition is raised. */
export function raisedWords(machine: string, row: Reading, lines: AlertLines): string {
  if (row.kind === 'containers') return `${machine}: the container runtime is not answering.`;
  const free = roomWords(row.freeMib ?? 0);
  if (row.kind === 'memory') return `${machine}: ${free} of memory is available. Alerts under ${roomWords(lines.memoryFreeMib)}.`;
  if (row.level === 'urgent') return `${machine}: ${row.thing} is ${row.usedPercent}% full (${free} free). Urgent at ${lines.diskUrgentPercent}%.`;
  if (underFloor(row, lines)) return `${machine}: ${row.thing} has ${free} free (${row.usedPercent}% full). Alerts under ${roomWords(lines.diskFreeMib)} free.`;
  return `${machine}: ${row.thing} is ${row.usedPercent}% full (${free} free). Alerts at ${lines.diskPercent}%.`;
}
/** What changed, as the reason a notice is closed with: the reading as it now is, and the line it is back
 * on the right side of. `before` is the record the notice was open for. */
export function clearedWords(before: Reading, row: Reading, lines: AlertLines): string {
  if (row.kind === 'containers') return 'The container runtime is answering again.';
  const free = roomWords(row.freeMib ?? 0);
  if (row.kind === 'memory') return `${free} of memory is available, over the ${roomWords(lines.memoryFreeMib)} floor.`;
  // Raised and not held there by how full it was: it was its free room that kept it raised.
  if (row.level === 'ok' && before.level === 'raised' && (before.usedPercent ?? 0) <= lines.diskPercent - CLEAR_POINTS && floorOf(lines.diskFreeMib, row.sizeMib ?? 0) > 0) return `${row.thing} has ${free} free (${row.usedPercent}% full), over the ${roomWords(lines.diskFreeMib)} floor.`;
  return `${row.thing} is at ${row.usedPercent}% (${free} free), under the ${row.level === 'ok' ? lines.diskPercent : lines.diskUrgentPercent}% line.`;
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

  /** The time of a reading as the household writes times, for the words of a notice. */
  private when(iso: string): string {
    return new Intl.DateTimeFormat('en-GB', { timeZone: householdTimezone(this.db), day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(iso));
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
      const lines = alertLines(this.db), seen = new Set<string>();
      const name = (key: Pick<Reading, 'kind' | 'thing'>) => JSON.stringify([key.kind, key.thing]);
      let changed = false;
      for (const reading of readings) {
        const key = { box, kind: reading.kind, thing: reading.kind === 'disk' ? reading.thing ?? '' : '' };
        if (seen.has(name(key))) continue;
        seen.add(name(key));
        const before = this.db.select().from(boxReadings).where(where(key)).get();
        if (reading.unknown) {
          // Never read, or already given up on: there is nothing to keep and nothing more to close.
          if (!before || before.stale) continue;
          if (before.unknownSince === null) { this.db.update(boxReadings).set({ unknownSince: at }).where(where(key)).run(); changed = true; continue; }
          if (now - Date.parse(before.unknownSince) < STALE_MS) continue;
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
    return this.db.transaction(() => this.drop(this.db.select({ reading: boxReadings }).from(boxReadings).innerJoin(boxes, eq(boxes.id, boxReadings.box))
      .where(isNotNull(boxes.revokedAt)).all().map(row => row.reading), alertLines(this.db), at), { behavior: 'immediate' });
  }
}
