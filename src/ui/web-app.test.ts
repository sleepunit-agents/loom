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
    // Neon Noir, the default look, is on the first page too: its stylesheet, named in its boot script (web/src/looks/boot.js).
    const boot = /<script src="\/app\/(assets\/look-[^"]+\.js)"/.exec(index)?.[1];
    expect(boot, 'the look\'s boot script in the head').toBeTruthy();
    const neon = readFileSync(`${root}dist/web/${boot}`, 'utf-8').match(/\/app\/(assets\/neon-[^']+\.css)/)?.[1];
    expect(neon, 'Neon Noir\'s stylesheet, named in the boot script').toBeTruthy();
    const css = named(/<link rel="stylesheet"[^>]+href="\/app\/([^"]+\.css)"/g) + gzipSync(readFileSync(`${root}dist/web/${neon}`)).length;
    expect(js).toBeGreaterThan(0);
    expect(css).toBeGreaterThan(0);
    expect(js, 'first-page JS, gzipped').toBeLessThan(250_000);
    console.log(`first page: ${js} B of JS, ${css} B of CSS, gzipped`);
    expect(css, 'first-page CSS, gzipped').toBeLessThan(120_000);
  });

  // 000h draws as it did (Neon Noir's sweep): each colour that was a Tailwind class is now a token whose 000h value is
  // that class's own colour, as the built stylesheet writes it, and the few hex literals keep their old values.
  it.runIf(existsSync(`${root}web/node_modules/tailwindcss/theme.css`))('000h\'s swept colours are the values they replaced', () => {
    // Tailwind's palette as it ships (the classes are gone from the build, so their colours are too).
    const css = readFileSync(`${root}web/node_modules/tailwindcss/theme.css`, 'utf-8');
    const tw = (c: string) => new RegExp(`--color-${c}:\\s*([^;}]+)`).exec(css)?.[1];
    const src = readFileSync(`${root}web/src/index.css`, 'utf-8');
    const block = (sel: string) => Object.fromEntries([...src.slice(src.indexOf(sel)).split('}')[0].matchAll(/(--loom-[\w-]+):\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()]));
    const light = block(':root { --loom-ok:'), dark = block(':root[data-mode="dark"] { --loom-ok-ink');
    const n = (v?: string) => v?.replace(/\s+/g, ' ').replace(/\b0\./g, '.').replace(/ none\)/g, ' 0)');
    const was: Array<[Record<string, string>, string, string]> = [
      [light, '--loom-ok', 'emerald-500'], [light, '--loom-warn', 'amber-500'], [light, '--loom-bad', 'red-500'], [light, '--loom-muted', 'neutral-400'],
      [light, '--loom-live', 'sky-500'], [light, '--loom-ring-bad', 'red-400'], [light, '--loom-ring-warn', 'amber-400'], [light, '--loom-ring-warn-soft', 'amber-300'],
      [light, '--loom-ok-ink', 'emerald-700'], [light, '--loom-warn-ink', 'amber-700'], [light, '--loom-bad-ink', 'red-700'], [light, '--loom-muted-wash', 'neutral-500'],
      [dark, '--loom-ok-ink', 'emerald-300'], [dark, '--loom-warn-ink', 'amber-300'], [dark, '--loom-bad-ink', 'red-300'],
    ];
    expect(was.filter(([t, k, c]) => n(t[k]) !== n(tw(c))).map(([t, k, c]) => `${k}: ${t[k]} vs ${c} ${tw(c)}`)).toEqual([]);
    expect(light).toMatchObject({ '--loom-live-pulse': '#0ea5e9', '--loom-count': '#e5484d', '--loom-count-ink': '#fff', '--loom-unread': '#2563eb',
      '--loom-ground-dim': '.55', '--loom-wash-dim': '.35' });
  });
});
