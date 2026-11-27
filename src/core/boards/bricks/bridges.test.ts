/** The `bridges` brick's definition (./bridges.ts), held to what it commits loom to. */
import { expect, it } from 'vitest';
import { catalogue } from '../bricks.js';
import { actRow, Refused } from '../model.js';
import { agent, empty, pins } from './bench.test.helper.js';
import definition from './bridges.js';

it('bridges: whether it can be big, what it flags itself for, how it is named, and each action with its operation', () => {
  expect(pins(definition)).toEqual({
    big: true,
    flags: ['held send'],
    linkKey: null,
    references: {},
    actions: { release: 'bridges.command', dismiss: 'bridges.command' },
  });
});

it('takes no parameter, and tells the board that a reply was released or dismissed and none of its words', () => {
  const place = (params: Record<string, unknown>) => () => agent(empty(), [{ change: 'place', brick: 'bridges', params }]);
  expect(place({})().board.placements[0].params).toEqual({});
  for (const params of [{ connection: 'c-1' }, { folder: 'sends' }, { text: 'hello' }]) expect(place(params), JSON.stringify(params)).toThrow(Refused);
  expect(catalogue().find((b) => b.name === 'bridges')).toMatchObject({ canBeBig: true, linkKey: null, references: {}, flagsItselfFor: ['held send'] });
  const board = place({})().board;
  for (const action of ['release', 'dismiss']) {
    expect(() => actRow(board, 'p1', action, {}), action).not.toThrow();
    for (const detail of [{ id: 's-1' }, { text: 'what it said' }, { channel: 'C1' }]) expect(() => actRow(board, 'p1', action, detail), action).toThrow(Refused);
  }
  for (const action of ['connection', 'disconnect', 'channel', 'person']) expect(() => actRow(board, 'p1', action, {}), action).toThrow(Refused);
});
