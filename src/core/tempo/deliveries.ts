import { and, desc, eq, getTableColumns, inArray, sql } from 'drizzle-orm';
import { sqlVisibility } from '../../policy-sql.js';
import type { Viewer } from '../../policy.js';
import type { DataDatabase } from '../data/database.js';
import { conversations, inbox, inboxRefs, jobs, jobUsage, programFirings, triggerLog } from '../data/schema.js';

/** Locate the delivery for this occurrence. A trigger can be edited, reassigned or
 * fired many times, so neither its current target nor a nearby job proves delivery. */
export function wakeDeliveries(db: DataDatabase, viewer: Viewer, agent: string | null, events: number[], includePrograms: boolean) {
  if (events.length > 100) throw Error('At most 100 firings per page');
  if (!events.length) return [];
  const seen = sqlVisibility(viewer, ['triggerLog', 'inbox', 'conversations', 'jobs']);
  const fired = and(inArray(triggerLog.seq, events), eq(triggerLog.event, 'fired'), seen.triggerLog(getTableColumns(triggerLog)));
  const occurrence = sql<string>`${triggerLog.trigger} || ':' || ${triggerLog.note}`;
  const mail = db.select({ event: triggerLog.seq, kind: sql<string>`'mail'`, conversation: conversations.id, job: jobs.id })
    .from(triggerLog)
    .innerJoin(inbox, and(eq(inbox.toKind, 'agent'), agent === null ? undefined : eq(inbox.to, agent), eq(inbox.source, 'trigger'),
      eq(inbox.sourceId, occurrence), seen.inbox(getTableColumns(inbox))))
    .innerJoin(inboxRefs, and(eq(inboxRefs.item, inbox.id), eq(inboxRefs.ref, triggerLog.trigger)))
    .innerJoin(conversations, and(eq(conversations.id, inbox.conversation), seen.conversations(getTableColumns(conversations))))
    .leftJoin(jobs, and(eq(jobs.id, inbox.job), eq(jobs.agent, inbox.to), eq(jobs.conversation, conversations.id), seen.jobs(getTableColumns(jobs))))
    .where(fired).all();
  if (!includePrograms) return mail;
  const programs = db.select({ event: triggerLog.seq, kind: sql<string>`'program'`, conversation: conversations.id, job: jobs.id })
    .from(triggerLog)
    .innerJoin(programFirings, and(eq(programFirings.id, occurrence), eq(programFirings.trigger, triggerLog.trigger)))
    .innerJoin(jobs, and(eq(jobs.id, programFirings.job), agent === null ? undefined : eq(jobs.agent, agent), seen.jobs(getTableColumns(jobs))))
    .leftJoin(conversations, and(eq(conversations.id, jobs.conversation), seen.conversations(getTableColumns(conversations))))
    .where(fired).all();
  return [...programs, ...mail];
}

/** Enrich the most recent actual firings, including those before a reassignment.
 * Access to each delivery, conversation, job and measurement is decided independently. */
export function recentTriggerRuns(db: DataDatabase, viewer: Viewer, id: string, includePrograms: boolean, includeUsage: boolean) {
  const seen = sqlVisibility(viewer, ['triggerLog','jobs','conversations']);
  const fired = db.select({event:triggerLog.seq, at:triggerLog.at}).from(triggerLog)
    .where(and(eq(triggerLog.trigger,id), eq(triggerLog.event,'fired'), seen.triggerLog(getTableColumns(triggerLog))))
    .orderBy(desc(triggerLog.seq)).limit(12).all();
  const deliveries = wakeDeliveries(db, viewer, null, fired.map(row=>row.event), includePrograms);
  const jobIds = [...new Set(deliveries.flatMap(row=>row.job ? [row.job] : []))];
  const conversationIds = [...new Set(deliveries.flatMap(row=>row.conversation ? [row.conversation] : []))];
  const work = jobIds.length ? db.select({id:jobs.id,state:jobs.state,startedAt:jobs.claimedAt,endedAt:jobs.endedAt})
    .from(jobs).where(and(inArray(jobs.id,jobIds),seen.jobs(getTableColumns(jobs)))).all() : [];
  const usage = includeUsage && work.length ? db.select({job:jobUsage.job,tokensOut:jobUsage.tokensOut,largestContext:jobUsage.largestContext,wallMs:jobUsage.wallMs})
    .from(jobUsage).where(inArray(jobUsage.job,work.map(row=>row.id))).all() : [];
  const talks = conversationIds.length ? db.select({id:conversations.id,venue:conversations.venue,place:conversations.place})
    .from(conversations).where(and(inArray(conversations.id,conversationIds),seen.conversations(getTableColumns(conversations)))).all() : [];
  return fired.flatMap(({event,at})=>deliveries.filter(row=>row.event===event).map(row=>({
    event, at, kind:row.kind,
    job:work.find(job=>job.id===row.job) ?? null,
    usage:usage.find(report=>report.job===row.job) ?? null,
    conversation:talks.find(talk=>talk.id===row.conversation) ?? null,
  })));
}
