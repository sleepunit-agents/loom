import { and, eq, inArray, isNull } from 'drizzle-orm';
import { z } from 'zod';
import { bodyOperationDefaults, type conversationBodyScope } from './core/conversations/body-scope.js';
import type { DataDatabase } from './core/data/database.js';
import { inbox, inboxRefs, triggerAcceptances, triggers } from './core/data/schema.js';
import { operation, OperationError, type Operations } from './core/operations/index.js';
import { appendLesson, hasAgentJournal, readJournal, replaceJournalState } from './core/tempo/journal.js';
import type { Viewer } from './policy.js';
import { jobWord } from './shared-place-mail.js';

type Scope = NonNullable<ReturnType<ReturnType<typeof conversationBodyScope>>>;

function ownTrigger(db: DataDatabase, viewer: Viewer, scope?: Scope) {
  if (!scope || viewer.kind !== 'agent' || viewer.workingFor || scope.cv.venue !== 'wake' || scope.cv.member) return;
  const { job, cv } = scope;
  if (viewer.id !== job.agent || jobWord(db, job).woke !== 'own') return;
  const trigger = db.select().from(triggers).where(eq(triggers.id, cv.place)).get();
  if (trigger && hasAgentJournal(trigger) && trigger.to === job.agent && trigger.project === cv.project) return trigger.id;
}

/** The guarded body-input projection calls this only for the authenticated recipient's taken item. */
export function wakeLessons(db: DataDatabase, viewer: Viewer, scope: Scope, item: typeof inbox.$inferSelect, refs: string[]) {
  if (item.source !== 'trigger' || item.fromKind !== 'schedule' || item.fromId !== scope.job.agent || item.onWordKind
      || item.volume !== 'full' || item.job !== scope.job.id || item.conversation !== scope.cv.id) return;
  const id = ownTrigger(db, viewer, scope);
  if (id && refs.includes(id)) return readJournal(db, id).lessons;
}

export function registerTriggerJournal(operations: Operations, db: DataDatabase,
  current: ReturnType<typeof conversationBodyScope>, hash: (text: string) => string) {
  function mine(viewer: Viewer) {
    const scope = current(viewer), id = ownTrigger(db, viewer, scope);
    if (!scope || !id) return;
    const { job, cv } = scope;
    const delivered = db.select({ item: inbox.id }).from(inbox).innerJoin(inboxRefs, eq(inboxRefs.item, inbox.id))
      .innerJoin(triggerAcceptances, eq(triggerAcceptances.item, inbox.id)).where(and(
        eq(inbox.job, job.id), eq(triggerAcceptances.job, job.id), inArray(inbox.state, ['taken', 'done']),
        eq(inbox.conversation, cv.id), eq(inboxRefs.ref, id), eq(inbox.toKind, 'agent'), eq(inbox.to, job.agent),
        eq(inbox.fromKind, 'schedule'), eq(inbox.fromId, job.agent), eq(inbox.source, 'trigger'), isNull(inbox.member), isNull(inbox.onWordKind),
      )).limit(1).get();
    if (delivered) return id;
  }
  function required(viewer: Viewer) {
    const id = mine(viewer);
    if (!id) throw new OperationError('denied', 'This job has no accepted trigger journal');
    return id;
  }
  const defaults = { ...bodyOperationDefaults(current, hash, 'trigger-journal'), may: (viewer: Viewer) => !!mine(viewer), refuses: true };
  operations.register(operation({ ...defaults, write: false, name: 'tempo.readJournal', input: z.object({}).strict(),
    output: z.object({trigger:z.string(), lessons:z.string(), state:z.string(), stateRevision:z.number(), stateChangedAt:z.string().nullable()}),
    run: ctx => readJournal(db, required(ctx.viewer)),
  }));
  operations.register(operation({ ...defaults, name: 'tempo.appendLesson', input: z.object({ lesson: z.string().min(1).max(16384) }).strict(),
    output: z.object({ saved: z.literal(true) }), run(ctx, { lesson }) {
      const id = required(ctx.viewer);
      appendLesson(db, id, lesson);
      ctx.changed('triggers', id);
      return { saved: true };
    },
  }));
  operations.register(operation({ ...defaults, name: 'tempo.replaceJournalState', input: z.object({ revision: z.number().int().nonnegative(), state: z.string().max(16384) }).strict(),
    output: z.object({ revision: z.number() }), run(ctx, input) {
      const id = required(ctx.viewer);
      const revision = replaceJournalState(db, id, input.revision, input.state, new Date(ctx.now).toISOString());
      if (revision !== input.revision) ctx.changed('triggers', id);
      return { revision };
    },
  }));
}
