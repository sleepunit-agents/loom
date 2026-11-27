/** The `activity` brick's definition (./activity.ts), held to what it commits loom to. */
import { describe, expect, it } from 'vitest';
import { catalogue } from '../bricks.js';
import { actRow, Refused } from '../model.js';
import { agent, empty, pins } from './bench.test.helper.js';
import definition from './activity.js';

it('activity: whether it can be big, what it flags itself for, how it is named, and each action with its operation', () => {
  expect(pins(definition)).toEqual({
    big: true,
    flags: [],
    linkKey: null,
    references: {},
    actions: {},
  });
});

describe('the household timeline', () => {
  const place = (params: Record<string, unknown>) => () => agent(empty(), [{ change: 'place', brick: 'activity', params }]);
  it('takes a day, 7 days or 30 days, changes nothing and flags nothing', () => {
    expect(place({})().board.placements[0].params).toEqual({ days: 1 });
    for (const days of [1, 7, 30]) expect(place({ days }), String(days)).not.toThrow();
    for (const params of [{ days: 3 }, { days: 0 }, { days: '7' }, { days: 7.5 }, { days: 7, agent: 'art' }, { day: '2026-11-13' }, { who: 'owner' }])
      expect(place(params), JSON.stringify(params)).toThrow(Refused);
    expect(catalogue().find((b) => b.name === 'activity')).toMatchObject({ canBeBig: true, linkKey: null, references: {}, flagsItselfFor: [], actions: {} });
    expect(() => actRow(place({})().board, 'p1', 'open', {})).toThrow(Refused);
  });
});
