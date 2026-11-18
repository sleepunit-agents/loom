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
import { triggerEdit, triggerInput, type NewTrigger, type Trigger, type TriggerAsked, type TriggerEdit } from './triggers.js';

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
  requestMachine?(viewer: Viewer, trigger: Trigger, machine: string): string;
  recorded?(viewer: Viewer, trigger: NewTrigger): { trigger: NewTrigger; member?: string; asked?: Asker };
  /** Why this caller may not set, reword, stop, start or run this trigger because of whose word its job works on, in words for the
   * caller, or nothing (policy.ts, maySchedule). Asked after `authorize`: of what the caller sent for a new
   * trigger, before it is recorded, and of the stored row for one that exists. */
  wordRefusal?(viewer: Viewer, action: 'set' | 'edit' | 'stop' | 'start' | 'runNow', trigger: TriggerAsked, change?: { times?: string; file?: string | null; instructions?: string | null; note?: string }): string | undefined;
  /** Why this caller may not do this at all because of whose word its job works on, in words for the caller, or
   * nothing: pause or resume an agent, set the volume of mail, or set, change, start, run or stop any schedule.
   * Asked first in every door here, after `authorize`: who the caller is does not answer it. */
  heldRefusal?(viewer: Viewer, action: 'pause' | 'resume' | 'volume' | 'set' | 'edit' | 'stop' | 'start' | 'runNow'): string | undefined;
  /** When what this caller asks is an owner's to allow first (src/shared-place-triggers.ts, ownersFirst): the
   * composition has asked them, and nothing is set or changed here. `waits` is what the caller is told, and `card`
   * the approval that waits. Asked after `wordRefusal`. Nothing for anything the caller may do itself. */
  ownersFirst?(viewer: Viewer, ask: { action: 'set'; trigger: NewTrigger } | { action: 'edit'; trigger: Trigger; change: TriggerEdit }): { id: string; card: string; waits: string } | undefined;
  /** Told once a trigger has been set, turned back on or changed, in the same write: for the notice a conversation
   * with many standing raises, and for the record of a come-back that follows another. It refuses nothing. */
  stood?(viewer: Viewer, action: 'set' | 'start' | 'edit', trigger: { id: string; conversation?: string | null }): void;
  /** Who asks for a trigger that names a conversation, once this caller has changed its words, file or times. */
  reasked?(viewer: Viewer, trigger: Trigger, change: { instructions?: string | null; file?: string | null; note?: string; times?: string }): Asker | undefined;
  /** Outside authenticated context for delegated mailbox receipt isolation. */
  mailboxReceiptScope?(viewer:Viewer):string|undefined;
}
const id = z.object({ id: z.string().min(1) }).strict();
const saved = z.object({ saved: z.literal(true) }).strict();
const manualResult = z.union([saved, z.object({ saved: z.literal(false), failed: z.literal(true), reason: z.string() }).strict()]);
/** `waits`: nothing was set or changed, and why, in words for the caller (an owner is asked first). */
const waits = z.string().optional();

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
  operations.register(operation({ ...common, name: 'tempo.set', input: triggerInput.extend({ machine: z.string().min(1).max(200).optional() }), output: z.object({ id: z.string(), waits }),
    may: (viewer, {machine: _machine, ...trigger}) => options.authorize(viewer, { action: 'set', trigger }),
    run(ctx, {machine, ...trigger}) {
      const held = options.heldRefusal?.(ctx.viewer, 'set'); if (held) throw new OperationError('denied', held);
      const refused = options.wordRefusal?.(ctx.viewer, 'set', trigger); if (refused) throw new OperationError('denied', refused);
      if (machine && (!options.requestMachine || trigger.conversation || trigger.targetKind !== 'inbox' || trigger.toKind !== 'agent')) {
        throw new OperationError('invalid', 'Only an agent’s own inbox schedule can request machine work');
      }
      const first = options.ownersFirst?.(ctx.viewer, { action: 'set', trigger });
      if (machine && first) throw new OperationError('denied', 'A delegated schedule cannot request machine work');
      if (first) { ctx.changed('approvals', first.card); ctx.changed('inbox', first.card); return { id: first.id, waits: first.waits }; }
      const as = options.recorded?.(ctx.viewer, trigger) ?? { trigger, member: undefined, asked: undefined };
      const row = tempo.triggers.set(as.trigger, as.member, as.asked, machine ? stored => {
        const card = options.requestMachine!(ctx.viewer, stored, machine);
        ctx.changed('approvals', card);
        ctx.changed('inbox', card);
      } : undefined); options.stood?.(ctx.viewer, 'set', row); ctx.changed('triggers', row.id); return { id: row.id }; },
  }));
  for (const action of ['stop', 'start', 'runNow'] as const) operations.register(operation({ ...common,
    name: `tempo.${action}`, input: id, output: action === 'runNow' ? manualResult : saved,
    may: (viewer, input) => triggerAccess(viewer, input.id, action),
    run(ctx, input) {
      // On whose word the caller works matters for these as for setting: a body working for anybody but owners starts,
      // runs and stops nothing of its agent's that fires outside its own conversation (policy.ts, maySchedule).
      const held = options.heldRefusal?.(ctx.viewer, action); if (held) throw new OperationError('denied', held);
      const stored = db.select().from(triggers).where(eq(triggers.id, input.id)).get(), refused = stored && options.wordRefusal?.(ctx.viewer, action, stored);
      if (refused) throw new OperationError('denied', refused);
      const failure = tempo.triggers[action](input.id);
      if (action === 'start' && stored) options.stood?.(ctx.viewer, 'start', stored);
      ctx.changed('triggers', input.id);
      if (typeof failure === 'string') return { saved: false, failed: true, reason: failure };
      return { saved: true };
    },
  }));
  operations.register(operation({ ...common, name: 'tempo.edit', input: triggerEdit.extend({ id: z.string().min(1) }).strict(), output: z.object({ saved: z.boolean(), waits }).strict(),
    may: (viewer, input) => (viewer.kind === 'member' || viewer.kind === 'agent') && triggerAccess(viewer, input.id, 'edit'),
    run(ctx, { id: target, ...change }) {
      if (ctx.viewer.kind !== 'member' && ctx.viewer.kind !== 'agent') throw new Error('Only a person or an agent edits a trigger');
      const held = options.heldRefusal?.(ctx.viewer, 'edit'); if (held) throw new OperationError('denied', held);
      const stored = db.select().from(triggers).where(eq(triggers.id, target)).get(), refused = stored && options.wordRefusal?.(ctx.viewer, 'edit', stored, change);
      if (refused) throw new OperationError('denied', refused);
      const first = stored && options.ownersFirst?.(ctx.viewer, { action: 'edit', trigger: stored, change });
      if (first) { ctx.changed('approvals', first.card); ctx.changed('inbox', first.card); return { saved: false, waits: first.waits }; }
      tempo.triggers.edit(target, change, { kind: ctx.viewer.kind, id: ctx.viewer.id }, stored ? options.reasked?.(ctx.viewer, stored, change) : undefined);
      if (stored) options.stood?.(ctx.viewer, 'edit', stored);
      ctx.changed('triggers', target); ctx.changed('triggerEdits', target); return { saved: true };
    },
  }));
  for (const action of ['pause', 'resume'] as const) operations.register(operation({ ...common,
    name: `tempo.${action}`, input: z.object({ agent: z.string().min(1) }).strict(), output: saved,
    may: (viewer, input) => options.authorize(viewer, { action, agent: input.agent }),
    run(ctx, input) {
      // A pause holds every trigger of the agent, wherever it fires: on whose word the caller works is asked, as for a trigger.
      const refused = options.heldRefusal?.(ctx.viewer, action); if (refused) throw new OperationError('denied', refused);
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
      // Muted mail starts no job and joins none (runtime/jobs.ts): the same question.
      const refused = options.heldRefusal?.(ctx.viewer, 'volume'); if (refused) throw new OperationError('denied', refused);
      const item = db.select().from(inbox).where(eq(inbox.id, input.item)).get()!;
      tempo.volume.set({ kind: item.toKind, id: item.to }, item.id, input.volume, input.until);
      ctx.changed('inbox', item.id); return { saved: true };
    },
  }));
}
