/** The `approvals` brick's definition (./approvals.ts), held to what it commits loom to. */
import { expect, it } from 'vitest';
import { pins } from './bench.test.helper.js';
import definition from './approvals.js';

it('approvals: whether it can be big, what it flags itself for, how it is named, and each action with its operation', () => {
  expect(pins(definition)).toEqual({
    big: true,
    flags: ['new approval'],
    linkKey: null,
    references: {},
    actions: {},
  });
});
