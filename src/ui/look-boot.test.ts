/**
 * The look before first paint (web/src/looks/boot.js, emitted by web/vite.config.ts): the built page's first script.
 * It runs here as the browser runs it, against a stand-in document: with nothing kept on this device it paints Neon
 * (dark, its stylesheet render-blocking); with 000h kept it paints 000h and fetches nothing. It sits before every
 * stylesheet, and it stays tiny: the first page pays for it on every load.
 */
import { existsSync, readFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { runInNewContext } from 'node:vm';
import { describe, it, expect } from 'vitest';

const root = new URL('../../', import.meta.url).pathname;
const built = existsSync(`${root}dist/web/index.html`);

type El = { tag: string; attrs: Record<string, string>; rel?: string; id?: string; href?: string; setAttribute(k: string, v: string): void };
function paint(src: string, kept: Record<string, string> | 'throws') {
  const html: Record<string, string> = {};
  const head: El[] = [];
  const el = (tag: string): El => ({ tag, attrs: {}, setAttribute(k, v) { this.attrs[k] = v; } });
  runInNewContext(src, {
    document: { documentElement: { setAttribute: (k: string, v: string) => { html[k] = v; } }, head: { appendChild: (e: El) => head.push(e) }, createElement: el },
    localStorage: { getItem: (k: string) => { if (kept === 'throws') throw new Error('private window'); return kept[k] ?? null; } },
  });
  return { html, head };
}

describe.runIf(built)('the look\'s boot script', () => {
  const index = built ? readFileSync(`${root}dist/web/index.html`, 'utf-8') : '';
  const path = /<script src="\/app\/(assets\/look-[^"]+\.js)"><\/script>/.exec(index)?.[1] ?? '';
  const src = built && path ? readFileSync(`${root}dist/web/${path}`, 'utf-8') : '';
  const neon = /\/app\/assets\/neon-[^']+\.css/.exec(src)?.[0];

  it('is in the head before any stylesheet or the app, under 1 KB gzipped', () => {
    expect(path).toMatch(/^assets\/look-/);
    const at = index.indexOf(path);
    expect(at).toBeLessThan(index.indexOf('rel="stylesheet"'));
    expect(at).toBeLessThan(index.indexOf('type="module"'));
    expect(gzipSync(src).length).toBeLessThan(1024);
    expect(neon && existsSync(`${root}dist/web/${neon.slice('/app/'.length)}`)).toBe(true);
  });
  it('nothing kept on this device: Neon, dark, its stylesheet render-blocking', () => {
    for (const kept of [{}, 'throws' as const, { 'loom-look': 'neon' }, { 'loom-look': 'glass' }]) {
      const { html, head } = paint(src, kept);
      expect(html, JSON.stringify(kept)).toMatchObject({ 'data-look': 'neon', 'data-mode': 'dark', 'data-neon-css': neon });
      expect(head).toHaveLength(1);
      // Set as a property or an attribute, the same to a browser.
      const at = (k: 'rel' | 'id' | 'href') => head[0][k] ?? head[0].attrs[k];
      expect([head[0].tag, at('rel'), at('id'), at('href'), head[0].attrs.blocking]).toEqual(['link', 'stylesheet', 'loom-look-neon', neon, 'render']);
    }
  });
  it('000h kept: 000h, its mode left to the app, nothing fetched', () => {
    const { html, head } = paint(src, { 'loom-look': '000h' });
    expect(html['data-look']).toBe('000h');
    expect(html['data-mode']).toBeUndefined();
    expect(head).toEqual([]);
    // Neon's address is still left on the page: loom's answer may say Neon, and look.ts wearLook loads it from there.
    expect(html['data-neon-css']).toBe(neon);
  });
});
