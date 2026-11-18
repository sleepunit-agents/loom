import { randomUUID } from 'node:crypto';
import { and, eq, inArray, lte } from 'drizzle-orm';
import type { TerminalEvent } from '../../shared-terminal-input.js';
import type { DataDatabase } from '../data/database.js';
import { jobs, jobUsage, terminalRuns, terminalSessions } from '../data/schema.js';
import { CommsMessages } from './messages.js';
import type { WordsKey } from './words.js';

export type TerminalScope = { agent: string; member: string; machine: string };
type Session = typeof terminalSessions.$inferSelect;
type Job = typeof jobs.$inferSelect;
export const terminalSilenceMs = 15 * 60_000;

function finish(db: DataDatabase, parent: string, state: 'done' | 'lost', at: string) {
  const group = db.select({ job: terminalRuns.job }).from(terminalRuns).where(eq(terminalRuns.parent,parent));
  const ended = db.update(jobs).set({state,endedAt:at}).where(and(inArray(jobs.id,group),eq(jobs.state,'running'))).returning().all();
  for (const job of ended) {
    const wallMs = job.claimedAt ? Math.max(0, Date.parse(at) - Date.parse(job.claimedAt)) : null;
    db.insert(jobUsage).values({job:job.id,source:'none',harness:job.harness,model:job.model || null,wallMs}).onConflictDoNothing().run();
  }
}

/** End external jobs at the end of their lease, even if maintenance runs later. */
export function expireTerminalSessions(db: DataDatabase, now: string): number {
  return db.transaction(() => {
    const cutoff = new Date(Date.parse(now)-terminalSilenceMs).toISOString();
    const stale = db.select({id:jobs.id,heardAt:jobs.heardAt}).from(terminalSessions)
      .innerJoin(jobs,eq(jobs.id,terminalSessions.job)).where(and(eq(jobs.state,'running'),lte(jobs.heardAt,cutoff))).all();
    for (const row of stale) finish(db,row.id,'lost',new Date(Date.parse(row.heardAt!)+terminalSilenceMs).toISOString());
    return stale.length;
  });
}

export class TerminalSessions {
  private readonly messages: CommsMessages;
  constructor(private readonly db: DataDatabase, private readonly key: WordsKey, private readonly now = () => new Date().toISOString()) {
    this.messages = new CommsMessages(db,key,now);
  }

  /** Only sealing runs asynchronously. The caller rechecks the grant before the returned commit. */
  async prepare(scope: TerminalScope, event: TerminalEvent) {
    if (scope.machine !== event.machine) throw new Error('Terminal machine differs from its credential');
    const words = event.action === 'turn' ? await this.key.seal(event.words) : null;
    return () => this.db.transaction(() => {
      const at = this.now();
      let session = this.db.select().from(terminalSessions).where(and(eq(terminalSessions.machine,scope.machine),
        eq(terminalSessions.agent,scope.agent),eq(terminalSessions.member,scope.member),eq(terminalSessions.harness,event.harness),
        eq(terminalSessions.sessionId,event.sessionId))).get();
      if (!session) {
        if (event.action !== 'open') throw new Error('Terminal session has not opened');
        session = this.open(scope,event,at);
      }
      if (!session.thread) throw new Error('Terminal thread was deleted');
      const thread = this.messages.threads.thread(session.thread);
      const parent = this.db.select().from(jobs).where(eq(jobs.id,session.job)).get()!;
      const result = {conversation:thread.conversation,thread:thread.id,job:parent.id};
      if (parent.state !== 'running') {
        if (event.action === 'end') {
          if (parent.state === 'lost') this.db.update(jobs).set({state:'done'}).where(eq(jobs.id,parent.id)).run();
          return result;
        }
        if (event.action !== 'open' && parent.state !== 'lost') throw new Error('Terminal session has ended');
        this.db.update(jobs).set({state:'running',endedAt:null,heardAt:at}).where(eq(jobs.id,parent.id)).run();
      }
      if (event.action === 'end') finish(this.db,parent.id,'done',at);
      else {
        if (event.action === 'turn') this.messages.recordObserved(thread.id,event.role,event.eventId,words!,parent.id);
        if (event.action === 'usage') this.usage(parent,event,at);
        this.db.update(jobs).set({heardAt:at}).where(eq(jobs.id,parent.id)).run();
      }
      return result;
    });
  }

  private open(scope: TerminalScope, event: Extract<TerminalEvent,{action:'open'}>, at: string): Session {
    const title = [...(scope.machine + ' · ' + event.harness)].slice(0,60).join('');
    const thread = this.messages.threads.open({agent:scope.agent,member:scope.member,venue:'terminal',title});
    const job = this.db.insert(jobs).values({agent:scope.agent,member:scope.member,box:scope.machine,
      id:'job-'+randomUUID(),conversation:thread.conversation,title,state:'running',brief:'',model:event.model ?? '',
      harness:event.harness,startedByKind:'terminal',startedBy:scope.member,houseRepository:'',houseFile:'',houseBranch:'',
      queuedAt:at,claimedAt:at,heardAt:at}).returning().get();
    const row = this.db.insert(terminalSessions).values({...scope,job:job.id,thread:thread.id,
      sessionId:event.sessionId,cwd:event.cwd,harness:event.harness}).returning().get();
    this.db.insert(terminalRuns).values({job:job.id,parent:job.id,runId:'main',revision:-1}).run();
    return row;
  }

  private usage(parent: Job, event: Extract<TerminalEvent,{action:'usage'}>, at: string) {
    const run = this.db.select().from(terminalRuns).where(and(eq(terminalRuns.parent,parent.id),eq(terminalRuns.runId,event.runId))).get();
    if (run && event.revision <= run.revision) return;
    const id = run?.job ?? 'job-'+randomUUID();
    const report = event.report;
    if (!run) {
      this.db.insert(jobs).values({id,member:parent.member,agent:parent.agent,box:parent.box,
        title:event.description || 'Terminal subagent',brief:'',state:'running',model:report.model ?? parent.model,harness:parent.harness,
        startedByKind:'terminal',startedBy:parent.startedBy,houseRepository:'',houseFile:'',houseBranch:'',
        queuedAt:at,claimedAt:at,heardAt:at}).run();
      this.db.insert(terminalRuns).values({job:id,parent:parent.id,runId:event.runId,revision:event.revision}).run();
    } else this.db.update(terminalRuns).set({revision:event.revision}).where(eq(terminalRuns.job,id)).run();
    const values = {source:report.source,tokensIn:report.tokensIn ?? null,tokensOut:report.tokensOut ?? null,
      cacheRead:report.cacheRead ?? null,cacheWritten:report.cacheWritten ?? null,modelCalls:report.modelCalls ?? null,
      toolCalls:report.toolCalls ?? null,tools:report.tools ?? null,largestContext:report.largestContext ?? null,
      wallMs:report.wallMs ?? null,harness:parent.harness,model:report.model ?? (parent.model || null)};
    this.db.insert(jobUsage).values({job:id,...values}).onConflictDoUpdate({target:jobUsage.job,set:values}).run();
    this.db.update(jobs).set({state:'running',endedAt:null,heardAt:at,...(id !== parent.id && event.description ? {title:event.description} : {}),...(report.model ? {model:report.model} : {})}).where(eq(jobs.id,id)).run();
  }
}
