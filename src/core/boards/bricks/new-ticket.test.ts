/** The `new-ticket` brick's definition (./new-ticket.ts), held to what it commits loom to. */
import { expect, it } from 'vitest';
import { pins } from './bench.test.helper.js';
import definition from './new-ticket.js';

it('new-ticket: whether it can be big, what it flags itself for, how it is named, and each action with its operation', () => {
  expect(pins(definition)).toEqual({
    big: true,
    flags: [],
    linkKey: null,
    references: { project: 'project' },
    actions: { create: 'tasks.command' },
  });
});
