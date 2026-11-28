/** The `pull` brick's definition (./pull.ts), held to what it commits loom to. */
import { expect, it } from 'vitest';
import { changeSentences } from '../brief.js';
import { actRow, Refused } from '../model.js';
import { agent, empty, pins } from './bench.test.helper.js';
import definition from './pull.js';

it('pull: whether it can be big, what it flags itself for, how it is named, and each action with its operation', () => {
  expect(pins(definition)).toEqual({
    big: true,
    flags: ['check failed', 'merged', 'closed'],
    linkKey: 'change',
    references: { change: 'change' },
    actions: { refresh: 'changes.refresh' },
  });
});

it('tells a refresh from GitHub with nothing in its detail, and refuses any other action', () => {
  const board = agent(empty(), [{ change: 'place', brick: 'pull', params: { change: 'github:acme/app#12' } }], () => 'p1').board;
  expect(actRow(board, 'p1', 'refresh', {}).detail).toEqual({});
  for (const detail of [{ repository: 'acme/app' }, { why: 'typed words' }]) expect(() => actRow(board, 'p1', 'refresh', detail), JSON.stringify(detail)).toThrow(Refused);
  expect(changeSentences(board, [actRow(board, 'p1', 'refresh', {})])).toEqual(["The member's page reported: used refresh on pull(change=github:acme/app#12) on board b1."]);
  for (const action of ['merge', 'answer']) expect(() => actRow(board, 'p1', action, {}), action).toThrow(Refused);
});
