/** The `agents` brick's definition (./agents.ts), held to what it commits loom to. */
import { expect, it } from 'vitest';
import { bricks } from '../bricks.js';
import { live, Refused } from '../model.js';
import { agent, empty, pins } from './bench.test.helper.js';
import definition from './agents.js';

it('agents: whether it can be big, what it flags itself for, how it is named, and each action with its operation', () => {
  expect(pins(definition)).toEqual({
    big: false,
    flags: [],
    linkKey: null,
    references: {},
    actions: {},
  });
});

it('the roster takes no parameter, has no action, never flags itself and is small only', () => {
  const brick = bricks.find((b) => b.name === 'agents')!;
  expect(brick).toMatchObject({ big: false, flags: [], references: {}, actions: {} });
  expect(live(agent(empty(), [{ change: 'place', brick: 'agents', params: {} }]).board)[0].params).toEqual({});
  for (const params of [{ agent: 'art' }, { scope: 'all' }]) expect(() => agent(empty(), [{ change: 'place', brick: 'agents', params }]), JSON.stringify(params)).toThrow(Refused);
  const board = agent(empty(), [{ change: 'place', brick: 'lanes', params: { project: 'loom' } }, { change: 'place', brick: 'agents', params: {} }]).board;
  expect(() => agent(board, [{ change: 'maximize', placement: 'p2' }])).toThrow(/no big form/);
});
