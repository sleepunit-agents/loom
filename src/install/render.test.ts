import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeSkill } from './render.js';

describe('writeSkill', () => {
  let work: string;
  beforeEach(async () => { work = await mkdtemp(join(tmpdir(), 'loom-install-')); });
  afterEach(async () => { await rm(work, { recursive: true, force: true }); });

  it('creates destination + parent dir when missing', async () => {
    const dest = join(work, 'nested', 'skills', 'loom-setup.md');
    const res = await writeSkill(dest);
    expect(res.action).toBe('created');
    expect(res.path).toBe(dest);
    const body = await readFile(dest, 'utf-8');
    expect(body).toMatch(/name:\s*loom-setup/);
    await expect(stat(dest)).resolves.toBeTruthy();
  });

  it('skips when destination exists and content matches', async () => {
    const dest = join(work, 'loom-setup.md');
    const first = await writeSkill(dest);
    expect(first.action).toBe('created');
    const second = await writeSkill(dest);
    expect(second.action).toBe('skipped-exists');
  });

  it('reports skipped-stale when destination exists with different content and force is unset', async () => {
    const dest = join(work, 'loom-setup.md');
    await writeFile(dest, 'pre-existing content\n', 'utf-8');
    const res = await writeSkill(dest);
    expect(res.action).toBe('skipped-stale');
    const body = await readFile(dest, 'utf-8');
    expect(body).toBe('pre-existing content\n');
  });

  it('overwrites when force=true', async () => {
    const dest = join(work, 'loom-setup.md');
    await writeFile(dest, 'pre-existing\n', 'utf-8');
    const res = await writeSkill(dest, { force: true });
    expect(res.action).toBe('overwritten');
    const body = await readFile(dest, 'utf-8');
    expect(body).toMatch(/name:\s*loom-setup/);
  });

  it('dryRun does not write but reports the action it would take', async () => {
    const dest = join(work, 'loom-setup.md');
    const res = await writeSkill(dest, { dryRun: true });
    expect(res.action).toBe('created');
    await expect(stat(dest)).rejects.toThrow();
  });
});
