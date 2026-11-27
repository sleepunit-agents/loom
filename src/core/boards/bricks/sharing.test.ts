/** The `sharing` brick's definition (./sharing.ts), held to what it commits loom to. */
import { expect, it } from 'vitest';
import { catalogue } from '../bricks.js';
import { actRow, Refused } from '../model.js';
import { agent, empty, pins } from './bench.test.helper.js';
import definition from './sharing.js';

it('sharing: whether it can be big, what it flags itself for, how it is named, and each action with its operation', () => {
  expect(pins(definition)).toEqual({ big: true, flags: [], linkKey: null, references: {}, actions: {} });
});

it('takes no parameter and has no action', () => {
  const place = (params: Record<string, unknown>) => () => agent(empty(), [{ change: 'place', brick: 'sharing', params }]);
  expect(place({})().board.placements[0].params).toEqual({});
  for (const params of [{ project: 'pond' }, { member: 'sam' }]) expect(place(params), JSON.stringify(params)).toThrow(Refused);
  expect(catalogue().find((b) => b.name === 'sharing')).toMatchObject({ canBeBig: true, linkKey: null, references: {}, flagsItselfFor: [], actions: {} });
  expect(() => actRow(place({})().board, 'p1', 'share', {})).toThrow(Refused);
});
