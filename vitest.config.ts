import { fileURLToPath } from 'node:url';
import { defineConfig, configDefaults } from 'vitest/config';
import CiSequencer from './scripts/ci-sequencer.js';

export default defineConfig({
  // The app's own imports (web/src: `@/components/ui/…`), for the tests that draw a piece of it (app-tint.test.ts).
  resolve: { alias: { '@': fileURLToPath(new URL('./web/src', import.meta.url)) } },
  test: {
    sequence: { sequencer: CiSequencer },
    // `.claude/worktrees/` holds abandoned agent worktrees — full stale copies
    // of this repo. Without this they get collected too, so the suite silently
    // reports hundreds of extra passes from old code against current
    // node_modules. Excluded so the count means what it says.
    exclude: [...configDefaults.exclude, '.claude/**'],
    projects: [
      { extends: true, test: { name: 'unit', exclude: [...configDefaults.exclude, '.claude/**', 'src/ui/**/*.integration.test.ts'] } },
      { extends: true, test: { name: 'browser', include: ['src/ui/**/*.integration.test.ts'], retry: process.env.CI ? 1 : 0 } },
    ],
    setupFiles: ['./src/test-isolation.ts', './src/test-setup.ts'],
    // expect.poll waits for something to become true; how long it may wait is not what any test checks. Vitest's own
    // default gives up after 1 s, which on a loaded runner turned "eventually" into a wall-clock limit: the desk tests'
    // 189 polls, a minimize's tile "still there" past it on CI (t-1923, t-1949). A passing poll returns as soon as its
    // condition holds, so this only changes how long a failing one takes to say so. A test that means "at once" says
    // what at once means on the page's own clock (desk.integration.test.ts, holdClock), not with a poll's deadline.
    expect: { poll: { timeout: 10_000 } },
    env: {
      // Force filesystem backend in tests so tool-level tests don't route
      // through Qdrant (which requires a live server and separate data store).
      LOOM_MEMORY_BACKEND: 'filesystem',
    },
  },
});
