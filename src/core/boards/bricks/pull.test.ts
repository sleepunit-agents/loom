/** The `pull` brick's definition (./pull.ts), held to what it commits loom to. */
import { expect, it } from 'vitest';
import { pins } from './bench.test.helper.js';
import definition from './pull.js';

it('pull: whether it can be big, what it flags itself for, how it is named, and each action with its operation', () => {
  expect(pins(definition)).toEqual({
    big: true,
    flags: ['check failed', 'merged', 'closed'],
    linkKey: 'change',
    references: { change: 'change' },
    actions: {},
  });
});
