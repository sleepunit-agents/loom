import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import tailwind from '@tailwindcss/vite';

// Verify the shipped graph, including lazy chunks. Shared behavior is opt-in.
const isolation: Plugin = {
  name: 'boards-visual-isolation',
  generateBundle(_, bundle) {
    for (const chunk of Object.values(bundle)) {
      if (chunk.type !== 'chunk') continue;
      for (const module of Object.keys(chunk.modules)) {
        const id = module.split('/web/src/')[1]?.split('?')[0];
        if (
          id &&
          !/^(access\.ts$|boards\/|pair\/|contexts\/(?:portrait\.tsx|portrait-player\.ts|manifest\.json|sheet\.png)$|data\/|signin\/use-session\.ts$|lib\/utils\.ts$|pieces\/comms\/use-deadline\.ts$)/.test(
            id,
          )
        )
          this.error('Desktop dependency in boards page: ' + id);
      }
    }
  },
};
export default defineConfig({
  base: '/app/',
  plugins: [react(), tailwind(), isolation],
  build: {
    outDir: '../dist/web',
    assetsDir: 'boards-assets',
    emptyOutDir: false,
    rolldownOptions: { input: 'board.html' },
  },
});
