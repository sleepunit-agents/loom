/** The `people` brick's definition (./people.ts), held to what it commits loom to. */
import { describe, expect, it } from 'vitest';
import { bricks, catalogue } from '../bricks.js';
import { actRow, Refused } from '../model.js';
import { agent, empty, pins } from './bench.test.helper.js';
import definition from './people.js';

it('people: whether it can be big, what it flags itself for, how it is named, and each action with its operation', () => {
  expect(pins(definition)).toEqual({
    big: true,
    flags: [],
    linkKey: null,
    references: {},
    actions: { add: 'mind.personAdd' },
  });
});

describe('the directory of people', () => {
  const place = (params: Record<string, unknown>) => () => agent(empty(), [{ change: 'place', brick: 'people', params }]);
  it('takes one of People\'s folders and no words to search for', () => {
    expect(place({})().board.placements[0].params).toEqual({ folder: 'all' });
    for (const folder of ['all', 'person', 'agent']) expect(place({ folder }), folder).not.toThrow();
    for (const params of [{ folder: 'friends' }, { folder: 'People' }, { query: 'anton' }, { folder: 'all', search: 'anton' }, { agent: 'art' }])
      expect(place(params), JSON.stringify(params)).toThrow(Refused);
    expect(catalogue().find((b) => b.name === 'people')).toMatchObject({ canBeBig: true, linkKey: null, references: {}, flagsItselfFor: [] });
    const board = place({})().board;
    expect(() => actRow(board, 'p1', 'add', {})).not.toThrow();
    expect(() => actRow(board, 'p1', 'add', { name: 'I typed this' })).toThrow(Refused);
    expect(bricks.find((b) => b.name === 'people')!.actions.add.operation).toBe('mind.personAdd');
  });
});
