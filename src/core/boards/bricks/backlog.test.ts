/** The `backlog` brick's definition (./backlog.ts), held to what it commits loom to. */
import { expect, it } from 'vitest';
import { pins } from './bench.test.helper.js';
import definition from './backlog.js';

it('backlog: whether it can be big, what it flags itself for, how it is named, and each action with its operation', () => {
  expect(pins(definition)).toEqual({
    big: true,
    flags: [],
    linkKey: null,
    references: { project: 'project' },
    actions: { priority: 'tasks.command' },
  });
});
