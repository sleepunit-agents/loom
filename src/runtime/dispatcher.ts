/** Trusted control plane for a runner door. The outside door must derive box
 * from the authenticated runner; installed callers use this directly. Nothing
 * here executes a process, opens credentials or invents another transport. */
import { Threads } from '../core/conversations/threads.js';
import { lateMailWaits } from '../core/conversations/index.js';
import { jobRoom, othersMail } from '../shared-place-mail.js';
import { loomToolsOnly } from '../policy.js';
import { wakePlaceTriggers } from '../core/tempo/tempo.js';
import { and, asc, eq } from 'drizzle-orm';
import type { DataDatabase } from '../core/data/database.js';
import { agentModels, agentRunSettings, agentHousePorts, boxes, jobNeeds, jobs, conversations, modelAccountBoxes, modelAccounts, threads, triggers } from '../core/data/schema.js';
import { Jobs, workingIn, type Job } from './jobs.js';
import { Machines } from './machines.js';
import { decidePlacement, type ModelRole } from './placement.js';
import type { WorkerRunPolicy } from './worker.js';
import type { WorkerExitBy } from './job-exit.js';
/** What loom records on a job on anybody else's word that no harness the agent has can run. */
export const UNHELD_NOTE = 'Never started: this job is not working for the agent\'s owners, so it runs with loom\'s tools only, and every model the agent has runs on a harness that always has a shell. Give the agent a model that runs on Claude Code.';
export class Dispatcher {
  readonly jobs: Jobs;
  readonly machines: Machines;
  /** `cannotRun` answers whether a harness would refuse a job with this room (harnessCannotRun in
   * body-harnesses.ts). It is handed in because the harness adapters start processes, and nothing this
   * file imports may. */
  constructor(readonly db: DataDatabase, readonly now: () => string, readonly roles: () => readonly ModelRole[],
    private readonly cannotRun: (harness: string, policy: WorkerRunPolicy | undefined) => boolean) {
    this.jobs = new Jobs(db, now); this.machines = new Machines(db, now);
  }
  private currentThread(job:Pick<Job,'id'|'agent'|'conversation'>){
    if(!job.conversation)return undefined;
    return this.db.select({id:threads.id}).from(threads)
      .innerJoin(conversations,eq(conversations.id,threads.conversation)).innerJoin(jobs,workingIn(job.id))
      .where(and(eq(conversations.id,job.conversation),eq(conversations.agent,job.agent),eq(conversations.venue,'loom'))).get();
  }
  /** Polls also report machine health when idle or report-only. Placement and
   * claim share one transaction, so a second poll cannot receive the same job.
   * `ended` is given the id of each job this poll ended as one no harness can hold. The caller tells of those
   * ends once the write is committed, as of any job's end: one job holds one asker's mail, so another asker's
   * mail may be waiting behind such a job for a job of its own. */
  next(box: string, facts?: readonly string[], ended?: string[], slots?: number) {
    this.machines.heartbeat(box, facts, slots);
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
        // And the word the job works on goes with it: on anybody else's the body is held to loom's tools (policy.ts, loomToolsOnly).
        const policy = jobRoom(this.db, job);
        const { placement, decision } = decidePlacement(this.db, { agent: job.agent, now: at, roles, needs, prefers: job.prefers ?? [], wants: this.wants(job.conversation),
          cannotRun: harness => this.cannotRun(harness, policy) });
        // A job on anybody else's word runs with loom's tools only, and a harness that always has a shell does
        // not run it. When every model the agent has is on such a harness, no machine will ever take the job:
        // it is ended now and says why. Any other job that cannot be placed waits, as before.
        // The mail that made it anybody else's is closed with the same reason, so it is not jobbed again in vain: an
        // owner's message in that conversation gets a job on owners' word, which runs.
        if (!placement && loomToolsOnly(policy.word) && this.unheld(job.agent, roles, policy)) { if (this.jobs.unplaceable(job.id, UNHELD_NOTE, othersMail(this.db, job))) ended?.push(job.id); continue; }
        if (!placement || placement.box !== box) continue;
        const claimed = this.jobs.claim(job.id, box);
        if (!claimed) continue;
        // Placement is decided here and nowhere else. The model a queued job carries is only what the
        // column needs before that (the agent's first model, also on a retry); this records the model,
        // account and harness the worker is actually asked for.
        this.db.update(jobs).set({ placementDecision: decision, model: placement.model, account: placement.account, harness: placement.harness }).where(eq(jobs.id, job.id)).run();
        const ports = this.db.select({ address: agentHousePorts.address, port: agentHousePorts.port })
          .from(agentHousePorts).where(eq(agentHousePorts.agent, claimed.agent))
          .orderBy(asc(agentHousePorts.address), asc(agentHousePorts.port)).all();
        const thread = this.currentThread(claimed);
        if(thread)new Threads(this.db,this.now,lateMailWaits).working(thread.id,true);
        const venue=claimed.conversation?this.db.select({venue:conversations.venue}).from(conversations).where(eq(conversations.id,claimed.conversation)).get()?.venue:null;
        return { venue:venue??null, thread:thread?.id ?? null, run: { nestedContainers: settings?.nestedContainers ?? false, gpu: settings?.gpu ?? false, ports, policy }, id: claimed.id, box, agent: claimed.agent, conversation: claimed.conversation,
          model: placement.model, account: placement.account, accountChoices: this.accountChoices(box, placement.account), harness: placement.harness,
          brief: this.jobs.workerBrief(claimed.id), house: { repository: claimed.houseRepository ?? '',
            file: claimed.houseFile ?? '', branch: claimed.houseBranch ?? '' } };
      }
    }, { behavior: 'immediate' });
  }
  /** Whether the agent has models, and every one of them runs on a harness that would refuse this job. */
  private unheld(agent: string, roles: readonly ModelRole[], policy: WorkerRunPolicy): boolean {
    const harnesses = this.db.select({ model: agentModels.model }).from(agentModels).where(eq(agentModels.agent, agent)).all()
      .flatMap(row => roles.filter(role => role.model === row.model).map(role => role.harness));
    return harnesses.length > 0 && harnesses.every(harness => this.cannotRun(harness, policy));
  }
  /** A lane's work runs in the conversation its trigger opened, whose place names the trigger (wakePlace). What that trigger
   * wants to run on is read when the job is placed, so an edit to the lane takes effect at once. */
  private wants(conversation: string | null): string | null {
    if (!conversation) return null;
    const row = this.db.select({ venue: conversations.venue, place: conversations.place }).from(conversations).where(eq(conversations.id, conversation)).get();
    if (row?.venue !== 'wake' || !row.place) return null;
    for (const id of wakePlaceTriggers(row.place)) {
      const trigger = this.db.select({ wants: triggers.wantsModel }).from(triggers).where(eq(triggers.id, id)).get();
      if (trigger) return trigger.wants ?? null;
    }
    return null;
  }
  /** How many accounts of the placed account's provider are signed in on the machine. Placement checked the
   * placed one for room; only the worker knows whether its command can be held to it (see workerRunner). */
  private accountChoices(box: string, account: string): number {
    const provider = this.db.select({ provider: modelAccounts.provider }).from(modelAccounts).where(eq(modelAccounts.id, account)).get()?.provider;
    return this.db.select({ id: modelAccounts.id }).from(modelAccountBoxes).innerJoin(modelAccounts, eq(modelAccounts.id, modelAccountBoxes.account))
      .where(and(eq(modelAccountBoxes.box, box), eq(modelAccounts.provider, provider ?? ''))).all().length || 1;
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
      if (!job || job.startedByKind === 'terminal' || job.box !== box || job.state !== state) return { active: false };
      if (state === 'starting') {
        // Nothing is running yet, so a Comms Stop ends the job here. Once a body runs, the Stop is the body's
        // to notice: it drops its work cleanly, and Jobs.finish records the stop when the worker reports.
        if (this.jobs.takeStop(job.id)) return { active: false, stopped: true as const };
        const thread = this.currentThread(job);
        if (thread) new Threads(this.db, this.now, lateMailWaits).working(thread.id, true);
      }
      // The worker reports a live process in the state the job is already in; its report moves no job.
      this.jobs.heartbeat(id, box, state);
      return { active: true };
    }, { behavior: 'immediate' });
  }
  /** Root reports job/retry source changes to Tempo after this transaction
   * commits. The HTTP adapter returns only {ok:true} to the worker. */
  finish(box: string, job: string, exitCode: number, logTail: string, exitBy?: WorkerExitBy) {
    this.machines.heartbeat(box);
    return this.db.transaction(() => {
      this.liveMachine(box);
      return this.jobs.finish(job, box, exitCode, logTail, exitBy);
    }, { behavior: 'immediate' });
  }
}
