import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { watchReadShape, readWatches } from './watch-read.js';
import type { Household } from './household.js';
import type { PieceInfo } from './ui/pieces.js';
const fixture = vi.hoisted(() => ({ pieces: [] as PieceInfo[] }));
vi.mock('./ui/pieces.js', async orig => ({ ...await orig<typeof import('./ui/pieces.js')>(), pieceManifests: vi.fn(async () => ({ pieces: fixture.pieces, skipped: [] })) }));
vi.mock('./needs-resolve.js', async orig => ({ ...await orig<typeof import('./needs-resolve.js')>(), pieceWithRole: (_env: unknown, role: string) => ({ name: role }) }));
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
  for (const b of [null, {}, { ...body, targets: [] }, { ...body, targets: Array(21).fill(body.targets[0]) },
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
