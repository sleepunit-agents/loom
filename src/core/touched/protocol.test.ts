import { expect, it } from 'vitest';
import { touchReader } from './protocol.js';
it('preserves an identity at every byte boundary, including inside UTF-8 characters', () => {
  const notification = { type: 'person', id: 'josé/🌊' };
  const bytes = Buffer.from(JSON.stringify(notification) + '\n');
  for (let split = 1; split < bytes.length; split++) {
    const read = touchReader();
    expect(read(bytes.subarray(0, split))).toBeUndefined();
    expect(read(bytes.subarray(split))).toEqual(notification);
  }
});
it('refuses oversized wire frames, invalid JSON, and caller/content fields', () => {
  expect(() => touchReader()(Buffer.alloc(4097))).toThrow('too large');
  expect(() => touchReader()(Buffer.from('no\n'))).toThrow();
  expect(() => touchReader()(Buffer.from(JSON.stringify({ type: 'memory', id: 'ref', viewer: 'owner' }) + '\n'))).toThrow();
});
