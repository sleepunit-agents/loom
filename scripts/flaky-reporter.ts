import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname, relative } from 'node:path';
import type { Reporter, TestCase } from 'vitest/node';

// Append as results arrive: a later worker crash must not erase earlier retries.
export default class FlakyReporter implements Reporter {
  onTestCaseResult(test: TestCase) {
    const retries = test.diagnostic()?.retryCount ?? 0;
    if (!retries) return;
    const path = process.env.LOOM_FLAKY_LEDGER ?? 'artifacts/flaky.jsonl';
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, JSON.stringify({
      file: relative(process.cwd(), test.module.moduleId), test: test.fullName,
      retries, state: test.result().state,
      errors: test.result().errors?.map(error => ({ message: error.message, stack: error.stack })),
      node: process.version, shard: process.env.LOOM_CI_SHARD,
      run: process.env.GITHUB_RUN_ID, attempt: process.env.GITHUB_RUN_ATTEMPT,
    }) + '\n');
  }
}
