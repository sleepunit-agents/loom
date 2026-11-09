/**
 * The look before first paint (web/src/looks/boot.js, emitted by web/vite.config.ts): the built page's first script.
 * It runs here as the browser runs it, against a stand-in document: with nothing kept on this device it paints Neon Noir
 * (dark); Low Light and Daylight kept paint themselves, dark and light; 000h kept (a look until 2026-11-05) paints the
 * look nearest it, Daylight if this device kept light, else Low Light. It fetches nothing. It sets Accessibility's
 * Reduce motion and Higher contrast too (data-motion, data-contrast): this device's copy, else the phone's own. It sits before every
 * stylesheet, and it stays tiny: the first page pays for it on every load.
 */
import { existsSync, readFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { runInNewContext } from 'node:vm';
import { describe, it, expect } from 'vitest';

const root = new URL('../../', import.meta.url).pathname;
const built = existsSync(`${root}dist/web/index.html`);

type El = { tag: string; attrs: Record<string, string>; rel?: string; id?: string; href?: string; setAttribute(k: string, v: string): void };
function paint(src: string, kept: Record<string, string> | 'throws', media: Record<string, boolean> = {}) {
  const html: Record<string, string> = {};
  const head: El[] = [];
  const el = (tag: string): El => ({ tag, attrs: {}, setAttribute(k, v) { this.attrs[k] = v; } });
  runInNewContext(src, {
    document: { documentElement: { setAttribute: (k: string, v: string) => { html[k] = v; } }, head: { appendChild: (e: El) => head.push(e) }, createElement: el },
    window: { matchMedia: (q: string) => ({ matches: !!media[q] }) },
    localStorage: { getItem: (k: string) => { if (kept === 'throws') throw new Error('private window'); return kept[k] ?? null; } },
  });
  return { html, head };
}

describe.runIf(built)('the look\'s boot script', () => {
  const index = built ? readFileSync(`${root}dist/web/index.html`, 'utf-8') : '';
  const path = /<script src="\/app\/(assets\/look-[^"]+\.js)"><\/script>/.exec(index)?.[1] ?? '';
  const src = built && path ? readFileSync(`${root}dist/web/${path}`, 'utf-8') : '';

  it('is in the head before any stylesheet or the app, under 1 KB gzipped', () => {
    expect(path).toMatch(/^assets\/look-/);
    const at = index.indexOf(path);
    expect(at).toBeLessThan(index.indexOf('rel="stylesheet"'));
    expect(at).toBeLessThan(index.indexOf('type="module"'));
    expect(gzipSync(src).length).toBeLessThan(1024);
  });
  it('nothing kept on this device, or nothing it knows: Neon Noir, dark, and nothing fetched', () => {
    for (const kept of [{}, 'throws' as const, { 'loom-look': 'neon' }, { 'loom-look': 'glass' }, { 'loom-mode': 'light' }]) {
      const { html, head } = paint(src, kept);
      expect(html, JSON.stringify(kept)).toMatchObject({ 'data-look': 'neon', 'data-mode': 'dark' });
      expect(head).toEqual([]);
    }
  });
  it('Low Light and Daylight kept: each, dark and light, whatever an old light or dark says', () => {
    for (const mode of [undefined, 'light', 'dark', 'auto']) {
      const m = mode ? { 'loom-mode': mode } : {};
      expect(paint(src, { 'loom-look': 'lowlight', ...m }).html).toMatchObject({ 'data-look': 'lowlight', 'data-mode': 'dark' });
      expect(paint(src, { 'loom-look': 'daylight', ...m }).html).toMatchObject({ 'data-look': 'daylight', 'data-mode': 'light' });
    }
  });
  it('000h kept (before 2026-11-05): Daylight if this device kept light, else Low Light', () => {
    expect(paint(src, { 'loom-look': '000h', 'loom-mode': 'light' }).html).toMatchObject({ 'data-look': 'daylight', 'data-mode': 'light' });
    for (const mode of [undefined, 'dark', 'auto']) expect(paint(src, { 'loom-look': '000h', ...(mode ? { 'loom-mode': mode } : {}) }).html, String(mode)).toMatchObject({ 'data-look': 'lowlight', 'data-mode': 'dark' });
    expect(paint(src, { 'loom-look': '000h' }).head).toEqual([]);
  });
  it('Reduce motion and Higher contrast: the phone\'s own unless this device keeps a choice; on and off win over the phone', () => {
    const RM = '(prefers-reduced-motion: reduce)', HC = '(prefers-contrast: more)';
    const at = (kept: Record<string, string> | 'throws', media: Record<string, boolean>) => { const { html } = paint(src, kept, media); return [html['data-motion'], html['data-contrast']]; };
    // Nothing kept (or it can't be read): follow the phone.
    expect(at({}, {})).toEqual(['full', 'normal']);
    expect(at({}, { [RM]: true, [HC]: true })).toEqual(['reduce', 'more']);
    expect(at('throws', { [RM]: true })).toEqual(['reduce', 'normal']);
    expect(at({ 'loom-motion': 'follow', 'loom-contrast': 'follow' }, { [RM]: true })).toEqual(['reduce', 'normal']);
    // On: whatever the phone says.
    expect(at({ 'loom-motion': 'on', 'loom-contrast': 'on' }, {})).toEqual(['reduce', 'more']);
    // Off: full motion and normal contrast even when the phone asks for less motion and more contrast.
    expect(at({ 'loom-motion': 'off', 'loom-contrast': 'off' }, { [RM]: true, [HC]: true })).toEqual(['full', 'normal']);
  });
});
