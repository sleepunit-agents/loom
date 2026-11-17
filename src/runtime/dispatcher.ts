/** Trusted control plane for a runner door. The outside door must derive box
 * from the authenticated runner; installed callers use this directly. Nothing
 * here executes a process, opens credentials or invents another transport. */
import { Threads } from '../core/conversations/threads.js';
import { workerPolicy } from './body-policy.js';
import { harnessCannotRun } from './harness-traits.js';
import { and, asc, eq } from 'drizzle-orm';
import type { DataDatabase } from '../core/data/database.js';
import { agentRunSettings, agentHousePorts, boxes, jobNeeds, jobs, conversations, threads, triggers } from '../core/data/schema.js';
import { Jobs, workingIn, type Job } from './jobs.js';
import { Machines } from './machines.js';
import { selectPlacement, type ModelRole } from './placement.js';
export class Dispatcher {
  readonly jobs: Jobs;
  readonly machines: Machines;
  constructor(readonly db: DataDatabase, readonly now: () => string, readonly roles: () => readonly ModelRole[]) {
    this.jobs = new Jobs(db, now); this.machines = new Machines(db, now);
  }
  private currentThread(job:Pick<Job,'id'|'agent'|'conversation'>){
    if(!job.conversation)return undefined;
    return this.db.select({id:threads.id}).from(threads)
      .innerJoin(conversations,eq(conversations.id,threads.conversation)).innerJoin(jobs,workingIn(job.id))
      .where(and(eq(conversations.id,job.conversation),eq(conversations.agent,job.agent),eq(conversations.venue,'loom'))).get();
  }
  /** Polls also report machine health when idle or report-only. Placement and
   * claim share one transaction, so a second poll cannot receive the same job. */
  next(box: string, facts?: readonly string[]) {
    this.machines.heartbeat(box, facts);
    return this.db.transaction(() => {
      const machine = this.liveMachine(box);
      if (machine.reportOnly) return;
      const at = this.now(), roles = this.roles();
      const queued = this.db.select().from(jobs).where(eq(jobs.state, 'queued')).orderBy(asc(jobs.queuedAt), asc(jobs.id)).all();
      for (const job of queued) {
        if (job.retryAt && job.retryAt > at) continue;
        const needs = this.db.select().from(jobNeeds).where(eq(jobNeeds.job, job.id)).all().map(row => row.need);
        const settings = this.db.select().from(agentRunSettings).where(eq(agentRunSettings.agent, job.agent)).get();
        // Settings may gain GPU after admission; never claim an incapable box.
        if (settings?.gpu && !needs.includes('gpu')) needs.push('gpu');
        // Who is in the job's room decides which tools its body is not given, and so which harnesses can run it.
        const policy = workerPolicy(this.db, job);
        const placement = selectPlacement(this.db, { agent: job.agent, now: at, roles, needs, wants: this.wants(job.conversation),
          cannotRun: harness => harnessCannotRun(harness, policy) });
        if (!placement || placement.box !== box) continue;
        const claimed = this.jobs.claim(job.id, box);
        if (!claimed) continue;
        // model on a queued job is the initial preference; this records the
        // model actually requested from the worker after current placement.
        this.db.update(jobs).set({ model: placement.model, account: placement.account, harness: placement.harness }).where(eq(jobs.id, job.id)).run();
        const ports = this.db.select({ address: agentHousePorts.address, port: agentHousePorts.port })
          .from(agentHousePorts).where(eq(agentHousePorts.agent, claimed.agent))
          .orderBy(asc(agentHousePorts.address), asc(agentHousePorts.port)).all();
        const thread = this.currentThread(claimed);
        if(thread)new Threads(this.db,this.now).working(thread.id,true);
        const venue=claimed.conversation?this.db.select({venue:conversations.venue}).from(conversations).where(eq(conversations.id,claimed.conversation)).get()?.venue:null;
        return { venue:venue??null, thread:thread?.id ?? null, run: { nestedContainers: settings?.nestedContainers ?? false, gpu: settings?.gpu ?? false, ports, policy }, id: claimed.id, box, agent: claimed.agent, conversation: claimed.conversation,
          model: placement.model, account: placement.account, harness: placement.harness,
          brief: this.jobs.workerBrief(claimed.id), house: { repository: claimed.houseRepository ?? '',
            file: claimed.houseFile ?? '', branch: claimed.houseBranch ?? '' } };
      }
    }, { behavior: 'immediate' });
  }
  /** A lane's work runs in the conversation its trigger opened, whose place is the trigger. What that trigger
   * wants to run on is read when the job is placed, so an edit to the lane takes effect at once. */
  private wants(conversation: string | null): string | null {
    if (!conversation) return null;
    const row = this.db.select({ venue: conversations.venue, place: conversations.place }).from(conversations).where(eq(conversations.id, conversation)).get();
    if (row?.venue !== 'wake' || !row.place) return null;
    return this.db.select({ wants: triggers.wantsModel }).from(triggers).where(eq(triggers.id, row.place)).get()?.wants ?? null;
  }
  private liveMachine(box: string) {
    const machine = this.db.select().from(boxes).where(eq(boxes.id, box)).get();
    if (!machine || machine.revokedAt) throw new Error('Machine not available');
    return machine;
  }
  started(box: string, job: string, build: string) {
    this.machines.heartbeat(box);
    return this.db.transaction(() => {
      this.liveMachine(box);
      this.jobs.started(job, box, build);
      return { ok: true as const };
    }, { behavior: 'immediate' });
  }
  heartbeat(box: string, id: string, state: 'starting' | 'running') {
    this.machines.heartbeat(box);
    return this.db.transaction(() => {
      this.liveMachine(box);
      const job = this.db.select().from(jobs).where(eq(jobs.id, id)).get();
      if (!job || job.box !== box || !(state === 'starting' ? job.state === 'starting' : ['running', 'waiting'].includes(job.state)))
        return { active: false };
      if (state === 'starting') {
        // Nothing is running yet, so a Comms Stop ends the job here. Once a body runs, the Stop is the body's
        // to notice: it drops its work cleanly, and Jobs.finish records the stop when the worker reports.
        if (this.jobs.takeStop(job.id)) return { active: false, stopped: true as const };
        const thread = this.currentThread(job);
        if (thread) new Threads(this.db, this.now).working(thread.id, true);
      }
      // The worker reports a live process, not whether its body resumed work.
      // Preserve a body's explicit waiting status until a body status update.
      this.jobs.heartbeat(id, box, job.state === 'waiting' ? 'waiting' : state);
      return { active: true };
    }, { behavior: 'immediate' });
  }
  /** Root reports job/retry source changes to Tempo after this transaction
   * commits. The HTTP adapter returns only {ok:true} to the worker. */
  finish(box: string, job: string, exitCode: number, logTail: string) {
    this.machines.heartbeat(box);
    return this.db.transaction(() => {
      this.liveMachine(box);
      return this.jobs.finish(job, box, exitCode, logTail);
    }, { behavior: 'immediate' });
  }
}
