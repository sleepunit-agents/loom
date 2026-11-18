import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Reporter, TestModule, Vitest } from 'vitest/node';

type Timing = { name: string; ms: number };
const byDuration = (a: Timing, b: Timing) => b.ms - a.ms || a.name.localeCompare(b.name);
const line = ({ name, ms }: Timing) => `  ${(ms / 1000).toFixed(3)}s  ${name}`;

export default class SlowReporter implements Reporter {
  private slowMs!: number;

  onInit(vitest: Vitest) {
    this.slowMs = vitest.config.slowTestThreshold;
  }

  onTestRunEnd(modules: ReadonlyArray<TestModule>) {
    const files: Timing[] = [];
    const tests: Timing[] = [];
    for (const mod of modules) {
      const file = mod.relativeModuleId;
      const timing = mod.diagnostic();
      if (timing.workerId) files.push({ name: file, ms: timing.duration });
      for (const test of mod.children.allTests()) {
        const ms = test.diagnostic()?.duration;
        if (ms !== undefined && ['passed', 'failed'].includes(test.result().state)) {
          tests.push({ name: `${file} > ${test.fullName}`, ms });
        }
      }
    }
    files.sort(byDuration);
    tests.sort(byDuration);
    const summary = [
      'Slowest files (tests and hooks)', ...files.slice(0, 5).map(line),
      `Slowest tests (top five and every test over ${this.slowMs / 1000}s)`,
      ...tests.filter((test, index) => index < 5 || test.ms > this.slowMs)
        .map(test => line(test) + (test.ms > this.slowMs ? ' [slow]' : '')),
    ].join('\n') + '\n';
    console.log(summary);
    const path = process.env.LOOM_SLOW_REPORT;
    if (path) {
      mkdirSync(dirname(path), { recursive: true });
      // A shard can run both changed tests and tree guards.
      appendFileSync(path, summary + '\n');
    }
  }
}
