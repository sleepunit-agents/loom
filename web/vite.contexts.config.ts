import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Build the unlisted prototype independently so importing its sign-in gate
// never executes the desktop's entry module.
export default defineConfig({
  base: '/app/',
  plugins: [react()],
  build: {
    outDir: '../dist/web',
    assetsDir: 'contexts-assets',
    emptyOutDir: false,
    rolldownOptions: { input: 'contexts.html' },
  },
});
