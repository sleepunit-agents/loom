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
    // Some of what they held, now under the attribute: a page's crossfade, 000h's own stillness, the ticker's loop
    // (motion allowed), Neon's glows off (more contrast).
    expect(all).toMatch(/html:where\(\[data-motion=["']?reduce["']?\]\)\[data-move\]::view-transition-old\(loom-page\)\{[^}]*loom-move-fade-out/);
    expect(all).toMatch(/:root:where\(\[data-motion=["']?reduce["']?\]\)\{[^}]*--t-micro:0/);
    expect(all).toMatch(/:root:where\(\[data-motion=["']?full["']?\]\)\[data-look=["']?neon["']?\] \.loom-tick\[data-run\] \.loom-tick__track\{animation:loom-tick/);
    expect(all).toMatch(/:root:where\(\[data-contrast=["']?more["']?\]\)\[data-look=["']?neon["']?\]\[data-mode\]\{--glow-key:0 0 0 0/);
  });

  it('no script of the app asks the phone for reduced motion or more contrast except access.ts', () => {
    const src = files(`${root}web/src`, /\.(ts|tsx)$/).filter((f) => !f.endsWith('/access.ts'));
    const asks = src.filter((f) => /matchMedia\([^)]*prefers-(reduced-motion|contrast)/.test(readFileSync(f, 'utf-8')));
    expect(asks.map((f) => f.slice(root.length))).toEqual([]);
  });
});
