/** The `machines` brick's definition (./machines.ts), held to what it commits loom to. */
import { expect, it } from 'vitest';
import { catalogue } from '../bricks.js';
import { actRow, Refused } from '../model.js';
import { agent, empty, pins } from './bench.test.helper.js';
import definition from './machines.js';

it('machines: whether it can be big, what it flags itself for, how it is named, and each action with its operation', () => {
  expect(pins(definition)).toEqual({
    big: true,
    flags: [],
    linkKey: null,
    references: {},
    actions: { proposeReader: 'machine.proposeReader', answerReader: 'machine.answerReader', setAlertLines: 'machine.setAlertLines' },
  });
});

it('takes no parameter, and its actions tell the board a choice and never a machine, an agent or a number', () => {
  const place = (params: Record<string, unknown>) => () => agent(empty(), [{ change: 'place', brick: 'machines', params }]);
  expect(place({})().board.placements[0].params).toEqual({});
  for (const params of [{ machine: 'box-1' }, { name: 'the big one' }]) expect(place(params), JSON.stringify(params)).toThrow(Refused);
  expect(catalogue().find((b) => b.name === 'machines')).toMatchObject({ canBeBig: true, linkKey: null, references: {}, flagsItselfFor: [] });
  const board = place({})().board;
  for (const [action, detail] of [['proposeReader', { allow: 'yes' }], ['proposeReader', { allow: 'no' }], ['answerReader', { answer: 'allow' }], ['answerReader', { answer: 'deny' }], ['setAlertLines', {}]] as const)
    expect(() => actRow(board, 'p1', action, detail), action).not.toThrow();
  for (const [action, detail] of [['proposeReader', {}], ['proposeReader', { allow: 'yes', agent: 'art' }], ['answerReader', { answer: 'maybe' }], ['answerReader', { answer: 'allow', id: 'a-1' }],
    ['setAlertLines', { diskPercent: '90' }], ['revoke', {}], ['enrol', {}]] as const)
    expect(() => actRow(board, 'p1', action, detail), action + JSON.stringify(detail)).toThrow(Refused);
});
