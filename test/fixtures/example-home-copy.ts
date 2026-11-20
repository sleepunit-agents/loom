import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { afterAll } from 'vitest';
import type { exampleHome } from '../../src/example-home.js';

/** Build one closed example household for this suite. Each caller starts its own writable copy. */
export function exampleHomeCopies(create: typeof exampleHome) {
  let parent: string | undefined;
  let ready: Promise<string> | undefined;
  afterAll(() => { if (parent) rmSync(parent, { recursive: true, force: true }); });
  return async (home: string, webRoot?: string): Promise<Awaited<ReturnType<typeof exampleHome>>> => {
    if (!ready) {
      parent = mkdtempSync(join(tmpdir(), 'loom-example-template-'));
      const directory = join(parent, 'home');
      ready = create(directory).then(() => directory);
    }
    const seed = await ready;
    cpSync(seed, home, { recursive: true, errorOnExist: true, force: false });
    // program.json names absolute paths. Keep every home-owned path in this test's copy.
    const config = join(home, 'program.json');
    const program = JSON.parse(readFileSync(config, 'utf8'), (_key, value) =>
      typeof value === 'string' && value.startsWith(seed + sep) ? join(home, relative(seed, value)) : value);
    if (webRoot) program.webRoot = webRoot;
    writeFileSync(config, JSON.stringify(program), { mode: 0o600 });
    return JSON.parse(readFileSync(join(home, 'example.json'), 'utf8'));
  };
}
