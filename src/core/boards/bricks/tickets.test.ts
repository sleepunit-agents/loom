/** The `tickets` brick's definition (./tickets.ts), held to what it commits loom to. */
import { describe, expect, it } from 'vitest';
import { bricks } from '../bricks.js';
import { live, Refused } from '../model.js';
import { agent, empty, pins } from './bench.test.helper.js';
import definition from './tickets.js';

it('tickets: whether it can be big, what it flags itself for, how it is named, and that it has no action', () => {
  expect(pins(definition)).toEqual({
    big: true,
    flags: [],
    linkKey: null,
    references: {},
    actions: {},
  });
});

describe('the tickets brick', () => {
  const place = (params: Record<string, unknown>) => agent(empty(), [{ change: 'place', brick: 'tickets', params }]);
  it('takes no reference: its one parameter is a fixed state, ready unless another is asked for', () => {
    const brick = bricks.find((b) => b.name === 'tickets')!;
    expect(brick).toMatchObject({ references: {}, big: true, flags: [] });
    expect(brick.linkKey).toBeUndefined();
    expect(live(place({}).board)[0].params).toEqual({ state: 'ready' });
    for (const state of ['in-progress', 'shelved', 'all']) expect(live(place({ state }).board)[0].params).toEqual({ state });
  });
  it('refuses any other state, a search, a project and a page: none is a choice from its list', () => {
    for (const params of [{ state: 'closed' }, { state: 'in progress' }, { state: 'Ready' }, { search: 'gate latch' }, { state: 'ready', query: 'x' },
      { project: 'garden' }, { state: 'all', page: 2 }, { state: 'all', offset: 30 }]) expect(() => place(params), JSON.stringify(params)).toThrow(Refused);
  });
});
