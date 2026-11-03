// @vitest-environment node
/**
 * The dock on an iPhone's home screen (web/src/standalone.ts; Jonathan, 2026-11-03: it sat too high until the page
 * scrolled): there, and only there, the page is marked so #root scrolls instead of the document.
 */
import { describe, expect, it } from 'vitest';
import { iosApp, markIosApp, toTop } from '../../web/src/standalone';

function fakeDoc() {
  const classes = new Set<string>();
  const scrolled: string[] = [];
  const root = { scrollTo: () => scrolled.push('root') };
  const doc = {
    documentElement: { classList: { toggle: (c: string, on: boolean) => (on ? classes.add(c) : classes.delete(c), on), contains: (c: string) => classes.has(c) } },
    getElementById: (id: string) => (id === 'root' ? root : null),
    defaultView: { scrollTo: () => scrolled.push('window') },
  };
  return { doc: doc as unknown as Document, classes, scrolled };
}
const nav = (standalone?: boolean) => ({ standalone }) as unknown as Navigator;

describe('the iPhone home-screen app', () => {
  it('is iOS Safari\'s standalone mode, and nothing else', () => {
    expect(iosApp(nav(true))).toBe(true);
    // Safari in a tab says false; Android, desktops and other browsers have no navigator.standalone at all.
    expect(iosApp(nav(false))).toBe(false);
    expect(iosApp(nav(undefined))).toBe(false);
  });
  it('marks the page so #root scrolls there, and goes back to the top of #root; elsewhere the window', () => {
    const app = fakeDoc();
    expect(markIosApp(app.doc, nav(true))).toBe(true);
    expect(app.classes.has('loom-ios-app')).toBe(true);
    toTop(app.doc);
    const tab = fakeDoc();
    markIosApp(tab.doc, nav(false));
    expect(tab.classes.size).toBe(0);
    toTop(tab.doc);
    expect([app.scrolled, tab.scrolled]).toEqual([['root'], ['window']]);
  });
});
