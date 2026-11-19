import Database from 'better-sqlite3';
import { afterEach, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createDataSchema } from '../core/data/database.js';
import { boxAlertSettings, boxes, boxReadings, inbox, members } from '../core/data/schema.js';
import { ALERT_LINE_DEFAULTS, MachineConditions, alertLines, roomWords, setAlertLines } from './machine-conditions.js';
import { Machines } from './machines.js';
import { SILENCE_MS } from './silence.js';

const clients: Database.Database[] = [];
afterEach(() => { for (const client of clients.splice(0)) client.close(); });
const GIB = 1024 ** 3, MIB = 1024 ** 2, MINUTES = 60_000;
function fixture() {
  const client = new Database(':memory:'); clients.push(client);
  let time = Date.parse('2026-11-19T14:00:00.000Z');
  const now = () => new Date(time).toISOString();
  const db = createDataSchema(client, now);
  db.insert(members).values([{ id: 'owner', role: 'member', joinedAt: now() }, { id: 'sam', role: 'member', joinedAt: now() }]).run();
  db.insert(boxes).values({ id: 'box-1', name: 'loom', owner: 'owner', sameMachineAsLoom: true, hostsAny: false, reportOnly: false, alwaysOn: true, enrolledAt: now(), lastSeenAt: now() }).run();
  const service = new MachineConditions(db, now);
  /** The next reading, five minutes on: a 200 GiB disk at `/` this full, unless the reading says otherwise. */
  const read = (...readings: Parameters<MachineConditions['read']>[1]) => { time += 5 * MINUTES; return service.read('box-1', readings); };
  const mail = () => db.select().from(inbox).all().sort((a, b) => a.at < b.at ? -1 : a.at > b.at ? 1 : 0);
  return { db, now, service, read, mail, advance: (ms: number) => { time += ms; },
    rows: () => db.select().from(boxReadings).all(),
    open: () => mail().filter(item => item.state === 'waiting').map(item => item.words),
    closed: () => mail().filter(item => item.state !== 'waiting').map(item => [item.words, item.resolution]) };
}
/** A 200 GiB disk that is this many percent full. */
const disk = (percent: number, thing = '/') => ({ kind: 'disk' as const, thing, sizeBytes: 200 * GIB, freeBytes: Math.round(200 * GIB * (100 - percent) / 100) });
const memory = (freeMib: number) => ({ kind: 'memory' as const, sizeBytes: 16 * GIB, freeBytes: freeMib * MIB });

it('keeps the latest reading of each thing and tells nobody of one under every line', () => {
  const f = fixture();
  expect(f.read(disk(71), memory(9000), { kind: 'containers', answers: true })).toEqual({ changed: true });
  expect(f.rows().map(row => [row.kind, row.thing, row.usedPercent, row.sizeMib, row.freeMib, row.answers, row.level, row.since])).toEqual([
    ['disk', '/', 71, 204_800, 59_392, null, 'ok', null], ['memory', '', null, 16_384, 9000, null, 'ok', null], ['containers', '', null, null, null, true, 'ok', null]]);
  // The numbers move and nothing a reader would act on does.
  expect(f.read(disk(72), memory(8000), { kind: 'containers', answers: true })).toEqual({ changed: false });
  expect(f.rows().map(row => [row.usedPercent ?? row.freeMib ?? row.answers, row.readAt])).toEqual([[72, f.now()], [8000, f.now()], [true, f.now()]]);
  expect(f.mail()).toEqual([]);
});

it('raises one notice to the machine\'s owner when a disk goes over the line, in words loom builds from the numbers', () => {
  const f = fixture();
  f.read(disk(71));
  expect(f.read(disk(91))).toEqual({ changed: true });
  expect(f.mail()).toHaveLength(1);
  expect(f.mail()[0]).toMatchObject({ toKind: 'person', to: 'owner', member: 'owner', source: 'notice', state: 'waiting', words: 'loom: / is 91% full (18 GB free). Alerts at 85%.' });
  expect(f.rows()[0]).toMatchObject({ level: 'raised', since: f.now(), urgentSince: null });
  const since = f.now();
  // The same reading again, and a worse one still under the urgent line: nothing new is said.
  expect(f.read(disk(91))).toEqual({ changed: false });
  expect(f.read(disk(93))).toEqual({ changed: false });
  expect(f.mail()).toHaveLength(1);
  expect(f.rows()[0]).toMatchObject({ level: 'raised', since, usedPercent: 93 });
});

it('adds one urgent notice when a raised disk crosses the urgent line, and not a stream of them', () => {
  const f = fixture();
  f.read(disk(91));
  expect(f.read(disk(96))).toEqual({ changed: true });
  expect(f.open()).toEqual(['loom: / is 91% full (18 GB free). Alerts at 85%.', 'loom: / is 96% full (8 GB free). Urgent at 95%.']);
  expect(f.read(disk(97))).toEqual({ changed: false });
  expect(f.read(disk(99))).toEqual({ changed: false });
  expect(f.mail()).toHaveLength(2);
  // Back under the urgent line by the margin, still over the other: the urgent notice closes with what changed.
  expect(f.read(disk(90))).toEqual({ changed: true });
  expect(f.open()).toEqual(['loom: / is 91% full (18 GB free). Alerts at 85%.']);
  expect(f.closed()).toEqual([['loom: / is 96% full (8 GB free). Urgent at 95%.', '/ is at 90% (20 GB free), under the 95% line.']]);
  // And then under the line: the first closes too.
  f.read(disk(71));
  expect(f.open()).toEqual([]);
  expect(f.closed()[0]).toEqual(['loom: / is 91% full (18 GB free). Alerts at 85%.', '/ is at 71% (58 GB free), under the 85% line.']);
});

it('sends the urgent notice alone for a disk found over the urgent line at once, and the ordinary one if it then stays raised', () => {
  const f = fixture();
  f.read(disk(98));
  expect(f.open()).toEqual(['loom: / is 98% full (4 GB free). Urgent at 95%.']);
  f.read(disk(88));
  expect(f.open()).toEqual(['loom: / is 88% full (24 GB free). Alerts at 85%.']);
  f.read(disk(60));
  expect(f.open()).toEqual([]);
  expect(f.mail()).toHaveLength(2);
});

it('does not flap for a reading that hovers at the line: raised at it, cleared only three points under it', () => {
  const f = fixture();
  f.read(disk(84));
  expect(f.mail()).toHaveLength(0);
  f.read(disk(85));
  for (const percent of [84, 85, 83, 86, 84, 83, 85]) expect(f.read(disk(percent)), String(percent)).toEqual({ changed: false });
  expect(f.mail()).toHaveLength(1);
  expect(f.open()).toHaveLength(1);
  expect(f.read(disk(82))).toEqual({ changed: true });
  expect(f.open()).toEqual([]);
  expect(f.closed()).toEqual([['loom: / is 85% full (30 GB free). Alerts at 85%.', '/ is at 82% (36 GB free), under the 85% line.']]);
  // The same at the urgent line.
  f.read(disk(95));
  for (const percent of [94, 96, 93, 95]) expect(f.read(disk(percent)), String(percent)).toEqual({ changed: false });
  expect(f.rows()[0].level).toBe('urgent');
  expect(f.read(disk(92))).toEqual({ changed: true });
  expect(f.rows()[0].level).toBe('raised');
});

it('raises again as a new occasion after a condition cleared, with a notice of its own', () => {
  const f = fixture();
  f.read(disk(91)); f.read(disk(70));
  expect(f.open()).toEqual([]);
  f.read(disk(88));
  expect(f.open()).toEqual(['loom: / is 88% full (24 GB free). Alerts at 85%.']);
  expect(f.mail()).toHaveLength(2);
  expect(new Set(f.mail().map(item => item.sourceId)).size).toBe(2);
});

it('does not say again what its reader closed by hand, for as long as the same occasion lasts', () => {
  const f = fixture();
  f.read(disk(91));
  f.db.update(inbox).set({ state: 'resolved', resolution: 'Seen' }).where(eq(inbox.id, f.mail()[0].id)).run();
  f.read(disk(92)); f.read(disk(96)); f.read(disk(90));
  // The urgent crossing was a new thing to say; going back under it brings the closed notice back for nobody.
  expect(f.mail()).toHaveLength(2);
  expect(f.open()).toEqual([]);
});

it('raises under the free-room floor with words about the floor, and clears a tenth over it', () => {
  const f = fixture();
  // 25 GiB with 4.5 free is 82% full: under the 85% line, and under the 5 GiB floor.
  const part = (freeMib: number) => ({ kind: 'disk' as const, thing: '/', sizeBytes: 25 * GIB, freeBytes: freeMib * MIB });
  f.read(part(4608));
  expect(f.open()).toEqual(['loom: / has 4.5 GB free (82% full). Alerts under 5 GB free.']);
  f.read(part(5300));
  expect(f.open()).toHaveLength(1);
  f.read(part(5700));
  expect(f.closed()).toEqual([['loom: / has 4.5 GB free (82% full). Alerts under 5 GB free.', '/ has 5.5 GB free (77% full), over the 5 GB floor.']]);
  // A disk too small for the floor to mean anything is held to the percent line alone.
  f.read({ kind: 'disk', thing: '/', sizeBytes: 8 * GIB, freeBytes: 4 * GIB });
  expect(f.open()).toEqual([]);
});

it('raises low memory and a container runtime that is not answering only when two readings in a row say so', () => {
  const f = fixture();
  f.read(memory(9000), { kind: 'containers', answers: true });
  f.read(memory(300), { kind: 'containers', answers: false });
  expect(f.mail()).toEqual([]);
  f.read(memory(9000), { kind: 'containers', answers: true });
  f.read(memory(300), { kind: 'containers', answers: false });
  expect(f.mail()).toEqual([]);
  expect(f.read(memory(310), { kind: 'containers', answers: false })).toEqual({ changed: true });
  expect(f.open()).toEqual(['loom: 310 MB of memory is available. Alerts under 512 MB.', 'loom: the container runtime is not answering.']);
  // Just over the floor is not clear of it.
  f.read(memory(540), { kind: 'containers', answers: false });
  expect(f.open()).toHaveLength(2);
  f.read(memory(2048), { kind: 'containers', answers: true });
  expect(f.open()).toEqual([]);
  expect(f.closed().map(([, reason]) => reason)).toEqual(['2 GB of memory is available, over the 512 MB floor.', 'The container runtime is answering again.']);
});

it('leaves a thing named as unknown as it was, and stops watching a thing no longer named', () => {
  const f = fixture();
  f.read(disk(91), disk(92, '/srv/data'), memory(9000));
  const before = f.rows();
  expect(f.read({ kind: 'disk', thing: '/', unknown: true }, disk(92, '/srv/data'), { kind: 'memory', unknown: true }, { kind: 'disk', thing: '/never/read', unknown: true })).toEqual({ changed: false });
  expect(f.rows().filter(row => row.thing !== '/srv/data')).toEqual(before.filter(row => row.thing !== '/srv/data'));
  expect(f.open()).toHaveLength(2);
  // The second disk is gone from what the worker watches: its notice closes, the other stands.
  expect(f.read(disk(91), memory(9000))).toEqual({ changed: true });
  expect(f.rows().map(row => row.thing)).toEqual(['/', '']);
  expect(f.open()).toEqual(['loom: / is 91% full (18 GB free). Alerts at 85%.']);
  expect(f.closed()).toEqual([['loom: /srv/data is 92% full (16 GB free). Alerts at 85%.', 'No longer watched']]);
});

it('leaves the conditions of a machine that has stopped reporting, and their notices, as they were', () => {
  const f = fixture(), machines = new Machines(f.db, f.now);
  f.read(disk(91));
  f.advance(SILENCE_MS * 20);
  expect(f.service.sweep()).toBe(false);
  // Its silence is its own notice, beside the one about its disk.
  machines.sweep();
  expect(f.open()).toEqual(['loom: / is 91% full (18 GB free). Alerts at 85%.', 'Machine loom has stopped reporting.']);
  expect(f.rows()[0]).toMatchObject({ level: 'raised', usedPercent: 91 });
});

it('closes what was said about a machine taken out of the household, and takes no more readings from it', () => {
  const f = fixture();
  f.read(disk(96), memory(9000));
  f.db.update(boxes).set({ revokedAt: f.now() }).where(eq(boxes.id, 'box-1')).run();
  expect(f.service.sweep()).toBe(true);
  expect(f.rows()).toEqual([]);
  expect(f.open()).toEqual([]);
  expect(f.closed()).toEqual([['loom: / is 96% full (8 GB free). Urgent at 95%.', 'No longer watched']]);
  expect(() => f.read(disk(96))).toThrow('Machine not available');
  expect(f.service.sweep()).toBe(false);
});

it('takes its lines from the household\'s settings, and the defaults while there are none', () => {
  const f = fixture();
  expect(alertLines(f.db)).toEqual({ diskPercent: 85, diskUrgentPercent: 95, diskFreeMib: 5120, memoryFreeMib: 512 });
  expect(alertLines(f.db)).toEqual(ALERT_LINE_DEFAULTS);
  expect(f.db.select().from(boxAlertSettings).all()).toEqual([]);
  f.read(disk(75));
  expect(f.mail()).toEqual([]);
  expect(setAlertLines(f.db, { ...ALERT_LINE_DEFAULTS, diskPercent: 70, diskUrgentPercent: 80 })).toMatchObject({ diskPercent: 70, diskUrgentPercent: 80 });
  // A machine is held to the new lines by its next reading.
  f.read(disk(75));
  expect(f.open()).toEqual(['loom: / is 75% full (50 GB free). Alerts at 70%.']);
  f.read(disk(81));
  expect(f.open()).toContain('loom: / is 81% full (38 GB free). Urgent at 80%.');
  setAlertLines(f.db, ALERT_LINE_DEFAULTS);
  f.read(disk(81));
  expect(f.open()).toEqual([]);
  expect(() => setAlertLines(f.db, { ...ALERT_LINE_DEFAULTS, diskPercent: 96 })).toThrow(/box_alert_settings_disk_urgent_percent_range/);
  expect(() => setAlertLines(f.db, { ...ALERT_LINE_DEFAULTS, diskPercent: 0 })).toThrow(/box_alert_settings_disk_percent_range/);
});

it('tells each machine\'s own owner, and keeps one machine\'s things apart from another\'s', () => {
  const f = fixture();
  f.db.insert(boxes).values({ id: 'box-2', name: 'wunder', owner: 'sam', sameMachineAsLoom: false, hostsAny: false, reportOnly: false, alwaysOn: false, enrolledAt: f.now(), lastSeenAt: f.now() }).run();
  f.read(disk(91));
  f.service.read('box-2', [disk(96)]);
  expect(f.mail().map(item => [item.to, item.words])).toEqual([['owner', 'loom: / is 91% full (18 GB free). Alerts at 85%.'], ['sam', 'wunder: / is 96% full (8 GB free). Urgent at 95%.']]);
  f.read(disk(60));
  expect(f.open()).toEqual(['wunder: / is 96% full (8 GB free). Urgent at 95%.']);
});

it('writes room as df does', () => {
  expect([0, 310, 1023, 1024, 4608, 10_239, 10_240, 61_440].map(roomWords)).toEqual(['0 MB', '310 MB', '1023 MB', '1 GB', '4.5 GB', '9.9 GB', '10 GB', '60 GB']);
});
