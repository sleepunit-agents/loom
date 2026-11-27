/** The `ticket` brick's definition (./ticket.ts), held to what it commits loom to. */
import { expect, it } from 'vitest';
import { pins } from './bench.test.helper.js';
import definition from './ticket.js';

it('ticket: whether it can be big, what it flags itself for, how it is named, and each action with its operation', () => {
  expect(pins(definition)).toEqual({
    big: true,
    flags: ['closed', 'reopened'],
    linkKey: 'ticket',
    references: { ticket: 'ticket' },
    actions: { claim: 'tasks.command', unclaim: 'tasks.command', close: 'tasks.command', reopen: 'tasks.command', edit: 'tasks.command', link: 'tasks.command', unlink: 'tasks.command', ask: 'tasks.command', promote: 'tasks.command' },
  });
});

it('tells an ask and a promotion with nothing: not who was asked, not the question', () => {
  for (const action of ['ask', 'promote'] as const) {
    expect(definition.actions[action].detail.safeParse({}).success).toBe(true);
    for (const detail of [{ to: 'sam' }, { ask: 'Which hinge?' }, { type: 'epic' }]) expect(definition.actions[action].detail.safeParse(detail).success, action + JSON.stringify(detail)).toBe(false);
  }
});
