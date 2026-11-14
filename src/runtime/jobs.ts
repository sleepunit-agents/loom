/** Trusted job lifecycle. The worker executes; this service only changes records.
 * External machine identity is checked at the API door before calling it. */
import { randomUUID } from 'node:crypto';
import { and, asc, eq, inArray, ne } from 'drizzle-orm';
import type { DataDatabase } from '../core/data/database.js';
import { agentModels, agentRunSettings, conversations, inbox, jobNeeds, jobs } from '../core/data/schema.js';

export type Job = typeof jobs.$inferSelect;
const active = ['queued', 'starting', 'running', 'waiting'] as const;
export class Jobs {
  constructor(readonly db: DataDatabase, readonly now: () => string) {}

  get(id: string): Job {
    const row = this.db.select().from(jobs).where(eq(jobs.id, id)).get();
    if (!row) throw new Error('Job not found');
    return row;
  }

  /** Called after inbox settling. Repeated admission returns the same active job.
   * Exhausted starts and manually stopped work need fresh mail to resume. */
  admit(conversationId: string): Job | undefined {
    return this.db.transaction(() => {
      const conversation = this.db.select().from(conversations).where(eq(conversations.id, conversationId)).get();
      if (!conversation) throw new Error('Conversation not found');
      const existing = this.db.select().from(jobs).where(and(eq(jobs.conversation, conversationId), inArray(jobs.state, [...active]))).get();
      if (existing) return existing;
      const mail = this.db.select().from(inbox).where(and(eq(inbox.conversation, conversationId), eq(inbox.toKind, 'agent'), eq(inbox.to, conversation.agent), eq(inbox.state, 'waiting'), ne(inbox.volume, 'mute'))).orderBy(asc(inbox.seq)).all();
      if (!mail.length) return;
      // A waiting row's job is its last admission attempt, even before take().
      // New mail has no job: no timestamp comparison can lose same-tick mail.
      if (!mail.some(item => item.job === null)) return;
      const settings = this.db.select().from(agentRunSettings).where(eq(agentRunSettings.agent, conversation.agent)).get();
      const model = this.db.select().from(agentModels).where(eq(agentModels.agent, conversation.agent)).orderBy(asc(agentModels.position), asc(agentModels.model)).get();
      if (!settings || !model) return;
      const at = this.now();
      const job = this.db.insert(jobs).values({
        id: `job-${randomUUID()}`, agent: conversation.agent, conversation: conversationId,
        project: conversation.project, member: conversation.member, title: conversation.label,
        state: 'queued', brief: mail.map(item => item.words ?? '').join('\n\n'), model: model.model,
        // Inbox admission is automatic work started by the receiving agent.
        // The actual sender and source remain on each inbox item.
        startedByKind: 'agent', startedBy: conversation.agent,
        houseRepository: settings.houseRepository, houseFile: settings.houseFile, houseBranch: settings.houseBranch, queuedAt: at,
      }).returning().get();
      if (settings.gpu) this.db.insert(jobNeeds).values({ job: job.id, need: 'gpu' }).run();
      this.db.update(inbox).set({ job: job.id, changedAt: at }).where(and(eq(inbox.conversation, conversationId), eq(inbox.toKind, 'agent'), eq(inbox.to, conversation.agent), eq(inbox.state, 'waiting'), ne(inbox.volume, 'mute'))).run();
      this.db.update(conversations).set({ job: job.id }).where(eq(conversations.id, conversationId)).run();
      return job;
    }, { behavior: 'immediate' });
  }

  /** The caller selects an eligible placement inside the same admission tick.
   * Compare-and-set makes a second worker claim harmless. */
  claim(id: string, box: string): Job | undefined {
    return this.db.transaction(() => {
      const job = this.get(id), at = this.now();
      if (job.state !== 'queued' || (job.retryAt && job.retryAt > at)) return;
      return this.db.update(jobs).set({ box, state: 'starting', claimedAt: at, heardAt: at })
        .where(and(eq(jobs.id, id), eq(jobs.state, 'queued'))).returning().get();
    }, { behavior: 'immediate' });
  }

  private assigned(id: string, box: string, states: readonly Job['state'][]): Job {
    const job = this.get(id);
    if (job.box !== box || !states.includes(job.state)) throw new Error('Job is not assigned in this state');
    return job;
  }

  started(id: string, box: string, build: string): Job {
    return this.db.transaction(() => {
      this.assigned(id, box, ['starting']);
      return this.db.update(jobs).set({ state: 'running', build, heardAt: this.now() }).where(eq(jobs.id, id)).returning().get()!;
    });
  }

  heartbeat(id: string, box: string, state: 'starting' | 'running' | 'waiting'): Job {
    return this.db.transaction(() => {
      this.assigned(id, box, state === 'starting' ? ['starting'] : ['running', 'waiting']);
      return this.db.update(jobs).set({ state, heardAt: this.now() }).where(eq(jobs.id, id)).returning().get()!;
    });
  }

  /** Only a failure before started() creates a retry: initial attempt + 3 retries.
   * Every successor points to its immediate predecessor and keeps its snapshot. */
  finish(id: string, box: string, exitCode: number, logTail = ''): { job: Job; retry?: Job } {
    return this.db.transaction(() => {
      const before = this.assigned(id, box, ['starting', 'running', 'waiting']);
      const at = this.now();
      const job = this.end(before, before.state === 'starting' || exitCode !== 0 ? 'failed' : 'done', { exitCode, logTail: logTail.slice(-16_384), endedAt: at });
      if (before.state !== 'starting') return { job };
      let depth = 0, ancestor = before;
      const seen = new Set([id]);
      while (ancestor.retryOf) {
        if (seen.has(ancestor.retryOf)) throw new Error('Cyclic job retries');
        seen.add(ancestor.retryOf); ancestor = this.get(ancestor.retryOf); depth++;
        if (depth >= 3) return { job };
      }
      const { id: _id, ...snapshot } = before;
      const retry = this.db.insert(jobs).values({ ...snapshot, id: `job-${randomUUID()}`, state: 'queued', box: null, account: null, harness: null,
        retryOf: id, retryAt: new Date(Date.parse(at) + 1000 * 2 ** depth).toISOString(), queuedAt: at,
        claimedAt: null, heardAt: null, endedAt: null, build: null, exitCode: null, logTail: null,
      }).returning().get();
      for (const need of this.db.select().from(jobNeeds).where(eq(jobNeeds.job, id)).all()) this.db.insert(jobNeeds).values({ job: retry.id, need: need.need }).run();
      this.db.update(inbox).set({ job: retry.id, changedAt: at }).where(and(eq(inbox.job, id), eq(inbox.state, 'waiting'))).run();
      if (before.conversation) this.db.update(conversations).set({ job: retry.id }).where(eq(conversations.id, before.conversation)).run();
      return { job, retry };
    }, { behavior: 'immediate' });
  }

  stop(id: string, member: string, reason: 'reset' | 'write-off'): Job {
    return this.db.transaction(() => {
      const job = this.get(id);
      if (!active.includes(job.state as typeof active[number])) throw new Error('Job has ended');
      return this.end(job, 'stopped', { endedBy: member, endedReason: reason, endedAt: this.now() });
    });
  }

  /** Fake-clock sweep; silence never turns a running body into a start retry. */
  sweep(silenceMs = 120_000): Job[] {
    if (!Number.isFinite(silenceMs) || silenceMs <= 0) throw new Error('Invalid silence interval');
    return this.db.transaction(() => {
      const at = this.now();
      return this.db.select().from(jobs).where(inArray(jobs.state, ['starting', 'running', 'waiting'])).all()
        .filter(job => Date.parse(at) - Date.parse(job.heardAt ?? job.claimedAt ?? job.queuedAt) > silenceMs)
        .map(job => this.end(job, 'lost', { endedAt: at }));
    });
  }

  private end(job: Job, state: Job['state'], values: Partial<Job>): Job {
    const ended = this.db.update(jobs).set({ ...values, state }).where(eq(jobs.id, job.id)).returning().get()!;
    // Unconfirmed mail survives a dead body, with no receipt fabricated for it.
    this.db.update(inbox).set({ state: 'waiting', takenAt: null, changedAt: this.now() })
      .where(and(eq(inbox.job, job.id), eq(inbox.state, 'taken'))).run();
    if (state === 'done' || (state !== 'stopped' && job.state !== 'starting')) {
      this.db.update(inbox).set({ job: null }).where(and(eq(inbox.job, job.id), eq(inbox.state, 'waiting'))).run();
    }
    if (job.conversation) this.db.update(conversations).set({ job: null })
      .where(and(eq(conversations.id, job.conversation), eq(conversations.job, job.id))).run();
    return ended;
  }
}
