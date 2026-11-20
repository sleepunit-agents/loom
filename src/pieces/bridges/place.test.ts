import { expect, it } from 'vitest';
import { conversationPlace, slackThread } from './place.js';

it('keeps the stored place formats, which existing conversations already use', () => {
  expect(conversationPlace('w', { channel: 'room', isDm: false }, null)).toBe('["w","room",null]');
  expect(conversationPlace('w', { channel: 'room', thread: 't', isDm: false }, 'jonathan')).toBe('["w","room","t"]');
  expect(conversationPlace('w', { channel: 'direct', isDm: true }, 'jonathan')).toBe('["w","direct",null,["member","jonathan"]]');
  expect(conversationPlace('w', { channel: 'direct', isDm: true }, null)).toBe('["w","direct",null,["member",null]]');
  expect(conversationPlace('w', { channel: 'direct', isDm: true, groupDm: true }, 'jonathan')).toBe('["w","direct",null,["group"]]');
});
it('starts a Slack thread at every message posted to a room, and none in a direct message', () => {
  for (const kind of ['channel', 'group'] as const) {
    expect(slackThread(kind, '1.000001', undefined)).toBe('1.000001');
    expect(slackThread(kind, '2.000001', '1.000001')).toBe('1.000001');
  }
  for (const kind of ['im', 'mpim'] as const) {
    expect(slackThread(kind, '1.000001', undefined)).toBeUndefined();
    expect(slackThread(kind, '2.000001', '1.000001')).toBe('1.000001');
  }
});
