import { randomUUID } from 'node:crypto';
import { and, eq, inArray, lte } from 'drizzle-orm';
import type { TerminalEvent } from '../../shared-terminal-input.js';
import type { DataDatabase } from '../data/database.js';
import { boxes, deletedThreads, jobs, jobUsage, terminalRuns, terminalSessions } from '../data/schema.js';
import { OperationError } from '../operations/index.js';
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
    db.insert(jobUsage).values({job:job.id,source:'none',harness:job.harness,model:job.model || null}).onConflictDoNothing().run();
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
    if (scope.machine !== event.machine) throw new OperationError('denied','Terminal machine differs from its credential');
    const words = event.action === 'turn' ? await this.key.seal(event.words) : null;
    return () => this.db.transaction(() => {
      const at = this.now();
      let session = this.db.select().from(terminalSessions).where(and(eq(terminalSessions.machine,scope.machine),
        eq(terminalSessions.agent,scope.agent),eq(terminalSessions.member,scope.member),eq(terminalSessions.harness,event.harness),
        eq(terminalSessions.sessionId,event.sessionId))).get();
      if (!session) {
        if (event.action !== 'open') throw new OperationError('conflict','Terminal session has not opened');
        session = this.open(scope,event,at);
      }
      const parent = this.db.select().from(jobs).where(eq(jobs.id,session.job)).get();
      if (!parent?.conversation || parent.startedByKind !== 'terminal' || parent.box !== scope.machine ||
          parent.member !== scope.member || parent.agent !== scope.agent || parent.harness !== event.harness)
        throw new Error('Terminal records disagree');
      const cv = this.messages.threads.conversations.conversation(parent.conversation);
      if (cv.venue !== 'terminal' || cv.member !== scope.member || cv.agent !== scope.agent)
        throw new Error('Terminal records disagree');
      // Comms deletion erases words immediately. The tombstone still identifies the session
      // whose accounting and process lifecycle can finish without recreating a private thread.
      const thread = session.thread ? this.messages.threads.thread(session.thread)
        : this.db.select().from(deletedThreads).where(eq(deletedThreads.id,cv.place)).get();
      if (!thread || thread.id !== cv.place || thread.conversation !== cv.id) throw new Error('Terminal records disagree');
      const result = {conversation:cv.id,thread:thread.id,job:parent.id};
      if (!session.thread && event.action !== 'usage' && event.action !== 'end')
        throw new OperationError('conflict','Terminal thread was deleted');
      const instance = event.instanceId ?? null;
      if (event.action === 'open' && instance !== session.instanceId) {
        this.db.update(terminalSessions).set({instanceId:instance}).where(eq(terminalSessions.job,parent.id)).run();
      } else if (event.action !== 'usage' && instance !== session.instanceId) {
        return result;
      }
      if (event.action === 'usage') {
        // A reporter may finish reading a large transcript after the harness has exited.
        this.usage(parent,event,at);
        return result;
      }
      if (event.action === 'end') {
        if (parent.state === 'running') finish(this.db,parent.id,'done',at);
        else if (parent.state === 'lost') this.db.update(jobs).set({state:'done'}).where(eq(jobs.id,parent.id)).run();
        return result;
      }
      if (parent.state !== 'running' && parent.state !== 'lost' && event.action !== 'open')
        throw new OperationError('conflict','Terminal session has ended');
      if (event.action === 'turn' && !this.messages.recordObserved(thread.id,event.role,event.eventId,words!,parent.id))
        return result;
      this.db.update(jobs).set({state:'running',endedAt:null,heardAt:at}).where(eq(jobs.id,parent.id)).run();
      return result;
    });
  }

  private open(scope: TerminalScope, event: Extract<TerminalEvent,{action:'open'}>, at: string): Session {
    // The machine by its name and the folder the session began in: what its person would call it. The
    // machine's id says nothing to them. The whole path is on the session row; the title has its last part.
    const machine = this.db.select({ name: boxes.name }).from(boxes).where(eq(boxes.id, scope.machine)).get()?.name ?? scope.machine;
    // The last part of the path, whichever way its slashes lean, with nothing in it that is not printable.
    const folder = event.cwd.split(/[\\/]/).filter(Boolean).pop()?.replace(/[\p{C}\u2028\u2029]/gu, '').trim();
    const title = [...([machine, event.harness, ...(folder ? [folder] : [])].join(' · '))].slice(0,60).join('');
    const thread = this.messages.threads.open({agent:scope.agent,member:scope.member,venue:'terminal',title});
    const job = this.db.insert(jobs).values({agent:scope.agent,member:scope.member,box:scope.machine,
      id:'job-'+randomUUID(),conversation:thread.conversation,title,state:'running',brief:'',model:event.model ?? '',
      harness:event.harness,startedByKind:'terminal',startedBy:scope.member,houseRepository:'',houseFile:'',houseBranch:'',
      queuedAt:at,claimedAt:at,heardAt:at}).returning().get();
    const row = this.db.insert(terminalSessions).values({...scope,job:job.id,thread:thread.id,
      sessionId:event.sessionId,instanceId:event.instanceId,cwd:event.cwd,harness:event.harness}).returning().get();
    this.db.insert(terminalRuns).values({job:job.id,parent:job.id,runId:'main',revision:-1}).run();
    return row;
  }

  private usage(parent: Job, event: Extract<TerminalEvent,{action:'usage'}>, at: string) {
    if (event.completed && event.runId === 'main') throw new OperationError('invalid','Use end to close the main session');
    const run = this.db.select().from(terminalRuns).where(and(eq(terminalRuns.parent,parent.id),eq(terminalRuns.runId,event.runId))).get();
    const prior = run ? this.db.select().from(jobs).where(eq(jobs.id,run.job)).get() : undefined;
    if (run) {
      if (!prior || prior.startedByKind !== 'terminal' || prior.member !== parent.member || prior.agent !== parent.agent ||
          prior.box !== parent.box || (event.runId === 'main' ? prior.id !== parent.id : prior.id === parent.id || prior.conversation !== null))
        throw new Error('Terminal run records disagree');
      if (event.revision <= run.revision) {
        // A completion hook may know only that the child stopped, with no new transcript bytes.
        if (event.completed && prior.state !== 'done') this.db.update(jobs).set({state:'done',endedAt:prior.endedAt ?? at})
          .where(eq(jobs.id,prior.id)).run();
        return;
      }
    }
    const id = run?.job ?? 'job-'+randomUUID();
    const report = event.report;
    const finished = event.completed || prior?.state === 'done';
    const state = finished ? 'done' : parent.state;
    const endedAt = finished ? prior?.endedAt ?? parent.endedAt ?? at : parent.endedAt;
    if (!run) {
      this.db.insert(jobs).values({id,member:parent.member,agent:parent.agent,box:parent.box,
        title:event.description || 'Terminal subagent',brief:'',state,endedAt,model:report.model ?? '',harness:parent.harness,
        startedByKind:'terminal',startedBy:parent.startedBy,houseRepository:'',houseFile:'',houseBranch:'',
        queuedAt:parent.endedAt ?? at,claimedAt:parent.endedAt ?? at,heardAt:parent.endedAt ?? at}).run();
      this.db.insert(terminalRuns).values({job:id,parent:parent.id,runId:event.runId,revision:event.revision}).run();
    } else this.db.update(terminalRuns).set({revision:event.revision}).where(eq(terminalRuns.job,id)).run();
    const values = {source:report.source,tokensIn:report.tokensIn ?? null,tokensOut:report.tokensOut ?? null,
      cacheRead:report.cacheRead ?? null,cacheWritten:report.cacheWritten ?? null,modelCalls:report.modelCalls ?? null,
      toolCalls:report.toolCalls ?? null,tools:report.tools ?? null,largestContext:report.largestContext ?? null,
      wallMs:report.wallMs ?? null,harness:parent.harness,model:report.model ?? (prior?.model || null)};
    this.db.insert(jobUsage).values({job:id,...values}).onConflictDoUpdate({target:jobUsage.job,set:values}).run();
    if (id !== parent.id) {
      this.db.update(jobs).set({state,endedAt,heardAt:endedAt ?? at,
        ...(event.description ? {title:event.description} : {}),...(report.model ? {model:report.model} : {})})
        .where(eq(jobs.id,id)).run();
    } else if (report.model && report.model !== parent.model) {
      this.db.update(jobs).set({model:report.model}).where(eq(jobs.id,id)).run();
    }
  }
}
