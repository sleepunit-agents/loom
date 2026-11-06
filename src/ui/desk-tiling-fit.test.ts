// A piece's own fit (docs/specs/desk-tiling.md, "Fit"; criterion 21): a manifest's tab.fit is read, judged and refused
// with a message naming the field, and what it says is what the desk's fit table gives that app.
import { describe, it, expect } from 'vitest';
import { parseManifest } from './vocab.js';
import { DEFAULT_FIT, FIT, fitFor } from '../../web/src/tiling/fit';

const tab = (fit: unknown) => parseManifest({ v: 2, tab: { label: 'Garden', fit } });

describe('a manifest\'s tab.fit', () => {
  it('reaches the desk\'s fit table, each key it leaves out the default row\'s', () => {
    const m = tab({ min: [600, 400], ideal: 1300, big: true });
    expect(typeof m).toBe('object');
    const own = (m as { tab?: { fit?: object } }).tab?.fit;
    expect(own).toEqual({ min: [600, 400], ideal: 1300, big: true });
    expect(fitFor('Garden', own)).toMatchObject({ min: [600, 400], ideal: 1300, max: DEFAULT_FIT.max, big: true });
    // a piece's own wins over loom's row for its label (Tasks is in the table)
    expect(fitFor('Tasks', { ideal: 800 })).toMatchObject({ ideal: 800, big: false, min: DEFAULT_FIT.min });
    expect(fitFor('Tasks')).toBe(FIT.Tasks);
    // max: null is "any width"
    expect((tab({ max: null }) as { tab: { fit: object } }).tab.fit).toEqual({ max: null });
    expect((tab({}) as { tab: { fit: object } }).tab.fit).toEqual({});
  });

  it('refuses a min under 320×240, an ideal under the min\'s width, a max under the ideal, naming the field', () => {
    expect(tab({ min: [200, 100] })).toMatch(/tab\.fit\.min/);
    expect(tab({ min: [400, 200] })).toMatch(/tab\.fit\.min/);
    expect(tab({ min: [500, 300], ideal: 480 })).toMatch(/tab\.fit\.ideal/);
    expect(tab({ ideal: 400 })).toMatch(/tab\.fit\.ideal .*420/);   // the default min's width
    expect(tab({ ideal: 900, max: 800 })).toMatch(/tab\.fit\.max/);
    expect(tab({ max: 600 })).toMatch(/tab\.fit\.max .*720/);       // the default ideal
    expect(tab({ min: '420x300' })).toMatch(/tab\.fit\.min/);
    expect(tab({ ideal: 'wide' })).toMatch(/tab\.fit\.ideal/);
    expect(tab({ big: 'yes' })).toMatch(/tab\.fit\.big/);
    expect(tab({ grow: 1 })).toMatch(/tab\.fit\.grow/);
    expect(tab('wide')).toMatch(/tab\.fit/);
  });
});
