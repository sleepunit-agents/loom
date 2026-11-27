/** The `appearance` brick's definition (./appearance.ts), held to what it commits loom to. */
import { expect, it } from 'vitest';
import { live, Refused } from '../model.js';
import { agent, empty, pins } from './bench.test.helper.js';
import definition from './appearance.js';

it('appearance: whether it can be big, what it flags itself for, how it is named, and each action with its operation', () => {
  expect(pins(definition)).toEqual({
    big: true,
    flags: [],
    linkKey: null,
    references: {},
    actions: { set: 'household.setPreferences' },
  });
});

it('takes no parameter, so an agent cannot choose a look by placing it, and its one action carries nothing', () => {
  expect(live(agent(empty(), [{ change: 'place', brick: 'appearance', params: {} }]).board)[0].params).toEqual({});
  for (const params of [{ look: 'daylight' }, { motion: 'on' }, { member: 'sam' }]) expect(() => agent(empty(), [{ change: 'place', brick: 'appearance', params }]), JSON.stringify(params)).toThrow(Refused);
  expect(definition.actions.set.detail.safeParse({}).success).toBe(true);
  for (const detail of [{ look: 'daylight' }, { motion: 'on' }]) expect(definition.actions.set.detail.safeParse(detail).success).toBe(false);
});
