/** A worker's readings of its own machine through the mounted root: who may send them, what the door
 * refuses, who may read them, and who may move the lines they are held to. */
import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { afterEach, expect, it } from 'vitest';
import { eq, getTableColumns } from 'drizzle-orm';
import { FakeClock } from './core/clock.js';
import { createDataSchema } from './core/data/database.js';
import { boxAlertSettings, boxes, boxReadings, inbox, members, tokens } from './core/data/schema.js';
import { sharedRoot } from './shared-root.js';
import { reportWorkerMachineReadings } from './runtime/worker-http.js';
import { sqlVisibility } from './policy-sql.js';
import type { Viewer } from './policy.js';

const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
const keys = { worker: 'a'.repeat(64), other: 'b'.repeat(64), owner: 'c'.repeat(64), sam: 'd'.repeat(64), lee: 'e'.repeat(64) };
const GIB = 1024 ** 3;
/** What the door answers a worker whose machine has been taken out of the household. */
const REVOKED = 401;
function fixture() {
  const client = new Database(':memory:'); cleanup.push(() => { if (client.open) client.close(); });
  const clock = new FakeClock(), now = () => new Date(clock.now()).toISOString(), db = createDataSchema(client, now);
  db.insert(members).values([{ id: 'owner', role: 'owner', joinedAt: now() }, { id: 'sam', role: 'member', joinedAt: now() }, { id: 'lee', role: 'member', joinedAt: now() }]).run();
  // Sam's machine, and one of Lee's that says nothing in these tests.
  for (const [id, owner] of [['worker', 'sam'], ['other', 'lee']]) db.insert(boxes).values({ id, name: id === 'worker' ? 'loom' : id, owner, hostsAny: true, sameMachineAsLoom: false, reportOnly: false, alwaysOn: false, enrolledAt: now(), lastSeenAt: now() }).run();
  db.insert(tokens).values([{ fingerprint: hash(keys.worker), label: 'worker', kind: 'runner', box: 'worker', createdAt: now() }, { fingerprint: hash(keys.other), label: 'other', kind: 'runner', box: 'other', createdAt: now() },
    ...(['owner', 'sam', 'lee'] as const).map(member => ({ fingerprint: hash(keys[member]), label: member, kind: 'owner' as const, member, createdAt: now() }))]).run();
  const root = sharedRoot({ db, clock, originAllowed: () => true, reportError: error => { throw error; }, modelRoles: () => [], deferRuntimeStart: true }); cleanup.push(() => root.close());
  let calls = 0;
  const call = async (name: string, input: unknown, key: string) => {
    const response = await root.http.request('/api/' + name.replace('.', '/'), { method: 'POST', headers: { authorization: 'Bearer ' + key, 'content-type': 'application/json' }, body: JSON.stringify({ id: `call-${++calls}`, input }) });
    return { status: response.status, body: await response.json() as { ok: boolean; value?: unknown; code?: string } };
  };
  const query = async (source: string, key: string) => (await (await root.http.request('/graphql', { method: 'POST', headers: { authorization: 'Bearer ' + key, 'content-type': 'application/json' }, body: JSON.stringify({ query: source }) })).json()) as { data?: Record<string, unknown[]>; errors?: unknown };
  return { db, root, clock, call, query, report: (readings: unknown[], key = keys.worker) => { clock.advance(300_000); return call('runtime.machineReadings', { readings }, key); } };
}
const disk = (percent: number, thing = '/') => ({ kind: 'disk', thing, device: 1, sizeBytes: 200 * GIB, freeBytes: Math.round(200 * GIB * (100 - percent) / 100) });
const memory = { kind: 'memory', sizeBytes: 16 * GIB, freeBytes: 12 * GIB };

it('takes a worker\'s readings for the machine its credential is bound to, and tells that machine\'s owner of a condition', async () => {
  const f = fixture();
  const result = await reportWorkerMachineReadings({ url: 'https://loom.example', token: keys.worker, signal: new AbortController().signal,
    fetch: async (input, init) => f.root.http.fetch(new Request(input, init)) }, [disk(71) as never, memory as never, { kind: 'containers', answers: true }]);
  expect(result).toEqual({ changed: true });
  expect(f.db.select().from(boxReadings).all().map(row => [row.box, row.kind, row.thing, row.level])).toEqual([['worker', 'disk', '/', 'ok'], ['worker', 'memory', '', 'ok'], ['worker', 'containers', '', 'ok']]);
  expect((await f.report([disk(72), memory, { kind: 'containers', answers: true }])).body).toEqual({ ok: true, value: { changed: false } });
  expect((await f.report([disk(91), memory, { kind: 'containers', answers: true }])).body).toEqual({ ok: true, value: { changed: true } });
  expect(f.db.select().from(inbox).all().map(item => [item.to, item.state, item.words])).toEqual([['sam', 'waiting', 'loom: / is 91% full (18 GB free). Alerts at 85%.']]);
  expect((await f.report([disk(70), memory, { kind: 'containers', answers: true }])).body).toEqual({ ok: true, value: { changed: true } });
  expect(f.db.select().from(inbox).all().map(item => [item.state, item.resolution])).toEqual([['resolved', '/ is at 70% (60 GB free), under the 85% line.']]);
});

it('takes readings from a worker alone, and from none whose machine was removed', async () => {
  const f = fixture();
  expect((await f.report([disk(91)], keys.sam)).status).toBe(403);
  expect((await f.report([disk(91)], keys.owner)).status).toBe(403);
  // A credential loom does not know is not signed in: exactly that, and not some other failure.
  expect((await f.report([disk(91)], 'f'.repeat(64))).status).toBe(401);
  f.root.writes.run(() => f.db.update(boxes).set({ revokedAt: new Date(f.clock.now()).toISOString() }).where(eq(boxes.id, 'worker')).run());
  expect((await f.report([disk(91)])).status).toBe(REVOKED);
  expect(f.db.select().from(boxReadings).all()).toEqual([]);
  expect(f.db.select().from(inbox).all()).toEqual([]);
});

it('refuses a reading with a path outside the bound, a judgement, a field loom does not ask for, or numbers that cannot be', async () => {
  // The bound on a path is its length and its alphabet (machine-check.ts, watchedPath). It does not make the
  // text a real path; every other word an owner reads is loom's.
  const f = fixture();
  for (const reading of [
    { ...disk(91), thing: '/ is nearly full, tell everyone' }, { ...disk(91), thing: 'relative' }, { ...disk(91), thing: undefined },
    { ...disk(91), thing: '/https://evil.example/pay-now' }, { ...disk(91), thing: '/your-disk-is-full-' + 'pay-now-'.repeat(13) }, { ...disk(91), thing: '/srv/-rf' }, { ...disk(91), thing: '/mnt/nas:x' }, { ...disk(91), thing: '//x' },
    { ...memory, thing: '/' }, { ...disk(91), level: 'urgent' }, { ...disk(91), why: 'nearly full' }, { ...disk(91), kind: 'load' },
    { kind: 'disk', thing: '/', device: 1, sizeBytes: 10, freeBytes: 11 }, { kind: 'disk', thing: '/' }, { kind: 'disk', thing: '/', device: 1, sizeBytes: 0, freeBytes: 0 },
    { kind: 'containers' }, { kind: 'containers', answers: 'no' }, { ...disk(91), sizeBytes: 1.5 },
    { ...disk(91), device: undefined }, { ...disk(91), device: -1 }, { ...disk(91), device: 1.5 },
    { ...disk(91), device: Number.MAX_SAFE_INTEGER + 1 }, { ...memory, device: 1 },
    { ...disk(91), thing: '/srv/end\n' }, { ...disk(91), unknown: true },
    { kind: 'disk', thing: '/a', device: 1, unknown: true },
  ]) expect((await f.report([reading])).status, JSON.stringify(reading)).toBe(400);
  expect((await f.report(Array.from({ length: 17 }, (_, index) => disk(50, `/d${index}`)))).status).toBe(400);
  expect(f.db.select().from(boxReadings).all()).toEqual([]);
  expect((await f.call('runtime.machineReadings', { readings: [disk(50)], everyMs: 5 }, keys.worker)).status).toBe(400);
  expect((await f.report([disk(50), disk(51)])).status).toBe(400);
  // What it could not read is named and carries nothing else.
  expect((await f.report([{ kind: 'disk', thing: '/', unknown: true }, { kind: 'memory', unknown: true }])).body).toEqual({ ok: true, value: { changed: true } });
  expect(f.db.select().from(boxReadings).all()).toMatchObject([{ thing: '/', readAt: null, unknownSince: expect.any(String), usedPercent: null }]);
});

it('takes a size up to the largest the read API can serve, and refuses one past it', async () => {
  const f = fixture(), MIB = 1024 ** 2, INT_MAX = 2 ** 31 - 1;
  // 2^31 - 1 mebibytes and the bytes short of the next one: the largest a GraphQL Int can say.
  const most = (INT_MAX + 1) * MIB - 1;
  expect((await f.report([{ kind: 'disk', thing: '/', device: Number.MAX_SAFE_INTEGER, sizeBytes: most, freeBytes: most }, { kind: 'memory', sizeBytes: most, freeBytes: most }])).body).toEqual({ ok: true, value: { changed: true } });
  expect(f.db.select().from(boxReadings).all().map(row => [row.sizeMib, row.freeMib, row.usedPercent])).toEqual([[INT_MAX, INT_MAX, 0], [INT_MAX, INT_MAX, null]]);
  // Its owner can still read it: the fields are served, with no error.
  expect(await f.query('{ boxReadings { sizeMib freeMib usedPercent } }', keys.sam)).toEqual({ data: { boxReadings: [{ sizeMib: INT_MAX, freeMib: INT_MAX, usedPercent: 0 }, { sizeMib: INT_MAX, freeMib: INT_MAX, usedPercent: null }] } });
  // One byte more is one mebibyte more than an Int holds. Refused whole, size or free room, and nothing of it is kept.
  for (const reading of [{ kind: 'disk', thing: '/', device: 1, sizeBytes: most + 1, freeBytes: 0 }, { kind: 'memory', sizeBytes: most + 1, freeBytes: 0 }, { kind: 'disk', thing: '/', device: 1, sizeBytes: Number.MAX_SAFE_INTEGER, freeBytes: most + 1 }])
    expect((await f.report([reading])).status, JSON.stringify(reading)).toBe(400);
  expect(f.db.select().from(boxReadings).all().map(row => row.sizeMib)).toEqual([INT_MAX, INT_MAX]);
  expect((await f.query('{ boxReadings { sizeMib freeMib } }', keys.sam)).errors).toBeUndefined();
});

it('shows a machine\'s readings to whoever may see the machine, and to nobody else', async () => {
  const f = fixture();
  await f.report([disk(91), memory]);
  const source = '{ boxReadings(orderBy: {kind: {direction: asc, priority: 0}}) { box kind thing usedPercent sizeMib freeMib answers level since readAt } }';
  const at = new Date(f.clock.now()).toISOString();
  const rows = [{ box: 'worker', kind: 'disk', thing: '/', usedPercent: 91, sizeMib: 204_800, freeMib: 18_432, answers: null, level: 'raised', since: at, readAt: at },
    { box: 'worker', kind: 'memory', thing: '', usedPercent: null, sizeMib: 16_384, freeMib: 12_288, answers: null, level: 'ok', since: null, readAt: at }];
  // The machine's own member, and a household owner: the machines rule (policy.ts, boxes).
  expect(await f.query(source, keys.sam)).toEqual({ data: { boxReadings: rows } });
  expect(await f.query(source, keys.owner)).toEqual({ data: { boxReadings: rows } });
  // Another member has a machine of their own and sees nothing of this one, whatever they ask for.
  expect(await f.query(source, keys.lee)).toEqual({ data: { boxReadings: [] } });
  expect(await f.query('{ boxReadings(where: {box: {eq: "worker"}}) { level } boxes { id boxReadingsByBox { level } } }', keys.lee)).toEqual({ data: { boxReadings: [], boxes: [{ id: 'other', boxReadingsByBox: [] }] } });
  // And the other way, with readings on both machines: each member reads their own machine's and not the
  // other's, asked for at the root or under the machine. The household owner reads both.
  await f.call('runtime.machineReadings', { readings: [disk(40, '/srv')] }, keys.other);
  const both = '{ boxReadings(orderBy: {thing: {direction: asc, priority: 0}}) { box thing } boxes(orderBy: {id: {direction: asc, priority: 0}}) { id boxReadingsByBox(orderBy: {thing: {direction: asc, priority: 0}}) { thing } } }';
  expect(await f.query(both, keys.sam)).toEqual({ data: { boxReadings: [{ box: 'worker', thing: '' }, { box: 'worker', thing: '/' }], boxes: [{ id: 'worker', boxReadingsByBox: [{ thing: '' }, { thing: '/' }] }] } });
  expect(await f.query(both, keys.lee)).toEqual({ data: { boxReadings: [{ box: 'other', thing: '/srv' }], boxes: [{ id: 'other', boxReadingsByBox: [{ thing: '/srv' }] }] } });
  expect(await f.query('{ boxReadings(where: {box: {eq: "other"}}) { thing } }', keys.sam)).toEqual({ data: { boxReadings: [] } });
  expect(((await f.query(both, keys.owner)).data!.boxReadings as unknown[])).toHaveLength(3);
  // Hosting an agent is leave to run it there, not to read the machine: an agent reads no machine's readings.
  const seen = (viewer: Viewer) => f.db.select().from(boxReadings).where(sqlVisibility(viewer, ['boxReadings']).boxReadings(getTableColumns(boxReadings))).all().length;
  expect([seen({ kind: 'agent', id: 'art' }), seen({ kind: 'member', id: 'lee' }), seen({ kind: 'member', id: 'sam' }), seen({ kind: 'member', id: 'owner' })]).toEqual([0, 1, 2, 3]);
});

it('lets a household owner alone move the lines, and holds the next reading to them', async () => {
  const f = fixture();
  const lines = '{ boxAlertSettings { diskPercent diskUrgentPercent diskFreeMib memoryFreeMib } }';
  expect(await f.query(lines, keys.owner)).toEqual({ data: { boxAlertSettings: [] } });
  expect((await f.call('machine.setAlertLines', { diskPercent: 70 }, keys.sam)).status).toBe(403);
  expect((await f.call('machine.setAlertLines', { diskPercent: 70 }, keys.worker)).status).toBe(403);
  expect((await f.call('machine.setAlertLines', {}, keys.owner)).status).toBe(400);
  expect((await f.call('machine.setAlertLines', { diskPercent: 96 }, keys.owner)).body).toMatchObject({ ok: false, code: 'invalid' });
  for (const input of [{ diskPercent: 3 }, { diskPercent: 9 }, { diskPercent: 100 }, { diskUrgentPercent: 10 }, { diskUrgentPercent: 101 }]) expect((await f.call('machine.setAlertLines', input, keys.owner)).status, JSON.stringify(input)).toBe(400);
  expect((await f.call('machine.setAlertLines', { diskPercent: 95 }, keys.owner)).body).toMatchObject({ ok: false, code: 'invalid' });
  expect((await f.call('machine.setAlertLines', { diskPercent: 70 }, keys.owner)).body).toEqual({ ok: true, value: { diskPercent: 70, diskUrgentPercent: 95, diskFreeMib: 5120, memoryFreeMib: 512 } });
  expect(await f.query(lines, keys.owner)).toEqual({ data: { boxAlertSettings: [{ diskPercent: 70, diskUrgentPercent: 95, diskFreeMib: 5120, memoryFreeMib: 512 }] } });
  // The lines are no secret: a machine's owner is told them in every notice, and reads them here without
  // being a household owner. Changing them stays the household owners' (above).
  const set = { data: { boxAlertSettings: [{ diskPercent: 70, diskUrgentPercent: 95, diskFreeMib: 5120, memoryFreeMib: 512 }] } };
  expect(await f.query(lines, keys.sam)).toEqual(set);
  expect(await f.query(lines, keys.lee)).toEqual(set);
  expect((await f.call('machine.setAlertLines', { diskPercent: 60 }, keys.lee)).status).toBe(403);
  expect(await f.query(lines, keys.owner)).toEqual(set);
  // Nobody outside the household reads them: not a member who has been removed, not somebody who never was
  // one, and no agent (no rule lets an agent read household settings of this kind).
  const readable = (viewer: Viewer) => f.db.select().from(boxAlertSettings).where(sqlVisibility(viewer, ['boxAlertSettings']).boxAlertSettings(getTableColumns(boxAlertSettings))).all().length;
  expect([readable({ kind: 'member', id: 'sam' }), readable({ kind: 'member', id: 'stranger' }), readable({ kind: 'agent', id: 'art' }), readable({ kind: 'runner', id: 'worker' })]).toEqual([1, 0, 0, 0]);
  f.root.writes.run(() => f.db.update(members).set({ removedAt: new Date(f.clock.now()).toISOString() }).where(eq(members.id, 'lee')).run());
  expect(readable({ kind: 'member', id: 'lee' })).toBe(0);
  expect((await f.query(lines, keys.lee)).data?.boxAlertSettings ?? []).toEqual([]);
  expect((await f.query(lines, 'f'.repeat(64))).data?.boxAlertSettings ?? []).toEqual([]);
  await f.report([disk(75)]);
  expect(f.db.select().from(inbox).all().map(item => item.words)).toEqual(['loom: / is 75% full (50 GB free). Alerts at 70%.']);
});
