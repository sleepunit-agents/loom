import { describe, it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import { resolveSkillSourcePath } from './skill-source.js';

describe('resolveSkillSourcePath', () => {
  it('returns a path that exists and has the expected frontmatter', async () => {
    const p = resolveSkillSourcePath();
    const body = await readFile(p, 'utf-8');
    expect(body.startsWith('---\n')).toBe(true);
    expect(body).toMatch(/^name:\s*loom-setup$/m);
    expect(body).toMatch(/^description:/m);
  });

  it('returns an absolute path', () => {
    const p = resolveSkillSourcePath();
    expect(p.startsWith('/')).toBe(true);
  });
});
