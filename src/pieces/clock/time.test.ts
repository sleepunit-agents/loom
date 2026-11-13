import { describe, expect, it } from 'vitest';
import { daysOf, nextOccurrence, parseAt, parseIn } from './time.js';
const iso = (n: number) => new Date(n).toISOString();
describe('Chicago clock calendar', () => {
  it('keeps the scheduled wall time when daylight saving ends', () => {
    const before = Date.parse('2026-10-31T13:31:00Z'); // 08:31 CDT
    const next = nextOccurrence({ at: '08:31' }, before);
    expect(iso(next)).toBe('2026-11-01T14:31:00.000Z'); // 08:31 CST
    expect(next-before).toBe(25*3600_000);
  });
  it('keeps the scheduled wall time when daylight saving begins', () => {
    const before = Date.parse('2026-03-07T14:31:00Z');
    expect(iso(nextOccurrence({ at: '08:31' }, before))).toBe('2026-03-08T13:31:00.000Z');
  });
  it('runs an ambiguous fall-back wall time once, at its first occurrence', () => {
    const schedule = { at: '01:31' };
    const first = nextOccurrence(schedule, Date.parse('2026-11-01T05:00:00Z'));
    expect(iso(first)).toBe('2026-11-01T06:31:00.000Z');
    expect(iso(nextOccurrence(schedule, first))).toBe('2026-11-02T07:31:00.000Z');
    expect(iso(nextOccurrence(schedule, Date.parse('2026-11-01T07:00:00Z')))).toBe('2026-11-02T07:31:00.000Z');
  });
  it('skips the spring gap even for a once-weekly schedule', () => {
    expect(iso(nextOccurrence({ at: '02:31', days: 'sun' }, Date.parse('2026-03-02T00:00:00Z')))).toBe('2026-03-15T07:31:00.000Z');
  });
  it('accepts several times and wrapping weekday ranges', () => {
    expect([...daysOf('fri-mon')]).toEqual([5,6,0,1]);
    expect(iso(nextOccurrence({ at: ['19:17','07:17'], days: 'mon-fri' }, Date.parse('2026-11-13T15:00:00Z')))).toBe('2026-11-14T01:17:00.000Z');
    expect(iso(nextOccurrence({ at: '07:17', days: 'mon-fri' }, Date.parse('2026-11-14T15:00:00Z')))).toBe('2026-11-16T13:17:00.000Z');
  });
  it('parses absolute, next and tomorrow wall times independently of the host timezone', () => {
    const now = Date.parse('2026-11-13T15:00:00Z');
    expect(iso(parseAt('2026-11-14 08:31:20', now))).toBe('2026-11-14T14:31:20.000Z');
    expect(iso(parseAt('10:17', now))).toBe('2026-11-13T16:17:00.000Z');
    expect(iso(parseAt('08:17', now))).toBe('2026-11-14T14:17:00.000Z');
    expect(iso(parseAt('tomorrow 10:17', now))).toBe('2026-11-14T16:17:00.000Z');
    expect(() => parseAt('2026-03-08 02:31', now)).toThrow('does not exist');
    expect(() => parseAt('2026-02-30 08:31', now)).toThrow('invalid');
  });
  it('parses elapsed durations and refuses malformed or unsafe values', () => {
    expect(parseIn('1h30m', 0)).toBe(5400_000);
    expect(() => parseIn('1hno', 0)).toThrow('duration');
    expect(() => parseIn('99999999999999999d', 0)).toThrow('range');
    expect(() => nextOccurrence({ at: '24:00' }, 0)).toThrow('HH:MM');
    expect(() => daysOf('mon-nope')).toThrow('--days');
  });
});
