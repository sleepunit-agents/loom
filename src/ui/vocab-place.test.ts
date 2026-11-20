// A section's place on its page (docs/extensions.md, "Pages"; Jonathan, 2026-11-05: "something in the vein of lately,
// but related to what we're looking at"): `"place": "side"` puts it in the side column. It's only a placement: the
// section is checked block by block exactly as a main-column one is, and the older `"side": true` still means it.
import { describe, it, expect } from 'vitest';
import { parsePage, type Page } from './vocab.js';

const page = (s: Record<string, unknown>) => parsePage({ title: 'T', sections: [{ id: 's', blocks: [{ type: 'text', text: 'hi' }], ...s }] });
const placeOf = (r: Page | string) => (typeof r === 'string' ? r : r.sections[0].place ?? 'main');

describe('a section\'s place', () => {
  it('is the main column unless it says side', () => {
    expect(placeOf(page({}))).toBe('main');
    expect(placeOf(page({ place: 'main' }))).toBe('main');
    expect(placeOf(page({ place: 'side' }))).toBe('side');
    // Main is the default, so it isn't written out.
    expect((page({ place: 'main' }) as Page).sections[0]).not.toHaveProperty('place');
  });

  it('takes the older "side": true as the side column, and false as the main one', () => {
    expect(placeOf(page({ side: true }))).toBe('side');
    expect(placeOf(page({ side: false }))).toBe('main');
    expect(placeOf(page({ side: true, place: 'side' }))).toBe('side');
    // Never written back out: one spelling reaches the app.
    expect((page({ side: true }) as Page).sections[0]).not.toHaveProperty('side');
  });

  it('refuses a place it doesn\'t know, and the two spellings disagreeing', () => {
    expect(page({ place: 'left' })).toMatch(/section\.place must be main or side/);
    expect(page({ place: 'main', side: true })).toMatch(/disagree/);
    expect(page({ place: 'side', side: false })).toMatch(/disagree/);
  });

  it('checks a side section\'s blocks as it does a main one\'s: a bad block refuses the page either way', () => {
    const bad = { blocks: [{ type: 'chart', kind: 'pie', series: [], data: [] }] };
    const main = page(bad), side = page({ ...bad, place: 'side' });
    expect(typeof main).toBe('string');
    expect(side).toBe(main);
    // And a secret stays secret in the side column too.
    const r = page({ place: 'side', blocks: [{ type: 'form', action: 'a', submit: 'S', fields: [{ name: 'v', label: 'V', kind: 'secret', value: 'leak' }] }] });
    expect(JSON.stringify(r)).not.toContain('leak');
  });
});
