/** Refresh reads the configured forge source; scoped queries expose its cache.
 * No forge mutation or source facts are returned by this global owner operation. */
import { z } from 'zod';
import type { DataDatabase } from './core/data/database.js';
import type { Operations } from './core/operations/index.js';
import { workAnswersAllowed } from './shared-work-access.js';
export function registerWorkRefresh(operations: Operations, db: DataDatabase, refresh: () => Promise<unknown>) {
  operations.register({ name:'changes.refresh', recheckPolicy:true,
    input:z.object({}).strict(), output:z.object({refreshed:z.literal(true)}).strict(),
    may:viewer=>workAnswersAllowed(db,viewer),
    // A refresh only reads upstream. The configured producer commits its cache
    // through DataWrites and shares/drains scheduled and manual source work.
    async prepare() { await refresh(); },
    run() { return {refreshed:true}; },
  });
}
