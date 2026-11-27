/** The `tempo` brick's definition (./tempo.ts), held to what it commits loom to. */
import { expect, it } from 'vitest';
import { Refused } from '../model.js';
import { agent, empty, pins } from './bench.test.helper.js';
import definition from './tempo.js';

it('tempo: whether it can be big, what it flags itself for, how it is named, and each action with its operation', () => {
  expect(pins(definition)).toEqual({ big: true, flags: ['a firing failed'], linkKey: null, references: { agent: 'agent' }, actions: {} });
});

it('takes one agent id and nothing else: no words to search for, no folder, no day', () => {
  const place = (params: Record<string, unknown>) => () => agent(empty(), [{ change: 'place', brick: 'tempo', params }]);
  expect(place({ agent: 'art' })).not.toThrow();
  for (const params of [{}, { agent: 'the helpful one' }, { agent: '' }, { agent: 'art', search: 'water' }, { agent: 'art', day: '2026-11-27' }, { agent: 7 }])
    expect(place(params), JSON.stringify(params)).toThrow(Refused);
});
