import { describe, it, expect } from 'vitest';
import { globToMatcher } from './glob.js';

describe('globToMatcher', () => {
  it('matches exact title', () => {
    const m = globToMatcher('My Memory Title');
    expect(m('My Memory Title')).toBe(true);
    expect(m('My Memory Title Extra')).toBe(false);
    expect(m('Not This')).toBe(false);
  });

  it('matches prefix with trailing wildcard', () => {
    const m = globToMatcher('Forgejo sweep*');
    expect(m('Forgejo sweep — 2026-04-01')).toBe(true);
    expect(m('Forgejo sweep')).toBe(true);
    expect(m('Not a Forgejo sweep')).toBe(false);
  });

  it('matches suffix with leading wildcard', () => {
    const m = globToMatcher('*shipped');
    expect(m('PR #48 shipped')).toBe(true);
    expect(m('shipped')).toBe(true);
    expect(m('shipped today')).toBe(false);
  });

  it('matches contains with surrounding wildcards', () => {
    const m = globToMatcher('*loom*');
    expect(m('loom PR #48')).toBe(true);
    expect(m('drfish/loom project')).toBe(true);
    expect(m('not matching')).toBe(false);
  });

  it('is case-insensitive', () => {
    const m = globToMatcher('Forgejo*');
    expect(m('forgejo sweep')).toBe(true);
    expect(m('FORGEJO SWEEP')).toBe(true);
  });

  it('escapes regex special characters in pattern', () => {
    const m = globToMatcher('PR #48 (stall detection)');
    expect(m('PR #48 (stall detection)')).toBe(true);
    expect(m('PR #48 stall detection')).toBe(false);
  });

  it('supports multiple wildcards', () => {
    const m = globToMatcher('*sweep*2026*');
    expect(m('Forgejo sweep — 2026-04-01')).toBe(true);
    expect(m('sweep 2026')).toBe(true);
    expect(m('sweep 2025')).toBe(false);
  });
});
