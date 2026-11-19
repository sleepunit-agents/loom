/** An open window costs an idle household little: what a worker with no work writes does not make loom read
 * every live selection again, and a change of who may see what still reaches them at once.
 *
 * On 2026-11-19 two idle workers, each asking for work about once a second, had every open selection read
 * again twice for each poll: once for the credential's last-used time and once for the machine's last-seen
 * time. What remains in an idle household is about four readings of each selection a minute: one after each
 * thirty-second runtime sweep, one for the desk's clock and one for such times. scripts/live-idle-cost.ts
 * counts the same on a larger household. */
import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { afterEach, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { GraphQLInt } from 'graphql/index.js';
import { WebSocket } from 'ws';
import { FakeClock } from './core/clock.js';
import { createDataSchema } from './core/data/database.js';
import { boxes, boxFacts, boxReadings, inbox, members, tokens } from './core/data/schema.js';
import { STAMP_WAKE_MS } from './next-data.js';
import { SILENCE_MS } from './runtime/silence.js';
import { sharedRoot } from './shared-root.js';

interface Patch { path: (string | number)[]; value?: unknown; removed?: boolean | null }
/** What a window does with a patch (web/src/data/graphql/client.ts), without loading the web program here. */
function apply(current: unknown, path: (string | number)[], patch: Patch): unknown {
  if (!path.length) return patch.value;
  const [key, ...rest] = path, copy = (Array.isArray(current) ? [...current] : { ...(current as object) }) as Record<string | number, unknown>;
  if (!rest.length && patch.removed) { if (Array.isArray(copy)) copy.splice(Number(key), 1); else delete copy[key!]; }
  else copy[key!] = apply(copy[key!], rest, patch);
  return copy;
}
const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
const keys = { worker: 'a'.repeat(64), owner: 'c'.repeat(64), sam: 'd'.repeat(64) };
async function fixture() {
  const client = new Database(':memory:'); cleanup.push(() => { if (client.open) client.close(); });
  const clock = new FakeClock(), now = () => new Date(clock.now()).toISOString();
  const db = createDataSchema(client, now);
  db.insert(members).values([{ id: 'owner', role: 'owner', joinedAt: now() }, { id: 'sam', role: 'member', joinedAt: now() }]).run();
  db.insert(boxes).values({ id: 'worker', name: 'worker', owner: 'sam', hostsAny: true, sameMachineAsLoom: false, reportOnly: false, alwaysOn: false, enrolledAt: now(), lastSeenAt: now() }).run();
  db.insert(tokens).values([{ fingerprint: hash(keys.worker), label: 'worker', kind: 'runner', box: 'worker', createdAt: now() },
    { fingerprint: hash(keys.owner), label: 'Owner', kind: 'owner', member: 'owner', createdAt: now() },
    { fingerprint: hash(keys.sam), label: 'Sam', kind: 'owner', member: 'sam', createdAt: now() }]).run();
  let reads = 0;
  // No runtime sweep: it tells of a change every thirty seconds, and this counts what the polls alone cause.
  const root = sharedRoot({ db, clock, originAllowed: () => true, reportError: error => { throw error; }, modelRoles: () => [], deferRuntimeStart: true,
    fields: { probe: { type: GraphQLInt, resolve: () => { reads++; return 0; } } } });
  const server = createServer(), detach = root.attach(server); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  cleanup.push(async () => { await root.close(); detach(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('No listener');
  /** One live selection on a socket of its own; `data()` is what the window now shows. */
  const watch = async (who: 'owner' | 'sam', query: string) => {
    const ws = new WebSocket(`ws://127.0.0.1:${address.port}/graphql`, 'graphql-transport-ws', { headers: { authorization: 'Bearer ' + keys[who] } }); cleanup.push(() => ws.terminate());
    await once(ws, 'open'); const ack = once(ws, 'message'); ws.send(JSON.stringify({ type: 'connection_init' })); await ack;
    let shown: unknown, frames = 0;
    ws.on('message', raw => { frames++; for (const patch of JSON.parse(String(raw)).payload.data.observe.patches as Patch[]) shown = apply(shown, patch.path, patch); });
    ws.send(JSON.stringify({ type: 'subscribe', id: 'one', payload: { query: `subscription { observe(query:${JSON.stringify(query)}) { revision patches { path value removed } } }` } }));
    await vi.waitFor(() => expect(frames).toBe(1));
    return { data: () => shown, frames: () => frames, closed: () => ws.readyState !== WebSocket.OPEN };
  };
  const poll = async (input: Record<string, unknown> = {}) => {
    const response = await root.http.request('http://loom/api/runtime/next', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + keys.worker },
      body: JSON.stringify({ input: { execution: 'container', facts: ['os:linux'], slots: 2, ...input }, id: `poll-${clock.now()}-${Math.random()}` }) });
    expect(await response.json()).toEqual({ ok: true, value: null });
  };
  /** What the worker read on its own machine: a 200 GiB disk this full, and its memory. */
  const reading = async (percent: number | 'unknown', freeMemoryMib = 12_288, answers = true) => {
    const response = await root.http.request('http://loom/api/runtime/machineReadings', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + keys.worker },
      body: JSON.stringify({ input: { readings: [percent === 'unknown' ? { kind: 'disk', thing: '/', unknown: true } : { kind: 'disk', thing: '/', sizeBytes: 200 * 1024 ** 3, freeBytes: Math.round(2 * 1024 ** 3 * (100 - percent)) },
        { kind: 'memory', sizeBytes: 16 * 1024 ** 3, freeBytes: freeMemoryMib * 1024 ** 2 }, { kind: 'containers', answers }] }, id: `reading-${clock.now()}-${Math.random()}` }) });
    return (await response.json() as { value: { changed: boolean } }).value.changed;
  };
  // Long enough for a selection that was woken to have been read again.
  const settle = async () => { for (let i = 0; i < 30; i++) await new Promise(resolve => setImmediate(resolve)); };
  const seen = () => db.select().from(boxes).where(eq(boxes.id, 'worker')).get()!.lastSeenAt;
  return { root, db, clock, now, watch, poll, reading, settle, seen, reads: () => reads };
}

it('does not read an open selection again for a poll that found no work, and shows the last-seen time within a minute', async () => {
  const f = await fixture(), window = await f.watch('owner', '{ probe boxes { id lastSeenAt } boxFacts { fact } }');
  expect(f.reads()).toBe(1);
  // The first poll reports the machine's facts and room: a change, shown at once.
  f.clock.advance(1000); await f.poll();
  await vi.waitFor(() => expect(window.data()).toMatchObject({ boxFacts: [{ fact: 'os:linux' }] }));
  const first = f.seen(), after = f.reads(), frames = window.frames();
  expect(window.data()).toMatchObject({ boxes: [{ id: 'worker', lastSeenAt: first }] });
  for (let i = 0; i < 20; i++) { f.clock.advance(1000); await f.poll(); await f.settle(); }
  // Each poll was recorded, and nothing was read or sent for any of them.
  expect(f.seen()).toBe(f.now()); expect(f.seen()).not.toBe(first);
  expect(f.db.select().from(boxFacts).all()).toHaveLength(1);
  expect(f.reads()).toBe(after); expect(window.frames()).toBe(frames); expect(window.closed()).toBe(false);
  // The time is still shown, late: within a minute of the earlier poll it was kept back for. The desk's clock also has
  // every selection read at each whole minute (desk-time.ts), so the polls below are placed to tell the two apart.
  f.clock.advance(120_000 - f.clock.now() % 60_000 + 20_000); await f.settle();
  await f.poll(); await f.settle();
  const kept = f.reads(), earlier = f.seen();
  expect(window.data()).not.toMatchObject({ boxes: [{ lastSeenAt: earlier }] });
  // The minute turns 40 s later, and the desk's reading shows that poll.
  f.clock.advance(45_000);
  await vi.waitFor(() => expect(window.data()).toMatchObject({ boxes: [{ lastSeenAt: earlier }] }));
  expect(f.reads()).toBe(kept + 1);
  // A second poll, 15 s before the earlier one's minute is up. No whole minute falls in those 15 s: only the
  // wake kept for the stamps can show it, and it does, exactly then.
  await f.poll(); await f.settle();
  const latest = f.seen(); expect(latest).not.toBe(earlier);
  f.clock.advance(14_999); await f.settle();
  expect(f.reads()).toBe(kept + 1); expect(window.data()).toMatchObject({ boxes: [{ lastSeenAt: earlier }] });
  f.clock.advance(1);
  await vi.waitFor(() => expect(window.data()).toMatchObject({ boxes: [{ lastSeenAt: latest }] }), { timeout: 3000 });
  expect(f.reads()).toBe(kept + 2);
});

it('reads an open selection again at once when a poll changes more than the last-seen time', async () => {
  const f = await fixture(), window = await f.watch('owner', '{ probe boxes { id slots } boxFacts { fact } }');
  f.clock.advance(1000); await f.poll();
  await vi.waitFor(() => expect(window.data()).toEqual({ probe: 0, boxes: [{ id: 'worker', slots: 2 }], boxFacts: [{ fact: 'os:linux' }] }));
  f.clock.advance(1000); await f.poll(); await f.settle();
  const quiet = f.reads();
  f.clock.advance(1000); await f.poll({ facts: ['os:linux', 'gpu'] });
  await vi.waitFor(() => expect(window.data()).toMatchObject({ boxFacts: [{ fact: 'gpu' }, { fact: 'os:linux' }] }));
  f.clock.advance(1000); await f.poll({ facts: ['os:linux', 'gpu'], slots: 3 });
  await vi.waitFor(() => expect(window.data()).toMatchObject({ boxes: [{ id: 'worker', slots: 3 }] }));
  expect(f.reads()).toBe(quiet + 2);
  // A machine heard from again after a silence is a change too: it can be given work again.
  f.clock.advance(SILENCE_MS + 1000); await f.settle();
  const silent = f.reads();
  await f.poll({ facts: ['os:linux', 'gpu'], slots: 3 });
  await vi.waitFor(() => expect(f.reads()).toBe(silent + 1));
});

it('still withdraws what a person may no longer see at once, with stamp-only writes waiting', async () => {
  const f = await fixture(), window = await f.watch('sam', '{ probe boxes { id } }');
  expect(window.data()).toEqual({ probe: 0, boxes: [{ id: 'worker' }] });
  f.clock.advance(1000); await f.poll(); await f.settle();
  // Stamp-only polls are now waiting for their minute. The clock does not move again in this test.
  f.clock.advance(1000); await f.poll(); await f.poll(); await f.settle();
  const before = f.reads();
  f.root.writes.run(() => f.db.update(boxes).set({ owner: 'owner' }).where(eq(boxes.id, 'worker')).run());
  await vi.waitFor(() => expect(window.data()).toEqual({ probe: 0, boxes: [] }));
  expect(f.reads()).toBe(before + 1);
  // And a person who is removed loses the socket itself, as before.
  f.root.writes.run(() => f.db.update(members).set({ removedAt: f.now() }).where(eq(members.id, 'sam')).run());
  await vi.waitFor(() => expect(window.closed()).toBe(true));
});

it('does not read an open selection again for a write that was refused before it wrote anything', async () => {
  const f = await fixture(), window = await f.watch('owner', '{ probe boxes { id } }');
  await f.settle();
  const before = f.reads();
  expect(f.root.operations.call('http', { kind: 'member', id: 'owner' }, 'runtime.next', { execution: 'container' }, 'not-a-worker')).toMatchObject({ ok: false, code: 'denied' });
  await f.settle();
  expect(f.reads()).toBe(before); expect(window.closed()).toBe(false);
});

it('reads an open selection again at once for a machine reading that changes a state a person is shown, and for no drift in the numbers between', async () => {
  const f = await fixture(), window = await f.watch('sam', '{ probe boxReadings(orderBy: {kind: {direction: asc, priority: 0}}) { kind usedPercent answers level unknownSince } }');
  const shown = () => (window.data() as { boxReadings: { kind: string; usedPercent: number | null; answers: boolean | null; level: string; unknownSince: string | null }[] }).boxReadings;
  f.clock.advance(1000); expect(await f.reading(71)).toBe(true);
  await vi.waitFor(() => expect(shown()).toHaveLength(3));
  /** One reading that must be an ordinary change: read again and shown at once, with nothing waited for. */
  const loud = async (percent: number | 'unknown', answers: boolean, check: () => void) => {
    await f.settle(); const before = f.reads();
    f.clock.advance(1000); expect(await f.reading(percent, 12_288, answers)).toBe(true);
    await vi.waitFor(check);
    expect(f.reads()).toBeGreaterThan(before);
  };
  /** Readings whose numbers alone move: each is kept, and none wakes the selection. */
  const quiet = async (percents: number[], answers: boolean, unknown = false) => {
    await f.settle(); const before = f.reads(), frames = window.frames();
    for (const percent of percents) { f.clock.advance(1000); expect(await f.reading(unknown ? 'unknown' : percent, 12_288 - percent, answers), String(percent)).toBe(false); await f.settle(); }
    expect(f.reads()).toBe(before); expect(window.frames()).toBe(frames);
  };
  await quiet([72, 74, 80, 84, 71], true);
  // The container runtime stops answering: not yet a condition (one reading), and shown at once all the same.
  await loud(71, false, () => expect(shown()[0]).toMatchObject({ kind: 'containers', answers: false, level: 'ok' }));
  expect(f.db.select().from(inbox).all()).toEqual([]);
  // Answering again: at once too.
  await loud(71, true, () => expect(shown()[0]).toMatchObject({ answers: true }));
  await quiet([73, 71], true);
  // A thing the worker can no longer read, and one it can read again.
  await loud('unknown', true, () => expect(shown()[1]).toMatchObject({ kind: 'disk', usedPercent: 71, unknownSince: f.now() }));
  await quiet([0, 0], true, true);
  await loud(72, true, () => expect(shown()[1]).toMatchObject({ kind: 'disk', usedPercent: 72, unknownSince: null }));
  await quiet([75, 71], true);
});

it('does not read an open selection again for a machine reading that raises and clears nothing, and shows a condition at once', async () => {
  const f = await fixture(), window = await f.watch('sam', '{ probe boxReadings(where: {kind: {eq: disk}}) { thing usedPercent level } }');
  // The first reading is a thing watched for the first time: a change, shown at once.
  f.clock.advance(1000); expect(await f.reading(71)).toBe(true);
  await vi.waitFor(() => expect(window.data()).toEqual({ probe: 0, boxReadings: [{ thing: '/', usedPercent: 71, level: 'ok' }] }));
  await f.settle();
  const after = f.reads(), frames = window.frames();
  // The same reading again and again, and readings whose numbers move under every line.
  for (const percent of [71, 71, 71, 72, 74, 71, 80, 84, 71, 71]) { f.clock.advance(1000); expect(await f.reading(percent, 12_288 - percent), String(percent)).toBe(false); await f.settle(); }
  expect(f.db.select().from(boxReadings).all().map(row => [row.kind, row.usedPercent ?? row.freeMib ?? row.answers, row.readAt])).toEqual([['disk', 71, f.now()], ['memory', 12_217, f.now()], ['containers', true, f.now()]]);
  expect(f.reads()).toBe(after); expect(window.frames()).toBe(frames); expect(window.closed()).toBe(false);
  // Over the line is a condition: raised, told to the machine's owner and shown at once. Said again, it is nothing new.
  const quiet = f.reads();
  f.clock.advance(1000); expect(await f.reading(91)).toBe(true);
  await vi.waitFor(() => expect(window.data()).toEqual({ probe: 0, boxReadings: [{ thing: '/', usedPercent: 91, level: 'raised' }] }));
  expect(f.db.select().from(inbox).all().map(item => [item.to, item.words])).toEqual([['sam', 'worker: / is 91% full (18 GB free). Alerts at 85%.']]);
  // Five seconds after a notice is filed loom reads every selection once more, whether or not anything is
  // reported meanwhile. That is the notice's cost and not a reading's, and is let pass before the repeats are counted.
  f.clock.advance(6000); await f.settle();
  const raised = f.reads();
  expect(raised).toBeGreaterThan(quiet);
  for (let i = 0; i < 5; i++) { f.clock.advance(1000); expect(await f.reading(91)).toBe(false); await f.settle(); }
  expect(f.reads()).toBe(raised);
  expect(f.db.select().from(inbox).all()).toHaveLength(1);
  // Cleared is shown at once too.
  f.clock.advance(1000); expect(await f.reading(70)).toBe(true);
  await vi.waitFor(() => expect(window.data()).toEqual({ probe: 0, boxReadings: [{ thing: '/', usedPercent: 70, level: 'ok' }] }));
  await f.settle();
  // The numbers alone still reach the window, late: within a minute, as a last-seen time does. (This test keeps
  // clear of a whole minute until here: the desk's clock has every selection read at each one.)
  f.clock.advance(1000); expect(await f.reading(80)).toBe(false); await f.settle();
  expect(window.data()).toMatchObject({ boxReadings: [{ usedPercent: 70 }] });
  f.clock.advance(60_000);
  await vi.waitFor(() => expect(window.data()).toEqual({ probe: 0, boxReadings: [{ thing: '/', usedPercent: 80, level: 'ok' }] }), { timeout: 3000 });
});
