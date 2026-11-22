import { sweepGuestPressure } from './guest-io-conditions.js';
import { randomUUID } from 'node:crypto';
import { and, eq, gte, isNotNull, or } from 'drizzle-orm';
import type { DataDatabase } from '../core/data/database.js';
import { boxAlertSettings, boxes, boxReadings } from '../core/data/schema.js';
import { householdTimezone } from '../core/data/household-settings.js';
import { DAY_MS } from '../core/day.js';
import { Conversations, lateMailWaits } from '../core/conversations/index.js';
import type { MachineReading } from './machine-check.js';
import { READING_OLD_MS } from './machine-reading-time.js';

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
const clearRoom = (floor: number) => floor + Math.floor((floor + 9) / 10);
/** A floor in mebibytes is asked only of something at least this many times its size: a disk smaller than
 * that is held to the percent line alone, or it would be under the floor however empty it was. */
const FLOOR_APPLIES = 2;
/** How long a thing may be unknown before loom closes what it said about it. */
export const STALE_MS = DAY_MS;
const WATCHED_THINGS_MAX = 24;

const MAX_OBSERVED_INTERVAL_MS = 60 * 60_000;
const clockEpoch = randomUUID();
const MIB = 1024 * 1024;

type Values = Pick<Reading, 'usedPercent' | 'sizeMib' | 'freeMib' | 'engineStatus'>;
const none: Values = { usedPercent: null, sizeMib: null, freeMib: null, engineStatus: null };
/** A reading as loom keeps it: whole mebibytes, and a disk's fullness as `df` works it out, used over used
 * and available, rounded up to a whole percent (84.2% is 85%), because `df` is what an owner will hold a
 * notice against. That whole number is the one shown and the one held to the lines. In whole numbers
 * throughout: a fraction that is a hair over a whole percent in floating point must not round up a point. */
function values(reading: MachineReading): Values {
  if (reading.kind === 'containers') return { ...none, engineStatus: reading.engineStatus! };
  const size = Math.floor((reading.sizeBytes ?? 0) / MIB), free = Math.min(size, Math.floor((reading.freeBytes ?? 0) / MIB));
  if (reading.kind === 'memory') return { ...none, sizeMib: size, freeMib: free };
  const bytes = reading.sizeBytes ?? 0, used = Math.max(0, bytes - (reading.freeBytes ?? 0));
  return { ...none, sizeMib: size, freeMib: free, usedPercent: bytes > 0 ? Math.min(100, Number((100n * BigInt(used) + BigInt(bytes) - 1n) / BigInt(bytes))) : 0 };
}
const floorOf = (floor: number, size: number) => size >= floor * FLOOR_APPLIES ? floor : 0;

type OrdinaryLine = NonNullable<Reading['ordinaryLine']>;
const floorSetting = (kind: Reading['kind'], lines: AlertLines) => kind === 'memory' ? lines.memoryFreeMib : lines.diskFreeMib;
const holdsFloor = (read: Values, floor: number) => read.freeMib! < clearRoom(floorOf(floor, read.sizeMib ?? 0));
const holdsPercent = (read: Values, percent: number) => read.usedPercent! > percent - CLEAR_POINTS;

function ordinaryLine(row: Reading, read: Values, lines: AlertLines, consecutive: boolean): OrdinaryLine | null {
  if (row.kind === 'containers') {
    return read.engineStatus !== 200 && (row.ordinaryLine === 'engine' ||
      (consecutive && row.engineStatus !== null && row.engineStatus !== 200)) ? 'engine' : null;
  }
  const floor = floorSetting(row.kind, lines);
  if (row.ordinaryLine === 'floor' && holdsFloor(read, floor)) return 'floor';
  if (row.ordinaryLine === 'percent' && holdsPercent(read, lines.diskPercent)) return 'percent';
  if (row.kind === 'disk' && read.usedPercent! >= lines.diskPercent) return 'percent';
  if (read.freeMib! >= floorOf(floor, read.sizeMib!)) return null;
  if (row.kind === 'disk') return 'floor';
  return consecutive && row.freeMib !== null &&
    row.freeMib < floorOf(row.lastLines?.memoryFreeMib ?? floor, row.sizeMib ?? 0) ? 'floor' : null;
}

const megabytes = (mib: number) => `${mib.toLocaleString('en-US')} MB`;
const shownGb = (mib: number) => mib < 102_400 ? Math.floor(mib * 10 / 1024) / 10 : Math.floor(mib / 1024);
/** An amount of room as a person reads it, in binary units, rounded down. */
export function roomWords(mib: number): string {
  return mib < 1024 ? megabytes(mib) : `${shownGb(mib)} GB`;
}

function roomAgainst(mib: number, line: number): [string, string] {
  const reading = roomWords(mib), floor = roomWords(line);
  // Keep both figures in MB across the one-GB boundary if rounding hides part of the floor.
  // Elsewhere, a rounded floor must still be above the actual reading when it triggers.
  const lineShownMib = line < 1024 ? line : shownGb(line) * 1024;
  const crossesUnitBoundary = mib < 1024 && lineShownMib === 1024 && line !== 1024;
  return (mib !== line && reading === floor) || (mib < line && lineShownMib <= mib) || crossesUnitBoundary
    ? [megabytes(mib), megabytes(line)] : [reading, floor];
}
// One notice per time a thing is found over a line, and one per time it is found over the urgent line: a
// notice already closed under an id is never sent again (Conversations.send), so each id names the occasion.
const raisedId = (row: Reading) => `machine-condition:${JSON.stringify([row.box, row.kind, row.thing, row.generation, row.occasion])}`;
const urgentId = (row: Reading) => `machine-condition-urgent:${JSON.stringify([row.box, row.kind, row.thing, row.generation, row.urgentOccasion])}`;
const where = (key: Pick<Reading, 'box' | 'kind' | 'thing'>) => and(eq(boxReadings.box, key.box), eq(boxReadings.kind, key.kind), eq(boxReadings.thing, key.thing));

function raisedWords(machine: string, row: Reading, lines: AlertLines): string {
  if (row.kind === 'containers') return `${machine}: the container runtime answered with an error (${row.engineStatus}).`;
  const free = roomWords(row.freeMib!);
  if (row.level === 'urgent') return `${machine}: ${row.thing} is ${row.usedPercent}% full (${free} free). Urgent at ${lines.diskUrgentPercent}%.`;
  if (row.ordinaryLine === 'percent') {
    const line = row.usedPercent! >= lines.diskPercent ? `Alerts at ${lines.diskPercent}%.` : `Not yet clear of the ${lines.diskPercent}% alert line.`;
    return `${machine}: ${row.thing} is ${row.usedPercent}% full (${free} free). ${line}`;
  }
  const floor = floorSetting(row.kind, lines);
  const [room, line] = roomAgainst(row.freeMib!, floor);
  if (row.kind === 'memory') return `${machine}: ${room} of memory is available. Alerts under ${line}.`;
  const threshold = row.freeMib! < floor ? `Alerts under ${line} free.` : `Not yet clear of the ${line} floor.`;
  return `${machine}: ${row.thing} has ${room} free (${row.usedPercent}% full). ${threshold}`;
}

function clearedWords(before: Reading, row: Reading, lines: AlertLines, urgent: boolean): string {
  if (row.kind === 'containers') return 'The container runtime answered successfully.';
  const free = row.freeMib!;
  const said = `${row.thing} is at ${row.usedPercent}% (${roomWords(free)} free)`;
  if (urgent || before.ordinaryLine === 'percent') {
    const current = urgent ? lines.diskUrgentPercent : lines.diskPercent;
    const original = urgent ? before.urgentLineValue! : before.ordinaryLineValue!;
    const changed = original !== current && holdsPercent(row, original) ? 'The lines changed. ' : '';
    return `${changed}${said}, under the ${current}% ${urgent ? 'urgent ' : ''}line.`;
  }
  const floor = floorSetting(row.kind, lines), original = before.ordinaryLineValue!;
  const changed = original !== floor && holdsFloor(row, original) ? 'The lines changed. ' : '';
  const [room, line] = roomAgainst(free, floor);
  const memory = row.kind === 'memory';
  if (!floor) return memory ? `${changed}The memory floor was switched off.` : `${changed}The disk floor was switched off; ${said}.`;
  if (!floorOf(floor, row.sizeMib!)) {
    return memory ? `${changed}The ${line} memory floor no longer applies to a machine with ${roomWords(row.sizeMib!)} of memory; ${room} is available.`
      : `${changed}The ${line} floor no longer applies to ${row.thing}; ${room} is free.`;
  }
  return memory ? `${changed}${room} of memory is available, over the ${line} floor.`
    : `${changed}${row.thing} has ${room} free (${row.usedPercent}% full), over the ${line} floor.`;
}

/** Describe the last reading without attributing its absence to a cause. */
export function staleWords(row: Reading, when: string): string {
  const thing = row.kind === 'containers' ? 'The container runtime' : row.kind === 'memory' ? 'Memory' : row.thing;
  const value = row.kind === 'containers' ? `HTTP ${row.engineStatus}` :
    row.kind === 'memory' ? `${roomWords(row.freeMib ?? 0)} available` :
      `${row.usedPercent}% full (${roomWords(row.freeMib ?? 0)} free)`;
  return `${thing} has not been read since ${when}; the last reading was ${value}.`;
}

export class MachineConditions {
  constructor(readonly db: DataDatabase, readonly now: () => string, readonly elapsed = () => performance.now()) {}

  private at(): string {
    const at = this.now();
    if (!Number.isFinite(Date.parse(at))) throw new Error('Invalid reading time');
    return at;
  }

  /** Say and close what the change from one record of a thing to the next makes true and untrue. */
  private settle(machine: Box | undefined, before: Reading | undefined, after: Reading | undefined, lines: AlertLines, at: string, gone = 'No longer watched'): void {
    const notices = new Conversations(this.db, () => at, lateMailWaits);
    // `after` is absent when the thing is no longer watched, and stale when it has been unknown too long:
    // neither is a fresh reading that cleared an alert line.
    const why = (urgent: boolean) => after && !after.stale ? clearedWords(before!, after, lines, urgent) : gone;
    if (before?.ordinaryLine && (!after?.ordinaryLine || after.occasion !== before.occasion)) {
      notices.resolveSource('notice', raisedId(before), why(false));
    }
    if (before?.level === 'urgent' && after?.level !== 'urgent') notices.resolveSource('notice', urgentId(before), why(true));
    if (!machine || !after || after.level === 'ok') return;
    if (after.level === before?.level && (after.level === 'urgent' || after.occasion === before.occasion)) return;
    // If a disk was urgent from the start, it can first get an ordinary notice on the way down.
    notices.send({ toKind: 'person', to: machine.owner, member: machine.owner, source: 'notice', sourceId: after.level === 'urgent' ? urgentId(after) : raisedId(after),
      fromKind: 'unknown', words: raisedWords(machine.name, after, lines), refs: [machine.id] });
  }

  /** A time in the household's zone as loom's screens say one ("Nov 19, 8:05 AM"; web/src/kit/time.ts), for the words of a notice. */
  private when(iso: string): string {
    return new Intl.DateTimeFormat('en-US', { timeZone: householdTimezone(this.db), month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(new Date(iso)).replace(/\u202f/g, ' ');
  }

  private save(before: Reading | undefined, after: Reading): void {
    if (before) this.db.update(boxReadings).set(after).where(where(before)).run();
    else this.db.insert(boxReadings).values(after).run();
  }

  private blank(key: Pick<Reading, 'box' | 'kind' | 'thing'>): Reading {
    return { ...key, ...none, generation: randomUUID(),
      level: 'ok', occasion: 0, urgentOccasion: 0, ordinaryLine: null, ordinaryLineValue: null, urgentLineValue: null, lastLines: null, since: null, urgentSince: null,
      readAt: null, unknownSince: null, observedAt: null, unknownMs: 0, absentMs: null, reportSequence: 0, stale: false };
  }

  private next(row: Reading, read: Values, lines: AlertLines, at: string, consecutive: boolean): Reading {
    const ordinary = ordinaryLine(row, read, lines, consecutive && row.unknownSince === null);
    const urgent = row.kind === 'disk' && (read.usedPercent! >= lines.diskUrgentPercent ||
      (row.level === 'urgent' && holdsPercent(read, lines.diskUrgentPercent)));
    const newOrdinary = ordinary !== null && ordinary !== row.ordinaryLine;
    return { ...row, ...read, level: urgent ? 'urgent' : ordinary ? 'raised' : 'ok',
      lastLines: lines, readAt: at, unknownSince: null, unknownMs: 0, absentMs: null, stale: false,
      ordinaryLine: ordinary,
      ordinaryLineValue: !ordinary ? null : !newOrdinary ? row.ordinaryLineValue :
        ordinary === 'percent' ? lines.diskPercent : ordinary === 'floor' ? floorSetting(row.kind, lines) : null,
      urgentLineValue: urgent ? row.urgentLineValue ?? lines.diskUrgentPercent : null,
      occasion: row.occasion + Number(newOrdinary),
      urgentOccasion: row.urgentOccasion + Number(urgent && row.level !== 'urgent'),
      since: urgent || ordinary ? row.since ?? at : null,
      urgentSince: urgent ? row.urgentSince ?? at : null };
  }

  /** Only an interval bracketed by reports on this process clock contributes elapsed time. */
  private interval(row: Reading, now: number): number {
    const [epoch, previous] = row.observedAt?.split(':') ?? [];
    return epoch === clockEpoch ? Math.max(0, now - Number(previous)) : 0;
  }

  private unknown(row: Reading, at: string, interval: number, absent: boolean): Reading {
    const elapsed = Math.min(interval, MAX_OBSERVED_INTERVAL_MS);
    return { ...row, unknownSince: row.unknownSince ?? at,
      unknownMs: Math.min(STALE_MS, row.unknownMs + (row.unknownSince === null ? 0 : elapsed)),
      absentMs: absent ? Math.min(STALE_MS, row.absentMs === null ? 0 : row.absentMs + elapsed) : null };
  }

  private expiryReason(row: Reading): string | undefined {
    return row.readAt ? staleWords(row, this.when(row.readAt)) : undefined;
  }

  private drop(row: Reading, lines: AlertLines, at: string, reason?: string): void {
    this.db.delete(boxReadings).where(where(row)).run();
    this.settle(undefined, row, undefined, lines, at, reason);
  }

  private expire(row: Reading): Reading | undefined {
    if (row.absentMs !== null && row.absentMs >= STALE_MS) return undefined;
    if (row.unknownMs >= STALE_MS && !row.stale) {
      return { ...row, stale: true, level: 'ok', ordinaryLine: null, ordinaryLineValue: null, urgentLineValue: null, since: null, urgentSince: null };
    }
    return row;
  }

  /** Numeric drift is a stamp. A change in the state a person is shown is published immediately. */
  read(box: string, readings: readonly MachineReading[]): { changed: boolean } {
    const at = this.at(), now = Math.floor(this.elapsed());
    return this.db.transaction(() => {
      const machine = this.db.select().from(boxes).where(eq(boxes.id, box)).get();
      if (!machine || machine.revokedAt) throw new Error('Machine not available');
      const sequence = Math.min(machine.readingSequence + 1, 2 ** 31 - 1);
      const seenAt = Date.parse(at);
      const lines = alertLines(this.db);
      const keyOf = (reading: { kind: Reading['kind']; thing?: string }) => JSON.stringify([reading.kind, reading.thing ?? '']);
      const report = new Map(readings.map(reading => [keyOf(reading), reading]));
      const previous = new Map(this.db.select().from(boxReadings).where(eq(boxReadings.box, box)).all().map(row => [keyOf(row), row]));
      const update = (row: Reading, reading?: MachineReading) => {
        const consecutive = row.reportSequence === machine.readingSequence && row.reportSequence > machine.readingSilenceSequence;
        return reading && !reading.unknown
          ? this.next(row, values(reading), lines, at, consecutive)
          : this.unknown(row, at, consecutive ? this.interval(row, now) : 0, !reading);
      };
      const updates: { before?: Reading; after?: Reading }[] = [...previous].map(([key, before]) => ({
        before, after: this.expire(update(before, report.get(key))),
      }));
      let retained = updates.filter(({ after }) => after !== undefined).length;
      let readingsLeftOut = 0;
      for (const [key, reading] of report) {
        if (previous.has(key)) continue;
        if (retained >= WATCHED_THINGS_MAX) {
          readingsLeftOut++;
          continue;
        }
        updates.push({ after: update(this.blank({ box, kind: reading.kind, thing: reading.thing ?? '' }), reading) });
        retained++;
      }
      this.db.update(boxes).set({ readingSequence: sequence, readingsLeftOut }).where(eq(boxes.id, box)).run();

      let changed = machine.readingsLeftOut !== readingsLeftOut;
      for (const { before, after } of updates) {
        if (!after) {
          this.drop(before!, lines, at, this.expiryReason(before!));
          changed = true;
          continue;
        }
        this.save(before, { ...after, observedAt: `${clockEpoch}:${now}`, reportSequence: sequence });
        this.settle(machine, before, after, lines, at, after.stale && !before?.stale ? this.expiryReason(after) : undefined);
        const priorAge = before?.readAt ? seenAt - Date.parse(before.readAt) : NaN;
        changed ||= !before || before.level !== after.level || before.occasion !== after.occasion || before.engineStatus !== after.engineStatus ||
          before.unknownSince !== after.unknownSince || before.stale !== after.stale ||
          (after.unknownSince === null && (priorAge > READING_OLD_MS || priorAge < 0));
      }
      return { changed };
    }, { behavior: 'immediate' });
  }

  /** Apply deadlines already reached by observations and close notices for revoked machines. */
  sweep(): boolean {
    const at = this.at();
    return this.db.transaction(() => {
      const lines = alertLines(this.db);
      const rows = this.db.select({ reading: boxReadings, revokedAt: boxes.revokedAt }).from(boxReadings)
        .innerJoin(boxes, eq(boxes.id, boxReadings.box)).where(or(isNotNull(boxes.revokedAt),
          gte(boxReadings.absentMs, STALE_MS), and(eq(boxReadings.stale, false), gte(boxReadings.unknownMs, STALE_MS)))).all();
      for (const { reading, revokedAt } of rows) {
        const after = revokedAt ? undefined : this.expire(reading);
        if (!after) this.drop(reading, lines, at, revokedAt ? 'Machine was removed from the household.' : this.expiryReason(reading));
        else {
          this.save(reading, after);
          this.settle(undefined, reading, after, lines, at, this.expiryReason(reading));
        }
      }
      return sweepGuestPressure(this.db, at) || rows.length > 0;
    }, { behavior: 'immediate' });
  }
}
