import { describe, it, expect } from 'vitest';
import { parseDeliverAnswer } from './delivery.js';

describe('quota delivery replies', () => {
  const base = { conversation: 'cv-0123456789ab', seq: 1, body: 'failed', reason: 'Claude is full; local Codex is disabled' };
  it('preserves the reset so the clock can wait instead of retrying blindly', () => {
    const answer = { ...base, code: 'quota', retryAfter: '2026-11-09T23:00:00.000Z' };
    expect(parseDeliverAnswer(answer)).toEqual(answer);
    expect(parseDeliverAnswer(base)).toEqual(base);
  });
  it('rejects malformed metadata and metadata on successful starts', () => {
    for (const extra of [{ code: 'other' }, { retryAfter: '2026-11-09T23:00:00.000Z' },
      { code: 'quota', retryAfter: 'tomorrow' }, { code: 'quota', body: 'started' },
      { code: 'quota', retryAfter: 42 }, { code: 'quota', retryAfter: '2026-11-09' }]) {
      expect(typeof parseDeliverAnswer({ ...base, ...extra })).toBe('string');
    }
  });
});
