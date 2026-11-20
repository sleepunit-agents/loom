/** "A live worker for this machine", stated once for every worker operation. */
import { eq } from 'drizzle-orm';
import type { Viewer } from './policy.js';
import type { DataDatabase } from './core/data/database.js';
import { boxes } from './core/data/schema.js';

/** The machine a worker's request speaks for, or nothing. `proof` is what the door established about the
 * credential presented (sharedCredentials.runner or .runnerEnrollment): it must be a worker's, bound to the
 * machine the viewer names, and that machine must not have been revoked. A viewer that merely says it is
 * a runner proves nothing. */
export function liveWorker(db: DataDatabase, viewer: Viewer, proof: Readonly<{ box: string }> | undefined): string | undefined {
  if (viewer.kind !== 'runner' || proof?.box !== viewer.id) return undefined;
  const row = db.select({ revokedAt: boxes.revokedAt }).from(boxes).where(eq(boxes.id, viewer.id)).get();
  return row && row.revokedAt === null ? viewer.id : undefined;
}
