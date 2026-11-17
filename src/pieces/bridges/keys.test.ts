import { expect, it } from 'vitest';
import { inboxSourceId, incomingId, outsidePersonKey, parseInboxSourceId } from './keys.js';

it('keeps the stored key formats, which existing rows already use', () => {
  expect(incomingId('c', 'm')).toBe('bi:["c","m"]');
  expect(incomingId('c', JSON.stringify(['C1', '1.000001']))).toBe('bi:["c","[\\"C1\\",\\"1.000001\\"]"]');
  expect(inboxSourceId('w', 'room', 'm')).toBe('["w","room","m"]');
  expect(outsidePersonKey('slack', 'w', 'U1')).toBe('["slack","w","U1"]');
});
it('reads back only what it wrote', () => {
  expect(parseInboxSourceId(inboxSourceId('w', 'room', 'm'))).toEqual({ workspace: 'w', channel: 'room', message: 'm' });
  for (const value of [null, '', 'thread:1', '["w","room"]', '["w","room",""]', '["w","room",3]', '{"a":1}']) expect(parseInboxSourceId(value)).toBeUndefined();
});
