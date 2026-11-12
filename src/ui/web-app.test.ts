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

  it.runIf(existsSync(`${root}dist/web/index.html`))('keeps its first page under 230 KB of JS and 120 KB of CSS, gzipped', () => {
    const index = readFileSync(`${root}dist/web/index.html`, 'utf-8');
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

  // And each place that named a Tailwind colour now names the token that holds that colour (web/src/tones.ts, one map).
  it('each swept class names the token for the colour it replaced', () => {
    const src = (p: string) => readFileSync(`${root}web/src/${p}`, 'utf-8');
    const tones = src('tones.ts');
    const was: Array<[string, string]> = [
      ["ok: 'bg-[var(--loom-ok)]'", 'bg-emerald-500'], ["warn: 'bg-[var(--loom-warn)]'", 'bg-amber-500'], ["bad: 'bg-[var(--loom-bad)]'", 'bg-red-500'],
      ["muted: 'bg-[var(--loom-muted)]'", 'bg-neutral-400'],
      ["s.tone === 'bad' ? 'ring-1 ring-[var(--loom-ring-bad)]' : s.tone === 'warn' ? 'ring-1 ring-[var(--loom-ring-warn)]'", 'ring-red-400 / ring-amber-400'],
      ["ok: 'bg-[color-mix(in_oklab,var(--loom-ok)_15%,transparent)] text-[color:var(--loom-ok-ink)]'", 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300'],
      ["warn: 'bg-[color-mix(in_oklab,var(--loom-warn)_15%,transparent)] text-[color:var(--loom-warn-ink)]'", 'bg-amber-500/15 text-amber-700 dark:text-amber-300'],
      ["bad: 'bg-[color-mix(in_oklab,var(--loom-bad)_15%,transparent)] text-[color:var(--loom-bad-ink)]'", 'bg-red-500/15 text-red-700 dark:text-red-300'],
      ["muted: 'bg-[color-mix(in_oklab,var(--loom-muted-wash)_15%,transparent)] opacity-80'", 'bg-neutral-500/15 opacity-80'],
    ];
    expect(was.filter(([now]) => !tones.includes(now)).map(([, w]) => w)).toEqual([]);
    const sites: Array<[string, string, string]> = [
      ['views.tsx', "state === 'working' ? 'bg-[var(--loom-live)]' : state === 'broken' ? 'bg-[var(--loom-bad)]' : state === 'unavailable' ? 'bg-[var(--loom-warn)]' : 'bg-[var(--loom-ok)]'", 'the agent dot: sky/red/amber/emerald-500'],
      ['views.tsx', "a.tone === 'bad' ? 'ring-1 ring-[var(--loom-ring-bad)]' : 'ring-1 ring-[var(--loom-ring-warn-soft)]'", 'an ask: ring-red-400 / ring-amber-300'],
      ['views.tsx', "p.tone === 'bad' ? 'bg-[color-mix(in_oklab,var(--loom-bad)_10%,transparent)]' : 'bg-[color-mix(in_oklab,var(--loom-warn)_10%,transparent)]'", 'a problem: bg-red-500/10 / bg-amber-500/10'],
      ['views.tsx', '<span className="size-2 rounded-full bg-[var(--loom-warn)]" />', 'Needs you: bg-amber-500'],
      ['views.tsx', 'bg-[var(--loom-accent,var(--loom-unread))]', 'the unread dot: #2563eb'],
      ['sheets.tsx', 'bg-[var(--loom-count)] px-1.5 text-[11px] font-semibold text-[color:var(--loom-count-ink)]', 'a count: #e5484d, white'],
      ['blocks.tsx', 'bg-[var(--loom-track)]', 'a meter loading: bg-black/10'],
    ];
    expect(sites.filter(([f, now]) => !src(f).includes(now)).map(([f, , w]) => `${f}: ${w}`)).toEqual([]);
  });

  // A look re-points loom's six agent marks by their colours: the page's map is the household's palette.
  it('the page knows each of loom\'s six marks by the household\'s colour for it', async () => {
    const { MARKS } = await import('../household.js');
    const look = readFileSync(`${root}web/src/look.ts`, 'utf-8');
    for (const m of MARKS) expect(look, m.name).toContain(`'${m.bg.toLowerCase()}': '${m.name.toLowerCase()}'`);
  });
});
