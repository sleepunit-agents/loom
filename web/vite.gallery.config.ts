import path from 'node:path';
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import tailwind from '@tailwindcss/vite';
import { accessMedia } from './access-media.ts';

// The bricks' gallery (src/boards/gallery): every brick in every form, drawn from fixtures. Development only: it is
// built by `npm run gallery:build` into a scratch directory and is no part of `npm run build`. Its one trick is
// here: the data hook every brick reads through (src/data/graphql) is replaced by the gallery's fixture-backed one.
const fakeData: Plugin = {
  name: 'gallery-fake-data',
  enforce: 'pre',
  async resolveId(source, importer, options) {
    if (!importer || !source.includes('graphql') && source !== './index') return null;
    const found = await this.resolve(source, importer, { ...options, skipSelf: true });
    return found && /\/src\/data\/graphql\/index\.ts$/.test(found.id) ? path.resolve(import.meta.dirname, 'src/boards/gallery/fake-graphql.ts') : null;
  },
};
export default defineConfig({
  base: './',
  plugins: [fakeData, react(), tailwind()],
  css: { postcss: { plugins: [accessMedia()] } },
  build: {
    outDir: process.env.GALLERY_OUT || '../dist/gallery',
    emptyOutDir: true,
    rolldownOptions: { input: 'gallery.html' },
  },
});
