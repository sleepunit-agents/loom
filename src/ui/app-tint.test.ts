// @vitest-environment node
/**
 * Each app has one colour (web/src/tint.ts), the same in Places or Setup, in the dock and in its page's header:
 * from its manifest's tab.accent, else loom's table, else its name. Never its place in a grid: before, a tile was
 * coloured `i % 4`, so installing a piece moved every colour after it, and Appearance was pink in Setup's grid but
 * green (olive) in its own header.
 */
import { describe, expect, it } from 'vitest';
// The app's own React (web/node_modules: `npm run build` installs it before `npm test`), the one its components use.
import { createElement as h } from '../../web/node_modules/react/index.js';
import { renderToStaticMarkup } from '../../web/node_modules/react-dom/server.node.js';
import { APP_TINTS, TINTS, nameTint, tintOf, tintsOf } from '../../web/src/tint';

import { Dock } from '../../web/src/components/ui/dock';
import { ACCENTS, parseManifest } from './vocab.js';

describe("an app's one colour (web/src/tint.ts)", () => {

  it("the dock's tile wears the colour it's given, not its place's", () => {
    const html = renderToStaticMarkup(h(Dock, { variant: 'shelf', items: ['Home', 'Inbox', 'Places', 'More'].reverse().map((label) => ({ value: label, label, icon: null, tint: tintOf(label) })) }));
    expect([...html.matchAll(/data-part="lane"[^>]*data-tint="([a-z]+)"[^>]*>.*?aria-label="([^"]+)"/g)].map((m) => [m[2], m[1]]))
      .toEqual([['More', 'olive'], ['Places', 'yellow'], ['Inbox', 'blue'], ['Home', 'pink']]);
  });

  it("a piece's own tab.accent wins over loom's table and its name; one that isn't a palette name is refused", () => {
    expect(tintsOf([{ label: 'Clock', accent: 'blue' }])('Clock')).toBe('blue');
    expect(tintsOf([{ label: 'Clock' }])('Clock')).toBe(APP_TINTS.Clock);
    expect(tintsOf([{ label: 'Gizmo', accent: 'yellow' }])('Gizmo')).toBe('yellow');
    expect(tintsOf([{ label: 'Gizmo', accent: '#ff0000' }])('Gizmo')).toBe(nameTint('Gizmo'));
    expect(parseManifest({ v: 2, tab: { label: 'x', accent: 'olive' } })).toMatchObject({ tab: { label: 'x', accent: 'olive' } });
    expect(parseManifest({ v: 2, tab: { label: 'x', accent: '#ff0000' } })).toMatch(/tab.accent/);
    expect(parseManifest({ v: 2, tab: { label: 'x', accent: 'green' } })).toMatch(/tab.accent must be one of loom's palette: pink, blue, yellow, olive/);
    // The manifest's palette and the app's are one list.
    expect([...ACCENTS]).toEqual([...TINTS]);
  });

  it('an app loom has no colour for gets a stable one from its name', () => {
    expect(tintOf('Gizmo')).toBe(tintOf('Gizmo'));
    expect(TINTS).toContain(tintOf('Gizmo'));
    expect(tintsOf([])('Gizmo')).toBe(nameTint('Gizmo'));
  });

});
