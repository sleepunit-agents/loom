/**
 * A list row's opened part and a filters block's chips and switch load with their own chunks, never the first page
 * (docs/extensions.md, "Blocks"; web-app.test.ts keeps the first page's weight). Read from the built app, as
 * desk-tiling-chunk.test.ts does.
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';

const root = new URL('../../', import.meta.url).pathname;
const built = existsSync(`${root}dist/web/index.html`);

describe('the opened row and the chip rows', () => {
  it.runIf(built)('are drawn by lazy chunks, not the first page', () => {
    const index = readFileSync(`${root}dist/web/index.html`, 'utf-8');
    const first = [...index.matchAll(/(?:<script[^>]+src|<link rel="(?:modulepreload|stylesheet)"[^>]+href)="\/app\/([^"]+\.(?:js|css))"/g)].map((m) => m[1]);
    expect(first.length).toBeGreaterThan(0);
    for (const f of first) for (const m of ['loom-row-more', 'loom-chip-row', 'loom-switch']) {
      expect(readFileSync(`${root}dist/web/${f}`, 'utf-8').includes(m), `${f} carries ${m}`).toBe(false);
    }
  });
});
