/** The `lanes` brick's definition (./lanes.ts), held to what it commits loom to. */
import { expect, it } from 'vitest';
import { bricks } from '../bricks.js';
import { changeSentences } from '../brief.js';
import { actRow, Refused } from '../model.js';
import { agent, empty, pins } from './bench.test.helper.js';
import definition from './lanes.js';

it('lanes: whether it can be big, what it flags itself for, how it is named, and each action with its operation', () => {
  expect(pins(definition)).toEqual({
    big: true,
    flags: [],
    linkKey: null,
    references: { project: 'project' },
    actions: { pause: 'work.setProjectClaims', resume: 'work.setProjectClaims' },
  });
});

it("tells a pause or a resume of an agent's claims from the lanes, with nothing in its detail", () => {
  const board = agent(empty(), [{ change: 'place', brick: 'lanes', params: { project: 'loom' } }], () => 'l1').board;
  for (const action of ['pause', 'resume']) {
    expect(actRow(board, 'l1', action, {}).detail).toEqual({});
    for (const detail of [{ agent: 'art' }, { paused: 'true' }, { why: 'typed words' }]) expect(() => actRow(board, 'l1', action, detail), action + JSON.stringify(detail)).toThrow(Refused);
    expect(bricks.find((x) => x.name === 'lanes')!.actions[action].operation).toBe('work.setProjectClaims');
  }
  expect(changeSentences(board, [actRow(board, 'l1', 'pause', {})])).toEqual(['The member used pause on lanes(project=loom) on board b1.']);
  expect(() => actRow(board, 'l1', 'claim', {})).toThrow(Refused);
});
