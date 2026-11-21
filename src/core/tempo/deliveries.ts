import { and, eq, getTableColumns, inArray, sql } from 'drizzle-orm';
import { sqlVisibility } from '../../policy-sql.js';
import type { Viewer } from '../../policy.js';
import type { DataDatabase } from '../data/database.js';
import { conversations, inbox, inboxRefs, jobs, programFirings, triggerLog } from '../data/schema.js';

/** Locate the delivery for this occurrence. A trigger can be edited, reassigned or
 * fired many times, so neither its current target nor a nearby job proves delivery. */
export function wakeDeliveries(db: DataDatabase, viewer: Viewer, agent: string, events: number[], includePrograms: boolean) {
  if (events.length > 100) throw Error('At most 100 firings per page');
  if (!events.length) return [];
  const seen = sqlVisibility(viewer, ['triggerLog', 'inbox', 'conversations', 'jobs']);
  const fired = and(inArray(triggerLog.seq, events), eq(triggerLog.event, 'fired'), seen.triggerLog(getTableColumns(triggerLog)));
  const occurrence = sql<string>`${triggerLog.trigger} || ':' || ${triggerLog.note}`;
  const mail = db.select({ event: triggerLog.seq, kind: sql<string>`'mail'`, conversation: conversations.id, job: jobs.id })
    .from(triggerLog)
    .innerJoin(inbox, and(eq(inbox.toKind, 'agent'), eq(inbox.to, agent), eq(inbox.source, 'trigger'),
      eq(inbox.sourceId, occurrence), seen.inbox(getTableColumns(inbox))))
    .innerJoin(inboxRefs, and(eq(inboxRefs.item, inbox.id), eq(inboxRefs.ref, triggerLog.trigger)))
    .innerJoin(conversations, and(eq(conversations.id, inbox.conversation), seen.conversations(getTableColumns(conversations))))
    .leftJoin(jobs, and(eq(jobs.id, inbox.job), eq(jobs.agent, agent), eq(jobs.conversation, conversations.id), seen.jobs(getTableColumns(jobs))))
    .where(fired).all();
  if (!includePrograms) return mail;
  const programs = db.select({ event: triggerLog.seq, kind: sql<string>`'program'`, conversation: conversations.id, job: jobs.id })
    .from(triggerLog)
    .innerJoin(programFirings, and(eq(programFirings.id, occurrence), eq(programFirings.trigger, triggerLog.trigger)))
    .innerJoin(jobs, and(eq(jobs.id, programFirings.job), eq(jobs.agent, agent), seen.jobs(getTableColumns(jobs))))
    .leftJoin(conversations, and(eq(conversations.id, jobs.conversation), seen.conversations(getTableColumns(conversations))))
    .where(fired).all();
  return [...programs, ...mail];
}
