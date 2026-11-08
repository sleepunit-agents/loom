import { describe, it, expect } from 'vitest';
import { parseTTL, computeExpiresAt, isExpired } from './ttl.js';

describe('parseTTL', () => {
  it('returns null for undefined', () => {
    expect(parseTTL(undefined)).toBeNull();
  });

  it('returns null for "permanent"', () => {
    expect(parseTTL('permanent')).toBeNull();
  });

  it('parses days', () => {
    expect(parseTTL('7d')).toBe(7 * 24 * 60 * 60 * 1000);
    expect(parseTTL('30d')).toBe(30 * 24 * 60 * 60 * 1000);
    expect(parseTTL('1d')).toBe(24 * 60 * 60 * 1000);
  });

  it('parses hours', () => {
    expect(parseTTL('24h')).toBe(24 * 60 * 60 * 1000);
    expect(parseTTL('1h')).toBe(60 * 60 * 1000);
  });

  it('throws on invalid format', () => {
    expect(() => parseTTL('7m')).toThrow('Invalid TTL format');
    expect(() => parseTTL('abc')).toThrow('Invalid TTL format');
    expect(() => parseTTL('7')).toThrow('Invalid TTL format');
  });

  it('returns null for empty string (falsy)', () => {
    expect(parseTTL('')).toBeNull();
  });
});

describe('computeExpiresAt', () => {
  it('returns null for permanent TTL', () => {
    expect(computeExpiresAt('2026-03-31T00:00:00.000Z', 'permanent')).toBeNull();
  });

  it('returns null for undefined TTL', () => {
    expect(computeExpiresAt('2026-03-31T00:00:00.000Z', undefined)).toBeNull();
  });

  it('computes correct expiration for days', () => {
    const result = computeExpiresAt('2026-03-31T00:00:00.000Z', '7d');
    expect(result).toBe('2026-04-07T00:00:00.000Z');
  });

  it('computes correct expiration for hours', () => {
    const result = computeExpiresAt('2026-03-31T00:00:00.000Z', '24h');
    expect(result).toBe('2026-04-01T00:00:00.000Z');
  });
});

describe('isExpired', () => {
  const past = '2026-03-01T00:00:00.000Z';
  const future = '2030-01-01T00:00:00.000Z';
  const now = new Date('2026-03-31T12:00:00.000Z');

  it('returns false for null/undefined', () => {
    expect(isExpired(null, now)).toBe(false);
    expect(isExpired(undefined, now)).toBe(false);
  });

  it('returns true for past expiration', () => {
    expect(isExpired(past, now)).toBe(true);
  });

  it('returns false for future expiration', () => {
    expect(isExpired(future, now)).toBe(false);
  });

  it('returns true when now equals expiry', () => {
    expect(isExpired('2026-03-31T12:00:00.000Z', now)).toBe(true);
  });
});
