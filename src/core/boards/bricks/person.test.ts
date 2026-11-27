/** The `person` brick's definition (./person.ts), held to what it commits loom to. */
import { describe, expect, it } from 'vitest';
import { catalogue } from '../bricks.js';
import { actRow, bigOf, live, Refused } from '../model.js';
import { agent, empty, pins } from './bench.test.helper.js';
import definition from './person.js';

it('person: whether it can be big, what it flags itself for, how it is named, and each action with its operation', () => {
  expect(pins(definition)).toEqual({
    big: true,
    flags: [],
    linkKey: 'person',
    references: { person: 'person' },
    actions: {},
  });
});

describe('a person can be big', () => {
  it('lets a person take the big place, and still has no action', () => {
    const board = agent(empty(), [
      { change: 'place', brick: 'question', params: { item: 'i-1' } },
      { change: 'place', brick: 'person', params: { person: 'contact:anton' } },
    ]).board;
    expect(bigOf(live(board))?.brick).toBe('person');
    expect(catalogue().find((b) => b.name === 'person')).toMatchObject({ canBeBig: true, actions: {}, flagsItselfFor: [], linkKey: 'person' });
    expect(() => actRow(board, 'p2', 'add', {})).toThrow(Refused);
  });
});
