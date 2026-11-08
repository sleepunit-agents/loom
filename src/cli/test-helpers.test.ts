/**
 * Direct tests for the runCliCaptured harness helper. These exist because
 * every subcommand test relies on the helper's stdin/TTY/env semantics, so
 * regressions here cascade invisibly through the rest of the CLI suite.
 */
import { describe, it, expect, vi } from 'vitest';
import type { IOStreams } from './io.js';

// Capture whatever IOStreams runCli receives, per-test. The module-level
// `let` + mock factory plumbing lets us inspect the harness's behavior
// without actually running any subcommand logic.
let lastIo: IOStreams | undefined;
vi.mock('./index.js', () => ({
  runCli: async (_argv: string[], io: IOStreams) => {
    lastIo = io;
    return 0;
  },
}));

// Import after vi.mock so the helper binds to the mocked runCli.
const { runCliCaptured } = await import('./test-helpers.js');

describe('runCliCaptured', () => {
  it('pipes opts.stdin through the ReadableStream and flips stdinIsTTY off', async () => {
    lastIo = undefined;
    await runCliCaptured(['recall', 'anything'], { stdin: 'piped body\n' });
    expect(lastIo).toBeDefined();
    expect(lastIo!.stdinIsTTY).toBe(false);
    const chunks: Buffer[] = [];
    for await (const chunk of lastIo!.stdin) {
      chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
    }
    expect(Buffer.concat(chunks).toString('utf-8')).toBe('piped body\n');
  });

  it('treats absent stdin as a TTY (no piped input)', async () => {
    lastIo = undefined;
    await runCliCaptured(['wake']);
    expect(lastIo).toBeDefined();
    expect(lastIo!.stdinIsTTY).toBe(true);
  });

  it('merges opts.contextDir into env, with opts.env.LOOM_CONTEXT_DIR winning', async () => {
    lastIo = undefined;
    await runCliCaptured(['wake'], {
      contextDir: '/tmp/from-opt',
      env: { LOOM_CONTEXT_DIR: '/tmp/from-env', FOO: 'bar' },
    });
    expect(lastIo!.env.LOOM_CONTEXT_DIR).toBe('/tmp/from-env');
    expect(lastIo!.env.FOO).toBe('bar');
  });

  it('uses opts.contextDir when env does not set LOOM_CONTEXT_DIR', async () => {
    lastIo = undefined;
    await runCliCaptured(['wake'], { contextDir: '/tmp/from-opt' });
    expect(lastIo!.env.LOOM_CONTEXT_DIR).toBe('/tmp/from-opt');
  });
});
