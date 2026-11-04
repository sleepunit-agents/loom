import path from 'node:path';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

/**
 * The looks (src/looks/): Neon Noir's stylesheet is its own file, built beside the app's, and a tiny script in the
 * page's head (src/looks/boot.js) puts it on before first paint. loom's CSP allows no inline script, so the script is a
 * file of its own, named by its content like the rest of assets/ (the service worker keeps it for offline).
 */
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
      const src = readFileSync(path.resolve(__dirname, 'src/looks/boot.js'), 'utf-8')
        .replace(/^\s*\/\/.*$/gm, '').replace(/\s*\/\*.*?\*\//g, '').replace(/\n\s*/g, '').replace(/__NEON_CSS__/g, css);
      const fileName = `assets/look-${createHash('sha256').update(src).digest('base64url').slice(0, 8)}.js`;
      this.emitFile({ type: 'asset', fileName, source: src });
      const html = bundle['index.html'];
      if (!html || html.type !== 'asset') throw new Error('loom-looks: no index.html in the build');
      // First in the head, before the app's stylesheet: it decides which look paints.
      html.source = String(html.source).replace('<meta charset="UTF-8" />', `<meta charset="UTF-8" />\n    <script src="/app/${fileName}"></script>`);
    },
  };
}

// loom serves the built app at /app/ (docs/specs/ui-app.md); the page itself is any of loom's paths.
export default defineConfig({
  base: '/app/',
  plugins: [react(), tailwindcss(), looks()],
  resolve: { alias: { '@': path.resolve(__dirname, './src') } },
  build: {
    outDir: '../dist/web', emptyOutDir: true,
    rollupOptions: { input: { index: path.resolve(__dirname, 'index.html'), neon: path.resolve(__dirname, 'src/looks/neon.css') } },
  },
});
