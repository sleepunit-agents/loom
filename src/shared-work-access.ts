/** Door owner's rule: answering household permission cards requires a current
 * household-owner member. Read visibility and execution grants do not confer it. */
import type { Viewer } from './policy.js';
import type { DataDatabase } from './core/data/database.js';
import { householdOwner } from './shared-sharing.js';
export function workAnswersAllowed(db: DataDatabase, viewer: Viewer): viewer is Extract<Viewer, {kind:'member'}> {
  return householdOwner(db, viewer);
}
