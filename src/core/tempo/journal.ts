import { and, eq } from 'drizzle-orm';
import type { DataDatabase } from '../data/database.js';
import { triggerJournals } from '../data/schema.js';

import type { Trigger } from './triggers.js';

/** An agent's own recurring wake has a private conversation dedicated to this trigger. */
export function hasAgentJournal(trigger: Trigger) {
  return trigger.lifespan === 'until-stopped' && trigger.targetKind === 'inbox' && trigger.toKind === 'agent'
    && trigger.ownerKind === 'agent' && trigger.owner === trigger.to && !!trigger.to
    && !trigger.member && !trigger.conversation && !trigger.program;
}

const journalBytes = 16_384;
function bounded(text: string) {
  if (Buffer.byteLength(text) > journalBytes) throw new Error('Trigger journal text exceeds 16384 bytes');
  return text;
}

/** Internal store. Callers resolve the authorized trigger before accessing its journal. */
export function readJournal(db: DataDatabase, trigger: string) {
  return db.select().from(triggerJournals).where(eq(triggerJournals.trigger, trigger)).get()
    ?? { trigger, lessons: '', state: '', stateRevision: 0, stateChangedAt: null };
}

export function appendLesson(db: DataDatabase, trigger: string, text: string) {
  if (!text.trim()) throw new Error('A lesson needs text');
  db.transaction(() => {
    const prior = readJournal(db, trigger).lessons;
    const lessons = bounded(prior ? prior + '\n' + text : text);
    db.insert(triggerJournals).values({ trigger, lessons }).onConflictDoUpdate({
      target: triggerJournals.trigger, set: { lessons },
    }).run();
  }, { behavior: 'immediate' });
}

export function replaceJournalState(db: DataDatabase, trigger: string, revision: number, state: string, at: string) {
  bounded(state);
  return db.transaction(() => {
    db.insert(triggerJournals).values({ trigger }).onConflictDoNothing().run();
    const current = readJournal(db, trigger);
    if (current.stateRevision !== revision) throw new Error('Trigger state changed since it was read');
    if (current.state === state) return revision;
    db.update(triggerJournals).set({ state, stateRevision: revision + 1, stateChangedAt: at })
      .where(and(eq(triggerJournals.trigger, trigger), eq(triggerJournals.stateRevision, revision))).run();
    return revision + 1;
  }, { behavior: 'immediate' });
}
