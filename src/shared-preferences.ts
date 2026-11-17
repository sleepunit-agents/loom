/** Member appearance is shared data, bound to the authenticated person. */
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import type { DataDatabase } from './core/data/database.js';
import { memberPreferences } from './core/data/schema.js';
import { currentMember } from './shared-sharing.js';
import { type Operations, OperationError } from './core/operations/index.js';
const choices = z.object({
  look: z.enum(memberPreferences.look.enumValues), ground: z.enum(memberPreferences.ground.enumValues),
  sound: z.boolean(), pixel: z.boolean(), icons: z.boolean(), haptics: z.boolean(),
  oneWindow: z.boolean(), zoom: z.boolean(), motion: z.enum(memberPreferences.motion.enumValues), contrast: z.enum(memberPreferences.contrast.enumValues),
});
const defaults: z.infer<typeof choices> = { look: 'neon', ground: 'depth', sound: false, pixel: true, icons: false,
  haptics: true, oneWindow: false, zoom: false, motion: 'follow', contrast: 'follow' };
export function registerSharedPreferences(operations: Operations, db: DataDatabase) {
  operations.register({ name: 'household.setPreferences', write: true, recheckPolicy: true,
    input: choices.partial().strict().refine(input => Object.values(input).some(value => value !== undefined), 'Choose a preference'),
    output: z.object({ changedAt: z.string() }).strict(),
    may: viewer => currentMember(db, viewer),
    run(ctx, patch) {
      if (ctx.viewer.kind !== 'member') throw new OperationError('denied', 'A member is required');
      const old = db.select().from(memberPreferences).where(eq(memberPreferences.member, ctx.viewer.id)).get();
      const changedAt = new Date(ctx.now).toISOString();
      // Undefined is not a choice; partial trusted calls must not erase one.
      const values = Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined));
      db.insert(memberPreferences).values({ ...defaults, ...old, ...values, member: ctx.viewer.id, changedAt })
        .onConflictDoUpdate({ target: memberPreferences.member, set: { ...values, changedAt } }).run();
      ctx.changed('memberPreferences', ctx.viewer.id);
      return { changedAt };
    },
  });
}
