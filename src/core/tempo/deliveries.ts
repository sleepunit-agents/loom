import { and, desc, eq, getTableColumns, gte, inArray, isNotNull, lt, or, sql, type SQL } from 'drizzle-orm';
import { DAY_MS } from '../day.js';
import { sqlVisibility } from '../../policy-sql.js';
import type { Viewer } from '../../policy.js';
import type { DataDatabase } from '../data/database.js';
import { conversations, inbox, inboxRefs, jobs, jobUsage, programFirings, triggerLog } from '../data/schema.js';

/** Locate the delivery for this occurrence. A trigger can be edited, reassigned or
 * fired many times, so neither its current target nor a nearby job proves delivery. */
export function wakeDeliveries(db: DataDatabase, viewer: Viewer, agent: string | null, events: number[], includePrograms: boolean) {
  if (events.length > 100) throw Error('At most 100 firings per page');
  if (!events.length) return [];
  return deliveryRows(db,viewer,agent,inArray(triggerLog.seq,events),includePrograms)
    .map(({event,kind,conversation,job})=>({event,kind,conversation,job}));
}

function deliveryRows(db:DataDatabase,viewer:Viewer,agent:string|null,selection:SQL,includePrograms:boolean,includeNotices=false) {
  const seen = sqlVisibility(viewer, ['triggerLog', 'inbox', 'conversations', 'jobs']);
  const fired = db.select({event:triggerLog.seq, trigger:triggerLog.trigger, note:triggerLog.note}).from(triggerLog)
    .where(and(selection,eq(triggerLog.event,'fired'),seen.triggerLog(getTableColumns(triggerLog)))).all();
  if (!fired.length) return [];
  // Use one SQLite membership lookup per delivery table. Joining a computed key
  // directly to the log scans all the mail again for each firing of a busy lane.
  const keys = [...new Set(fired.map(row=>row.trigger+':'+row.note))];
  const occurrences = sql`(select value from json_each(${JSON.stringify(keys)}))`;
  const outcome = {state:jobs.state, endedNote:jobs.endedNote, exitCode:jobs.exitCode};
  const mail = db.select({occurrence:inbox.sourceId, trigger:inboxRefs.ref,
    kind:sql<string>`case when ${inbox.toKind}='person' then 'notice' else 'mail' end`,
    conversation:conversations.id,job:jobs.id,...outcome}).from(inbox)
    .innerJoin(inboxRefs,eq(inboxRefs.item,inbox.id))
    .leftJoin(conversations,and(eq(conversations.id,inbox.conversation),seen.conversations(getTableColumns(conversations))))
    .leftJoin(jobs,and(eq(inbox.toKind,'agent'),eq(jobs.id,inbox.job),eq(jobs.agent,inbox.to),
      eq(jobs.conversation,conversations.id),seen.jobs(getTableColumns(jobs))))
    .where(and(eq(inbox.source,'trigger'),sql`${inbox.sourceId} in ${occurrences}`,seen.inbox(getTableColumns(inbox)),
      agent===null ? undefined : eq(inbox.to,agent),
      or(and(eq(inbox.toKind,'agent'),isNotNull(conversations.id)),includeNotices ? eq(inbox.toKind,'person') : undefined))).all();
  const programs = includePrograms ? db.select({occurrence:programFirings.id,trigger:programFirings.trigger,kind:sql<string>`'program'`,
    conversation:conversations.id,job:jobs.id,...outcome}).from(programFirings)
    .innerJoin(jobs,and(eq(jobs.id,programFirings.job),agent===null ? undefined : eq(jobs.agent,agent),seen.jobs(getTableColumns(jobs))))
    .leftJoin(conversations,and(eq(conversations.id,jobs.conversation),seen.conversations(getTableColumns(conversations))))
    .where(sql`${programFirings.id} in ${occurrences}`).all() : [];
  const byOccurrence = new Map<string,typeof mail>();
  for (const row of [...programs,...mail]) {
    if(row.occurrence===null)continue;
    const group=byOccurrence.get(row.occurrence);
    if(group)group.push(row);else byOccurrence.set(row.occurrence,[row]);
  }
  return fired.flatMap(({event,trigger,note})=>(byOccurrence.get(trigger+':'+note)??[])
    .filter(row=>row.trigger===trigger).map(row=>({...row,event})));
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

/** Calendar navigation requests one civil day or week, padded for household time zones. */
export function calendarOutcomes(db:DataDatabase,viewer:Viewer,from:string,until:string,includePrograms:boolean) {
  const start=Date.parse(from), end=Date.parse(until);
  if(!Number.isFinite(start)||!Number.isFinite(end)||end<=start||end-start>9*DAY_MS
    ||new Date(start).toISOString()!==from||new Date(end).toISOString()!==until) throw Error('Expected a range of at most nine days');
  const window=and(gte(triggerLog.at,new Date(start).toISOString()),lt(triggerLog.at,new Date(end).toISOString()))!;
  return deliveryRows(db,viewer,null,window,includePrograms,true).map(({event,kind,state,endedNote,exitCode})=>({
    event,kind,state,reason:state==='failed'||state==='lost' ? endedNote || (exitCode==null ? null : 'Exit code '+exitCode) : null,
  }));
}
