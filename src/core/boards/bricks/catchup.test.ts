/** The `catchup` brick's definition (./catchup.ts), held to what it commits loom to. */
import { describe, expect, it } from 'vitest';
import { bricks } from '../bricks.js';
import { actRow, live, Refused } from '../model.js';
import { agent, empty, pins } from './bench.test.helper.js';
import definition from './catchup.js';

it('catchup: whether it can be big, what it flags itself for, how it is named, and that it has no action', () => {
  expect(pins(definition)).toEqual({
    big: true,
    flags: [],
    linkKey: null,
    references: {},
    actions: {},
  });
});

describe('the catch-up brick', () => {
  const place = (params: Record<string, unknown>) => agent(empty(), [{ change: 'place', brick: 'catchup', params }]);
  it('takes no reference: its one parameter is a fixed time to look back to, today unless another is asked for', () => {
    expect(bricks.find((b) => b.name === 'catchup')).toMatchObject({ references: {}, big: true, flags: [] });
    expect(live(place({}).board)[0].params).toEqual({ since: 'today' });
    for (const since of ['3-days', '7-days']) expect(live(place({ since }).board)[0].params).toEqual({ since });
  });
  it('refuses any other time, a date, a number of days, a project and a search: none is a choice from its list', () => {
    for (const params of [{ since: 'yesterday' }, { since: '30-days' }, { since: 'Today' }, { since: '2026-11-20T00:00:00.000Z' }, { since: 3 },
      { days: 7 }, { project: 'garden' }, { since: 'today', search: 'pump' }]) expect(() => place(params), JSON.stringify(params)).toThrow(Refused);
    expect(() => actRow(place({}).board, 'p1', 'open', {})).toThrow(Refused);
  });
});
