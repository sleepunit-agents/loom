/** Worker observations enter through the same receipt and shared-write boundary. */
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import type { Viewer } from './policy.js';
import type { DataDatabase } from './core/data/database.js';
import { boxes, modelAccountBoxes, modelAccounts } from './core/data/schema.js';
import type { Operations } from './core/operations/index.js';
import { quotaWindows } from './runtime/account-observation.js';
import { recordAccountWindows } from './runtime/account-windows.js';
export function registerSharedAccountReports(operations: Operations, db: DataDatabase, now: () => string, runner: (viewer: Viewer) => Readonly<{box: string}> | undefined) {
  operations.register({ name: 'runtime.accountUsage', write: true, recheckPolicy: true, doors: ['http'],
    input: z.object({ account: z.string().min(1), owner: z.string().min(1), provider: z.string().min(1), windows: quotaWindows }).strict(),
    output: z.object({ recorded: z.boolean() }).strict(),
    may(viewer, input) {
      if (viewer.kind !== 'runner' || runner(viewer)?.box !== viewer.id) return false;
      const box = db.select({ revokedAt: boxes.revokedAt }).from(boxes).where(eq(boxes.id, viewer.id)).get();
      const account = db.select().from(modelAccounts).where(eq(modelAccounts.id, input.account)).get();
      const membership = db.select().from(modelAccountBoxes).where(and(eq(modelAccountBoxes.account, input.account), eq(modelAccountBoxes.box, viewer.id))).get();
      return !!box && box.revokedAt === null && !!membership && account?.owner === input.owner && account?.provider === input.provider;
    },
    run(ctx, input) {
      const recorded = recordAccountWindows(db, input, input.windows, now());
      if (recorded) ctx.changed('modelAccount', input.account);
      return { recorded };
    },
  });
}
