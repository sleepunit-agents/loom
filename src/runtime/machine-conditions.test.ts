import Database from 'better-sqlite3';
import { afterEach, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createDataSchema } from '../core/data/database.js';
import { boxAlertSettings, boxes, boxReadings, household, inbox, members } from '../core/data/schema.js';
import { ALERT_LINE_DEFAULTS, MachineConditions, STALE_MS, alertLines, roomWords, setAlertLines } from './machine-conditions.js';
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
  let elapsed = 0;
  const service = new MachineConditions(db, now, () => elapsed);
  /** The next reading, five minutes on: a 200 GiB disk at `/` this full, unless the reading says otherwise. */
  const read = (...readings: Parameters<MachineConditions['read']>[1]) => { time += 5 * MINUTES; elapsed += 5 * MINUTES; return service.read('box-1', readings); };
  const mail = () => db.select().from(inbox).all().sort((a, b) => a.at < b.at ? -1 : a.at > b.at ? 1 : 0);
  return { db, now, service, read, mail, advance: (ms: number) => { time += ms; elapsed += Math.max(ms, 0); }, stepClock: (ms: number) => { time += ms; },
    rows: () => db.select().from(boxReadings).all(),
    open: () => mail().filter(item => item.state === 'waiting').map(item => item.words),
    closed: () => mail().filter(item => item.state !== 'waiting').map(item => [item.words, item.resolution]) };
}
/** A 200 GiB disk that is this many percent full. */
const disk = (percent: number, thing = '/', device = thing === '/' ? 1 : 2) => ({ kind: 'disk' as const, thing, device, sizeBytes: 200 * GIB, freeBytes: Math.round(200 * GIB * (100 - percent) / 100) });
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
  const part = (freeMib: number) => ({ kind: 'disk' as const, thing: '/', device: 1, sizeBytes: 25 * GIB, freeBytes: freeMib * MIB });
  f.read(part(4608));
  expect(f.open()).toEqual(['loom: / has 4.5 GB free (82% full). Alerts under 5 GB free.']);
  f.read(part(5300));
  expect(f.open()).toHaveLength(1);
  f.read(part(5700));
  expect(f.closed()).toEqual([['loom: / has 4.5 GB free (82% full). Alerts under 5 GB free.', '/ has 5.5 GB free (78% full), over the 5 GB floor.']]);
  // A disk too small for the floor to mean anything is held to the percent line alone, and when it is
  // over that line its notice says nothing of a floor it is not held to.
  f.read({ kind: 'disk', thing: '/', device: 1, sizeBytes: 8 * GIB, freeBytes: 4 * GIB });
  expect(f.open()).toEqual([]);
  f.read({ kind: 'disk', thing: '/', device: 1, sizeBytes: 8 * GIB, freeBytes: 1 * GIB });
  expect(f.open()).toEqual(['loom: / is 88% full (1 GB free). Alerts at 85%.']);
  f.read({ kind: 'disk', thing: '/', device: 1, sizeBytes: 8 * GIB, freeBytes: 4 * GIB });
  expect(f.closed().at(-1)).toEqual(['loom: / is 88% full (1 GB free). Alerts at 85%.', '/ is at 50% (4 GB free), under the 85% line.']);
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

it('keeps what was last read of a thing named as unknown, raising and clearing nothing, and stops watching a thing no longer named', () => {
  const f = fixture();
  f.read(disk(91), disk(92, '/srv/data'), memory(9000));
  const before = f.rows(), readAt = f.now();
  // Becoming unknown is a state a person is shown; staying unknown is nothing new.
  expect(f.read({ kind: 'disk', thing: '/', unknown: true }, disk(92, '/srv/data'), { kind: 'memory', unknown: true }, { kind: 'disk', thing: '/never/read', unknown: true })).toEqual({ changed: true });
  const since = f.now();
  expect(f.read({ kind: 'disk', thing: '/', unknown: true }, disk(92, '/srv/data'), { kind: 'memory', unknown: true }, { kind: 'disk', thing: '/never/read', unknown: true })).toEqual({ changed: false });
  // The numbers, the level and the time they were read stand; only that it is unknown, and since when, is added.
  expect(f.rows().filter(row => row.thing !== '/srv/data' && row.thing !== '/never/read')).toMatchObject(before.filter(row => row.thing !== '/srv/data').map(row => ({ ...row, unknownSince: since, unknownObservation: expect.any(String) })));
  expect(f.rows().filter(row => row.thing !== '/never/read').map(row => row.readAt)).toEqual([readAt, f.now(), readAt]);
  expect(f.rows().find(row => row.thing === '/never/read')).toMatchObject({ level: 'ok', unknownSince: since, usedPercent: null, readAt: null });
  expect(f.open()).toHaveLength(2);
  // Readable again is shown too, and the same occasion goes on: no second notice.
  expect(f.read(disk(91), disk(92, '/srv/data'), memory(9000))).toEqual({ changed: true });
  expect(f.rows().map(row => [row.unknownSince, row.stale])).toEqual([[null, false], [null, false], [null, false]]);
  expect(f.mail()).toHaveLength(2);
  // The second disk is gone from what the worker watches: its notice closes, the other stands.
  expect(f.read(disk(91), memory(9000))).toEqual({ changed: true });
  expect(f.rows().map(row => row.thing)).toEqual(['/', '']);
  expect(f.open()).toEqual(['loom: / is 91% full (18 GB free). Alerts at 85%.']);
  expect(f.closed()).toEqual([['loom: /srv/data is 92% full (16 GB free). Alerts at 85%.', 'No longer watched']]);
});

it('closes what it said about a thing that has been unknown for a day, marks the record stale, and starts a new occasion when it is read again', () => {
  const f = fixture();
  f.db.insert(household).values({ timezone: 'America/Chicago' }).run();
  // Another disk of the machine is read throughout: this is one disk gone, not a worker that cannot see its disks.
  f.read(disk(96), disk(40, '/srv'), memory(9000));
  expect(f.open()).toEqual(['loom: / is 96% full (8 GB free). Urgent at 95%.']);
  const gone = [{ kind: 'disk' as const, thing: '/', unknown: true as const }, disk(40, '/srv'), memory(9000)];
  f.read(...gone);
  // The healthy readings return after a long gap, but the unreadable disk notice stands.
  f.advance(STALE_MS - 20 * MINUTES);
  expect(f.read(...gone)).toEqual({ changed: true });
  expect(f.open()).toHaveLength(1);
  expect(f.rows()[0]).toMatchObject({ level: 'urgent', stale: false, usedPercent: 96 });
  // A full day: loom closes it, saying that it can no longer be read and what was last read, in the household's time.
  f.advance(20 * MINUTES);
  expect(f.read(...gone)).toEqual({ changed: true });
  expect(f.open()).toEqual([]);
  expect(f.closed()).toEqual([['loom: / is 96% full (8 GB free). Urgent at 95%.', '/ can no longer be read; last read Nov 19, 8:05 AM at 96%.']]);
  // The last numbers are kept, marked stale and held to no line.
  expect(f.rows()[0]).toMatchObject({ level: 'ok', stale: true, usedPercent: 96, since: null, urgentSince: null, readAt: '2026-11-19T14:05:00.000Z' });
  expect(f.read(...gone)).toEqual({ changed: false });
  expect(f.mail()).toHaveLength(1);
  // Read again and still over the line: a new occasion, with a notice of its own.
  expect(f.read(disk(97), disk(40, '/srv'), memory(9000))).toEqual({ changed: true });
  expect(f.open()).toEqual(['loom: / is 97% full (6 GB free). Urgent at 95%.']);
  expect(f.rows()[0]).toMatchObject({ level: 'urgent', stale: false, unknownSince: null, since: f.now() });
  expect(new Set(f.mail().map(item => item.sourceId)).size).toBe(2);
});

it('raises nothing for a thing that goes unknown and stale while it was fine, and nothing when it is read again under the lines', () => {
  const f = fixture();
  f.read(disk(50), disk(40, '/srv'), memory(9000));
  f.read({ kind: 'disk', thing: '/', unknown: true }, disk(40, '/srv'), { kind: 'memory', unknown: true });
  f.advance(STALE_MS);
  f.read({ kind: 'disk', thing: '/', unknown: true }, disk(40, '/srv'), { kind: 'memory', unknown: true });
  expect(f.rows().map(row => row.stale)).toEqual([true, false, true]);
  f.read(disk(50), disk(40, '/srv'), memory(9000));
  expect(f.mail()).toEqual([]);
});

it('says a change in a state a person is shown, and not a drift in the numbers', () => {
  const f = fixture(), up = { kind: 'containers' as const, answers: true }, down = { kind: 'containers' as const, answers: false };
  expect(f.read(disk(71), memory(9000), up)).toEqual({ changed: true });
  expect(f.read(disk(84), memory(600), up)).toEqual({ changed: false });
  // The container runtime not answering is shown as it is, before it is a condition and when it is back.
  expect(f.read(disk(84), memory(600), down)).toEqual({ changed: true });
  expect(f.mail()).toEqual([]);
  expect(f.read(disk(84), memory(600), up)).toEqual({ changed: true });
  expect(f.read(disk(84), memory(600), up)).toEqual({ changed: false });
});

it('counts only consecutive reports no more than 30 minutes apart, resetting on unknown or missing', () => {
  const f = fixture(), down = { kind: 'containers' as const, answers: false };
  f.read(memory(300), down);
  f.advance(26 * MINUTES);
  f.read(memory(300), down);
  expect(f.mail()).toEqual([]);
  f.read({ kind: 'memory', unknown: true }, { kind: 'containers', unknown: true });
  f.read(memory(300), down);
  expect(f.mail()).toEqual([]);
  f.read(disk(50));
  f.read(memory(300), down);
  expect(f.mail()).toEqual([]);
  f.advance(25 * MINUTES);
  f.read(memory(300), down);
  expect(f.open()).toHaveLength(2);
});

it('assigns new ordinary and urgent occasions when the clock repeats a raise timestamp', () => {
  const f = fixture();
  f.read(disk(91));
  const ordinary = f.now();
  f.read(disk(96));
  const urgent = f.now();
  f.read(disk(50));
  f.stepClock(Date.parse(ordinary) - Date.parse(f.now()));
  f.service.read('box-1', [disk(91)]);
  f.stepClock(Date.parse(urgent) - Date.parse(f.now()));
  f.service.read('box-1', [disk(96)]);
  expect(f.open()).toHaveLength(2);
  expect(new Set(f.mail().map(item => item.sourceId)).size).toBe(4);
  expect(f.rows()[0]).toMatchObject({ occasion: 2, urgentOccasion: 2 });
});

it.each([true, false])('expires confirmed unknown disks in a sweep only when the machine is still reporting (%s)', live => {
  const f = fixture(), machine = new Machines(f.db, f.now);
  f.read(disk(91));
  f.read(unknown('/'));
  f.advance(55 * MINUTES);
  f.read(unknown('/'));
  f.advance(STALE_MS - 60 * MINUTES);
  if (live) machine.heartbeat('box-1');
  else machine.sweep();
  expect(f.service.sweep()).toBe(live);
  expect(f.rows()[0].stale).toBe(live);
  expect(f.closed()).toHaveLength(live ? 1 : 0);
  expect(f.open()).toEqual(live ? [] : [
    'loom: / is 91% full (18 GB free). Alerts at 85%.', 'Machine loom has stopped reporting.',
  ]);
});

it('does not expire an unknown disk on a clock jump or with only one unknown report', () => {
  const f = fixture(), machine = new Machines(f.db, f.now);
  f.read(disk(91));
  f.read(unknown('/'));
  f.stepClock(STALE_MS);
  machine.heartbeat('box-1');
  expect(f.service.sweep()).toBe(false);
  f.read(unknown('/'));
  expect(f.rows()[0].stale).toBe(false);
  expect(f.closed()).toEqual([]);
  f.advance(55 * MINUTES);
  f.read(unknown('/'));
  expect(f.rows()[0].stale).toBe(true);
  f.stepClock(-STALE_MS);
  expect(f.read(unknown('/'))).toEqual({ changed: false });
  expect(f.mail()).toHaveLength(1);
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
  expect(f.db.select().from(boxAlertSettings).all()).toEqual([{ singleton: 1, ...ALERT_LINE_DEFAULTS }]);
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
  expect(() => setAlertLines(f.db, { ...ALERT_LINE_DEFAULTS, diskPercent: 95 })).toThrow(/box_alert_settings_disk_urgent_percent_range/);
  // A line clears three points under itself: one of 1, 2 or 3 could never clear, so the lowest line is one that can.
  for (const diskPercent of [0, 1, 3, 9, 100]) expect(() => setAlertLines(f.db, { ...ALERT_LINE_DEFAULTS, diskPercent }), String(diskPercent)).toThrow(/box_alert_settings_disk_(urgent_)?percent_range/);
  setAlertLines(f.db, { ...ALERT_LINE_DEFAULTS, diskPercent: 10, diskUrgentPercent: 11 });
  f.read(disk(12)); f.read(disk(7));
  expect(f.rows()[0].level).toBe('ok');
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

it('writes room in binary units, rounded down', () => {
  expect([0, 310, 1023, 1024, 4608, 10_239, 10_240, 61_440].map(roomWords)).toEqual(['0 MB', '310 MB', '1023 MB', '1 GB', '4.5 GB', '9.9 GB', '10 GB', '60 GB']);
});

it('works a disk\'s fullness out as df does, used over used and available and rounded up, and holds the line to that number', () => {
  const f = fixture(), of = (usedMib: number) => ({ kind: 'disk' as const, thing: '/', device: 1, sizeBytes: 100_000 * MIB, freeBytes: (100_000 - usedMib) * MIB });
  // 84.0% is 84 and under the line. 84.001% is 85 in df, and so it is here: over the line.
  f.read(of(84_000));
  expect(f.rows()[0]).toMatchObject({ usedPercent: 84, level: 'ok' });
  f.read(of(84_001));
  expect(f.rows()[0]).toMatchObject({ usedPercent: 85, level: 'raised' });
  expect(f.open()).toEqual(['loom: / is 85% full (15.6 GB free). Alerts at 85%.']);
  // A whole percent stays that percent: 71% of a size whose hundredth is no whole number of bytes is 71, not 72.
  for (const [used, percent] of [[71, 71], [29, 29], [1, 1], [0, 0], [100, 100]]) {
    f.read({ kind: 'disk', thing: '/x', device: 2, sizeBytes: 3 * 100 * 1_000_003, freeBytes: 3 * (100 - used) * 1_000_003 }, of(10_000));
    expect(f.rows().find(row => row.thing === '/x')!.usedPercent, String(used)).toBe(percent);
  }
  // One byte used of a petabyte is 1%, as df says, and a full disk is 100.
  f.read({ kind: 'disk', thing: '/x', device: 2, sizeBytes: 2 ** 50, freeBytes: 2 ** 50 - 1 }, of(10_000));
  expect(f.rows().find(row => row.thing === '/x')!.usedPercent).toBe(1);
});

const unknown = (thing: string) => ({ kind: 'disk' as const, thing, unknown: true as const });
const a = '/srv/a', b = '/srv/b', c = '/srv/c';
const grouped = 'loom: the disk holding /srv/a and /srv/b is 91% full (18 GB free). Alerts at 85%.';

it('shares one persisted occasion across paths, worker restarts and report order', () => {
  const f = fixture();
  f.read(disk(91, a, 10), disk(91, b, 10));
  expect(f.open()).toEqual([grouped]);
  expect(f.rows().map(row => [row.thing, row.disk, row.since])).toEqual([[a, f.rows()[0].disk, f.now()], [b, f.rows()[0].disk, f.now()]]);
  const group = f.rows()[0].disk, since = f.now();
  f.advance(5 * MINUTES);
  expect(new MachineConditions(f.db, f.now).read('box-1', [disk(91, b, 10), disk(91, a, 10)])).toEqual({ changed: false });
  expect(f.rows().every(row => row.disk === group && row.since === since)).toBe(true);
  expect(f.mail()).toHaveLength(1);
  f.read(disk(96, a, 10), disk(96, b, 10));
  expect(f.open()).toEqual([grouped, 'loom: the disk holding /srv/a and /srv/b is 96% full (8 GB free). Urgent at 95%.']);
  f.read(disk(60, a, 10), disk(60, b, 10));
  expect(f.closed().map(([, why]) => why)).toEqual([
    'the disk holding /srv/a and /srv/b is at 60% (80 GB free), under the 85% line.',
    'the disk holding /srv/a and /srv/b is at 60% (80 GB free), under the 95% line.',
  ]);
});

it('keeps a partly unknown group readable and waits a day after the last path becomes unknown', () => {
  const f = fixture();
  f.db.insert(household).values({ timezone: 'UTC' }).run();
  f.read(disk(91, a, 10), disk(91, b, 10));
  f.read(unknown(a), disk(92, b, 10));
  f.advance(STALE_MS);
  f.read(unknown(a), disk(93, b, 10));
  const latest = f.now();
  expect(f.open()).toEqual([grouped]);
  expect(f.rows().map(row => [row.usedPercent, row.stale])).toEqual([[91, false], [93, false]]);
  f.read(unknown(a), unknown(b));
  f.advance(STALE_MS - 10 * MINUTES);
  expect(f.read(unknown(a), unknown(b))).toEqual({ changed: false });
  expect(f.open()).toEqual([grouped]);
  expect(f.read(unknown(a), unknown(b))).toEqual({ changed: true });
  expect(f.mail()).toHaveLength(1);
  const when = new Intl.DateTimeFormat('en-US', {timeZone:'UTC', month:'short',day:'numeric',hour:'numeric',minute:'2-digit'}).format(new Date(latest)).replace(/\u202f/g, ' ');
  expect(f.closed()).toEqual([[grouped, `the disk holding /srv/a and /srv/b can no longer be read; last read ${when} at 93%.`]]);
  expect(f.rows().every(row => row.stale && row.level === 'ok')).toBe(true);
  f.read(unknown(a), disk(91, b, 10));
  expect(f.open()).toEqual([grouped]);
  expect(f.mail()).toHaveLength(2);
});

it('keeps the old disk unknown when the only readable path has moved to a healthy disk', () => {
  const f = fixture();
  f.read(disk(91, a, 10), disk(91, b, 10));
  const group = f.rows()[0].disk;
  f.read(disk(60, a, 11), unknown(b));
  expect(f.rows().find(row => row.thing === a)).toMatchObject({ device: '11', level: 'ok' });
  expect(f.rows().find(row => row.thing === b)).toMatchObject({ disk: group, device: '10', level: 'raised', unknownSince: f.now() });
  expect(f.open()).toEqual([grouped]);
  expect(f.closed()).toEqual([]);
  f.read(disk(60, a, 11), disk(60, b, 10));
  expect(f.closed()).toEqual([[grouped, '/srv/b is at 60% (80 GB free), under the 85% line.']]);
});

it('closes each wholly unreadable disk after a day without emitting a machine-wide notice', () => {
  const f = fixture();
  f.read(disk(96, a, 10), disk(91, b, 11));
  f.read(unknown(a), unknown(b));
  f.advance(STALE_MS);
  f.read(unknown(a), unknown(b));
  expect(f.open()).toEqual([]);
  expect(f.closed().map(([, why]) => why)).toEqual([
    expect.stringMatching(/^\/srv\/a can no longer be read; .* at 96%\.$/),
    expect.stringMatching(/^\/srv\/b can no longer be read; .* at 91%\.$/),
  ]);
  f.read(unknown(a));
  expect(f.mail()).toHaveLength(2);
});

it('keeps the original occasion when a group drops and adds paths', () => {
  const f = fixture();
  f.read(disk(91, a, 10), disk(91, b, 10));
  const [notice] = f.mail(), [{ disk: group }] = f.rows();
  f.read(disk(91, a, 10));
  f.read(disk(91, a, 10), disk(91, c, 10));
  expect(f.rows().map(row => [row.thing, row.disk, row.occasion])).toEqual([[a, group, 1], [c, group, 1]]);
  expect(f.mail().map(row => [row.id, row.state])).toEqual([[notice.id, 'waiting']]);
  f.read(disk(60, a, 10), disk(60, c, 10));
  expect(f.closed()[0][1]).toBe('the disk holding /srv/a and /srv/c is at 60% (80 GB free), under the 85% line.');
});

it('keeps one occasion when two disjoint groups later prove they share a device', () => {
  const f = fixture();
  f.read(disk(91, a, 10));
  const [first] = f.mail();
  f.read(unknown(a), disk(91, b, 10));
  expect(f.open()).toHaveLength(2);
  f.read(disk(91, a, 10), disk(91, b, 10));
  expect(f.mail().map(row => row.state)).toEqual(['waiting', 'resolved']);
  expect(f.mail()[0].id).toBe(first.id);
  expect(f.closed()[0][1]).toBe('/srv/b and /srv/a are now read on the same disk.');
  expect(new Set(f.rows().map(row => row.disk)).size).toBe(1);
});

it('publishes a fresh reading immediately when a machine returns with its previous level', () => {
  const f = fixture();
  f.read(disk(91), memory(9000), { kind: 'containers', answers: true });
  f.advance(16 * MINUTES);
  expect(f.read(disk(91), memory(9000), { kind: 'containers', answers: true })).toEqual({ changed: true });
  expect(f.mail()).toHaveLength(1);
  expect(f.rows().every(row => row.readAt === f.now())).toBe(true);
});

/** Every sentence a notice is opened or closed with, against the way it came to be said. Each row is a
 * machine with one thing: the lines it starts with, the readings that open the condition, then what
 * happens (a reading, the lines changed, or both) and the sentence that must follow. Sizes: a 200 GiB
 * disk unless the row says, 16 GiB of memory. */
const lined = (lines: Partial<typeof ALERT_LINE_DEFAULTS>) => ({ ...ALERT_LINE_DEFAULTS, ...lines });
const sized = (sizeGib: number, freeMib: number) => ({ kind: 'disk' as const, thing: '/', device: 1, sizeBytes: sizeGib * GIB, freeBytes: freeMib * MIB });
it.each<[cause: string, open: Parameters<MachineConditions['read']>[1], opened: string, then: { firstLines?: Partial<typeof ALERT_LINE_DEFAULTS>; lines?: Partial<typeof ALERT_LINE_DEFAULTS>; reading: Parameters<MachineConditions['read']>[1][number] }, closed: string | null, said?: string]>([
  // Opened by a reading, closed by a reading that recovered.
  ['over the percent line, then under it by the margin', [disk(91)], 'loom: / is 91% full (18 GB free). Alerts at 85%.', { reading: disk(71) }, '/ is at 71% (58 GB free), under the 85% line.'],
  ['under the free-room floor and inside the percent margin, then clear of both', [sized(30, 5000)], 'loom: / has 4.8 GB free (84% full). Alerts under 5 GB free.', { reading: sized(30, 6144) }, '/ is at 80% (6 GB free), clear of the alert lines (85%, 5 GB free).'],
  ['a percent condition held open by the floor, then clear of that floor',
    [sized(20, 1844), sized(20, 4096)], 'loom: / is 91% full (1.8 GB free). Alerts at 85% or under 5 GB free.',
    { reading: sized(20, 6144) }, '/ has 6 GB free (70% full), over the 5 GB floor.'],
  ['a floor clears at exactly 110 MiB',
    [sized(1, 99)], 'loom: / has 99 MB free (91% full). Alerts under 100 MB free.',
    { firstLines: { diskPercent: 98, diskUrgentPercent: 99, diskFreeMib: 100 }, reading: sized(1, 110) },
    '/ has 110 MB free (90% full), over the 100 MB floor.'],
  ['over the urgent line, then under the ordinary one', [disk(96)], 'loom: / is 96% full (8 GB free). Urgent at 95%.', { reading: disk(60) }, '/ is at 60% (80 GB free), under the 95% line.'],
  ['over the urgent line, then under it and still raised', [disk(96)], 'loom: / is 96% full (8 GB free). Urgent at 95%.', { reading: disk(90) }, '/ is at 90% (20 GB free), under the 95% line.', 'loom: / is 90% full (20 GB free). Alerts at 85%.'],
  ['over the urgent line, then inside the margin of the ordinary one', [disk(96)], 'loom: / is 96% full (8 GB free). Urgent at 95%.', { reading: disk(83) }, '/ is at 83% (34 GB free), under the 95% line.', 'loom: / is 83% full (34 GB free). Not yet clear of the alert lines (85%, 5 GB free).'],
  ['low memory twice, then a tenth over the floor', [memory(300), memory(310)], 'loom: 310 MB of memory is available. Alerts under 512 MB.', { reading: memory(2048) }, '2 GB of memory is available, over the 512 MB floor.'],
  ['the container runtime not answering twice, then answering', [{ kind: 'containers', answers: false }, { kind: 'containers', answers: false }], 'loom: the container runtime is not answering.', { reading: { kind: 'containers', answers: true } }, 'The container runtime is answering again.'],
  // Closed because the lines changed while it was open: the reading is the same and nothing recovered.
  ['the percent line raised over a disk that is as full as it was', [disk(91)], 'loom: / is 91% full (18 GB free). Alerts at 85%.', { lines: { diskPercent: 96, diskUrgentPercent: 99 }, reading: disk(91) }, 'The alert line is now 96%; / is at 91% (18 GB free).'],
  ['the free-room floor lowered under a disk with as little room as it had', [sized(25, 4608)], 'loom: / has 4.5 GB free (82% full). Alerts under 5 GB free.', { lines: { diskFreeMib: 2048 }, reading: sized(25, 4608) }, 'The disk floor is now 2 GB; / has 4.5 GB free (82% full).'],
  ['the free-room floor raised until it is no longer asked of a disk that small', [sized(25, 4608)], 'loom: / has 4.5 GB free (82% full). Alerts under 5 GB free.', { lines: { diskFreeMib: 20_480 }, reading: sized(25, 4608) }, 'The 20 GB floor is no longer asked of /; 4.5 GB is free.'],
  ['the urgent line raised over a disk that is as full as it was', [disk(96)], 'loom: / is 96% full (8 GB free). Urgent at 95%.', { lines: { diskUrgentPercent: 100 }, reading: disk(96) }, 'The urgent line is now 100%; / is at 96% (8 GB free).', 'loom: / is 96% full (8 GB free). Alerts at 85%.'],
  ['the memory floor lowered under a machine with as little memory free', [memory(300), memory(310)], 'loom: 310 MB of memory is available. Alerts under 512 MB.', { lines: { memoryFreeMib: 200 }, reading: memory(310) }, 'The memory floor is now 200 MB; 310 MB of memory is available.'],
  ['the memory floor raised past half the machine\'s memory, where it is not asked', [memory(300), memory(310)], 'loom: 310 MB of memory is available. Alerts under 512 MB.', { lines: { memoryFreeMib: 9000 }, reading: memory(310) }, 'The memory floor is now 8.7 GB, which is not asked of a machine with 16 GB of memory; 310 MB is available.'],
  ['the memory floor switched off', [memory(300), memory(310)], 'loom: 310 MB of memory is available. Alerts under 512 MB.', { lines: { memoryFreeMib: 0 }, reading: memory(310) }, 'The memory floor was switched off.'],
  ['the disk floor switched off', [sized(25, 4608)], 'loom: / has 4.5 GB free (82% full). Alerts under 5 GB free.', { lines: { diskFreeMib: 0 }, reading: sized(25, 4608) }, 'The disk floor was switched off; / is at 82% (4.5 GB free).'],
  ['a reading and floor that round to the same amount', [sized(100, 40_000)], '', { lines: { diskFreeMib: 40_001 }, reading: sized(100, 40_000) }, null, 'loom: / has 40000 MB free (61% full). Alerts under 40001 MB free.'],
  // The lines changed and the condition stands: nothing is closed and nothing new is said.
  ['the memory floor raised, still asked, and still not met', [memory(300), memory(310)], 'loom: 310 MB of memory is available. Alerts under 512 MB.', { lines: { memoryFreeMib: 600 }, reading: memory(310) }, null],
  ['the percent line lowered under a raised disk', [disk(91)], 'loom: / is 91% full (18 GB free). Alerts at 85%.', { lines: { diskPercent: 70 }, reading: disk(91) }, null],
  // Opened by the lines changing over a reading that did not move.
  ['the percent line lowered under a disk that was fine', [disk(75), disk(75)], '', { lines: { diskPercent: 70 }, reading: disk(75) }, null, 'loom: / is 75% full (50 GB free). Alerts at 70%.'],
  ['the free-room floor raised over a disk that was fine', [sized(100, 30_000), sized(100, 30_000)], '', { lines: { diskFreeMib: 40_000 }, reading: sized(100, 30_000) }, null, 'loom: / has 29.2 GB free (71% full). Alerts under 39 GB free.'],
])('says what is true when %s', (_cause, open, opened, then, closed, said) => {
  const f = fixture();
  if (then.firstLines) setAlertLines(f.db, lined(then.firstLines));
  for (const reading of open) f.read(reading);
  expect(f.open()).toEqual(opened ? [opened] : []);
  if (then.lines) setAlertLines(f.db, lined(then.lines));
  f.read(then.reading);
  expect(f.closed()).toEqual(closed === null ? [] : [[opened, closed]]);
  expect(f.open()).toEqual(said ? [said] : closed === null ? [opened] : []);
});

it('closes a notice whose thing is no longer watched, or no longer readable, with that and nothing about a line', () => {
  const f = fixture();
  f.db.insert(household).values({ timezone: 'UTC' }).run();
  f.read(disk(91), disk(92, '/srv'), memory(300)); f.read(disk(91), disk(92, '/srv'), memory(300));
  f.read(disk(91), { kind: 'disk', thing: '/srv', unknown: true }, { kind: 'memory', unknown: true });
  f.advance(STALE_MS);
  f.read(disk(91), { kind: 'disk', thing: '/srv', unknown: true }, { kind: 'memory', unknown: true });
  f.read(memory(9000));
  expect(f.closed().map(([, why]) => why).sort()).toEqual(['/srv can no longer be read; last read Nov 19, 2:10 PM at 92%.', 'Memory can no longer be read; last read Nov 19, 2:10 PM with 300 MB available.', 'No longer watched']);
});
