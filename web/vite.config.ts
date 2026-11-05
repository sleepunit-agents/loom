import path from 'node:path';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import postcss, { type AtRule, type ChildNode, type Container, type Plugin as PostcssPlugin, type Rule } from 'postcss';

/**
 * The looks (src/looks/): Neon Noir's stylesheet is its own file, built beside the app's, and a tiny script in the
 * page's head (src/looks/boot.js) puts it on before first paint. loom's CSP allows no inline script, so the script is a
 * file of its own, named by its content like the rest of assets/ (the service worker keeps it for offline).
 */
// The boot script is joined onto one line (comments dropped): every statement in boot.js ends with ; or }, and
// src/ui/look-boot.test.ts runs the emitted file. Build only: under `vite dev` there's no Neon (000h dark shows).
function looks(): Plugin {
  return {
    name: 'loom-looks',
    apply: 'build',
    enforce: 'post',
    generateBundle(_opts, bundle) {
      const neon = Object.values(bundle).find((f) => f.type === 'asset' && /^assets\/neon-[^/]+\.css$/.test(f.fileName));
      if (!neon) throw new Error('loom-looks: no assets/neon-*.css in the build');
      // The CSS entry's empty script: nothing loads it.
      for (const [k, f] of Object.entries(bundle)) if (f.type === 'chunk' && f.name === 'neon' && !f.code.trim().replace(/\/\/.*$/gm, '').trim()) delete bundle[k];
      const css = `/app/${neon.fileName}`;
      const src = readFileSync(path.resolve(import.meta.dirname, 'src/looks/boot.js'), 'utf-8')
        .replace(/^\s*\/\/.*$/gm, '').replace(/\s*\/\*.*?\*\//g, '').replace(/\n\s*/g, '').replace(/__NEON_CSS__/g, css);
      const fileName = `assets/look-${createHash('sha256').update(src).digest('base64url').slice(0, 8)}.js`;
      this.emitFile({ type: 'asset', fileName, source: src });
      const html = bundle['index.html'];
      if (!html || html.type !== 'asset') throw new Error('loom-looks: no index.html in the build');
      // First in the head, before the app's stylesheet: it decides which look paints.
      const anchor = '<meta charset="UTF-8" />';
      if (!String(html.source).includes(anchor)) throw new Error(`loom-looks: index.html has no ${anchor} to put the look's script after`);
      html.source = String(html.source).replace(anchor, `${anchor}\n    <script src="/app/${fileName}"></script>`);
    },
  };
}

/**
 * Accessibility's media queries (src/access.ts): the person's Reduce motion and Higher contrast are attributes on <html>
 * (data-motion, data-contrast), set from their choice, the phone's own setting only while they follow it. So every
 * stylesheet's @media (prefers-reduced-motion: reduce | no-preference) and (prefers-contrast: more), 000h's own
 * included, is rewritten here into the same rules under that attribute: `@media (prefers-reduced-motion: reduce) { .x {…} }`
 * becomes `:where(:root[data-motion="reduce"]) .x {…}`, its specificity unchanged. A query in any other form fails the
 * build, so nothing can ask the phone directly and slip past the choice (src/ui/access-css.test.ts reads the output).
 */
export function accessMedia(): PostcssPlugin {
  const FORMS: Array<[RegExp, string]> = [
    [/^\(\s*prefers-reduced-motion\s*(:\s*reduce\s*)?\)$/, '[data-motion="reduce"]'],
    [/^\(\s*prefers-reduced-motion\s*:\s*no-preference\s*\)$/, '[data-motion="full"]'],
    [/^not\s+\(\s*prefers-reduced-motion\s*:\s*reduce\s*\)$/, '[data-motion="full"]'],
    [/^\(\s*prefers-contrast\s*:\s*more\s*\)$/, '[data-contrast="more"]'],
  ];
  const scope = (sel: string, attr: string) => {
    const s = sel.trim();
    if (/^:root(?![\w-])/.test(s)) return `:root:where(${attr})${s.slice(5)}`;
    if (/^html(?![\w-])/.test(s)) return `html:where(${attr})${s.slice(4)}`;
    if (s.startsWith('::')) return `:where(:root${attr})${s}`;
    return `:where(:root${attr}) ${s}`;
  };
  // A rule's selectors under the attribute; at-rules inside (a layer, a supports) are walked; keyframes and font faces left.
  const under = (n: Container, attr: string) => n.each((c: ChildNode) => {
    if (c.type === 'rule') (c as Rule).selectors = (c as Rule).selectors.map((x) => scope(x, attr));
    else if (c.type === 'atrule' && !/keyframes$|^font-face$|^property$/.test((c as AtRule).name) && (c as AtRule).nodes) under(c as AtRule, attr);
  });
  return {
    postcssPlugin: 'loom-access-media',
    AtRule: {
      media(m: AtRule) {
        if (!/prefers-(reduced-motion|contrast)/.test(m.params)) return;
        const attr = FORMS.find(([re]) => re.test(m.params.trim()))?.[1];
        if (!attr) throw m.error(`loom-access-media: "@media ${m.params}" isn't a form src/access.ts routes (give it a query of its own)`);
        if (m.parent?.type === 'rule') {
          // Nested in a rule: the same declarations and rules, on that rule only while the attribute is set.
          const r = postcss.rule({ selector: `:where(:root${attr}) &` });
          r.append(m.nodes ?? []);
          m.replaceWith(r);
          return;
        }
        under(m, attr);
        m.replaceWith(m.nodes ?? []);
      },
    },
  };
}

// loom serves the built app at /app/ (docs/specs/ui-app.md); the page itself is any of loom's paths.
export default defineConfig({
  base: '/app/',
  plugins: [react(), tailwindcss(), looks()],
  css: { postcss: { plugins: [accessMedia()] } },
  resolve: { alias: { '@': path.resolve(import.meta.dirname, './src') } },
  build: {
    outDir: '../dist/web', emptyOutDir: true,
    rollupOptions: { input: { index: path.resolve(import.meta.dirname, 'index.html'), neon: path.resolve(import.meta.dirname, 'src/looks/neon.css') } },
  },
});
