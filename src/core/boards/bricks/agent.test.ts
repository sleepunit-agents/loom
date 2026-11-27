/** The `agent` brick's definition (./agent.ts), held to what it commits loom to. */
import { expect, it } from 'vitest';
import { bricks } from '../bricks.js';
import { applyChanges, live, Refused } from '../model.js';
import { agent, empty, ids, pins } from './bench.test.helper.js';
import definition from './agent.js';

it('agent: whether it can be big, what it flags itself for, how it is named, and each action with its operation', () => {
  expect(pins(definition)).toEqual({
    big: true,
    flags: ['waiting on you'],
    linkKey: 'agent',
    references: { agent: 'agent' },
    actions: { stop: 'runtime.jobStop' },
  });
});

it('an agent can be big, flags itself when it starts waiting on the member, and its one action is stopping a job', () => {
  const brick = bricks.find((b) => b.name === 'agent')!;
  expect(brick).toMatchObject({ big: true, flags: ['waiting on you'], references: { agent: 'agent' }, linkKey: 'agent' });
  expect(Object.keys(brick.actions)).toEqual(['stop']);
  expect(brick.actions.stop.operation).toBe('runtime.jobStop');
  // The job stopped and the reason are the operation's; the board is told only that it happened.
  expect(brick.actions.stop.detail.safeParse({}).success).toBe(true);
  for (const detail of [{ job: 'j-1' }, { reason: 'write-off' }, { note: 'because' }]) expect(brick.actions.stop.detail.safeParse(detail).success).toBe(false);
  const place = (params: Record<string, unknown>) => () => agent(empty(), [{ change: 'place', brick: 'agent', params }]);
  expect(place({ agent: 'art' })).not.toThrow();
  for (const params of [{}, { agent: 'the helpful one' }, { agent: 'art', job: 'j-1' }]) expect(place(params), JSON.stringify(params)).toThrow(Refused);
  const board = agent(empty(), [{ change: 'place', brick: 'lanes', params: { project: 'loom' } }, { change: 'place', brick: 'agent', params: { agent: 'art' } }]).board;
  expect(live(applyChanges(board, [{ change: 'maximize', placement: 'p2' }], 'member', ids()).board).map((p) => [p.brick, p.rank])).toEqual([['agent', 0], ['lanes', 1]]);
});
