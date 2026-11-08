import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, symlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

/**
 * The packaged shape, exercised.
 *
 * Every install route — `npm i -g`, `npm link`, `npx` — puts a SYMLINK in a
 * bin directory pointing at dist/index.js, and the entry-point guard used to
 * compare `process.argv[1]` (the symlink) against `import.meta.url` (the real
 * file) as raw strings. It never matched, so `loom --version` exited 0 with no
 * output and `loom serve` started nothing. Running `node dist/index.js`
 * directly — which is what every other test and every dev machine does —
 * hides it completely. So: invoke through a symlink, like a user would.
 */
describe('entry point — invoked through a symlinked bin', () => {
  const dist = resolve(__dirname, '..', 'dist', 'index.js');
  let bin: string;
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'loom-entry-bin-'));
    bin = join(dir, 'loom');
    await symlink(dist, bin);
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it.skipIf(!existsSync(dist))('dispatches --version through the symlink', async () => {
    const { stdout } = await run(process.execPath, [bin, '--version']);
    expect(stdout).toMatch(/^loom v\d+\.\d+\.\d+/);
  });

  it.skipIf(!existsSync(dist))('dispatches a subcommand through the symlink', async () => {
    const { stdout } = await run(process.execPath, [bin, '--help']);
    expect(stdout).toContain('Usage: loom <command> [options]');
  });
});
