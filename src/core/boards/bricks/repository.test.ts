/** The `repository` brick's definition (./repository.ts), held to what it commits loom to. */
import { expect, it } from 'vitest';
import { pins } from './bench.test.helper.js';
import definition from './repository.js';

it('repository: whether it can be big, what it flags itself for, how it is named, and each action with its operation', () => {
  expect(pins(definition)).toEqual({
    big: true,
    flags: [],
    linkKey: 'repository',
    references: { repository: 'repository', project: 'project' },
    actions: {},
  });
});
