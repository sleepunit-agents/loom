/**
 * No dead weight in the app (web/; t-1875's trim): every module under web/src is reached from a page's entry
 * (the sign-in gate's shell/main.tsx, the boot script vite.config.ts emits, or the boards page's boards/main.tsx, which board.html loads and
 * vite.boards.config.ts builds; or, for boards/gallery alone, from the bricks' gallery, a development-only page that
 * vite.gallery.config.ts builds into a scratch directory and no shipped page loads), every 000h-library stylesheet is imported (one
 * that isn't ships nothing; one that's imported but gone breaks the build), and no Tailwind theme key is declared in
 * both index.css and theme.css (index.css carried a 230-line copy of theme.css's block until 2026-11-05).
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { describe, it, expect } from 'vitest';

const src = new URL('../../web/src/', import.meta.url).pathname;
const walk = (d: string): string[] => readdirSync(d).flatMap((f) => { const p = join(d, f); return statSync(p).isDirectory() ? walk(p) : [p]; });
const files = walk(src).filter((f) => /\.(tsx?|jsx?)$/.test(f) && !/\.test\./.test(f));
const resolveSpec = (from: string, spec: string): string | undefined => {
  const base = spec.startsWith('@/') ? join(src, spec.slice(2)) : spec.startsWith('.') ? resolve(dirname(from), spec) : undefined;
  if (!base) return undefined;
  return [base, `${base}.ts`, `${base}.tsx`, `${base}.js`, join(base, 'index.ts'), join(base, 'index.tsx')].find((p) => existsSync(p) && statSync(p).isFile());
};

describe('the app carries nothing it doesn\'t use', () => {
  it('every module under web/src is reached from a shipped entry', () => {
    const seen = new Set<string>();
    const todo = [join(src, 'shell/main.tsx'), join(src, 'looks/boot.js'), join(src, 'boards/main.tsx')];
    // Development only, never shipped: the gallery that draws every brick from fixtures (web/vite.gallery.config.ts).
    todo.push(join(src, 'boards/gallery/main.tsx'));
    while (todo.length) {
      const f = todo.pop()!;
      if (seen.has(f)) continue;
      seen.add(f);
      const text = readFileSync(f, 'utf-8');
      for (const m of text.matchAll(/(?:from\s+|import\s*\(\s*|import\s+)['"]([^'"]+)['"]/g)) {
        const to = resolveSpec(f, m[1]);
        if (to && /\.(tsx?|jsx?)$/.test(to)) todo.push(to);
      }
    }
    expect(files.filter((f) => !seen.has(f)).map((f) => relative(src, f)).sort()).toEqual([]);
  });

  it('every 000h-library stylesheet is imported (by index.css, or by the lazy chunk that uses it), and every import is there', () => {
    const index = readFileSync(join(src, 'index.css'), 'utf-8');
    const imported = [...index.matchAll(/@import\s+"@\/styles\/cojeev\/([\w-]+\.css)"/g), ...files.flatMap((f) => [...readFileSync(f, 'utf-8').matchAll(/import\s+'@\/styles\/cojeev\/([\w-]+\.css)'/g)])].map((m) => m[1]);
    const onDisk = readdirSync(join(src, 'styles/cojeev')).filter((f) => f.endsWith('.css'));
    expect(onDisk.filter((f) => !imported.includes(f)), 'a stylesheet nothing imports').toEqual([]);
    expect(imported.filter((f) => !onDisk.includes(f)), 'an import with no stylesheet').toEqual([]);
  });

  it('no Tailwind theme key is declared in both index.css and theme.css', () => {
    const keys = (file: string) => {
      const css = readFileSync(join(src, file), 'utf-8');
      return [...css.matchAll(/@theme inline\s*\{([^}]*)\}/g)].flatMap((b) => [...b[1].matchAll(/(--[\w-]+)\s*:/g)].map((m) => m[1]));
    };
    const theme = new Set(keys('styles/cojeev/theme.css'));
    expect(theme.size).toBeGreaterThan(200);
    expect(keys('index.css').filter((k) => theme.has(k))).toEqual([]);
  });
});
