import { describe, expect, it } from 'vitest';
import { newId } from './id';

const v4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe('newId', () => {
  it('uses randomUUID where the page is a secure context', () => {
    expect(newId({ randomUUID: () => 'from-platform', getRandomValues: () => { throw new Error('unused'); } })).toBe('from-platform');
  });

  it('makes a version 4 UUID from getRandomValues where randomUUID is missing (plain HTTP)', () => {
    const source = { getRandomValues: <T extends ArrayBufferView | null>(array: T) => crypto.getRandomValues(array) };
    const ids = new Set(Array.from({ length: 200 }, () => newId(source)));
    expect(ids.size).toBe(200);
    for (const id of ids) expect(id).toMatch(v4);
  });

  it('sets the version and variant bits whatever the random bytes are', () => {
    for (const fill of [0x00, 0xff]) {
      const id = newId({ getRandomValues: <T extends ArrayBufferView | null>(array: T) => { (array as unknown as Uint8Array).fill(fill); return array; } });
      expect(id).toMatch(v4);
    }
  });
});
