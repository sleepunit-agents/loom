import { lstatSync, realpathSync } from 'node:fs';
import { basename, join } from 'node:path';

/** A restored candidate is never an operational home until its owning recovery
 * coordinator has finished Secrets recovery and acceptance. No remover yet. */
export const restorePending = '.restore-pending';
export const restorePrefix = '.loom-restore-';
export function assertHomeReady(home: string): void {
  // Names reserve the mkdir-to-marker crash window too. Resolve aliases before
  // allowing startup; a different pathname must not bypass the staging fence.
  if (basename(home).startsWith(restorePrefix)) throw new Error('Household restore is incomplete');
  let canonical = home;
  try { canonical = realpathSync(home); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('Household restore is incomplete');
  }
  if (basename(canonical).startsWith(restorePrefix)) throw new Error('Household restore is incomplete');
  try { lstatSync(join(home, restorePending)); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw new Error('Household restore is incomplete');
  }
  throw new Error('Household restore is incomplete');
}
