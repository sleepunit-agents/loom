import {keepJobText} from './job-text.js';
/** Trusted job lifecycle. The worker executes; this service only changes records.
 * External machine identity is checked at the API door before calling it. */
import { mailWords } from '../core/conversations/volume.js';
import { randomUUID } from 'node:crypto';
import { and, asc, eq, gt, inArray, isNull, ne } from 'drizzle-orm';
import type { DataDatabase } from '../core/data/database.js';
import { agentModels, agentRunSettings, agents, conversations, inbox, jobNeeds, jobs, messages, threads } from '../core/data/schema.js';
import { membersWithAgent } from '../policy.js';
import { householdOwners, sharedSharing } from '../shared-sharing.js';
import { Threads } from '../core/conversations/threads.js';
import { Conversations } from '../core/conversations/index.js';
import type { AdmitInbox } from '../core/tempo/settle.js';
import { BODY_EXIT, LOOM_EXIT } from './job-exit.js';
import { claimedJobStates, jobUnended, unendedJobStates } from '../core/data/job-states.js';
import { SILENCE_MS } from './silence.js';

export type Job = typeof jobs.$inferSelect;
/** Join condition: this job is the one working in the conversation row, that is, its one job that has not ended. */
export const workingIn = (job: string) => and(eq(jobs.conversation, conversations.id), eq(jobs.id, job), inArray(jobs.state, unendedJobStates));
/** One piece of work gets its first attempt and at most this many more, whatever made each attempt fail. */
export const JOB_RETRIES = 3;
/** How long each retry waits, by how many attempts came before it. A start that failed (no body ran) is
 * usually the worker's own trouble and is tried again quickly. A body that started and then failed or went
 * silent most often lost loom itself, to a restart or an upgrade, so those retries are spread over a few
 * minutes: a schedule of seconds would spend every attempt before loom is back. */
const START_RETRY_MS = [1_000, 2_000, 4_000], RUN_RETRY_MS = [5_000, 30_000, 120_000];
/** How long a queued job waits for a machine, counted from when it could first be claimed (when it was
 * queued, or its retry time). Placement leaves a job queued while no allowed machine is reporting, no
 * account has room or no allowed harness can run it, and most of those pass: a machine wakes, a usage
 * window resets. A job still unclaimed after this long is ended as failed with LOOM_EXIT.unplaced
 * (Jobs.sweep), so that it shows as a failure and its conversation can take fresh mail, and is not tried
 * again: a next attempt would only wait as long. One number for every reason: docs/accepted-tradeoffs.md,
 * "A queued job has one deadline, whatever keeps it queued". */
export const QUEUE_DEADLINE_MS = 24 * 3_600_000;
/** What loom records on a job that reported success with mail of its own still unconfirmed. */
const UNSETTLED_NOTE = 'Finished without settling its mail';
/** What admission answers: the conversation's unended job, or why its waiting mail did not become one. */
export interface Admission {
  job?: Job;
  /** Whether this call started that job. */
  started?: boolean;
  /** That job was already there and does not hold all of the conversation's waiting mail: some arrived
   * after it was admitted. A body takes mail once, so that mail may never reach it, and it is not admitted
   * until it is held by a job. It becomes one when this job has ended and admission is asked again. */
  behind?: boolean;
  /** Why mail that is waiting got no job, in loom's own words. Absent when there was nothing to admit. */
  declined?: string;
  /** Whether this call told the agent's owners so for the first time. */
  noticed?: boolean;
}
export class Jobs {
  private readonly mail: Conversations;
  constructor(readonly db: DataDatabase, readonly now: () => string) { this.mail = new Conversations(db, now); }

  get(id: string): Job {
    const row = this.db.select().from(jobs).where(eq(jobs.id, id)).get();
    if (!row) throw new Error('Job not found');
    return row;
  }

  /** Only unconfirmed original messages held by this exact job. Delivery is
   * separate from the agent's explicitly reported status and from mail ACKs. */
  private delivery(job: string, delivery: 'sending' | 'held' | 'failed'): void {
    const pending = this.db.select({id:inbox.id}).from(inbox).where(and(eq(inbox.job,job),inArray(inbox.state,['waiting','taken'])));
    this.db.update(messages).set({delivery}).where(and(eq(messages.kind,'message'),inArray(messages.inboxItem,pending))).run();
  }

  private keepText(job: Pick<Job, 'conversation'>): boolean {
    if (!job.conversation) return true;
    const conversation = this.db.select({ venue: conversations.venue, member: conversations.member, direct: conversations.direct }).from(conversations)
      .where(eq(conversations.id, job.conversation)).get();
    return keepJobText(conversation);
  }

  /** Old queued rows may contain a plaintext brief; never send it to a worker. */
  workerBrief(id: string): string {
    const job = this.get(id);
    return this.keepText(job) ? job.brief : '';
  }

  /** Called after inbox settling. Repeated admission returns the same active job, whether or not it holds
   * the mail that is waiting now (see Admission.behind).
   * Work that ran out of attempts and work that was stopped need fresh mail to resume. */
  admit(conversationId: string): Job | undefined { return this.admission(conversationId).job; }

  /** The notices that say why this mail got no job: one for each of the agent's owners, or for the household's
   * owners when the agent has none. Keyed by the first piece of mail that was held up, so each time an
   * agent becomes unable to run is told once however often admission is asked. */
  private declined(agent: string, mail: readonly Pick<typeof inbox.$inferSelect, 'id'>[], why: string): Admission {
    const key = (item: string) => `mail-not-admitted:${JSON.stringify([agent, item])}`;
    let to = membersWithAgent(agent, sharedSharing(this.db));
    if (!to.length) to = householdOwners(this.db);
    let noticed = false;
    for (const member of to) {
      const before = this.db.select({ id: inbox.id }).from(inbox).where(and(eq(inbox.toKind, 'person'), eq(inbox.to, member), eq(inbox.source, 'notice'), eq(inbox.sourceId, key(mail[0].id)))).get();
      this.mail.send({ toKind: 'person', to: member, member, source: 'notice', sourceId: key(mail[0].id), fromKind: 'unknown',
        words: `Mail for ${agent} is waiting and no work was started: ${why}.`, refs: [agent] });
      noticed ||= !before;
    }
    return { declined: why, noticed };
  }

  /** admit(), and when waiting mail got no job, why. That is recorded as a notice to the agent's owners
   * (see declined), and the notice is closed when the mail is admitted after all. */
  admission(conversationId: string): Admission {
    return this.db.transaction(() => {
      const conversation = this.db.select().from(conversations).where(eq(conversations.id, conversationId)).get();
      if (!conversation) throw new Error('Conversation not found');
      const existing = this.db.select().from(jobs).where(and(eq(jobs.conversation, conversationId), inArray(jobs.state, unendedJobStates))).get();
      const mail = this.db.select().from(inbox).where(and(eq(inbox.conversation, conversationId), eq(inbox.toKind, 'agent'), eq(inbox.to, conversation.agent), eq(inbox.state, 'waiting'), ne(inbox.volume, 'mute'))).orderBy(asc(inbox.seq)).all();
      if (existing) return { job: existing, behind: mail.some(item => item.job !== existing.id) };
      if (!mail.length) return {};
      // A waiting row's job is its last admission attempt, even before take().
      // New mail has no job: no timestamp comparison can lose same-tick mail.
      if (!mail.some(item => item.job === null)) return {};
      const settings = this.db.select().from(agentRunSettings).where(eq(agentRunSettings.agent, conversation.agent)).get();
      const model = this.db.select().from(agentModels).where(eq(agentModels.agent, conversation.agent)).orderBy(asc(agentModels.position), asc(agentModels.model)).get();
      // A removed agent keeps its history and its mail, and does not run.
      if (this.db.select({ removedAt: agents.removedAt }).from(agents).where(eq(agents.id, conversation.agent)).get()?.removedAt)
        return this.declined(conversation.agent, mail, 'the agent has been removed');
      if (!settings) return this.declined(conversation.agent, mail, 'the agent has no run settings');
      if (!model) return this.declined(conversation.agent, mail, 'the agent has no model to run on');
      const at = this.now();
      const job = this.db.insert(jobs).values({
        id: `job-${randomUUID()}`, agent: conversation.agent, conversation: conversationId,
        project: conversation.project, member: conversation.member, title: conversation.label,
        // Comms and handoff words are delivered ephemerally by ConversationMail.
        // No private conversation or encrypted brief is copied into the job.
        state: 'queued', brief: !keepJobText(conversation) ? '' : mail.map(item => mailWords(item.volume, item.words) ?? '').join('\n\n'), model: model.model,
        // Inbox admission is automatic work started by the receiving agent.
        // The actual sender and source remain on each inbox item.
        startedByKind: 'agent', startedBy: conversation.agent,
        houseRepository: settings.houseRepository, houseFile: settings.houseFile, houseBranch: settings.houseBranch, queuedAt: at,
      }).returning().get();
      if (settings.gpu) this.db.insert(jobNeeds).values({ job: job.id, need: 'gpu' }).run();
      this.db.update(inbox).set({ job: job.id, changedAt: at }).where(and(eq(inbox.conversation, conversationId), eq(inbox.toKind, 'agent'), eq(inbox.to, conversation.agent), eq(inbox.state, 'waiting'), ne(inbox.volume, 'mute'))).run();
      this.delivery(job.id,'held');
      for (const item of mail) this.mail.resolveSource('notice', `mail-not-admitted:${JSON.stringify([conversation.agent, item.id])}`, 'Work was started');
      return { job, started: true };
    }, { behavior: 'immediate' });
  }

  /** Record that admitting a conversation's mail threw, for agentMailAdmission: the same notice as a declined admission. */
  failed(conversationId: string, error: unknown): Admission {
    return this.db.transaction(() => {
      const conversation = this.db.select({ agent: conversations.agent }).from(conversations).where(eq(conversations.id, conversationId)).get();
      const mail = conversation ? this.db.select({ id: inbox.id }).from(inbox).where(and(eq(inbox.conversation, conversationId), eq(inbox.toKind, 'agent'), eq(inbox.to, conversation.agent), eq(inbox.state, 'waiting'), ne(inbox.volume, 'mute'))).orderBy(asc(inbox.seq)).all() : [];
      if (!conversation || !mail.length) return {};
      // loom's own error, first line only: it is about the database or the conversation, not anyone's words.
      const why = (error instanceof Error ? error.message : String(error)).split(/[\r\n]/, 1)[0].slice(0, 200);
      return this.declined(conversation.agent, mail, `loom could not admit it (${why})`);
    }, { behavior: 'immediate' });
  }

  /** The caller selects an eligible placement inside the same admission tick.
   * Compare-and-set makes a second worker claim harmless. */
  claim(id: string, box: string): Job | undefined {
    return this.db.transaction(() => {
      const job = this.get(id), at = this.now();
      if (job.state !== 'queued' || (job.retryAt && job.retryAt > at)) return;
      const claimed = this.db.update(jobs).set({ box, state: 'starting', claimedAt: at, heardAt: at })
        .where(and(eq(jobs.id, id), eq(jobs.state, 'queued'))).returning().get();
      if(claimed)this.delivery(id,'sending');
      return claimed;
    }, { behavior: 'immediate' });
  }

  private assigned(id: string, box: string, states: readonly Job['state'][]): Job {
    const job = this.get(id);
    if (job.box !== box || !states.includes(job.state)) throw new Error('Job is not assigned in this state');
    return job;
  }

  started(id: string, box: string, build: string): Job {
    return this.db.transaction(() => {
      // A worker may report "started" late or twice. Once the job is running that report changes nothing.
      const job = this.assigned(id, box, claimedJobStates);
      if (job.state !== 'starting') return job;
      return this.db.update(jobs).set({ state: 'running', build, heardAt: this.now() }).where(eq(jobs.id, id)).returning().get()!;
    });
  }

  heartbeat(id: string, box: string, state: 'starting' | 'running'): Job {
    return this.db.transaction(() => {
      this.assigned(id, box, [state]);
      return this.db.update(jobs).set({ state, heardAt: this.now() }).where(eq(jobs.id, id)).returning().get()!;
    });
  }

  /** A Comms Stop asked for on this job's thread and not yet taken. Only the job now working in the
   * conversation (its one job that has not ended), for the agent it still belongs to, can be meant; a thread nobody opened has no
   * one to record as having ended it. */
  private stopAsked(job: Pick<Job, 'id' | 'agent' | 'conversation'>): { thread: string; member: string } | undefined {
    if (!job.conversation) return undefined;
    const row = this.db.select({ thread: threads.id, stop: threads.stopRequested, member: conversations.member }).from(threads)
      .innerJoin(conversations, eq(conversations.id, threads.conversation))
      .innerJoin(jobs, workingIn(job.id))
      .where(and(eq(conversations.id, job.conversation), eq(conversations.agent, job.agent), eq(conversations.venue, 'loom'))).get();
    return row?.stop && row.member ? { thread: row.thread, member: row.member } : undefined;
  }

  /** The one place a Comms Stop ends a job: stopped, by the thread's member, with the reason `stop`, and the Stop
   * is taken with it. Its unconfirmed mail stays with it and is not run again. A Stop belongs to whoever
   * is in charge of the job when it is noticed, and both come here:
   *  - before a body is running, the worker's heartbeat notices it (takeStop);
   *  - once a body is running, the body notices it on its own report, stops its work and leaves with
   *    BODY_EXIT.stopped; finish() checks that a Stop really is waiting and ends the job here.
   * A Stop is pressed on the job then working, and it ends with that job whichever way that job ends:
   *  - the job finished its work first: the work is done, and the Stop is dropped (end());
   *  - the job failed or went silent first: it is ended here as stopped, so the work is not tried again.
   * It is never left on the thread to stop whatever that person asks for next. */
  private endIfStopAsked(job: Job, values: Partial<Job> = {}): Job | undefined {
    const asked = this.stopAsked(job);
    if (!asked) return undefined;
    new Threads(this.db, this.now).takeStop(asked.thread);
    return this.end(job, 'stopped', { ...values, endedBy: asked.member, endedReason: 'stop', endedAt: this.now() });
  }

  /** For the worker's heartbeat while it prepares a job: ends the job as stopped when a Comms Stop is waiting for it. */
  takeStop(id: string): Job | undefined {
    return this.db.transaction(() => {
      const job = this.get(id);
      return job.state === 'starting' ? this.endIfStopAsked(job) : undefined;
    });
  }

  /** An attempt is tried again when it never started, or when it started and left mail it had not
   * confirmed. That holds for a body that reported success too: one that leaves with exit 0 having
   * confirmed none of its own mail did not do that work (a machine's own runner, which is given no
   * credential, can never take or confirm any). Every successor points to its immediate predecessor and
   * keeps its snapshot; the chain ends after JOB_RETRIES, and the mail then stays with the last attempt
   * until fresh mail arrives.
   * The one case where unconfirmed mail starts a new chain: a body that reported success and confirmed part
   * of its mail (it took less than the whole batch to stay inside its input budget). The rest is fresh mail
   * for the next admission. Each such job settles at least one piece, so the mail itself bounds them. */
  finish(id: string, box: string, exitCode: number, logTail = ''): { job: Job; retry?: Job } {
    return this.db.transaction(() => {
      const before = this.assigned(id, box, claimedJobStates);
      const at = this.now();
      // A body that says it left for a Stop is believed only while that Stop is still waiting for this job.
      const stopped = exitCode === BODY_EXIT.stopped ? this.endIfStopAsked(before, { exitCode }) : undefined;
      if (stopped) return { job: stopped };
      // A runner's stdout/stderr can contain the private prompt or reply.
      const failed = before.state === 'starting' || exitCode !== 0;
      const held = (states: readonly (typeof inbox.$inferSelect)['state'][]) =>
        !!this.db.select({ id: inbox.id }).from(inbox).where(and(eq(inbox.job, id), inArray(inbox.state, states))).get();
      const progressed = !failed && held(['done']), unsettled = !failed && !progressed && held(['waiting', 'taken']);
      // Work someone asked to stop is not run again because its body died before noticing.
      if (failed || unsettled) { const asked = this.endIfStopAsked(before, { exitCode }); if (asked) return { job: asked }; }
      const job = this.end(before, failed ? 'failed' : 'done',
        { exitCode, logTail: this.keepText(before) ? logTail.slice(-16_384) : null, endedAt: at, ...(unsettled ? { endedNote: UNSETTLED_NOTE } : {}) });
      if (progressed) { this.db.update(inbox).set({ job: null }).where(and(eq(inbox.job, id), eq(inbox.state, 'waiting'))).run(); return { job }; }
      const retry = this.retry(before, at);
      // Out of attempts: what this body left was not delivered, and says so like a failure's.
      if (unsettled && !retry) this.delivery(id, 'failed');
      return retry ? { job, retry } : { job };
    }, { behavior: 'immediate' });
  }

  /** Queue the next attempt of work whose last attempt ended with a reason to run again, if it has any left. */
  private retry(before: Job, at: string): Job | undefined {
    const unconfirmed = and(eq(inbox.job, before.id), eq(inbox.state, 'waiting'));
    // Once a body has started, only mail it left unconfirmed is a reason to run again.
    if (before.state !== 'starting' && !this.db.select({ id: inbox.id }).from(inbox).where(unconfirmed).get()) return undefined;
    let depth = 0, ancestor = before;
    const seen = new Set([before.id]);
    while (ancestor.retryOf) {
      if (seen.has(ancestor.retryOf)) throw new Error('Cyclic job retries');
      seen.add(ancestor.retryOf); ancestor = this.get(ancestor.retryOf); depth++;
      if (depth >= JOB_RETRIES) return undefined;
    }
    const { id: _id, ...snapshot } = before;
    const retry = this.db.insert(jobs).values({ ...snapshot, brief: this.keepText(before) ? before.brief : '', id: `job-${randomUUID()}`, state: 'queued', box: null, account: null, harness: null,
      retryOf: before.id, retryAt: new Date(Date.parse(at) + (before.state === 'starting' ? START_RETRY_MS : RUN_RETRY_MS)[depth]).toISOString(), queuedAt: at,
      claimedAt: null, heardAt: null, endedAt: null, build: null, exitCode: null, logTail: null, endedNote: null,
    }).returning().get();
    for (const need of this.db.select().from(jobNeeds).where(eq(jobNeeds.job, before.id)).all()) this.db.insert(jobNeeds).values({ job: retry.id, need: need.need }).run();
    this.db.update(inbox).set({ job: retry.id, changedAt: at }).where(unconfirmed).run();
    this.delivery(retry.id,'held');
    return retry;
  }

  stop(id: string, member: string, reason: 'reset' | 'write-off'): Job {
    return this.db.transaction(() => {
      const job = this.get(id);
      if (!jobUnended(job.state)) throw new Error('Job has ended');
      return this.end(job, 'stopped', { endedBy: member, endedReason: reason, endedAt: this.now() });
    });
  }

  /** Fake-clock sweep: ends the jobs that time alone ends, and returns them.
   * - A claimed job nobody has reported on for the silence interval is lost; like a failed attempt it is
   *   tried again while it has attempts left (see finish).
   * - A queued job no machine has taken within the queue deadline is failed with LOOM_EXIT.unplaced and
   *   not tried again (see QUEUE_DEADLINE_MS).
   * Either row says what happened in loom's own words (ended_note), which are kept for a private conversation too.
   * Silence is read from this server's clock, so the caller must not sweep across a jump of that clock
   * (createRuntime waits one interval after one); a stamp left later than now by a clock set back is
   * counted from now here. */
  sweep(silenceMs = SILENCE_MS, queueMs = QUEUE_DEADLINE_MS): Job[] {
    if (!Number.isFinite(silenceMs) || silenceMs <= 0 || !Number.isFinite(queueMs) || queueMs <= 0) throw new Error('Invalid silence interval');
    return this.db.transaction(() => {
      const at = this.now(), now = Date.parse(at);
      // Only a clock that has since been set back leaves a report stamped later than now. Its true age is
      // unknown; counting from now delays noticing a dead job by one interval and never loses a live one.
      this.db.update(jobs).set({ heardAt: at }).where(and(inArray(jobs.state, claimedJobStates), gt(jobs.heardAt, at))).run();
      const lost = this.db.select().from(jobs).where(inArray(jobs.state, claimedJobStates)).all()
        .filter(job => now - Date.parse(job.heardAt ?? job.claimedAt ?? job.queuedAt) > silenceMs)
        .map(job => {
          const asked = this.endIfStopAsked(job, { endedNote: `Lost while ${job.state}: its worker stopped reporting` });
          if (asked) return asked;
          const ended = this.end(job, 'lost', { endedAt: at, endedNote: `Lost while ${job.state}: its worker stopped reporting` });
          this.retry(job, at);
          return ended;
        });
      const unplaced = this.db.select().from(jobs).where(eq(jobs.state, 'queued')).all()
        .filter(job => now - Math.max(Date.parse(job.queuedAt), job.retryAt ? Date.parse(job.retryAt) : 0) > queueMs)
        .map(job => this.end(job, 'failed', { endedAt: at, exitCode: LOOM_EXIT.unplaced,
          endedNote: `Never started: no machine took it within ${Math.round(queueMs / 3_600_000)} hours` }));
      return [...lost, ...unplaced];
    }, { behavior: 'immediate' });
  }

  private end(job: Job, state: Job['state'], values: Partial<Job>): Job {
    const ended = this.db.update(jobs).set({ ...values, state }).where(eq(jobs.id, job.id)).returning().get()!;
    this.delivery(job.id,state==='failed'||state==='lost'?'failed':'held');
    // Unconfirmed mail survives a dead body, with no receipt fabricated for it. However the job ended, that
    // mail stays with this job and is never handed back as fresh: retry() gives it to a successor within
    // the bounded chain, or it waits for fresh mail.
    this.mail.returnTaken(job.id);
    // The job working in a conversation is its one job that has not ended, so ending that job is what
    // leaves the conversation with none. Clear its working indicator in the same transaction, and with it a
    // Stop that was pressed on this job and never taken: the next job there is not the one it was meant for.
    // The last reported agent state stays.
    if (job.conversation && jobUnended(job.state)) this.db.update(threads)
      .set({ working: false, workingSince: null, workingBeat: null, stopRequested: false }).where(eq(threads.conversation, job.conversation)).run();
    return ended;
  }
}

/** How settled mail for an agent becomes work: one job per conversation the mail is in, even when one
 * settled batch holds mail from several. Tempo calls this; it is the only caller of admission outside
 * tests. True only when every conversation in the batch has a job that holds all of its waiting mail. Mail
 * that arrived behind a job already there is not admitted by it (Admission.behind), so the answer is
 * false and the settled inbox offers the batch again on every later change. The end of a job is one such
 * change (the root calls Tempo's capacityChanged for every job that ends), and that is when the mail gets
 * its own job. Mail that got none for another reason is not dropped in silence: Jobs.admission tells the
 * agent's owners why, and an admission that threw is recorded the same way here instead of being left to
 * the caller, which could only swallow it. `changed` runs when any job was started or any such notice was
 * newly written. */
export function agentMailAdmission(jobs: Jobs, changed: () => void): AdmitInbox {
  return (who, items) => {
    if (who.kind !== 'agent') return false;
    const conversations = new Set(items.filter(item => item.toKind === 'agent' && item.to === who.id)
      .flatMap(item => item.conversation ? [item.conversation] : []));
    let admitted = 0, started = false, noticed = false;
    for (const id of conversations) {
      let result: Admission;
      try { result = jobs.admission(id); }
      // If even the record cannot be written, the caller hears the error and offers the mail again later.
      catch (error) { result = jobs.failed(id, error); }
      if (result.job && !result.behind) admitted++;
      started ||= result.started === true;
      noticed ||= result.noticed === true;
    }
    if (started || noticed) changed();
    return admitted > 0 && admitted === conversations.size;
  };
}
