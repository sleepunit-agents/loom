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
    // Real browsers run after unit work, one file at a time. Concurrent app
    // proofs compete for the same runner CPUs and turn actionability waits into
    // timeouts even when the command/data path is sound.
    projects: [
      { extends: true, test: { name: 'unit', sequence: { groupOrder: 0 }, exclude: [...configDefaults.exclude, '.claude/**', 'src/ui/**/*.integration.test.ts'] } },
      // The browser suites are off while the web app waits its turn (Jonathan, 2026-11-16).
      // LOOM_BROWSER_TESTS=on brings them back, here and in CI.
      ...(process.env.LOOM_BROWSER_TESTS === 'on' ? [{ extends: true as const, test: { name: 'browser', sequence: { groupOrder: 1 }, fileParallelism: false, maxWorkers: 1, include: ['src/ui/**/*.integration.test.ts'], retry: process.env.CI ? 1 : 0 } }] : []),
    ],
    setupFiles: ['./src/test-isolation.ts', './src/test-setup.ts'],
    // expect.poll waits for something to become true; how long it may wait is not what any test checks. Vitest's own
    // default gives up after 1 s, which on a loaded runner turned "eventually" into a wall-clock limit: the desk tests'
    // 189 polls, a minimize's tile "still there" past it on CI (t-1923, t-1949). A passing poll returns as soon as its
    // condition holds, so this only changes how long a failing one takes to say so. A test that means "at once" says
    // what at once means on the page's own clock (desk.integration.test.ts, holdClock), not with a poll's deadline.
    expect: { poll: { timeout: 10_000 } },
    // The same reasoning for a whole test: its wall-clock budget is not what any test checks. On GitHub's shared
    // runners four unrelated tests passed their 5 s default in one evening (sign-in notifications, collections paging
    // and sync, mind activity, the runner's secret command), each passing again untouched, and each failure left main
    // without a green build to deploy. A passing test ends when it ends, so this only changes how long a hung one
    // takes to say so. The same holds on a developer's machine and on loom's own, where bodies run suites beside
    // other work: on 2026-11-18 one local run showed 69 failures of which 67 were this budget, and a CI shard failed on
    // a test that had only grown with the schema. So there is one budget everywhere, and it is a hang detector: long
    // enough that a loaded machine does not reach it. A slow test is worth noticing, and is noticed by being reported
    // (scripts/flaky-reporter.ts), not by failing.
    testTimeout: 60_000,
    env: {
      // Force filesystem backend in tests so tool-level tests don't route
      // through Qdrant (which requires a live server and separate data store).
      LOOM_MEMORY_BACKEND: 'filesystem',
    },
  },
});
