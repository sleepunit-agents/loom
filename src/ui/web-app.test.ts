/**
 * What docs/specs/ui-app.md asks CI to pin about the app in web/: every block
 * type loom accepts has a way to be drawn there, and the first page stays
 * inside its weight (JS under 250 KB, CSS under 120 KB, gzipped).
 */
import { readFileSync, existsSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';

const root = fileURLToPath(new URL('../../', import.meta.url));
const casesIn = (src: string) => new Set([...src.matchAll(/^\s*case '([a-z]+)':/gm)].map((m) => m[1]));

describe('the app (web/)', () => {
  it('draws every block type vocab.ts accepts', () => {
    const vocab = readFileSync(`${root}src/ui/vocab.ts`, 'utf-8');
    const body = vocab.slice(vocab.indexOf('function block('), vocab.indexOf('unknown block type'));
    const accepted = casesIn(body);
    expect(accepted.size).toBeGreaterThan(10);
    const drawn = casesIn(readFileSync(`${root}web/src/blocks.tsx`, 'utf-8'));
    expect([...accepted].filter((t) => !drawn.has(t)), 'a block type with no case in web/src/blocks.tsx BlockView').toEqual([]);
  });

  it.runIf(existsSync(`${root}dist/web/index.html`))('keeps its first page under 250 KB of JS and 120 KB of CSS, gzipped', () => {
    const index = readFileSync(`${root}dist/web/index.html`, 'utf-8');
    const named = (re: RegExp) => [...index.matchAll(re)].map((m) => gzipSync(readFileSync(`${root}dist/web/${m[1]}`)).length).reduce((a, b) => a + b, 0);
    const js = named(/<script[^>]+src="\/app\/([^"]+\.js)"/g) + named(/<link rel="modulepreload"[^>]+href="\/app\/([^"]+\.js)"/g);
    const css = named(/<link rel="stylesheet"[^>]+href="\/app\/([^"]+\.css)"/g);
    expect(js).toBeGreaterThan(0);
    expect(css).toBeGreaterThan(0);
    expect(js, 'first-page JS, gzipped').toBeLessThan(250_000);
    expect(css, 'first-page CSS, gzipped').toBeLessThan(120_000);
  });
});
