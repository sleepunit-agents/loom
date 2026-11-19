/** Per-path readings and per-disk conditions. Device ids group paths within a report. A persisted
 * group keeps its occasion when the same set of paths comes back, even with a new device id.
 * Unknown paths keep their last readings. A disk goes stale once all its paths have been unknown
 * for a day. Silence alone does not change a reading or close its notice. */
import { randomUUID } from 'node:crypto';
import { and, eq, isNotNull } from 'drizzle-orm';
import type { DataDatabase } from '../core/data/database.js';
import { boxAlertSettings, boxes, boxReadings } from '../core/data/schema.js';
import { householdTimezone } from '../core/data/household-settings.js';
import { DAY_MS } from '../core/day.js';
import { Conversations, lateMailWaits } from '../core/conversations/index.js';
import type { MachineReading } from './machine-check.js';
import { MACHINE_CHECK_MS, READING_OLD_MS } from './machine-reading-time.js';

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
const raisedId = (row: Reading) => `machine-condition:${JSON.stringify([row.box, row.kind, row.disk ?? row.thing, row.since])}`;
const urgentId = (row: Reading) => `machine-condition-urgent:${JSON.stringify([row.box, row.kind, row.disk ?? row.thing, row.urgentSince])}`;
const where = (key: Pick<Reading, 'box' | 'kind' | 'thing'>) => and(eq(boxReadings.box, key.box), eq(boxReadings.kind, key.kind), eq(boxReadings.thing, key.thing));

type Numbers = Pick<Reading, 'kind' | 'thing' | 'level' | 'usedPercent' | 'sizeMib' | 'freeMib'> & { diskLine?: Reading['diskLine'] };
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
  if (row.kind === 'memory') {
    const [room, floor] = roomAgainst(row.freeMib ?? 0, lines.memoryFreeMib);
    return `${machine}: ${room} of memory is available. Alerts under ${floor}.`;
  }
  const percent = row.usedPercent ?? 0, floor = floorOf(lines.diskFreeMib, row.sizeMib ?? 0);
  if (row.level === 'urgent') return `${machine}: ${row.thing} is ${percent}% full (${free} free). Urgent at ${lines.diskUrgentPercent}%.`;
  if (percent >= lines.diskPercent) return `${machine}: ${row.thing} is ${percent}% full (${free} free). Alerts at ${lines.diskPercent}%.`;
  if ((row.freeMib ?? 0) < floor) {
    const [room, line] = roomAgainst(row.freeMib ?? 0, floor);
    return `${machine}: ${row.thing} has ${room} free (${percent}% full). Alerts under ${line} free.`;
  }
  return `${machine}: ${row.thing} is ${percent}% full (${free} free). Not yet clear of the alert lines (${lines.diskPercent}%${floor ? `, ${roomWords(floor)} free` : ''}).`;
}
/** Why a notice is closed by a reading, as the sentence its reader finds on it. `before` is the record the
 * notice was open for and `row` the record as just written. There are two causes and the sentence says
 * which. The reading recovered: `before`, held to the lines as they now are, would still be raised, so it
 * is the numbers that moved, and the sentence names the line they are now clear of. Or the lines changed:
 * `before` would not be raised by the lines as they now are, so nothing about the machine got better, and
 * the sentence says the line moved (or is no longer asked of this machine) and what the reading is.
 * (A notice closed for any other reason, no longer watched or no longer readable, is not closed here.) */
export function clearedWords(before: Numbers, row: Numbers, lines: AlertLines, urgent = false): string {
  if (row.kind === 'containers') return 'The container runtime is answering again.';
  const free = roomWords(row.freeMib ?? 0), was = before.freeMib ?? 0;
  if (row.kind === 'memory') {
    const floor = floorOf(lines.memoryFreeMib, row.sizeMib ?? 0);
    if (!lines.memoryFreeMib) return 'The memory floor was switched off.';
    const [room, line] = roomAgainst(row.freeMib ?? 0, floor);
    if (!floor) return `The memory floor is now ${roomWords(lines.memoryFreeMib)}, which is not asked of a machine with ${roomWords(row.sizeMib ?? 0)} of memory; ${free} is available.`;
    if (was < floor * CLEAR_ROOM) return `${room} of memory is available, over the ${line} floor.`;
    return `The memory floor is now ${line}; ${room} of memory is available.`;
  }
  const percent = row.usedPercent ?? 0, full = before.usedPercent ?? 0, said = `${row.thing} is at ${percent}% (${free} free)`;
  // The urgent notice of a disk that is still raised: only the urgent line is spoken of.
  if (urgent) return full > lines.diskUrgentPercent - CLEAR_POINTS ? `${said}, under the ${lines.diskUrgentPercent}% line.` : `The urgent line is now ${lines.diskUrgentPercent}%; ${said}.`;
  const floor = floorOf(lines.diskFreeMib, row.sizeMib ?? 0), wasFloor = floorOf(lines.diskFreeMib, before.sizeMib ?? 0);
  if (before.diskLine === 'floor') {
    if (!lines.diskFreeMib) return `The disk floor was switched off; ${said}.`;
    const [room, line] = roomAgainst(row.freeMib ?? 0, floor || lines.diskFreeMib);
    if (!floor) return `The ${line} floor is no longer asked of ${row.thing}; ${room} is free.`;
    if (wasFloor && was < wasFloor * CLEAR_ROOM) return `${row.thing} has ${room} free (${percent}% full), over the ${line} floor.`;
    return `The disk floor is now ${line}; ${row.thing} has ${room} free (${percent}% full).`;
  }
  if (before.diskLine !== 'margin') {
    if (full > lines.diskPercent - CLEAR_POINTS) return `${said}, under the ${lines.diskPercent}% line.`;
    return `The alert line is now ${lines.diskPercent}%; ${said}.`;
  }
  const [room, line] = roomAgainst(row.freeMib ?? 0, floor);
  return `${row.thing} is at ${percent}% (${room} free), clear of the alert lines (${lines.diskPercent}%${floor ? `, ${line} free` : ''}).`;
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
    const why = (urgent: boolean) => after && !after.stale ? clearedWords(before!, after, lines, urgent) : gone;
    if (before && before.level !== 'ok' && (!after || after.level === 'ok')) notices.resolveSource('notice', raisedId(before), why(false));
    if (before?.level === 'urgent' && after?.level !== 'urgent') notices.resolveSource('notice', urgentId(before), why(true));
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

  private save(before: Reading | undefined, after: Reading): void {
    if (before) this.db.update(boxReadings).set(after).where(where(before)).run();
    else this.db.insert(boxReadings).values(after).run();
  }

  private next(key: Pick<Reading, 'box' | 'kind' | 'thing' | 'disk'>, read: Values, before: Reading | undefined,
    lines: AlertLines, at: string, recent: boolean): Reading {
    const level = evaluate(key.kind, read, before, lines, recent);
    let diskLine = level === 'ok' ? null : before?.diskLine ?? null;
    if (key.kind === 'disk' && level === 'raised' && !diskLine) {
      diskLine = read.usedPercent! >= lines.diskPercent ? 'percent' :
        read.freeMib! < floorOf(lines.diskFreeMib, read.sizeMib!) ? 'floor' : 'margin';
    }
    return { ...key, ...read, level, diskLine, readAt: at, unknownSince: null, stale: false,
      since: level === 'ok' ? null : before?.since ?? at,
      urgentSince: level === 'urgent' ? before?.urgentSince ?? at : null };
  }

  private changed(before: Reading | undefined, after: Reading, now: number): boolean {
    return !before || before.disk !== after.disk || before.level !== after.level ||
      before.answers !== after.answers || before.unknownSince !== after.unknownSince || before.stale !== after.stale ||
      (after.unknownSince === null && now - Date.parse(before.readAt ?? '') > READING_OLD_MS);
  }

  /** Assign unknown paths using the last group we could prove. A single readable destination
   * carries the unknown paths with it. If the group splits, their new location is undetermined. */
  private readDisks(machine: Box, previous: Reading[], report: readonly MachineReading[], lines: AlertLines, at: string): boolean {
    const now = Date.parse(at);
    const existing = new Map(previous.map(row => [row.thing, row]));
    const oldGroups = groupBy(previous, row => row.disk!);
    const paths = new Map(report.map(row => [row.thing!, row]));
    const readable = [...paths.values()].filter(row => !row.unknown);
    const byDevice = groupBy(readable, row => row.device!);
    const groups = [...byDevice.values()];
    const unchanged = new Map<MachineReading[], Reading[]>();
    const continued = new Set<Reading[]>();
    for (const old of oldGroups.values()) {
      const reported = old.map(row => paths.get(row.thing)).filter(row => row !== undefined);
      const devices = [...new Set(reported.filter(row => !row.unknown).map(row => row.device!))];
      const unknown = reported.filter(row => row.unknown);
      if (devices.length === 1) byDevice.get(devices[0])!.push(...unknown);
      else if (unknown.length) groups.push(unknown);
    }
    for (const row of paths.values()) if (row.unknown && !existing.has(row.thing!)) groups.push([row]);
    let changed = false;
    const names = (group: readonly { thing?: string }[]) => group.map(row => row.thing!).sort();
    const signature = (group: readonly { thing?: string }[]) => JSON.stringify(names(group));
    const oldByPaths = new Map([...oldGroups.values()].map(group => [signature(group), group]));
    const groupByPath = new Map<string, MachineReading[]>();
    for (const group of groups) {
      const old = oldByPaths.get(signature(group));
      if (old) { unchanged.set(group, old); continued.add(old); }
      for (const row of group) groupByPath.set(row.thing!, group);
    }
    for (const old of oldGroups.values()) {
      if (continued.has(old)) continue;
      const known = old.flatMap(row => {
        const reading = paths.get(row.thing);
        return reading && !reading.unknown ? [reading] : [];
      });
      const other = known.find(row => row.device !== known[0].device);
      const merged = known.flatMap(row => groupByPath.get(row.thing!) ?? [])
        .find(row => !row.unknown && !old.some(prior => prior.thing === row.thing));
      const removed = old.filter(row => !paths.has(row.thing));
      const gone = other ? `${known[0].thing} and ${other.thing} are now on different disks.` :
        removed.length === old.length ? 'No longer watched' :
        removed.length ? `No longer watched: ${names(removed).join(', ')}.` :
        merged ? `${merged.thing} and ${known[0].thing} are now read on the same disk.` : 'The disk’s group of paths changed.';
      this.settle(undefined, old[0], undefined, lines, at, gone);
      changed = true;
    }
    for (const group of groups) {
      const old = unchanged.get(group);
      const thing = diskName(names(group));
      const last = old?.reduce((latest, row) => (row.readAt ?? '') > (latest.readAt ?? '') ? row : latest);
      const before = last && { ...last, thing };
      const key = { box: machine.id, kind: 'disk' as const, thing, disk: last?.disk ?? randomUUID() };
      // Use a single deterministic reading for the condition. Each path retains its actual numbers.
      const read = group.filter(row => !row.unknown).sort((a, b) => a.thing!.localeCompare(b.thing!))[0];
      const members = group.map(row => {
        const prior = existing.get(row.thing!);
        const readingKey = { ...key, thing: row.thing! };
        return { prior, path: row.unknown ? { ...none, readAt: null, ...prior, ...readingKey, unknownSince: prior?.unknownSince ?? at } :
          { ...readingKey, ...values(row), readAt: at, unknownSince: null } };
      });
      let after: Reading;
      if (read) after = this.next(key, values(read), before, lines, at, true);
      else {
        const stale = members.every(({ path }) => now - Date.parse(path.unknownSince!) >= STALE_MS);
        const lastValues = before ?? members[0].path;
        after = { ...lastValues, ...key, stale, level: stale || !before ? 'ok' : before.level,
          since: stale ? null : before?.since ?? null, urgentSince: stale ? null : before?.urgentSince ?? null,
          diskLine: stale ? null : before?.diskLine ?? null };
      }
      this.settle(machine, before, after, lines, at, after.stale && before?.readAt ? staleWords(before, this.when(before.readAt)) : undefined);
      const { level, since, urgentSince, stale, diskLine } = after;
      for (const { prior, path } of members) {
        const row = { ...path, level, since, urgentSince, stale, diskLine };
        this.save(prior, row);
        if (this.changed(prior, row, now)) changed = true;
      }
    }
    for (const row of previous) if (!paths.has(row.thing)) this.db.delete(boxReadings).where(where(row)).run();
    return changed;
  }

  /** A report replaces the watched set. Numeric drift is a stamp. Returning from an aged or
   * unknown reading is an ordinary change, even when the condition is unchanged. */
  read(box: string, readings: readonly MachineReading[], everyMs = MACHINE_CHECK_MS): { changed: boolean } {
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
        if (reading.unknown && !before) continue;
        const key = { box, kind, thing: '', disk: null };
        const age = before?.readAt ? now - Date.parse(before.readAt) : NaN;
        let after: Reading;
        if (reading.unknown) {
          const unknownSince = before!.unknownSince ?? at;
          const stale = now - Date.parse(unknownSince) >= STALE_MS;
          after = { ...before!, unknownSince, stale, ...(stale ? { level: 'ok', since: null, urgentSince: null } as const : {}) };
        } else {
          after = this.next(key, values(reading), before, lines, at, age >= 0 && age <= IN_A_ROW_INTERVALS * everyMs);
        }
        this.save(before, after);
        this.settle(machine, before, after, lines, at, after.stale ? staleWords(before!, this.when(before!.readAt!)) : undefined);
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

  /** A machine taken out of the household reports no more, so nothing else would close what was said about
   * it: its readings are dropped and their notices closed. Says whether there were any. Nothing is raised
   * here; a condition is raised by the reading that finds it (read, above). */
  sweep(): boolean {
    const at = this.at();
    return this.db.transaction(() => {
      const rows = this.db.select({ reading: boxReadings }).from(boxReadings).innerJoin(boxes, eq(boxes.id, boxReadings.box)).where(isNotNull(boxes.revokedAt)).all().map(row => row.reading);
      return this.drop(rows, alertLines(this.db), at);
    }, { behavior: 'immediate' });
  }
}
