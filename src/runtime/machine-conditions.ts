import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import type { DataDatabase } from '../core/data/database.js';
import { boxAlertSettings, boxes, boxReadings } from '../core/data/schema.js';
import { householdTimezone } from '../core/data/household-settings.js';
import { DAY_MS } from '../core/day.js';
import { Conversations, lateMailWaits } from '../core/conversations/index.js';
import type { MachineReading } from './machine-check.js';
import { READING_OLD_MS } from './machine-reading-time.js';
import { SILENCE_MS } from './silence.js';

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
const CONSECUTIVE_MS = 30 * 60_000;
const CONFIRM_UNKNOWN_MS = 60 * 60_000;
const clockEpoch = randomUUID();
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
 * under it by a margin (CLEAR_POINTS, clearRoom), so a reading that hovers at the line raises once and
 * stays raised. A disk is raised by the first reading over the line, since a disk does not fill and empty
 * between two readings. Memory and the container runtime do dip for a moment (a build, an engine being
 * restarted), so those are raised only by two readings in a row: `recent` says the one before was read
 * lately enough to count as the one before (CONSECUTIVE_MS). An older one starts the count again. */
export function evaluate(kind: Reading['kind'], now: Values, before: Pick<Reading, 'level' | 'sizeMib' | 'freeMib' | 'answers' | 'lastLines'> | undefined, lines: AlertLines, recent = true): Level {
  const was = before?.level ?? 'ok';
  if (kind === 'containers') return now.answers ? 'ok' : was !== 'ok' || (recent && before?.answers === false) ? 'raised' : 'ok';
  const size = now.sizeMib ?? 0, free = now.freeMib ?? 0;
  if (kind === 'memory') {
    const floor = floorOf(lines.memoryFreeMib, size);
    if (was !== 'ok') return free < clearRoom(floor) ? 'raised' : 'ok';
    return free < floor && recent && before?.freeMib != null && before.freeMib < floorOf(before.lastLines?.memoryFreeMib ?? lines.memoryFreeMib, before.sizeMib ?? 0) ? 'raised' : 'ok';
  }
  const percent = now.usedPercent ?? 0, floor = floorOf(lines.diskFreeMib, size);
  if (percent >= lines.diskUrgentPercent || (was === 'urgent' && percent > lines.diskUrgentPercent - CLEAR_POINTS)) return 'urgent';
  if (percent >= lines.diskPercent || free < floor) return 'raised';
  return was !== 'ok' && (percent > lines.diskPercent - CLEAR_POINTS || free < clearRoom(floor)) ? 'raised' : 'ok';
}

/** An amount of room as a person reads it, in binary units, rounded down: never more room than there is. */
export function roomWords(mib: number): string {
  if (mib < 1024) return `${mib} MB`;
  const gb = mib / 1024;
  return `${gb < 100 ? Math.floor(gb * 10) / 10 : Math.floor(gb)} GB`;
}
// Increase precision when ordinary rounding would hide a difference between the reading and the line.
function roomAgainst(mib: number, line: number): [string, string] {
  const reading = roomWords(mib), floor = roomWords(line);
  return mib !== line && reading === floor ? [`${mib} MB`, `${line} MB`] : [reading, floor];
}
const diskName = (paths: readonly string[]) => paths.length === 1 ? paths[0] :
  `the disk holding ${paths.slice(0, -1).join(', ')} and ${paths.at(-1)}`;

// One notice per time a thing is found over a line, and one per time it is found over the urgent line: a
// notice already closed under an id is never sent again (Conversations.send), so each id names the occasion.
const raisedId = (row: Reading) => `machine-condition:${JSON.stringify([row.box, row.kind, row.disk ?? row.generation, row.occasion])}`;
const urgentId = (row: Reading) => `machine-condition-urgent:${JSON.stringify([row.box, row.kind, row.disk ?? row.generation, row.urgentOccasion])}`;
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
function raisedWords(machine: string, row: Numbers, lines: AlertLines, before?: Reading): string {
  if (row.kind === 'containers') return `${machine}: the container runtime is not answering.`;
  const free = roomWords(row.freeMib ?? 0);
  if (row.kind === 'memory') {
    const [room, floor] = roomAgainst(row.freeMib ?? 0, lines.memoryFreeMib);
    return `${machine}: ${room} of memory is available. Alerts under ${floor}.`;
  }
  const percent = row.usedPercent ?? 0, floor = floorOf(lines.diskFreeMib, row.sizeMib ?? 0);
  if (row.level === 'urgent') return `${machine}: ${row.thing} is ${percent}% full (${free} free). Urgent at ${lines.diskUrgentPercent}%.`;
  const overPercent = percent >= lines.diskPercent, underFloor = row.freeMib! < floor;
  const priorLines = before?.lastLines ?? lines;
  const crossedPercent = !before || before.usedPercent! < priorLines.diskPercent;
  const crossedFloor = !before || before.freeMib! >= floorOf(priorLines.diskFreeMib, before.sizeMib ?? 0);
  if (overPercent && underFloor && crossedPercent === crossedFloor) {
    const [room, line] = roomAgainst(row.freeMib!, floor);
    return `${machine}: ${row.thing} is ${percent}% full (${room} free). Alerts at ${lines.diskPercent}% or under ${line} free.`;
  }
  if (overPercent && (!underFloor || crossedPercent)) return `${machine}: ${row.thing} is ${percent}% full (${free} free). Alerts at ${lines.diskPercent}%.`;
  if (underFloor) {
    const [room, line] = roomAgainst(row.freeMib ?? 0, floor);
    return `${machine}: ${row.thing} has ${room} free (${percent}% full). Alerts under ${line} free.`;
  }
  return `${machine}: ${row.thing} is ${percent}% full (${free} free). Not yet clear of the alert lines (${lines.diskPercent}%${floor ? `, ${roomWords(floor)} free` : ''}).`;
}
/** Attribute a closure to a line edit only when the prior numbers clear under the new lines. */
export function clearedWords(before: Reading, row: Reading, lines: AlertLines, urgent = false): string {
  if (row.kind === 'containers') return 'The container runtime is answering again.';
  const previous = before.lastLines ?? lines;
  const free = row.freeMib ?? 0, percent = row.usedPercent ?? 0;
  const said = `${row.thing} is at ${percent}% (${roomWords(free)} free)`;
  if (urgent) {
    if (previous.diskUrgentPercent !== lines.diskUrgentPercent &&
        before.usedPercent! <= lines.diskUrgentPercent - CLEAR_POINTS) {
      return `The urgent line is now ${lines.diskUrgentPercent}%; ${said}.`;
    }
    return `${said}, under the ${lines.diskUrgentPercent}% line.`;
  }
  const memory = row.kind === 'memory';
  const floorLine = memory ? lines.memoryFreeMib : lines.diskFreeMib;
  const oldLine = memory ? previous.memoryFreeMib : previous.diskFreeMib;
  const priorFloor = floorOf(oldLine, before.sizeMib ?? 0);
  const newPriorFloor = floorOf(floorLine, before.sizeMib ?? 0);
  const floor = floorOf(floorLine, row.sizeMib ?? 0);
  const wasBelowFloor = before.freeMib! < clearRoom(priorFloor);
  const wasOverPercent = !memory && before.usedPercent! > previous.diskPercent - CLEAR_POINTS;
  const percentEdit = wasOverPercent && previous.diskPercent !== lines.diskPercent &&
    before.usedPercent! <= lines.diskPercent - CLEAR_POINTS;
  const floorEdit = wasBelowFloor && oldLine !== floorLine && before.freeMib! >= clearRoom(newPriorFloor);
  const [room, line] = roomAgainst(free, floor || floorLine);
  if (memory) {
    if (floorEdit && !floorLine) return 'The memory floor was switched off.';
    if (floorEdit && !floor) return `The memory floor is now ${line}, which is not asked of a machine with ${roomWords(row.sizeMib ?? 0)} of memory; ${room} is available.`;
    if (floorEdit) return `The memory floor is now ${line}; ${room} of memory is available.`;
    if (!floor) return `The ${line} memory floor is no longer asked of a machine with ${roomWords(row.sizeMib ?? 0)} of memory; ${room} is available.`;
    return `${room} of memory is available, over the ${line} floor.`;
  }
  if (wasOverPercent && wasBelowFloor) {
    return `${said}, clear of the alert lines (${lines.diskPercent}%${floor ? `, ${line} free` : ''}).`;
  }
  if (wasBelowFloor) {
    if (floorEdit && !floorLine) return `The disk floor was switched off; ${said}.`;
    if (!floor) return `The ${line} floor is no longer asked of ${row.thing}; ${room} is free.`;
    if (floorEdit) return `The disk floor is now ${line}; ${row.thing} has ${room} free (${percent}% full).`;
    return `${row.thing} has ${room} free (${percent}% full), over the ${line} floor.`;
  }
  if (percentEdit) return `The alert line is now ${lines.diskPercent}%; ${said}.`;
  return `${said}, under the ${lines.diskPercent}% line.`;
}

/** The reason a notice is closed with when its thing has been unknown for STALE_MS: that it can no longer
 * be read, and what the last reading was. `when` is the time of that reading as its reader's household writes times. */
export function staleWords(row: Reading, when: string): string {
  if (row.kind === 'containers') return `The container runtime can no longer be asked; last asked ${when}.`;
  if (row.kind === 'memory') return `Memory can no longer be read; last read ${when} with ${roomWords(row.freeMib ?? 0)} available.`;
  return `${row.thing} can no longer be read; last read ${when} at ${row.usedPercent}%.`;
}

function groupBy<T, K>(items: readonly T[], key: (item: T) => K): Map<K, T[]> {
  const groups = new Map<K, T[]>();
  for (const item of items) {
    const id = key(item), group = groups.get(id);
    if (group) group.push(item);
    else groups.set(id, [item]);
  }
  return groups;
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
    // neither is a reading that put anything right, and the reason says which.
    const why = (urgent: boolean) => after && !after.stale ? clearedWords(before!, after, lines, urgent) : gone;
    if (before && before.level !== 'ok' && (!after || after.level === 'ok')) notices.resolveSource('notice', raisedId(before), why(false));
    if (before?.level === 'urgent' && after?.level !== 'urgent') notices.resolveSource('notice', urgentId(before), why(true));
    if (!machine || !after || after.level === 'ok' || after.level === before?.level) return;
    // Over the urgent line there is one urgent notice, beside the one already open if the thing was raised
    // before. Back under it and still raised, the ordinary notice of this occasion is the one that stands:
    // sent now if the thing went straight to urgent, and otherwise still open (or closed by its reader).
    notices.send({ toKind: 'person', to: machine.owner, member: machine.owner, source: 'notice', sourceId: after.level === 'urgent' ? urgentId(after) : raisedId(after),
      fromKind: 'unknown', words: raisedWords(machine.name, after, lines, before), refs: [machine.id] });
  }

  /** A time in the household's zone as loom's screens say one ("Nov 19, 8:05 AM"; web/src/kit/time.ts), for the words of a notice. */
  private when(iso: string): string {
    return new Intl.DateTimeFormat('en-US', { timeZone: householdTimezone(this.db), month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(new Date(iso)).replace(/\u202f/g, ' ');
  }

  private save(before: Reading | undefined, after: Reading): void {
    if (before) this.db.update(boxReadings).set(after).where(where(before)).run();
    else this.db.insert(boxReadings).values(after).run();
  }

  private blank(key: Pick<Reading, 'box' | 'kind' | 'thing' | 'disk'>): Reading {
    return { ...key, ...none, device: null, generation: key.disk ? null : randomUUID(),
      level: 'ok', occasion: 0, urgentOccasion: 0, lastLines: null, since: null, urgentSince: null,
      readAt: null, unknownSince: null, unknownObservation: null, unknownConfirmed: false, stale: false };
  }

  private next(row: Reading, read: Values, lines: AlertLines, at: string, recent: boolean): Reading {
    const level = evaluate(row.kind, read, row, lines, recent);
    return { ...row, ...read, level, lastLines: lines, readAt: at, unknownSince: null,
      unknownObservation: null, unknownConfirmed: false, stale: false,
      occasion: row.occasion + Number(level !== 'ok' && row.level === 'ok'),
      urgentOccasion: row.urgentOccasion + Number(level === 'urgent' && row.level !== 'urgent'),
      since: level === 'ok' ? null : row.since ?? at,
      urgentSince: level === 'urgent' ? row.urgentSince ?? at : null };
  }

  private unknown(row: Reading, at: string): Reading {
    const elapsed = this.elapsed();
    const [epoch, start] = row.unknownObservation?.split(':') ?? [];
    const sameClock = epoch === clockEpoch && elapsed >= Number(start);
    return { ...row, unknownSince: row.unknownSince ?? at,
      unknownObservation: sameClock ? row.unknownObservation : `${clockEpoch}:${elapsed}`,
      unknownConfirmed: row.unknownConfirmed || (sameClock && elapsed - Number(start) >= CONFIRM_UNKNOWN_MS) };
  }

  private expire(machine: Box, rows: Reading[], lines: AlertLines, at: string): Reading[] {
    if (rows[0].stale || !rows.every(row => row.unknownConfirmed && Date.parse(at) - Date.parse(row.unknownSince!) >= STALE_MS)) return rows;
    const before = this.diskSummary(rows);
    const after = { ...before, stale: true, level: 'ok' as const, since: null, urgentSince: null };
    this.settle(machine, before, after, lines, at, before.readAt ? staleWords(before, this.when(before.readAt)) : undefined);
    return rows.map(row => ({ ...row, stale: true, level: 'ok', since: null, urgentSince: null }));
  }

  private diskSummary(rows: Reading[]): Reading {
    const last = [...rows].sort((a, b) => a.thing.localeCompare(b.thing)).find(row => !row.unknownSince) ??
      rows.reduce((latest, row) => (row.readAt ?? '') > (latest.readAt ?? '') ? row : latest);
    return { ...last, thing: last.disk ? diskName(rows.map(row => row.thing).sort()) : last.thing };
  }

  private changed(before: Reading | undefined, after: Reading, now: number): boolean {
    return !before || before.disk !== after.disk || before.level !== after.level ||
      before.answers !== after.answers || before.unknownSince !== after.unknownSince || before.stale !== after.stale ||
      (after.unknownSince === null && now - Date.parse(before.readAt ?? '') > READING_OLD_MS);
  }

  private readDisks(machine: Box, previous: Reading[], report: readonly MachineReading[], lines: AlertLines, at: string): boolean {
    const existing = new Map(previous.map(row => [row.thing, row]));
    const groups = groupBy(previous, row => row.disk!);
    const paths = new Map(report.map(row => [row.thing!, row]));
    const readable = groupBy(report.filter(row => !row.unknown), row => String(row.device));
    const continued = new Map<string, { before: Reading; unknown: Reading[] }>();
    let changed = false;
    const save = (rows: Reading[]) => {
      for (const row of rows) {
        const prior = existing.get(row.thing);
        this.save(prior, row);
        changed = this.changed(prior, row, Date.parse(at)) || changed;
      }
    };
    // Two formerly disjoint groups can both supply a matching path in this round.
    // Keep an open occasion ahead of an inactive group when their identity joins.
    const oldGroups = [...groups.values()].map(rows => ({ rows, before: this.diskSummary(rows) }));
    oldGroups.sort((a, b) => Number(a.before.level === 'ok') - Number(b.before.level === 'ok'));
    for (const { rows: old, before } of oldGroups) {
      const device = old.find(row => row.device !== null)?.device;
      const known = device == null ? undefined : readable.get(device);
      const shared = known?.find(row => old.some(prior => prior.thing === row.thing));
      const unknown = old.filter(row => paths.get(row.thing)?.unknown);
      if (shared) {
        const match = continued.get(device!);
        if (!match) {
          continued.set(device!, { before, unknown });
        } else {
          match.unknown.push(...unknown);
          const other = known!.find(row => !old.some(prior => prior.thing === row.thing));
          this.settle(undefined, before, undefined, lines, at,
            `${shared.thing} and ${other!.thing} are now read on the same disk.`);
        }
      } else if (unknown.length) {
        save(this.expire(machine, unknown.map(row => this.unknown(row, at)), lines, at));
      } else {
        const moved = old.some(row => paths.has(row.thing));
        this.settle(undefined, before, undefined, lines, at, moved
          ? `${before.thing} can no longer be read at its previous paths.` : 'No longer watched');
      }
    }
    for (const [device, group] of readable) {
      const match = continued.get(device);
      save(this.readDiskGroup(machine, group, match?.unknown ?? [], match?.before, match?.before.disk ?? randomUUID(), lines, at));
    }
    for (const row of report) {
      if (row.unknown && !existing.has(row.thing!)) {
        save([this.unknown(this.blank({ box: machine.id, kind: 'disk', thing: row.thing!, disk: randomUUID() }), at)]);
      }
    }
    for (const row of previous) {
      if (!paths.has(row.thing)) {
        this.db.delete(boxReadings).where(where(row)).run();
        changed = true;
      }
    }
    return changed;
  }

  private readDiskGroup(machine: Box, known: MachineReading[], unknown: Reading[], before: Reading | undefined,
    disk: string, lines: AlertLines, at: string): Reading[] {
    const sorted = [...known].sort((a, b) => a.thing!.localeCompare(b.thing!));
    const thing = diskName([...known.map(row => row.thing!), ...unknown.map(row => row.thing)].sort());
    const base = before ?? this.blank({ box: machine.id, kind: 'disk', thing, disk });
    const after = this.next({ ...base, thing, device: String(sorted[0].device) }, values(sorted[0]), lines, at, true);
    this.settle(machine, before, after, lines, at);
    return [
      ...sorted.map(row => ({ ...after, ...values(row), thing: row.thing! })),
      ...unknown.map(row => {
        const { level, since, urgentSince, occasion, urgentOccasion, lastLines } = after;
        return { ...this.unknown(row, at), disk, level, since, urgentSince, occasion, urgentOccasion, lastLines, stale: false };
      }),
    ];
  }

  /** Numeric drift is a stamp. A new, absent, unknown or aged reading changes the view. */
  read(box: string, readings: readonly MachineReading[]): { changed: boolean } {
    const at = this.at(), now = Date.parse(at);
    return this.db.transaction(() => {
      const machine = this.db.select().from(boxes).where(eq(boxes.id, box)).get();
      if (!machine || machine.revokedAt) throw new Error('Machine not available');
      const lines = alertLines(this.db);
      const previous = groupBy(this.db.select().from(boxReadings).where(eq(boxReadings.box, box)).all(), row => row.kind);
      let changed = this.readDisks(machine, previous.get('disk') ?? [], readings.filter(row => row.kind === 'disk'), lines, at);
      for (const kind of ['memory', 'containers'] as const) {
        const before = previous.get(kind)?.[0], reading = readings.find(row => row.kind === kind);
        if (!reading) {
          if (before) { this.drop([before], lines, at); changed = true; }
          continue;
        }
        const row = before ?? this.blank({ box, kind, thing: '', disk: null });
        const age = now - Date.parse(row.readAt ?? '');
        const after = reading.unknown
          ? this.expire(machine, [this.unknown(row, at)], lines, at)[0]
          : this.next(row, values(reading), lines, at, !row.unknownSince && age >= 0 && age <= CONSECUTIVE_MS);
        this.save(before, after);
        if (!reading.unknown) this.settle(machine, before, after, lines, at);
        if (this.changed(before, after, now)) changed = true;
      }
      return { changed };
    }, { behavior: 'immediate' });
  }

  private drop(rows: readonly Reading[], lines: AlertLines, at: string): boolean {
    const closed = new Set<string>();
    for (const row of rows) {
      this.db.delete(boxReadings).where(where(row)).run();
      const id = JSON.stringify([row.box, row.kind, row.disk]);
      if (closed.has(id)) continue;
      this.settle(undefined, row, undefined, lines, at);
      closed.add(id);
    }
    return rows.length > 0;
  }

  /** A revoked machine is removed. A live machine's confirmed unreadable readings can age out
   * even if its worker keeps sending only heartbeats. A silent machine's notices stay open. */
  sweep(judgeSilence = true): boolean {
    const at = this.at();
    return this.db.transaction(() => {
      const lines = alertLines(this.db);
      const rows = this.db.select({ reading: boxReadings, machine: boxes }).from(boxReadings)
        .innerJoin(boxes, eq(boxes.id, boxReadings.box)).all();
      let changed = this.drop(rows.filter(row => row.machine.revokedAt).map(row => row.reading), lines, at);
      const candidates = rows.filter(({ machine }) => {
        const age = Date.parse(at) - Date.parse(machine.lastSeenAt ?? machine.enrolledAt);
        return judgeSilence && !machine.revokedAt && age >= 0 && age <= SILENCE_MS;
      });
      for (const group of groupBy(candidates, ({ reading }) => JSON.stringify([reading.box, reading.kind, reading.disk])).values()) {
        const before = group.map(row => row.reading);
        const after = this.expire(group[0].machine, before, lines, at);
        if (after === before) continue;
        for (const [index, row] of after.entries()) this.save(before[index], row);
        changed = true;
      }
      return changed;
    }, { behavior: 'immediate' });
  }
}
