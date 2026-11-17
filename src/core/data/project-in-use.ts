/** A project that something is filed under, joined or merged must be one in use: there, and not removed.
 * Stated here once, with the one set of words a caller is told. A task's project (apps/tasks.ts), an agent
 * let onto a project and a merge of two (shared-projects.ts) all ask this; none reads `removed_at` itself. */
import { eq } from 'drizzle-orm';
import type { DataDatabase } from './database.js';
import { projects } from './schema.js';

export interface ProjectRefusal { code: 'not-found' | 'invalid'; message: string }
/** Why this project will not do, or nothing when it is in use. */
export function projectRefusal(db: DataDatabase, project: string): ProjectRefusal | undefined {
  const found = db.select({ removedAt: projects.removedAt }).from(projects).where(eq(projects.id, project)).get();
  return !found ? { code: 'not-found', message: 'No project has the id ' + project }
    : found.removedAt ? { code: 'invalid', message: 'Project ' + project + ' is removed' } : undefined;
}
