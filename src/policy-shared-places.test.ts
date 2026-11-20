import { expect, it } from 'vitest';
import { WORD_SCHEDULE_REFUSAL, isSharedPlace, maySchedule } from './policy.js';

it('calls a bridge conversation that is not one member\'s own a shared place, and nothing else', () => {
  for (const venue of ['discord', 'slack']) {
    // A channel, a thread, a group direct message, a direct message from somebody who is no member.
    expect(isSharedPlace({ venue, member: null })).toBe(true);
    // One member's own direct conversation.
    expect(isSharedPlace({ venue, member: 'jonathan' })).toBe(false);
  }
  // A Comms thread, the agent's own wake, a handoff.
  for (const venue of ['loom', 'wake', 'handoff']) { expect(isSharedPlace({ venue, member: null })).toBe(false); expect(isSharedPlace({ venue, member: 'jonathan' })).toBe(false); }
});

it('holds a job to triggers naming the shared place it works in only when it works for anybody but owners', () => {
  const shared = { id: 'cv', venue: 'discord', member: null }, own = { id: 'own', venue: 'discord', member: 'jonathan' }, thread = { id: 'thread', venue: 'loom', member: 'jonathan' }, wake = { id: 'wake', venue: 'wake', member: null };
  const triggers = [{ conversation: 'cv' }, { conversation: 'another' }, { conversation: null }, {}];
  // Owners' word and the agent's own work: anything, wherever the body sits.
  for (const woke of ['owners', 'own'] as const) for (const where of [shared, own, thread, wake]) for (const trigger of triggers) expect(maySchedule(woke, where, trigger)).toBe(true);
  // Anybody else's word: only the shared place it is working in, and so nothing from anywhere else.
  expect(triggers.map(trigger => maySchedule('others', shared, trigger))).toEqual([true, false, false, false]);
  for (const where of [own, thread, wake]) for (const trigger of [...triggers, { conversation: where.id }]) expect(maySchedule('others', where, trigger)).toBe(false);
  expect(WORD_SCHEDULE_REFUSAL).toBe('This job is not working for the agent\'s owners, so it schedules only into the Discord or Slack conversation it is working in, if that is a shared place. Ask in your own thread, or have an owner schedule it.');
});
