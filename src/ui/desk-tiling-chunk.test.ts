/**
 * The tiled desktop rides in the desk's own chunk, never the first page (docs/specs/desk-tiling.md, "Budget"): a phone
 * never fetches it. Read from the built app: none of the first page's scripts carries the tiles' code, and the desk's
 * chunk does. Runs where the app is built (npm run build), as web-app.test.ts does.
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readdirSync, readFileSync } from 'node:fs';

const root = new URL('../../', import.meta.url).pathname;
const built = existsSync(`${root}dist/web/index.html`);

describe('the tiled desktop\'s code', () => {
  it.runIf(built)('is in the desk\'s chunk, not the first page', () => {
    const index = readFileSync(`${root}dist/web/index.html`, 'utf-8');
    const first = [...index.matchAll(/(?:<script[^>]+src|<link rel="modulepreload"[^>]+href)="\/app\/([^"]+\.js)"/g)].map((m) => m[1]);
    expect(first.length).toBeGreaterThan(0);
    // What only the tiles carry: their class names and their saved set's key.
    const marks = ['loom-tile__bar', '"loom-tiles"', 'aria-roledescription":"tile'];
    for (const f of first) for (const m of marks) expect(readFileSync(`${root}dist/web/${f}`, 'utf-8').includes(m), `${f} carries ${m}`).toBe(false);
    const desk = readdirSync(`${root}dist/web/assets`).filter((f) => /^desk-.*\.js$/.test(f));
    expect(desk.some((f) => readFileSync(`${root}dist/web/assets/${f}`, 'utf-8').includes('loom-tile__bar'))).toBe(true);
  });
});
