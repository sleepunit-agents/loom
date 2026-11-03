import { defineConfig, configDefaults } from 'vitest/config';

export default defineConfig({
  test: {
    // `.claude/worktrees/` holds abandoned agent worktrees — full stale copies
    // of this repo. Without this they get collected too, so the suite silently
    // reports hundreds of extra passes from old code against current
    // node_modules. Excluded so the count means what it says.
    exclude: [...configDefaults.exclude, '.claude/**'],
    setupFiles: ['./src/test-isolation.ts', './src/test-setup.ts'],
    env: {
      // Force filesystem backend in tests so tool-level tests don't route
      // through Qdrant (which requires a live server and separate data store).
      LOOM_MEMORY_BACKEND: 'filesystem',
    },
  },
});
