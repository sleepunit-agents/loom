/** The `session` brick's definition (./session.ts), held to what it commits loom to. */
import { expect, it } from 'vitest';
import { pins } from './bench.test.helper.js';
import definition from './session.js';

it('session: whether it can be big, what it flags itself for, how it is named, and each action with its operation', () => {
  expect(pins(definition)).toEqual({
    big: true,
    flags: ['finished', 'failed', 'stopped'],
    linkKey: 'session',
    references: { session: 'session' },
    actions: { stop: 'runtime.jobStop' },
  });
});
