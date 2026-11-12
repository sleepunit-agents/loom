import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { watchReadShape, readWatches } from './watch-read.js';
import type { Household } from './household.js';
import type { PieceInfo } from './ui/pieces.js';
const fixture = vi.hoisted(() => ({ pieces: [] as PieceInfo[] }));
vi.mock('./ui/pieces.js', async orig => ({ ...await orig<typeof import('./ui/pieces.js')>(), pieceManifests: vi.fn(async () => ({ pieces: fixture.pieces, skipped: [] })) }));
vi.mock('./needs-resolve.js', async orig => ({ ...await orig<typeof import('./needs-resolve.js')>(), pieceWithRole: (_env: unknown, role: string) => ({ name: role }) }));
vi.mock('./comms.js', async orig => ({ ...await orig<typeof import('./comms.js')>(),
  threadOfAgentConversation: (_home: string, agent: string, cv: string) => agent === 'art' && cv === 'cv-private' ? { id: 'th-private', agent: 'art', member: 'sam' } : undefined,
  threadMembers: () => ({ live: new Map([['cv-private', { agent: 'art', member: 'sam' }]]), deleted: new Map() }),
}));
import { pieceManifests } from './ui/pieces.js';
const h = { home: '/tmp/unused-watch-test', agents: ['art', 'mark'], default: 'art', members: [
  { person: 'jonathan', role: 'owner', agents: '*' }, { person: 'sam', role: 'owner', agents: ['art'] },
] } as Household;
const body = { agent: 'art', principal: 'owner', targets: [{ kind: 'tasks.task', id: 't-1' }] };
beforeEach(() => { fixture.pieces = [{ piece: 'tasks', path: '', manifest: { v: 2, owners: 2, asks: [], agents: {
  art: { readings: [], jobs: [{ id: 't-1', text: 'Private prose', status: 'running' }] },
  mark: { readings: [], jobs: [{ id: 't-1', text: 'Other person', status: 'waiting' }] },
} } }]; });
afterEach(() => vi.clearAllMocks());
it('validates bounded targets and refuses unknown principals/agents before reading', async () => {
  expect(watchReadShape(body)).toBe(true);
  expect(watchReadShape({ ...body, targets: Array(20).fill(body.targets[0]) })).toBe(true);
  for (const b of [null, {}, { ...body, agent: 7 }, { ...body, principal: 7 }, { ...body, targets: [{ kind: 7, id: 'x' }] }, { ...body, targets: [{ kind: 'tasks.task', id: 7 }] }, { ...body, targets: [] }, { ...body, targets: Array(21).fill(body.targets[0]) },
    { ...body, targets: [{ kind: 'tasks.task', id: '\n' }] }, { ...body, principal: '-' }]) expect(watchReadShape(b)).toBe(false);
  await expect(readWatches({}, h, { ...body, principal: 'absent' })).rejects.toThrow();
  await expect(readWatches({}, h, { ...body, principal: 'sam', agent: 'mark' })).rejects.toThrow();
  expect(pieceManifests).not.toHaveBeenCalled();
});
it('awaits a fresh snapshot and returns only this agent target and observation, with no item prose', async () => {
  const read = await readWatches({}, h, body);
  expect(pieceManifests).toHaveBeenCalledWith({}, expect.any(Number), true);
  expect(read.observations).toEqual([{ kind: 'tasks.task', id: 't-1', identity: '["tasks.task","art","t-1"]', value: '["running",null,null]' }]);
  expect(JSON.stringify(read)).not.toContain('Private prose');
  fixture.pieces[0].manifest.agents!.art.jobs![0].status = 'waiting';
  expect((await readWatches({}, h, body)).observations[0]).toMatchObject({ value: '["waiting",null,null]' });
});
it('treats missing, unknown and failed providers as errors, never terminal observations', async () => {
  for (const targets of [[{ kind: 'tasks.task', id: 'missing' }], [{ kind: 'github.pr', id: 'x/y#1' }]]) {
    expect((await readWatches({}, h, { ...body, targets })).observations[0]).toEqual({ ...targets[0], error: 'Observation unavailable' });
  }
  fixture.pieces[0].manifest.agents!.art.state = 'unavailable';
  expect((await readWatches({}, h, body)).observations[0]).toMatchObject({ error: 'Observation unavailable' });
});

it('hides owners-unaware providers from an agent owner and scopes producer reads like Home', async () => {
  delete fixture.pieces[0].manifest.owners;
  expect((await readWatches({}, h, { ...body, principal: 'sam' })).observations[0]).toMatchObject({ error: 'Observation unavailable' });
  expect(pieceManifests).toHaveBeenCalledWith({ LOOM_OWNER_SCOPE: 'art' }, expect.any(Number), true);
  expect((await readWatches({}, h, body)).observations[0]).toMatchObject({ value: '["running",null,null]' });
});

it('the seam hides another members conversation jobs and approval targets while preserving their own access', async () => {
  fixture.pieces[0].manifest.agents!.art.jobs!.push({ id: 'private', text: 'Sam private work', status: 'running', conversation: 'cv-private' });
  fixture.pieces.push({ piece: 'approvals', path: '', manifest: { v: 2, owners: 2, asks: [
    { agent: 'art', text: 'Sam private decision', conversation: 'cv-private', actions: [{ label: 'Allow', action: 'allow', fields: { id: 'a-private' } }] },
    { agent: 'art', text: 'Public decision', actions: [{ label: 'Allow', action: 'allow', fields: { id: 'a-public' } }] },
  ] } });
  const targets = [{ kind: 'tasks.task', id: 'private' }, { kind: 'approvals.pending', id: 'a-private' }, { kind: 'approvals.pending', id: 'a-public' }, ...body.targets];
  const owner = await readWatches({}, h, { ...body, targets });
  expect(owner.observations.slice(0, 2)).toEqual(targets.slice(0, 2).map(t => ({ ...t, error: 'Observation unavailable' })));
  expect(owner.observations[2]).toMatchObject({ value: '["pending",null,null]' });
  expect(owner.observations[3]).toMatchObject({ value: '["running",null,null]' });
  const sam = await readWatches({}, h, { ...body, principal: 'sam', targets });
  expect(sam.observations.every(o => 'value' in o)).toBe(true);
  expect(JSON.stringify(owner)).not.toContain('Sam private');
});
