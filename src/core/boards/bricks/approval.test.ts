/** The `approval` brick's definition (./approval.ts), held to what it commits loom to. */
import { expect, it } from 'vitest';
import { catalogue } from '../bricks.js';
import { pins } from './bench.test.helper.js';
import definition from './approval.js';

it('approval: whether it can be big, what it flags itself for, how it is named, and each action with its operation', () => {
  expect(pins(definition)).toEqual({
    big: false,
    flags: [],
    linkKey: 'approval',
    references: { approval: 'approval' },
    actions: { approve: 'approvals.answer', refuse: 'approvals.answer', always: 'approvals.always' },
  });
});

it('tells an answer and a standing answer with nothing in the detail', () => {
  const actions = catalogue().find((b) => b.name === 'approval')!.actions;
  for (const action of [actions.approve, actions.refuse, actions.always]) expect(action).toMatchObject({ type: 'object', properties: {}, additionalProperties: false });
});
