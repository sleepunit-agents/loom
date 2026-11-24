import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import { bodyOperationDefaults, type conversationBodyScope } from './core/conversations/body-scope.js';
import type { DataDatabase } from './core/data/database.js';
import { jobs, inbox, inboxRefs, triggerAcceptances, triggerLog, triggers } from './core/data/schema.js';
import { operation, OperationError, type Operations } from './core/operations/index.js';
import { TRIGGER_JOURNAL_BYTES, appendLesson, hasAgentJournal, readJournal, replaceJournalState } from './core/tempo/journal.js';
import type { Viewer } from './policy.js';
import { jobWord } from './shared-place-mail.js';

import { omittedWakeTools, type WakeToolProfiles } from './runtime/wake-tool-profiles.js';

type Scope = NonNullable<ReturnType<ReturnType<typeof conversationBodyScope>>>;

function ownTrigger(db: DataDatabase, viewer: Viewer, scope?: Scope) {
  if (!scope || viewer.kind !== 'agent' || viewer.workingFor || scope.cv.venue !== 'wake' || scope.cv.member) return;
  const { job, cv } = scope;
  if (viewer.id !== job.agent || jobWord(db, job).woke !== 'own') return;
  const trigger = db.select().from(triggers).where(eq(triggers.id, cv.place)).get();
  if (trigger && hasAgentJournal(trigger) && trigger.to === job.agent && trigger.project === cv.project) return trigger;
}

export function registerTriggerJournal(operations: Operations, db: DataDatabase,
  current: ReturnType<typeof conversationBodyScope>, hash: (text: string) => string, profiles: WakeToolProfiles) {
  function acceptedMail(scope: Scope, trigger: string) {
    const {job, cv} = scope;
    return and(eq(inbox.job, job.id), eq(triggerAcceptances.job, job.id), inArray(inbox.state, ['taken', 'done']),
      eq(inbox.conversation, cv.id), eq(inboxRefs.ref, trigger), eq(inbox.toKind, 'agent'), eq(inbox.to, job.agent),
      eq(inbox.fromKind, 'schedule'), eq(inbox.fromId, job.agent), eq(inbox.source, 'trigger'), isNull(inbox.member), isNull(inbox.onWordKind));
  }
  function mine(viewer: Viewer, deliveries?: string[]) {
    const scope = current(viewer), trigger = ownTrigger(db, viewer, scope);
    if (!scope || !trigger) return;
    const id = trigger.id;
    const { job, cv } = scope;
    const delivered = db.select({ item: inbox.id, sourceId:inbox.sourceId }).from(inbox).innerJoin(inboxRefs, eq(inboxRefs.item, inbox.id))
      .innerJoin(triggerAcceptances, eq(triggerAcceptances.item, inbox.id)).where(and(
        deliveries ? and(inArray(inbox.id, deliveries), eq(inbox.takenVolume, 'full')) : undefined,
        acceptedMail(scope, id),
      )).limit(1).get();
    if (delivered) return { id, job:job.id, cv, sourceKind:trigger.sourceKind, sourceId:delivered.sourceId };
  }
  function required(viewer: Viewer, items?:string[]) {
    const delivery = mine(viewer,items);
    if (!delivery) throw new OperationError('denied', 'This job has no accepted trigger journal');
    return delivery;
  }
  const defaults = { ...bodyOperationDefaults(current, hash, 'trigger-journal'), may: (viewer: Viewer) => !!mine(viewer), refuses: true };
  // Acknowledged mail in the current model turn, checked again after the body reported receipt.
  // Ineligible wakes have no lessons to attach and continue normally.
  operations.register(operation({ ...defaults, write: false, name: 'tempo.wakeLessons', may: viewer => !!current(viewer),
    input: z.object({ items: z.array(z.string().min(1)).min(1).max(100) }).strict(), output: z.string().nullable(),
    run(ctx, { items }) { const delivery = mine(ctx.viewer, items); return delivery ? readJournal(db, delivery.id).lessons : null; },
  }));
  operations.register(operation({ ...defaults, write: false, name: 'tempo.wakeToolProfile', may: viewer => !!current(viewer),
    input: z.object({items: z.array(z.string().min(1)).min(1).max(100)}).strict(), output: omittedWakeTools,
    run(ctx, {items}) {
      if (!profiles.length || new Set(items).size !== items.length) return [];
      const scope = current(ctx.viewer), trigger = ownTrigger(db, ctx.viewer, scope);
      if (!scope || trigger?.sourceKind !== 'time') return [];
      const profile = profiles.find(row => row.agent === scope.job.agent && row.trigger === trigger.id);
      if (!profile) return [];
      const receipts = db.selectDistinct({id: inbox.id}).from(inbox)
        .innerJoin(triggerAcceptances, eq(triggerAcceptances.item, inbox.id))
        .innerJoin(inboxRefs, eq(inboxRefs.item, inbox.id))
        .innerJoin(triggerLog, and(eq(triggerLog.trigger, trigger.id), eq(triggerLog.event, 'fired'),
          eq(inbox.sourceId, sql`${triggerLog.trigger} || ':' || ${triggerLog.note}`)))
        .where(and(inArray(inbox.id, items), eq(inbox.takenVolume, 'full'), acceptedMail(scope, trigger.id))).all();
      return receipts.length === items.length ? profile.omitClaudeTools : [];
    },
  }));
  operations.register(operation({ ...defaults, write: false, name: 'tempo.readJournal', input: z.object({ item:z.string().min(1).optional(), priorJob:z.string().min(1).optional() }).strict(),
    output: z.object({trigger:z.string(), lessons:z.string(), state:z.string(), stateRevision:z.number(), stateChangedAt:z.string().nullable(),
      priorJobState:z.enum(jobs.state.enumValues).nullable().optional(), firing:z.object({job:z.string(),item:z.string(),scheduledAt:z.string().datetime().nullable()}).optional()}),
    run(ctx, {item,priorJob}) {
      const delivery = required(ctx.viewer,item ? [item] : undefined);
      const prior = priorJob ? db.select({state:jobs.state}).from(jobs).where(and(eq(jobs.id,priorJob),
        eq(jobs.conversation,delivery.cv.id),eq(jobs.agent,delivery.cv.agent),isNull(jobs.member),
        delivery.cv.project ? eq(jobs.project,delivery.cv.project) : isNull(jobs.project))).get() : undefined;
      const journal = {...readJournal(db, delivery.id), ...(priorJob ? {priorJobState:prior?.state ?? null} : {})};
      if (!item) return journal;
      const prefix = delivery.id + ':time:';
      const at = delivery.sourceId?.startsWith(prefix) ? delivery.sourceId.slice(prefix.length) : undefined;
      const scheduled = z.string().datetime().safeParse(at);
      return {...journal, firing:{job:delivery.job,item,scheduledAt:delivery.sourceKind === 'time' && scheduled.success ? scheduled.data : null}};
    },
  }));
  operations.register(operation({ ...defaults, name: 'tempo.appendLesson', input: z.object({ lesson: z.string().min(1).max(TRIGGER_JOURNAL_BYTES) }).strict(),
    output: z.object({ saved: z.literal(true) }), run(ctx, { lesson }) {
      const {id} = required(ctx.viewer);
      appendLesson(db, id, lesson);
      ctx.changed('triggers', id);
      return { saved: true };
    },
  }));
  operations.register(operation({ ...defaults, name: 'tempo.replaceJournalState', input: z.object({ revision: z.number().int().nonnegative(), state: z.string().max(TRIGGER_JOURNAL_BYTES) }).strict(),
    output: z.object({ revision: z.number() }), run(ctx, input) {
      const {id} = required(ctx.viewer);
      const revision = replaceJournalState(db, id, input.revision, input.state, new Date(ctx.now).toISOString());
      if (revision !== input.revision) ctx.changed('triggers', id);
      return { revision };
    },
  }));
}
