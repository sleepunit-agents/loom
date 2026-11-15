/** Outside browser administration. A member ends their own browser/device;
 * current household owners may end any and revoke household tokens. */
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import type { Viewer } from './policy.js';
import type { DataDatabase } from './core/data/database.js';
import { members } from './core/data/schema.js';
import { signinAccounts } from './core/signin/accounts.js';
import type { Operations } from './core/operations/index.js';
const input = z.object({ id: z.string().regex(/^[0-9a-f]{64}$/) }).strict();
export function registerSharedSigninAccount(operations: Operations, db: DataDatabase, service: ReturnType<typeof signinAccounts>) {
  const person = (viewer: Viewer) => viewer.kind === 'member'
    ? db.select({ id: members.id, role: members.role }).from(members).where(eq(members.id, viewer.id)).get() : undefined;
  const mayEnd = (viewer: Viewer, target: () => string | null | undefined) => {
    const current = person(viewer);
    // A missing target is an authenticated idempotent no-op. A receipt contains
    // only the supplied opaque id, never metadata from the removed browser.
    if (!current) return false;
    if (current.role === 'owner') return true;
    const owner = target(); return owner === undefined || owner === current.id;
  };
  operations.register({ name: 'signin.endSession', write: true, recheckPolicy: true, input, output: input,
    may: (viewer, value) => mayEnd(viewer, () => service.sessionMember(value.id)),
    run(ctx, value) { service.endSession(value.id); ctx.changed('core.access', 'sessions'); return value; },
  });
  operations.register({ name: 'signin.removeDevice', write: true, recheckPolicy: true, input, output: input,
    may: (viewer, value) => mayEnd(viewer, () => service.deviceMember(value.id)),
    run(ctx, value) { service.removeDevice(value.id); ctx.changed('signin.devices', value.id); return value; },
  });
  operations.register({ name: 'signin.revokeToken', write: true, recheckPolicy: true, input, output: input,
    may: viewer => person(viewer)?.role === 'owner',
    run(ctx, value) { service.revokeToken(value.id, new Date(ctx.now).toISOString()); ctx.changed('core.access', 'tokens'); return value; },
  });
}
