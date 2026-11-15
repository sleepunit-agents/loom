import { existsSync, readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
const root = new URL('../../', import.meta.url);
it('does not publish or retain the obsolete Clock credential client', () => {
  const manifest = JSON.parse(readFileSync(new URL('package.json', root), 'utf8'));
  const lock = JSON.parse(readFileSync(new URL('package-lock.json', root), 'utf8'));
  for (const bins of [manifest.bin, lock.packages[''].bin]) {
    expect(bins).not.toHaveProperty('loom-wake-client');
    expect(Object.values(bins)).not.toContain('dist/wake-client.js');
  }
  expect(existsSync(new URL('src/wake-client.ts', root))).toBe(false);
  expect(existsSync(new URL('src/cli/wake-client.ts', root))).toBe(false);
  expect(existsSync(new URL('src/cli/wake.ts', root))).toBe(true);
});
