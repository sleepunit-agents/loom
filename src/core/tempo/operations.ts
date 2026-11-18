/** Commands over the shared Tempo service. Current caller policy and proposal
 * provenance come from composition; no service name or request field grants
 * authority here. The shared writer must call tempo.committed() after commit.
 */
import {createHash} from 'node:crypto';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import type { Viewer } from '../../policy.js';
import type { Asker } from '../../policy.js';
import type { DataDatabase } from '../data/database.js';
import { inbox, triggers } from '../data/schema.js';
import { OperationError, Operations, operation } from '../operations/index.js';
import type { createTempo } from './tempo.js';
import { triggerEdit, triggerInput, type NewTrigger, type Trigger, type TriggerAsked } from './triggers.js';

export type TempoAccess =
  | { action: 'set'; trigger: NewTrigger }
  | { action: 'stop' | 'start' | 'runNow' | 'edit'; trigger: Trigger }
  | { action: 'pause' | 'resume'; agent: string }
  | { action: 'volume'; item: typeof inbox.$inferSelect };
export interface TempoOperationOptions {
  authorize(viewer: Viewer, access: TempoAccess): boolean;
  /** A new trigger as it is recorded for this caller: whose it is can follow who set it (policy.ts,
   * triggerAsSet), and with it the member its work is for, if any. `authorize` judges a `set` by the same
   * reading. Without it, as given and for nobody. */
  recorded?(viewer: Viewer, trigger: NewTrigger): { trigger: NewTrigger; member?: string; asked?: Asker };
  /** Why this caller may not set, reword, stop, start or run this trigger because of whose word its job works on, in words for the
   * caller, or nothing (policy.ts, maySchedule). Asked after `authorize`: of what the caller sent for a new
   * trigger, before it is recorded, and of the stored row for one that exists. */
  wordRefusal?(viewer: Viewer, action: 'set' | 'edit' | 'stop' | 'start' | 'runNow', trigger: TriggerAsked, change?: { times?: string; file?: string | null; instructions?: string | null; note?: string }): string | undefined;
  /** Why a trigger may not be turned on now (its conversation already has as many standing as it may). */
  standRefusal?(trigger: { conversation?: string | null }): string | undefined;
  /** Who asks for a trigger that names a conversation, once this caller has changed its words, file or times. */
  reasked?(viewer: Viewer, trigger: { conversation: string | null }, change: { instructions?: string | null; file?: string | null; note?: string; times?: string }): Asker | undefined;
  /** Outside authenticated context for delegated mailbox receipt isolation. */
  mailboxReceiptScope?(viewer:Viewer):string|undefined;
}
const id = z.object({ id: z.string().min(1) }).strict();
const saved = z.object({ saved: z.literal(true) }).strict();

export function registerTempoOperations(operations: Operations, db: DataDatabase,
  tempo: ReturnType<typeof createTempo>, options: TempoOperationOptions): void {
  if (operations.db !== db.$client) throw new Error('Tempo operations need the shared connection');
  const common = { write: true, recheckPolicy: true, refuses: true };
  const mailbox = {...common,inputHash:(canonical:string,identity:Readonly<{actor:Viewer}>)=>{
    const scope=options.mailboxReceiptScope?.(identity.actor);
    return createHash('sha256').update(scope===undefined?canonical:JSON.stringify([scope,canonical])).digest('hex');
  }};
  const triggerAccess = (viewer: Viewer, target: string, action: 'stop' | 'start' | 'runNow' | 'edit') => {
    const trigger = db.select().from(triggers).where(eq(triggers.id, target)).get();
    return !!trigger && options.authorize(viewer, { action, trigger });
  };
  operations.register(operation({ ...common, name: 'tempo.set', input: triggerInput, output: z.object({ id: z.string() }),
    may: (viewer, trigger) => options.authorize(viewer, { action: 'set', trigger }),
    run(ctx, trigger) {
      const refused = options.wordRefusal?.(ctx.viewer, 'set', trigger); if (refused) throw new OperationError('denied', refused);
      const as = options.recorded?.(ctx.viewer, trigger) ?? { trigger };
      const row = tempo.triggers.set(as.trigger, as.member, as.asked); ctx.changed('triggers', row.id); return { id: row.id }; },
  }));
  for (const action of ['stop', 'start', 'runNow'] as const) operations.register(operation({ ...common,
    name: `tempo.${action}`, input: id, output: saved,
    may: (viewer, input) => triggerAccess(viewer, input.id, action),
    run(ctx, input) {
      // On whose word the caller works matters for these as for setting: a body working for anybody but owners starts,
      // runs and stops nothing of its agent's that fires outside its own conversation (policy.ts, maySchedule).
      const stored = db.select().from(triggers).where(eq(triggers.id, input.id)).get(), refused = stored && options.wordRefusal?.(ctx.viewer, action, stored);
      if (refused) throw new OperationError('denied', refused);
      const full = action === 'start' && stored ? options.standRefusal?.(stored) : undefined;
      if (full) throw new OperationError('conflict', full);
      tempo.triggers[action](input.id); ctx.changed('triggers', input.id); return { saved: true };
    },
  }));
  operations.register(operation({ ...common, name: 'tempo.edit', input: triggerEdit.extend({ id: z.string().min(1) }).strict(), output: saved,
    may: (viewer, input) => (viewer.kind === 'member' || viewer.kind === 'agent') && triggerAccess(viewer, input.id, 'edit'),
    run(ctx, { id: target, ...change }) {
      if (ctx.viewer.kind !== 'member' && ctx.viewer.kind !== 'agent') throw new Error('Only a person or an agent edits a trigger');
      const stored = db.select().from(triggers).where(eq(triggers.id, target)).get(), refused = stored && options.wordRefusal?.(ctx.viewer, 'edit', stored, change);
      if (refused) throw new OperationError('denied', refused);
      tempo.triggers.edit(target, change, { kind: ctx.viewer.kind, id: ctx.viewer.id }, stored ? options.reasked?.(ctx.viewer, stored, change) : undefined);
      ctx.changed('triggers', target); ctx.changed('triggerEdits', target); return { saved: true };
    },
  }));
  for (const action of ['pause', 'resume'] as const) operations.register(operation({ ...common,
    name: `tempo.${action}`, input: z.object({ agent: z.string().min(1) }).strict(), output: saved,
    may: (viewer, input) => options.authorize(viewer, { action, agent: input.agent }),
    run(ctx, input) {
      tempo.triggers[action](input.agent); ctx.changed('agentPauses', input.agent); ctx.changed('triggers', input.agent);
      return { saved: true };
    },
  }));
  operations.register(operation({ ...mailbox, name: 'inbox.volume',
    input: z.object({ item: z.string().min(1), volume: z.enum(inbox.volume.enumValues), until: z.string().optional() }).strict(), output: saved,
    may(viewer, input) {
      const item = db.select().from(inbox).where(eq(inbox.id, input.item)).get();
      return !!item && options.authorize(viewer, { action: 'volume', item });
    },
    run(ctx, input) {
      const item = db.select().from(inbox).where(eq(inbox.id, input.item)).get()!;
      tempo.volume.set({ kind: item.toKind, id: item.to }, item.id, input.volume, input.until);
      ctx.changed('inbox', item.id); return { saved: true };
    },
  }));
}
