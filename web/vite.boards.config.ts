import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import tailwind from '@tailwindcss/vite';
import { fileURLToPath } from 'node:url';
import { accessMedia } from './access-media.ts';
import { boardsGuard } from './boards-guard.ts';

// Verify the whole module graph the build loaded, lazy chunks and files that render no code included (boards-guard.ts).
const isolation: Plugin = {
  name: 'boards-visual-isolation',
  generateBundle() {
    const root = fileURLToPath(new URL('..', import.meta.url));
    const seen = [...this.getModuleIds()].map((id) => {
      const info = this.getModuleInfo(id);
      return { id, imports: [...(info?.importedIds ?? []), ...(info?.dynamicallyImportedIds ?? [])] };
    });
    const problems = boardsGuard(seen, root);
    if (problems.length) this.error(problems.join('\n'));
  },
};
export default defineConfig({
  base: '/app/',
  plugins: [react(), tailwind(), isolation],
  // As the desktop's build does: every motion media query becomes a rule under <html data-motion>, which this page
  // sets from the member's own Reduce motion (src/boards/wear.ts), so no stylesheet asks the device past that choice.
  css: { postcss: { plugins: [accessMedia()] } },
  build: {
    outDir: '../dist/web',
    assetsDir: 'boards-assets',
    emptyOutDir: false,
    rolldownOptions: { input: 'board.html' },
  },
});
