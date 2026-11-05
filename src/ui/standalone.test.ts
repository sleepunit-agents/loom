// @vitest-environment node
/**
 * The dock on an iPhone's home screen (web/src/standalone.ts; Jonathan, 2026-11-03: it sat too high until the page
 * scrolled): there, and only there, the page is marked, so index.css keeps the document the screen's height.
 */
import { describe, expect, it } from 'vitest';
import { iosApp, markIosApp } from '../../web/src/standalone';

function fakeDoc() {
  const classes = new Set<string>();
  const doc = {
    documentElement: { classList: { toggle: (c: string, on: boolean) => (on ? classes.add(c) : classes.delete(c), on), contains: (c: string) => classes.has(c) } },
  };
  return { doc: doc as unknown as Document, classes };
}
const nav = (standalone?: boolean) => ({ standalone }) as unknown as Navigator;

describe('the iPhone home-screen app', () => {
  it('is iOS Safari\'s standalone mode, and nothing else', () => {
    expect(iosApp(nav(true))).toBe(true);
    // Safari in a tab says false; Android, desktops and other browsers have no navigator.standalone at all.
    expect(iosApp(nav(false))).toBe(false);
    expect(iosApp(nav(undefined))).toBe(false);
  });
  it('marks the page there, and only there', () => {
    const app = fakeDoc();
    expect(markIosApp(app.doc, nav(true))).toBe(true);
    expect(app.classes.has('loom-ios-app')).toBe(true);
    const tab = fakeDoc();
    expect(markIosApp(tab.doc, nav(false))).toBe(false);
    expect(tab.classes.size).toBe(0);
  });
});
