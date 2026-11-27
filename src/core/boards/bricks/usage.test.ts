/** The `usage` brick's definition (./usage.ts), held to what it commits loom to. */
import { expect, it } from 'vitest';
import { catalogue } from '../bricks.js';
import { actRow, Refused } from '../model.js';
import { agent, empty, pins } from './bench.test.helper.js';
import definition from './usage.js';

it('usage: whether it can be big, what it flags itself for, how it is named, and each action with its operation', () => {
  expect(pins(definition)).toEqual({ big: true, flags: [], linkKey: null, references: {}, actions: {} });
});

it('takes a day, a week or thirty days, a week unless told, no conversation, and has no action', () => {
  const place = (params: Record<string, unknown>) => () => agent(empty(), [{ change: 'place', brick: 'usage', params }]);
  expect(place({})().board.placements[0].params).toEqual({ days: 7 });
  for (const days of [1, 7, 30]) expect(place({ days }), String(days)).not.toThrow();
  for (const params of [{ days: 2 }, { days: '7' }, { days: 0 }, { days: 7, conversation: 'cv-1' }, { from: '2026-11-01' }]) expect(place(params), JSON.stringify(params)).toThrow(Refused);
  expect(catalogue().find((b) => b.name === 'usage')).toMatchObject({ canBeBig: true, linkKey: null, references: {}, flagsItselfFor: [], actions: {} });
  expect(() => actRow(place({})().board, 'p1', 'open', {})).toThrow(Refused);
});
