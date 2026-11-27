/** The `inbox` brick's definition (./inbox.ts), held to what it commits loom to. */
import { expect, it } from 'vitest';
import { catalogue } from '../bricks.js';
import { pins } from './bench.test.helper.js';
import definition from './inbox.js';

it('inbox: whether it can be big, what it flags itself for, how it is named, and each action with its operation', () => {
  expect(pins(definition)).toEqual({
    big: true,
    flags: ['new item'],
    linkKey: null,
    references: {},
    actions: { read: 'inbox.read', dismissResult: 'inbox.dismissResult' },
  });
});

it('tells a read and a dismissed result with nothing in the detail', () => {
  const actions = catalogue().find((b) => b.name === 'inbox')!.actions;
  for (const action of [actions.read, actions.dismissResult]) expect(action).toMatchObject({ type: 'object', properties: {}, additionalProperties: false });
});
