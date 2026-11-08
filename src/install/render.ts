import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { resolveSkillSourcePath } from './skill-source.js';

export type WriteAction = 'created' | 'skipped-exists' | 'skipped-stale' | 'overwritten';

export interface WriteSkillResult {
  path: string;
  action: WriteAction;
}

export interface WriteSkillOpts {
  force?: boolean;
  dryRun?: boolean;
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await readFile(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Write the bundled SKILL.md to `dest`. Idempotent: returns
 * `skipped-exists` when destination already matches source,
 * `skipped-stale` when content differs and `force` is unset (signals
 * the on-disk copy is out of date), `overwritten` with `force: true`.
 * `dryRun: true` short-circuits all writes but still reports the
 * action that would have been taken.
 */
export async function writeSkill(
  dest: string,
  opts: WriteSkillOpts = {},
): Promise<WriteSkillResult> {
  const source = await readFile(resolveSkillSourcePath(), 'utf-8');
  const exists = await pathExists(dest);

  if (!exists) {
    if (!opts.dryRun) {
      await mkdir(dirname(dest), { recursive: true });
      await writeFile(dest, source, 'utf-8');
    }
    return { path: dest, action: 'created' };
  }

  const current = await readFile(dest, 'utf-8');
  if (current === source) {
    return { path: dest, action: 'skipped-exists' };
  }
  if (!opts.force) {
    return { path: dest, action: 'skipped-stale' };
  }
  if (!opts.dryRun) {
    await writeFile(dest, source, 'utf-8');
  }
  return { path: dest, action: 'overwritten' };
}
