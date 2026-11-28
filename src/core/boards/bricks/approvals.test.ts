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

it('approvals: its state is one of pending, answered, rules and notices, pending by default, and nothing else', () => {
  for (const state of ['pending', 'answered', 'rules', 'notices']) expect(definition.params.parse({ state })).toEqual({ state });
  expect(definition.params.parse({})).toEqual({ state: 'pending' });
  for (const state of ['history', 'Rules', 'rules ', '', 'all']) expect(() => definition.params.parse({ state }), state).toThrow();
  expect(() => definition.params.parse({ state: 'rules', search: 'pump' })).toThrow();
});
