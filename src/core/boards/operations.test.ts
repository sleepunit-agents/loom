import Database from 'better-sqlite3';
import { afterEach, expect, it } from 'vitest';
import { FakeClock } from '../clock.js';
import { Operations } from '../operations/index.js';
import { createDataSchema } from '../data/database.js';
import { OperationResults } from '../data/operation-results.js';
import { DataWrites } from '../data/writes.js';
import { agents, blueprints, boardChanges, boardPlacements, boards, members } from '../data/schema.js';
import { CommsMessages } from '../conversations/messages.js';
import type { Viewer } from '../../policy.js';
import { registerBoardOperations } from './operations.js';

const clients: Database.Database[] = [], dispatchers: Operations[] = [];
afterEach(() => { for (const op of dispatchers.splice(0)) op.close(); for (const client of clients.splice(0)) client.close(); });

/** One household: two members, one agent, a thread each, and a body working in each thread. */
function fixture() {
  const client = new Database(':memory:'); clients.push(client);
  const clock = new FakeClock(), now = () => new Date(clock.now()).toISOString();
  const db = createDataSchema(client, now);
  for (const id of ['jonathan', 'other']) db.insert(members).values({ id, role: 'member', joinedAt: now() }).run();
  db.insert(agents).values({ id: 'art', about: '', markBg: '#000', markFg: '#fff', faceShape: 'pebble', faceEyes: 'dot' }).run();
  let woken = 0;
  const operations = new Operations(client, clock, () => { woken++; }, {
    receipts: new OperationResults(db), writes: new DataWrites(db, { refreshAccess() {}, changed() {} }), reportError(error) { throw error; },
  });
  dispatchers.push(operations);
  const service = new CommsMessages(db, { async seal(w) { return Buffer.from(w); }, async open(b) { return Buffer.from(b).toString(); }, hash: (w) => 'h:' + w }, now);
  const mine = service.threads.open({ id: 'th:mine', member: 'jonathan', agent: 'art', title: 'Loom' });
  const theirs = service.threads.open({ id: 'th:theirs', member: 'other', agent: 'art', title: 'Pond' });
  const bodies: Record<string, { job: { id: string }; cv: { id: string; agent: string } }> = {
    'body-mine': { job: { id: 'job-1' }, cv: { id: mine.conversation, agent: 'art' } },
    'body-theirs': { job: { id: 'job-2' }, cv: { id: theirs.conversation, agent: 'art' } },
  };
  const store = registerBoardOperations(operations, db, ((viewer: Viewer) => bodies[viewer.id]) as never, (w) => 'h:' + w);
  let n = 0;
  const as = (viewer: Viewer) => async (name: string, input: unknown, command = 'c' + ++n) => {
    clock.advance(1000);
    return operations.callAsync('http', viewer, name, input, command, true, () => true) as Promise<{ ok: boolean; code?: string; message?: string; value?: any }>; // eslint-disable-line @typescript-eslint/no-explicit-any
  };
  return { db, store, woken: () => woken, agent: as({ kind: 'agent', id: 'body-mine' }), stranger: as({ kind: 'agent', id: 'body-theirs' }),
    member: as({ kind: 'member', id: 'jonathan' }), other: as({ kind: 'member', id: 'other' }) };
}
const place = (brick: string, params: Record<string, unknown>, rank?: number) => ({ change: 'place', brick, params, ...(rank === undefined ? {} : { rank }) });
async function pulse(f: ReturnType<typeof fixture>) {
  const board = (await f.agent('boards.open', { title: 'Loom lately' })).value.board as string;
  await f.agent('boards.change', { board, changes: [place('lanes', { project: 'loom' })] });
  const two = await f.agent('boards.change', { board, changes: [place('trend', { project: 'loom' })] });
  return { board, placements: two.value.placements as { placement: string; brick: string; rank: number }[] };
}

it('opens a board at revision 1 and draws each change as its own revision (check 1)', async () => {
  const f = fixture();
  const opened = await f.agent('boards.open', { title: 'Loom lately' });
  expect(opened).toMatchObject({ ok: true, value: { revision: 1, closed: false, placements: [], meanwhile: [] } });
  const board = opened.value.board;
  const one = await f.agent('boards.change', { board, changes: [place('lanes', { project: 'loom' })] });
  expect(one.value).toMatchObject({ revision: 2, placements: [{ brick: 'lanes', rank: 0 }] });
  const two = await f.agent('boards.change', { board, changes: [place('trend', { project: 'loom' })] });
  expect(two.value).toMatchObject({ revision: 3, placements: [{ brick: 'lanes', rank: 0 }, { brick: 'trend', rank: 1, params: { project: 'loom', days: 30 } }] });
  expect(f.db.select().from(boardChanges).all().map((r) => [r.revision, r.seq, r.change])).toEqual([[1, 0, 'open'], [2, 0, 'place'], [3, 0, 'place']]);
  expect(f.woken()).toBe(3);
});

it('stores nothing when a change in the call is refused, and says why (checks 4, 5)', async () => {
  const f = fixture(), { board } = await pulse(f);
  const refused = await f.agent('boards.change', { board, changes: [place('ticket', { ticket: 't-1' }), place('nonesuch', {})] });
  expect(refused).toMatchObject({ ok: false, code: 'invalid' });
  expect(refused.message).toContain('no brick named');
  expect(f.db.select().from(boardPlacements).all()).toHaveLength(2);
  expect((await f.agent('boards.change', { board, changes: [place('trend', { project: 'loom', days: 30 })] })).ok).toBe(false);
  expect((await f.agent('boards.change', { board, changes: [place('ticket', { ticket: 't-404' }, 9)] })).ok).toBe(false);
  expect((await f.agent('boards.change', { board, changes: [{ change: 'title', title: 'x'.repeat(81) }] })).ok).toBe(false);
  expect(f.store.row(board)!.revision).toBe(3);
});

it('returns the first result for a repeated command and refuses the same id with another input (check 6)', async () => {
  const f = fixture(), { board } = await pulse(f);
  const input = { board, changes: [place('ticket', { ticket: 't-1' })] };
  const first = await f.agent('boards.change', input, 'same');
  expect(await f.agent('boards.change', input, 'same')).toEqual(first);
  expect(f.db.select().from(boardPlacements).all()).toHaveLength(3);
  expect((await f.agent('boards.change', { board, changes: [place('ticket', { ticket: 't-2' })] }, 'same')).ok).toBe(false);
});

it("keeps a board to its thread's member and that thread's body (check 7)", async () => {
  const f = fixture(), { board, placements } = await pulse(f);
  const change = { board, changes: [{ change: 'remove', placement: placements[1].placement }] };
  for (const who of [f.other, f.stranger]) {
    expect(await who('boards.change', change)).toMatchObject({ ok: false, code: 'denied' });
    expect(await who('boards.close', { board })).toMatchObject({ ok: false, code: 'denied' });
  }
  expect(await f.stranger('boards.read', { board })).toMatchObject({ ok: false, code: 'denied' });
  expect(await f.other('boards.act', { board, placement: placements[0].placement, action: 'x', detail: {} })).toMatchObject({ ok: false, code: 'denied' });
  expect(await f.other('boards.open', { thread: 'th:mine', place: { brick: 'ticket', params: { ticket: 't-1' } } })).toMatchObject({ ok: false, code: 'denied' });
  expect(await f.member('boards.read', { board })).toMatchObject({ ok: false, code: 'denied' });
  expect((await f.stranger('boards.list', {})).value.boards).toEqual([]);
});

it("gives the member a narrower hand, and tells the agent what the member did (checks 6, 8, 9, 10)", async () => {
  const f = fixture(), { board, placements } = await pulse(f);
  const placed = await f.member('boards.change', { board, changes: [place('person', { person: 'member:jonathan' })] });
  expect(placed).toMatchObject({ ok: true, value: { board, revision: 4 } });
  expect(f.db.select().from(boardPlacements).all().at(-1)).toMatchObject({ brick: 'person', rank: 2, placedByKind: 'member' });
  expect((await f.member('boards.change', { board, changes: [place('person', { person: 'member:jonathan' })] })).ok).toBe(false);
  expect((await f.member('boards.change', { board, changes: [place('agent', { agent: 'art' }, 0)] })).ok).toBe(false);
  expect((await f.member('boards.change', { board, changes: [{ change: 'title', title: 'mine' }] })).ok).toBe(false);
  expect((await f.member('boards.change', { board, changes: [{ change: 'rank', placement: placements[1].placement, rank: 0 }] })).ok).toBe(false);
  await f.member('boards.change', { board, changes: [{ change: 'remove', placement: placements[1].placement }] });
  // The agent's next call on the board carries what it has not been told, once.
  const next = await f.agent('boards.change', { board, changes: [place('ticket', { ticket: 't-2441' })] });
  expect(next.value.meanwhile).toEqual([
    `The member placed person(person=member:jonathan) on board ${board}.`,
    `The member removed trend(days=30, project=loom) from board ${board}.`,
  ]);
  expect((await f.agent('boards.change', { board, changes: [{ change: 'title', title: 'Loom' }] })).value.meanwhile).toEqual([]);
  expect(f.store.row(board)).toMatchObject({ revision: 7, agentSeen: 7 });
});

it('hands a job its brief once, naming boards and placements by id (checks 9, 11)', async () => {
  const f = fixture(), { board, placements } = await pulse(f);
  expect(f.store.takeBrief('th:theirs')).toBe('No board is open in this thread.');
  await f.member('boards.change', { board, changes: [{ change: 'remove', placement: placements[1].placement }] });
  const other = (await f.member('boards.open', { thread: 'th:mine', place: { brick: 'ticket', params: { ticket: 't-7' } } })).value.board as string;
  const brief = f.store.takeBrief('th:mine', board);
  expect(brief).toContain(`Board ${board} "Loom lately", open, revision 4.`);
  expect(brief).toContain(`lanes(project=loom) [placement ${placements[0].placement}] (primary)`);
  expect(brief).toContain(`The member removed trend(days=30, project=loom) from board ${board}.`);
  expect(brief).toContain(`The member opened board ${other}.`);
  expect(brief).toContain(`The member placed ticket(ticket=t-7) on board ${other}.`);
  expect(f.store.takeBrief('th:mine', board)).not.toContain('Since you last looked');
  // With no board named, the last on the trail is the one shown.
  expect(f.store.takeBrief('th:mine')).toContain(`Board ${other}, open, revision 1.`);
});

it("logs a brick's action only for an action the brick has (check 12)", async () => {
  const f = fixture(), { board } = await pulse(f);
  const ticket = (await f.agent('boards.change', { board, changes: [place('ticket', { ticket: 't-2441' })] })).value.placements[2].placement;
  expect(await f.member('boards.act', { board, placement: ticket, action: 'set status', detail: { status: 'closed' } })).toMatchObject({ ok: true, value: { revision: 5 } });
  expect((await f.member('boards.act', { board, placement: ticket, action: 'delete', detail: {} })).ok).toBe(false);
  expect((await f.member('boards.act', { board, placement: ticket, action: 'set status', detail: { status: 'closed', words: 'secret' } })).ok).toBe(false);
  expect((await f.agent('boards.act', { board, placement: ticket, action: 'set status', detail: { status: 'open' } })).ok).toBe(false);
  expect(f.store.takeBrief('th:mine', board)).toContain(`The member used set status on ticket(ticket=t-2441) on board ${board}: status=closed.`);
  await f.member('boards.close', { board });
  expect((await f.member('boards.act', { board, placement: ticket, action: 'set status', detail: { status: 'open' } })).ok).toBe(false);
});

it('saves a blueprint, opens it for another project in one revision, and replaces it by name (checks 14, 15)', async () => {
  const f = fixture(), { board, placements } = await pulse(f);
  await f.agent('boards.change', { board, changes: [place('ticket', { ticket: 't-1' })] });
  const keep = placements.map((p) => ({ placement: p.placement, open: { project: 'project' } }));
  const saved = await f.agent('blueprints.save', { board, name: 'project pulse', description: 'Lanes and the opened-closed trend for one project.', placements: keep });
  expect(saved).toMatchObject({ ok: true, value: { parameters: [{ name: 'project', kind: 'project' }] } });
  expect((await f.agent('blueprints.list', {})).value.blueprints).toMatchObject([{ name: 'project pulse', uses: 0 }]);
  expect((await f.member('blueprints.list', {})).ok).toBe(false);
  const blueprint = saved.value.blueprint as string;
  const opened = await f.agent('boards.open', { title: 'Pond lately', blueprint, arguments: { project: 'pond' } });
  expect(opened.value).toMatchObject({ revision: 1, placements: [{ brick: 'lanes', params: { project: 'pond' }, rank: 0 }, { brick: 'trend', params: { project: 'pond', days: 30 }, rank: 1 }] });
  expect(f.db.select().from(blueprints).all()).toMatchObject([{ id: blueprint, uses: 1 }]);
  // Changing a board does not change the blueprint it came from; saving again by name keeps the id and the uses.
  await f.agent('boards.change', { board: opened.value.board, changes: [place('agent', { agent: 'art' })] });
  const again = await f.agent('blueprints.save', { board, name: 'project pulse', description: 'Lanes only.', placements: [keep[0]] });
  expect(again.value.blueprint).toBe(blueprint);
  expect(f.db.select().from(blueprints).all()).toMatchObject([{ id: blueprint, uses: 1, description: 'Lanes only.' }]);
  expect((await f.agent('boards.open', { title: 'x', blueprint, arguments: {} })).ok).toBe(false);
  expect((await f.agent('boards.open', { title: 'x', blueprint, arguments: { project: 'pond', extra: 1 } })).ok).toBe(false);
  expect(await f.stranger('boards.open', { title: 'x', blueprint: 'bp-none', arguments: {} })).toMatchObject({ ok: false, code: 'denied' });
  expect((await f.agent('blueprints.save', { board, name: 'bad', description: '', placements: [{ placement: placements[1].placement, open: { days: 'days' } }] })).ok).toBe(false);
});

it('closes and reopens along the trail (checks 16, 17)', async () => {
  const f = fixture(), { board } = await pulse(f);
  const second = (await f.agent('boards.open', { title: 'Another thing' })).value.board as string;
  expect(f.store.trail('th:mine').map((b) => b.id)).toEqual([board, second]);
  expect((await f.agent('boards.list', {})).value.boards).toMatchObject([{ board, primary: { brick: 'lanes' } }, { board: second, primary: null }]);
  expect((await f.member('boards.close', { board })).ok).toBe(true);
  expect((await f.member('boards.close', { board })).ok).toBe(false);
  expect((await f.agent('boards.change', { board, changes: [place('ticket', { ticket: 't-1' })] })).ok).toBe(false);
  expect(f.store.trail('th:mine').map((b) => b.id)).toEqual([second]);
  expect((await f.agent('boards.reopen', { board })).value).toMatchObject({ closed: false, revision: 5, meanwhile: [`The member closed board ${board}.`] });
  expect((await f.agent('boards.reopen', { board })).ok).toBe(false);
  expect(f.store.trail('th:mine').map((b) => b.id)).toEqual([second, board]);
  const read = await f.agent('boards.read', { board, since: 3 });
  expect(read.value.changes.map((c: { change: string }) => c.change)).toEqual(['close', 'reopen']);
  expect(f.db.select().from(boards).all()).toHaveLength(2);
});

it('lists every brick for a body and for a member', async () => {
  const f = fixture();
  expect((await f.agent('bricks.catalogue', {})).value.bricks).toHaveLength(11);
  expect((await f.member('bricks.catalogue', {})).value.bricks[2]).toMatchObject({ name: 'trend', linkKey: null });
});
