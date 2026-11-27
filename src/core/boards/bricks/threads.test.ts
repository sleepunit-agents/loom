/** The `threads` brick's definition (./threads.ts), held to what it commits loom to. */
import { describe, expect, it } from 'vitest';
import { bricks } from '../bricks.js';
import { live, Refused } from '../model.js';
import { agent, empty, pins } from './bench.test.helper.js';
import definition from './threads.js';

it('threads: whether it can be big, what it flags itself for, how it is named, and each action with its operation', () => {
  expect(pins(definition)).toEqual({
    big: true,
    flags: [],
    linkKey: null,
    references: {},
    actions: {},
  });
});

describe('the threads brick', () => {
  const place = (params: Record<string, unknown>) => agent(empty(), [{ change: 'place', brick: 'threads', params }]);
  it('takes no reference: its one parameter is Comms\' folder, open unless archived is asked for', () => {
    const brick = bricks.find((b) => b.name === 'threads')!;
    expect(brick).toMatchObject({ references: {}, actions: {}, big: true, flags: [] });
    expect(brick.linkKey).toBeUndefined();
    expect(live(place({}).board)[0].params).toEqual({ scope: 'open' });
    expect(live(place({ scope: 'archived' }).board)[0].params).toEqual({ scope: 'archived' });
    for (const params of [{ scope: 'all' }, { scope: 'th:alice' }, { member: 'other' }, { scope: 'open', thread: 'th:1' }]) expect(() => place(params), JSON.stringify(params)).toThrow(Refused);
  });
});
