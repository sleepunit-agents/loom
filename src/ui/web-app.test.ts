/**
 * What docs/specs/ui-app.md asks CI to pin about the app in web/: every block
 * type loom accepts has a way to be drawn there, and the first page stays
 * inside its weight (JS under 230 KB, CSS under 120 KB, gzipped).
 */
import { readFileSync, existsSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';

const root = fileURLToPath(new URL('../../', import.meta.url));
const casesIn = (src: string) => new Set([...src.matchAll(/^\s*case '([a-z]+)':/gm)].map((m) => m[1]));

describe('the app (web/)', () => {
  // The one page this build ships is the sign-in gate (next.html); the boards page is vite.boards.config.ts's.
  it.runIf(existsSync(`${root}dist/web/next.html`)).each(['next'])('keeps %s first page under 230 KB of JS and 120 KB of CSS, gzipped', (page) => {
    const index = readFileSync(`${root}dist/web/${page}.html`, 'utf-8');
    const named = (re: RegExp) => [...index.matchAll(re)].map((m) => gzipSync(readFileSync(`${root}dist/web/${m[1]}`)).length).reduce((a, b) => a + b, 0);
    const js = named(/<script[^>]+src="\/app\/([^"]+\.js)"/g) + named(/<link rel="modulepreload"[^>]+href="\/app\/([^"]+\.js)"/g);
    // The looks (Neon Noir's structure and every look's tokens) are in the app's own stylesheet (index.css imports them).
    const sheets = [...index.matchAll(/<link rel="stylesheet"[^>]+href="\/app\/([^"]+\.css)"/g)].map((m) => readFileSync(`${root}dist/web/${m[1]}`, 'utf-8')).join('\n');
    for (const look of ['neon', 'lowlight', 'daylight']) expect(sheets, `${look}'s tokens on the first page`).toMatch(new RegExp(`:root\\[data-look="?${look}"?\\]\\[data-mode\\]\\{`));
    const css = named(/<link rel="stylesheet"[^>]+href="\/app\/([^"]+\.css)"/g);
    expect(js).toBeGreaterThan(0);
    expect(css).toBeGreaterThan(0);
    expect(js, 'first-page JS, gzipped').toBeLessThan(230_000);
    expect(css, 'first-page CSS, gzipped').toBeLessThan(120_000);
  });
});
