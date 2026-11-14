import { lstatSync } from 'node:fs';
import { join } from 'node:path';

/** A restored candidate is never an operational home until its owning recovery
 * coordinator has finished Secrets recovery and acceptance. No remover yet. */
export const restorePending = '.restore-pending';
export function assertHomeReady(home: string): void {
  try { lstatSync(join(home, restorePending)); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw new Error('Household restore is incomplete');
  }
  throw new Error('Household restore is incomplete');
}
