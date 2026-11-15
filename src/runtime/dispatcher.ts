/** Trusted control plane for a runner door. The outside door must derive box
 * from the authenticated runner; installed callers use this directly. Nothing
 * here executes a process, opens credentials or invents another transport. */
import { asc, eq } from 'drizzle-orm';
import type { DataDatabase } from '../core/data/database.js';
import { agentRunSettings, agentHousePorts, boxes, jobNeeds, jobs } from '../core/data/schema.js';
import { Jobs } from './jobs.js';
import { Machines } from './machines.js';
import { selectPlacement, type ModelRole } from './placement.js';
export class Dispatcher {
  readonly jobs: Jobs;
  readonly machines: Machines;
  constructor(readonly db: DataDatabase, readonly now: () => string, readonly roles: () => readonly ModelRole[]) {
    this.jobs = new Jobs(db, now); this.machines = new Machines(db, now);
  }
  /** Polls also report machine health when idle or report-only. Placement and
   * claim share one transaction, so a second poll cannot receive the same job. */
  next(box: string) {
    this.machines.heartbeat(box);
    return this.db.transaction(() => {
      const machine = this.liveMachine(box);
      if (machine.reportOnly) return;
      const at = this.now(), roles = this.roles();
      const queued = this.db.select().from(jobs).where(eq(jobs.state, 'queued')).orderBy(asc(jobs.queuedAt), asc(jobs.id)).all();
      for (const job of queued) {
        if (job.retryAt && job.retryAt > at) continue;
        const needs = this.db.select().from(jobNeeds).where(eq(jobNeeds.job, job.id)).all().map(row => row.need);
        const placement = selectPlacement(this.db, { agent: job.agent, now: at, roles, needs });
        if (!placement || placement.box !== box) continue;
        const claimed = this.jobs.claim(job.id, box);
        if (!claimed) continue;
        // model on a queued job is the initial preference; this records the
        // model actually requested from the worker after current placement.
        this.db.update(jobs).set({ model: placement.model, account: placement.account, harness: placement.harness }).where(eq(jobs.id, job.id)).run();
        const settings = this.db.select().from(agentRunSettings).where(eq(agentRunSettings.agent, claimed.agent)).get();
        const ports = this.db.select({ address: agentHousePorts.address, port: agentHousePorts.port })
          .from(agentHousePorts).where(eq(agentHousePorts.agent, claimed.agent))
          .orderBy(asc(agentHousePorts.address), asc(agentHousePorts.port)).all();
        return { run: { nestedContainers: settings?.nestedContainers ?? false, gpu: settings?.gpu ?? false, ports }, id: claimed.id, box, agent: claimed.agent, conversation: claimed.conversation,
          model: placement.model, account: placement.account, harness: placement.harness,
          brief: claimed.brief ?? '', house: { repository: claimed.houseRepository ?? '',
            file: claimed.houseFile ?? '', branch: claimed.houseBranch ?? '' } };
      }
    }, { behavior: 'immediate' });
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
      this.jobs.heartbeat(id, box, state);
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
