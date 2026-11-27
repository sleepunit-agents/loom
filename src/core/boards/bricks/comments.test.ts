/** The `comments` brick's definition (./comments.ts), held to what it commits loom to. */
import { expect, it } from 'vitest';
import { pins } from './bench.test.helper.js';
import definition from './comments.js';

it('comments: whether it can be big, what it flags itself for, how it is named, and each action with its operation', () => {
  expect(pins(definition)).toEqual({
    big: true,
    flags: ['comment'],
    linkKey: null,
    references: { ticket: 'ticket' },
    actions: { comment: 'tasks.command' },
  });
});
