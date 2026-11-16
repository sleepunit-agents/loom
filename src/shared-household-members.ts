/** Household identity administration belongs to current household owners. */
import type { Viewer } from './policy.js';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import type { DataDatabase } from './core/data/database.js';
import { members } from './core/data/schema.js';
import { householdService, HouseholdError, memberInput, agentInput, settingsInput } from './apps/household.js';
import { OperationError, type Operations } from './core/operations/index.js';
export function registerSharedHouseholdMembers(operations: Operations, db: DataDatabase, service: ReturnType<typeof householdService>) {
  const may = (viewer: Viewer) => viewer.kind === 'member' &&
    db.select({ role: members.role }).from(members).where(eq(members.id, viewer.id)).get()?.role === 'owner';
  operations.register({ name: 'household.setMember', write: true, recheckPolicy: true, input: memberInput,
    output: z.object({ id: z.string() }).strict(), may,
    run(ctx, input) {
      try {
        const result = service.setMember(input); ctx.changed('core.access', 'household'); return result;
      } catch (error) { if (error instanceof HouseholdError) throw new OperationError(error.code, error.message); throw error; }
    },
  });
  operations.register({ name: 'household.setAgent', write: true, recheckPolicy: true, input: agentInput,
    output: z.object({ id: z.string() }).strict(), may,
    run(ctx, input) { const result = service.setAgent(input); ctx.changed('agents', result.id); return result; },
  });
  // The household's own row: default agent, time zone, keep time, GitHub owner
  // and backups. The Secrets default stays with secrets.command.
  operations.register({ name: 'household.setSettings', write: true, recheckPolicy: true, input: settingsInput,
    output: z.object({ saved: z.literal(true) }).strict(), may,
    run(ctx, input) {
      try {
        const result = service.setSettings(input); ctx.changed('core.access', 'household'); ctx.changed('household', 'settings'); return result;
      } catch (error) { if (error instanceof HouseholdError) throw new OperationError(error.code, error.message); throw error; }
    },
  });
}
