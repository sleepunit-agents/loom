import { and, eq, getTableColumns } from 'drizzle-orm';
import { changes } from './core/data/schema.js';
import { sqlVisibility } from './policy-sql.js';
import type { Viewer } from './policy.js';
/** Refresh reads the configured forge source; scoped queries expose its cache.
 * No forge mutation or source facts are returned by this global owner operation. */
import { z } from 'zod';
import type { DataDatabase } from './core/data/database.js';
import type { Operations } from './core/operations/index.js';
import { workAnswersAllowed } from './shared-work-access.js';
export function registerWorkRefresh(
  operations: Operations,
  db: DataDatabase,
  refresh: () => Promise<unknown>,
) {
  operations.register({
    name: 'changes.refresh',
    recheckPolicy: true,
    input: z.object({}).strict(),
    output: z.object({ refreshed: z.literal(true) }).strict(),
    may: (viewer) => workAnswersAllowed(db, viewer),
    // A refresh only reads upstream. The configured producer commits its cache
    // through DataWrites and shares/drains scheduled and manual source work.
    async prepare() {
      await refresh();
    },
    run() {
      return { refreshed: true };
    },
  });
}

export function registerPullChecks(
  operations: Operations,
  db: DataDatabase,
  read: (repository: string, number: number, head: string) => Promise<{ name: string; state: string }[]>,
) {
  function visible(viewer: Viewer, id: string, head: string) {
    if (viewer.kind !== 'member') return;
    return db
      .select({ repository: changes.repository, number: changes.number })
      .from(changes)
      .where(
        and(
          eq(changes.id, id),
          eq(changes.headCommit, head),
          sqlVisibility(viewer, ['changes']).changes(getTableColumns(changes)),
        ),
      )
      .get();
  }
  operations.register({
    name: 'changes.checkRuns',
    doors: ['http'],
    write: false,
    input: z.object({ id: z.string(), head: z.string().min(1) }).strict(),
    output: z.object({
      checks: z.array(z.object({ name: z.string(), state: z.string() })),
      readAt: z.string(),
    }),
    may: (viewer, input) => !!visible(viewer, input.id, input.head),
    async prepare(input, { viewer }) {
      const pull = visible(viewer, input.id, input.head);
      if (!pull) throw Error('Pull unavailable');
      return {
        checks: await read(pull.repository, pull.number, input.head),
        readAt: new Date().toISOString(),
      };
    },
    run(_ctx, _input, prepared) {
      return prepared as { checks: { name: string; state: string }[]; readAt: string };
    },
  });
}
