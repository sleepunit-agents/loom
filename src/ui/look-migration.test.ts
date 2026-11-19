/**
 * 000h, a look until 2026-11-05, comes across as the look nearest it, by one rule held in two places: the app's
 * (web/src/look.ts lookOf, applied to what the program kept) and the boot script's (look-boot.test.ts runs it). 000h
 * with light is Daylight; with dark, auto or nothing, Low Light; the three looks are themselves; anything else is Neon Noir.
 */
import { describe, it, expect } from 'vitest';
import { lookOf as appLookOf, LOOKS, modeOf } from '../../web/src/look';

const CASES: Array<[unknown, unknown, string]> = [
  ['000h', 'light', 'daylight'], ['000h', 'dark', 'lowlight'], ['000h', 'auto', 'lowlight'], ['000h', undefined, 'lowlight'],
  ['neon', 'light', 'neon'], ['lowlight', 'light', 'lowlight'], ['daylight', 'dark', 'daylight'], ['glass', undefined, 'neon'], ['', 'light', 'neon'],
];

describe('a saved look as loom wears it now', () => {
  for (const [look, mode, now] of CASES) {
    it(`${JSON.stringify(look)} with ${JSON.stringify(mode)}: ${now}`, () => {
      expect(appLookOf(look as string, mode as string)).toBe(now);
    });
  }
  it('nothing saved: the app paints Neon Noir', () => {
    expect(appLookOf(undefined)).toBe('neon');
  });
  it('Appearance offers the three, each light or dark of its own', () => {
    expect(LOOKS.map((l) => [l.look, l.name, l.mode, modeOf(l.look)])).toEqual([
      ['neon', 'Neon Noir', 'dark', 'dark'], ['lowlight', 'Low Light', 'dark', 'dark'], ['daylight', 'Daylight', 'light', 'light']]);
  });
});
