/** Door owner's rule: answering household permission cards requires a current
 * household-owner member. Read visibility and execution grants do not confer it. */
import { eq } from 'drizzle-orm';
import type { Viewer } from './policy.js';
import type { DataDatabase } from './core/data/database.js';
import { members } from './core/data/schema.js';
export function workAnswersAllowed(db: DataDatabase, viewer: Viewer): viewer is Extract<Viewer, {kind:'member'}> {
  return viewer.kind === 'member' && db.select({role:members.role}).from(members).where(eq(members.id,viewer.id)).get()?.role === 'owner';
}
