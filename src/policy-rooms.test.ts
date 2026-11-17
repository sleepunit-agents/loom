import { expect, it } from 'vitest';
import { ROOM_SCHEDULE_REFUSAL, isRoom, maySchedule } from './policy.js';

it('calls a bridge conversation that is not one member\'s own a room, and nothing else', () => {
  for (const venue of ['discord', 'slack']) {
    // A channel, a thread, a group direct message, a direct message from somebody who is no member.
    expect(isRoom({ venue, member: null })).toBe(true);
    // One member's own direct conversation.
    expect(isRoom({ venue, member: 'jonathan' })).toBe(false);
  }
  // A Comms thread, the agent's own wake, a handoff.
  for (const venue of ['loom', 'wake', 'handoff']) { expect(isRoom({ venue, member: null })).toBe(false); expect(isRoom({ venue, member: 'jonathan' })).toBe(false); }
});

it('lets a room\'s body schedule nothing, whatever the trigger, and leaves every other body to the rule about who it is', () => {
  const room = { venue: 'discord', member: null }, own = { venue: 'discord', member: 'jonathan' }, thread = { venue: 'loom', member: 'jonathan' }, wake = { venue: 'wake', member: null };
  for (const trigger of [{ ownerKind: 'agent', owner: 'art', toKind: 'agent', to: 'art' }, { ownerKind: 'agent', owner: 'art', toKind: null, to: null }, { ownerKind: 'member', owner: 'jonathan', toKind: 'person', to: 'jonathan' }] as const) {
    expect(maySchedule(room, trigger)).toBe(false);
    for (const elsewhere of [own, thread, wake]) expect(maySchedule(elsewhere, trigger)).toBe(true);
  }
  expect(ROOM_SCHEDULE_REFUSAL).toBe('A body working in a room cannot schedule work: ask in your own thread, or have an owner schedule it.');
});
