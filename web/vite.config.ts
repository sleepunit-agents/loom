import path from 'node:path';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { accessMedia } from './access-media.ts';

/**
 * The looks: every look's tokens must be in the app's stylesheet (checked here), and the look before first paint
 * (src/looks/boot.js): a tiny script in the page's head sets <html data-look>, its light or
 * dark, and Accessibility's two before the app's stylesheet paints anything. loom's CSP allows no inline script, so
 * it's a file of its own, named by its content like the rest of assets/ (the service worker keeps it for offline).
 */
// The boot script is joined onto one line (comments dropped): every statement in boot.js ends with ; or }, and
// src/ui/look-boot.test.ts runs the emitted file. Build only: under `vite dev` the app sets them as it mounts (look.ts wearLook).
function looks(): Plugin {
  return {
    name: 'loom-looks',
    apply: 'build',
    enforce: 'post',
    generateBundle(_opts, bundle) {
      const src = readFileSync(path.resolve(import.meta.dirname, 'src/looks/boot.js'), 'utf-8')
        .replace(/^\s*\/\/.*$/gm, '').replace(/\s*\/\*.*?\*\//g, '').replace(/\n\s*/g, '');
      const fileName = `assets/look-${createHash('sha256').update(src).digest('base64url').slice(0, 8)}.js`;
      this.emitFile({ type: 'asset', fileName, source: src });
      // Every look's tokens are in the app's stylesheet (index.css imports looks/looks.css): without them nothing paints.
      const css = Object.values(bundle).filter((f) => f.type === 'asset' && /^assets\/index-[^/]+\.css$/.test(f.fileName)).map((f) => String((f as { source: unknown }).source)).join('');
      for (const look of ['neon', 'lowlight', 'daylight']) if (!new RegExp(`\\[data-look="?${look}"?\\]`).test(css)) throw new Error(`loom-looks: the app's stylesheet has no ${look} tokens (looks/looks.css)`);
      const html = bundle['index.html'];
      if (!html || html.type !== 'asset') throw new Error('loom-looks: no index.html in the build');
      // First in the head, before the app's stylesheet: it decides which look paints.
      const anchor = '<meta charset="UTF-8" />';
      if (!String(html.source).includes(anchor)) throw new Error(`loom-looks: index.html has no ${anchor} to put the look's script after`);
      html.source = String(html.source).replace(anchor, `${anchor}\n    <script src="/app/${fileName}"></script>`);
    },
  };
}

// loom serves the built app at /app/ (docs/specs/ui-app.md); the page itself is any of loom's paths.
export default defineConfig({
  base: '/app/',
  plugins: [react(), tailwindcss(), looks()],
  css: { postcss: { plugins: [accessMedia()] } },
  resolve: { alias: { '@': path.resolve(import.meta.dirname, './src') } },
  build: { outDir: '../dist/web', emptyOutDir: true },
});
