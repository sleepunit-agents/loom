/**
 * Reduce motion and Higher contrast have one source of truth each (web/src/access.ts): <html data-motion> and
 * <html data-contrast>, set from the person's choice (the phone's own setting only while they follow it). So nothing
 * may ask the phone directly: the built stylesheets carry no prefers-reduced-motion or prefers-contrast query (the build
 * rewrites each onto the attribute, web/vite.config.ts accessMedia), and no script of the app's asks matchMedia for
 * either except access.ts itself (and looks/boot.js, for the first paint).
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';

const root = new URL('../../', import.meta.url).pathname;
const built = existsSync(`${root}dist/web/index.html`);

function files(dir: string, ext: RegExp): string[] {
  return readdirSync(dir).flatMap((f) => { const p = join(dir, f); return statSync(p).isDirectory() ? files(p, ext) : ext.test(f) ? [p] : []; });
}

describe('one source of truth for motion and contrast', () => {
  it.runIf(built)('the built stylesheets have no motion or contrast media query left, and the rules they held are on the attributes', () => {
    const css = files(`${root}dist/web/assets`, /\.css$/).map((f) => [f, readFileSync(f, 'utf-8')] as const);
    expect(css.length).toBeGreaterThan(1);
    expect(css.filter(([, s]) => /prefers-(reduced-motion|contrast)/.test(s)).map(([f]) => f)).toEqual([]);
    const all = css.map(([, s]) => s).join('\n');
    // Some of what they held, now under the attribute: a page's crossfade, the library's own stillness, the ticker's loop
    // (motion allowed), every look's glows off (more contrast).
    expect(all).toMatch(/html:where\(\[data-motion=["']?reduce["']?\]\)\[data-move\]::view-transition-old\(loom-page\)\{[^}]*loom-move-fade-out/);
    expect(all).toMatch(/:root:where\(\[data-motion=["']?reduce["']?\]\)\{[^}]*--t-micro:0/);
    expect(all).toMatch(/:root:where\(\[data-motion=["']?full["']?\]\)\[data-look\] \.loom-tick\[data-run\] \.loom-tick__track\{animation:loom-tick/);
    expect(all).toMatch(/:root:where\(\[data-contrast=["']?more["']?\]\)\[data-look\]\[data-mode\]\{--glow-key:0 0 0 0/);
  });

  it('no script of the app names either query except access.ts and the boot script, however it\'s written', () => {
    // Any script at all (.ts, .tsx, .js, .mjs), and the query as a string anywhere in it: a query kept in a constant
    // and handed to matchMedia later (as phone-bar.tsx's was) is caught as surely as one written inside the call.
    const src = files(`${root}web/src`, /\.(ts|tsx|js|mjs)$/).filter((f) => !f.endsWith('/web/src/access.ts') && !f.endsWith('/web/src/looks/boot.js'));
    const asks = src.filter((f) => /['"`]\s*\(?\s*prefers-(reduced-motion|contrast)/.test(readFileSync(f, 'utf-8')));
    expect(asks.map((f) => f.slice(root.length))).toEqual([]);
    // And nothing reads the attribute itself but access.ts: one helper answers.
    const reads = src.filter((f) => /dataset\.motion\b|data-motion["']\s*\)|getAttribute\(\s*['"]data-motion/.test(readFileSync(f, 'utf-8')));
    expect(reads.map((f) => f.slice(root.length))).toEqual([]);
  });

  it('the rewrite: each form of the query lands on its attribute, specificity kept; nested and layered rules too; another form fails', async () => {
    const { default: postcss } = await import('../../web/node_modules/postcss/lib/postcss.js');
    const { accessMedia } = await import('../../web/access-media');
    const run = (css: string) => postcss([accessMedia()]).process(css, { from: undefined }).css.replace(/\s+/g, ' ').trim();
    expect(run('@media (prefers-reduced-motion: reduce) { .x { a: 1 } }')).toBe(':where(:root[data-motion="reduce"]) .x { a: 1 }');
    expect(run('@media (prefers-reduced-motion) { .x { a: 1 } }')).toBe(':where(:root[data-motion="reduce"]) .x { a: 1 }');
    expect(run('@media (prefers-reduced-motion:no-preference){:root[data-look="neon"] .t{a:1}}')).toBe(':root:where([data-motion="full"])[data-look="neon"] .t{a:1}');
    expect(run('@media not (prefers-reduced-motion: reduce) { html[data-move] .x { a: 1 } }')).toBe('html:where([data-motion="full"])[data-move] .x { a: 1 }');
    expect(run('@media (prefers-contrast: more) { ::view-transition-old(p), .a, .b { a: 1 } }')).toBe(':where(:root[data-contrast="more"])::view-transition-old(p), :where(:root[data-contrast="more"]) .a, :where(:root[data-contrast="more"]) .b { a: 1 }');
    expect(run('@layer l { @media (prefers-reduced-motion: reduce) { @supports (x: y) { .x { a: 1 } } } }')).toBe('@layer l { @supports (x: y) { :where(:root[data-motion="reduce"]) .x { a: 1 } } }');
    expect(run('.p { color: red; @media (prefers-reduced-motion: reduce) { a: 1 } }')).toBe('.p { color: red; :where(:root[data-motion="reduce"]) & { a: 1 } }');
    // Anything else naming either feature: the build stops, rather than a query that asks the phone slipping through.
    for (const q of ['(prefers-contrast: less)', '(prefers-reduced-motion: reduce) and (min-width: 1px)', '(prefers-contrast: more), print']) {
      expect(() => run(`@media ${q} { .x { a: 1 } }`), q).toThrow(/loom-access-media/);
    }
    // Other media queries are left alone.
    expect(run('@media (min-width: 1px) { .x { a: 1 } }')).toBe('@media (min-width: 1px) { .x { a: 1 } }');
  });
});
