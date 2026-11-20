import { closePendingReview, hasChangeReview } from '../apps/change-reviews.js';
import {keepJobText} from './job-text.js';
/** Trusted job lifecycle. The worker executes; this service only changes records.
 * External machine identity is checked at the API door before calling it. */
import { mailWords } from '../core/conversations/volume.js';
import { randomUUID } from 'node:crypto';
import { and, asc, desc, eq, gt, inArray, isNull, ne, or, sql } from 'drizzle-orm';
import type { DataDatabase } from '../core/data/database.js';
import { agentModels, agentRunSettings, agents, bridgeIncoming, conversations, inbox, inboxRefs, jobNeeds, jobs, jobUsage, programFirings, messages, threads, triggers, turns } from '../core/data/schema.js';
import { agentsPeople } from '../policy.js';
import { sharedSharing } from '../shared-sharing.js';
import { OWNERS_KEY, askers, named, privateRefusal, stillKnown } from '../shared-place-mail.js';
import { Threads } from '../core/conversations/threads.js';
import { Conversations, lateMailWaits } from '../core/conversations/index.js';
import { finishProgramFiring, logTrigger } from '../core/tempo/triggers.js';
import type { AdmitInbox } from '../core/tempo/settle.js';
import { wakePlaceTriggers } from '../core/tempo/tempo.js';
import { BODY_EXIT, LOOM_EXIT, type WorkerExitBy } from './job-exit.js';
import { claimedJobStates, jobUnended, unendedJobStates } from '../core/data/job-states.js';
import { CONTACT_PROBE_MS, REPORT_MS, SILENCE_MS, WORKER_FAILURE_OBSERVATION_MS } from './silence.js';
import { LOG_TAIL_MAX } from './log-tail.js';

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
/** What loom records on a job of somebody who is not an owner that it set aside, before any machine took it, because
 * an owner's mail came to wait in its conversation (Jobs.admission). Not a failure: nothing ran, and its mail waits. */
export const SET_ASIDE_NOTE = 'Set aside before any machine took it: mail on the owners\' word came to this conversation, and the owners\' job goes first. Its mail waits for a job of its own.';
/** What loom records on the mail of an owners' job a person ended: why that request waits for nothing (Jobs.stop). */
export const STOPPED_NOTE = { stop: 'Stopped: a person said stop where the work was', reset: 'Ended by hand (reset)', 'write-off': 'Ended by hand (write-off)' } as const;
/** What admission answers: the conversation's unended job, or why its waiting mail did not become one. */
export interface Admission {
  job?: Job;
  /** Whether this call started that job. */
  started?: boolean;
  /** That job does not hold all of the conversation's waiting mail: some arrived after it was admitted, or
   * was somebody else's request when it was formed (one job holds one asker's mail). A body takes mail once,
   * so that mail may never reach it, and it is not admitted until it is held by a job. It becomes one when
   * this job has ended and admission is asked again. */
  behind?: boolean;
  /** Why mail that is waiting got no job, in loom's own words. Absent when there was nothing to admit. */
  declined?: string;
  /** Whether this call told the agent's owners so for the first time, or told them of mail it dropped
   * because the person on whose word it was sent is no longer known (wordUnknown). */
  noticed?: boolean;
}
export class Jobs {
  private readonly mail: Conversations;
  constructor(readonly db: DataDatabase, readonly now: () => string) { this.mail = new Conversations(db, now, lateMailWaits); }

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

  /** Queue a scheduled program in its wake conversation. Tempo records the firing and its frozen input
   * in the same transaction. A current job in the conversation takes precedence. */
  admitProgram(trigger: typeof triggers.$inferSelect, conversation: string, words: string): string | undefined {
    const agent = trigger.to!;
    const profile = this.db.select().from(agents).where(eq(agents.id, agent)).get();
    const settings = this.db.select().from(agentRunSettings).where(eq(agentRunSettings.agent, agent)).get();
    if (!profile || profile.removedAt || !settings) throw new Error('Program needs a current agent with a configured house');
    const busy = this.db.select({ id: jobs.id }).from(jobs).where(and(eq(jobs.conversation, conversation), inArray(jobs.state, unendedJobStates))).get();
    if (busy) return undefined;
    const job = this.db.insert(jobs).values({ id: `job-${randomUUID()}`, agent, conversation, project: trigger.project,
      title: trigger.note, state: 'queued', brief: words, model: '', startedByKind: 'program', startedBy: trigger.id,
      houseRepository: settings.houseRepository, houseFile: settings.houseFile, houseBranch: settings.houseBranch,
      prefers: trigger.prefers ?? settings.prefers, queuedAt: this.now() }).returning({ id: jobs.id }).get();
    if (trigger.needs?.length) this.db.insert(jobNeeds).values(trigger.needs.map(need => ({ job: job.id, need }))).run();
    return job.id;
  }

  /** Called after inbox settling. Repeated admission returns the same active job, whether or not it holds
   * the mail that is waiting now (see Admission.behind).
   * Work that ran out of attempts and work that was stopped need fresh mail to resume.
   *
   * One job holds one asker's mail (shared-place-mail.ts, askers): reach follows who asked, never who else
   * is in the room. Owners first (the owner's ruling, 2026-11-18): when fresh mail on the owners' key waits,
   * with the agent's own work, that job is formed; otherwise the oldest fresh mail decides whose job this is.
   * Fresh mail is mail no job has been formed for. Whatever is fresh on another key waits for a job of its
   * own, formed when this one has ended: jobs in one conversation run one at a time.
   *
   * Mail an ended job left behind (out of attempts, never placed, stopped, parked by a stop word) is never
   * revived by somebody else. It goes into a job only when its own asker next writes: fresh mail on the same
   * key takes it along. Mail on another key forms no job from it, and it is never handed back as fresh, so
   * two askers' failing mail cannot re-job each other with nobody writing.
   *
   * One exception, which loom itself makes. A job on anybody else's key that no machine has taken yet holds
   * no owner behind it: when mail on the owners' key comes to wait while such a job is still queued, that
   * job is set aside (stopped by loom, with SET_ASIDE_NOTE) and the owners' job is formed in the same write.
   * Mail of a set-aside job counts as fresh: it is jobbed again after the owners' job with nobody writing,
   * and the new job takes the set-aside job's place in its chain of attempts, so the count carries on. A job
   * a machine has claimed is not interrupted. A conversation still has one unended job. */
  admit(conversationId: string): Job | undefined { return this.admission(conversationId).job; }

  /** The notices that say why this mail got no job: one for each of the agent's owners, or for the household's
   * owners when the agent has none. Keyed by the first piece of mail that was held up, so each time an
   * agent becomes unable to run is told once however often admission is asked. */
  private declined(agent: string, mail: readonly Pick<typeof inbox.$inferSelect, 'id'>[], why: string): Admission {
    const key = (item: string) => `mail-not-admitted:${JSON.stringify([agent, item])}`;
    const to = agentsPeople(agent, sharedSharing(this.db));
    let noticed = false;
    for (const member of to) {
      const before = this.db.select({ id: inbox.id }).from(inbox).where(and(eq(inbox.toKind, 'person'), eq(inbox.to, member), eq(inbox.source, 'notice'), eq(inbox.sourceId, key(mail[0].id)))).get();
      this.mail.send({ toKind: 'person', to: member, member, source: 'notice', sourceId: key(mail[0].id), fromKind: 'unknown',
        words: `Mail for ${agent} is waiting and no work was started: ${why}.`, refs: [agent] });
      noticed ||= !before;
    }
    return { declined: why, noticed };
  }

  /** Mail that runs on somebody's word without that person speaking now: a note from another body of this
   * agent, and a trigger's firing in a named conversation. It gets what that person would get, so when that
   * person is no longer known to the agent (shared-place-mail.ts, stillKnown: the one meaning, asked of a
   * trigger's asker as it fires) it starts nothing. It is closed with that reason, and the people the
   * agent's notices go to are told. Asked as a job is about to start, of everything then waiting: mail
   * parked by a stop word is asked about when it is released, not when it is parked. The same is asked of a
   * conversation that is one member's private one: mail on anybody else's word is not delivered into it. A brief from another
   * agent is not this: its word is known to the agent that sent it, and is the key it is jobbed by (jobWord). */
  private wordUnknown(agent: string, member: string | null, mail: readonly (typeof inbox.$inferSelect)[]): Set<string> {
    const gone = new Set<string>();
    for (const item of mail) {
      if (!item.onWordKind || !item.onWord || !(item.source === 'trigger' || (item.source === 'handoff' && item.fromKind === 'agent' && item.fromId === agent))) continue;
      const who = { kind: item.onWordKind, id: item.onWord };
      // And into one member's private conversation only that member's word goes (the agent's own work has no word).
      const why = stillKnown(this.db, agent, who) ? privateRefusal(member, who)?.replace('who asked for it', 'on whose word it was sent') : `${named(who)}, on whose word it was sent, is no longer known to ${agent}`;
      if (!why) continue;
      this.mail.resolveItem(item.id, why); gone.add(item.id);
      for (const member of agentsPeople(agent, sharedSharing(this.db))) this.mail.send({ toKind: 'person', to: member, member, source: 'notice', sourceId: `word-unknown:${item.id}`, fromKind: 'unknown',
        words: `${item.source === 'trigger' ? 'A firing of a schedule' : `A note between bodies of ${agent}`} in conversation ${item.conversation} was dropped and started no work: ${why}.`, refs: [agent] });
    }
    return gone;
  }

  /** admit(), and when waiting mail got no job, why. That is recorded as a notice to the agent's owners
   * (see declined), and the notice is closed when the mail is admitted after all. */
  admission(conversationId: string): Admission {
    return this.db.transaction(() => {
      const conversation = this.db.select().from(conversations).where(eq(conversations.id, conversationId)).get();
      if (!conversation) throw new Error('Conversation not found');
      if (conversation.venue === 'terminal') return { declined: 'This conversation runs on its terminal' };
      const existing = this.db.select().from(jobs).where(and(eq(jobs.conversation, conversationId), inArray(jobs.state, unendedJobStates))).get();
      const waits = () => this.db.select().from(inbox).where(and(eq(inbox.conversation, conversationId), eq(inbox.toKind, 'agent'), eq(inbox.to, conversation.agent), eq(inbox.state, 'waiting'), ne(inbox.volume, 'mute'))).orderBy(asc(inbox.seq)).all();
      const waiting = waits();
      // The jobs loom set aside for an owner whose mail still waits: that mail starts a job again, with nobody writing.
      const aside = () => { const bound = [...new Set(waiting.flatMap(item => item.job ? [item.job] : []))];
        return new Map((bound.length ? this.db.select().from(jobs).where(and(inArray(jobs.id, bound), eq(jobs.state, 'stopped'), eq(jobs.endedNote, SET_ASIDE_NOTE))).all() : []).map(row => [row.id, row])); };
      let setAside = aside();
      /** Mail that may start a job: mail no job has been formed for, and mail of a job loom set aside. */
      const fresh = (item: typeof waiting[number]) => item.job === null || setAside.has(item.job);
      if (existing) {
        const behind = waiting.filter(item => item.job !== existing.id && fresh(item)), held = waiting.filter(item => item.job === existing.id);
        // Owners first: a queued job nobody has claimed, on anybody else's key, with owners' mail behind it, is set aside.
        const key = existing.state === 'queued' && held.length && behind.length ? askers(this.db, { agent: conversation.agent, conversation: conversationId }) : undefined;
        if (!key || key(held[0].id) === OWNERS_KEY || !behind.some(item => key(item.id) === OWNERS_KEY)) return { job: existing, behind: behind.length > 0 };
        this.end(existing, 'stopped', { endedAt: this.now(), endedNote: SET_ASIDE_NOTE });
        setAside = aside();
      }
      if (!waiting.length) return {};
      // A waiting row's job is its last admission attempt, even before take().
      // New mail has no job: no timestamp comparison can lose same-tick mail.
      if (!waiting.some(fresh)) return {};
      // A person said stop in this place (stop, below). Until a person speaks there again nothing starts: the
      // notes and firings that were waiting are parked with the stopped job, and one that arrives meanwhile
      // waits with them. Only a bridge's place: a lane's own conversation goes on at its next time.
      // A person speaking is mail from a member, or a delivered bridge message from an account that is no bot
      // and no webhook: mail from a sender loom cannot name is otherwise nobody speaking.
      const spoke = (item: typeof waiting[number]) => item.fromKind === 'person' || (item.fromKind === 'unknown' && !!this.db.select({ id: bridgeIncoming.id }).from(inboxRefs)
        .innerJoin(bridgeIncoming, eq(bridgeIncoming.id, inboxRefs.ref)).where(and(eq(inboxRefs.item, item.id), eq(bridgeIncoming.conversation, conversationId), eq(bridgeIncoming.state, 'delivered'),
          or(isNull(bridgeIncoming.bot), eq(bridgeIncoming.bot, false)), or(isNull(bridgeIncoming.webhook), eq(bridgeIncoming.webhook, false)))).get());
      if ((conversation.venue === 'discord' || conversation.venue === 'slack') && !waiting.some(item => fresh(item) && spoke(item))) {
        const last = this.db.select({ state: jobs.state, endedReason: jobs.endedReason }).from(jobs).where(eq(jobs.conversation, conversationId)).orderBy(desc(jobs.queuedAt), desc(sql`${jobs}.rowid`)).get();
        if (last?.state === 'stopped' && last.endedReason === 'stop') return {};
      }
      // Work is about to start for what waits here. First, what was sent on the word of somebody no longer known is dropped.
      const gone = this.wordUnknown(conversation.agent, conversation.member, waiting), mail = waiting.filter(item => !gone.has(item.id));
      if (!mail.some(fresh)) return gone.size ? { noticed: true } : {};
      const settings = this.db.select().from(agentRunSettings).where(eq(agentRunSettings.agent, conversation.agent)).get();
      const model = this.db.select().from(agentModels).where(eq(agentModels.agent, conversation.agent)).orderBy(asc(agentModels.position), asc(agentModels.model)).get();
      // A removed agent keeps its history and its mail, and does not run.
      if (this.db.select({ removedAt: agents.removedAt }).from(agents).where(eq(agents.id, conversation.agent)).get()?.removedAt)
        return this.declined(conversation.agent, mail, 'the agent has been removed');
      if (!settings) return this.declined(conversation.agent, mail, 'the agent has no run settings');
      if (!model) return this.declined(conversation.agent, mail, 'the agent has no model to run on');
      const at = this.now();
      const key = askers(this.db, { agent: conversation.agent, conversation: conversationId });
      const starters = mail.filter(fresh), asked = starters.some(item => key(item.id) === OWNERS_KEY) ? OWNERS_KEY : key(starters[0].id);
      // Everything waiting on that key goes along, what an ended job left behind on it included. Nothing on another key does.
      const mine = mail.filter(item => key(item.id) === asked), behind = starters.some(item => key(item.id) !== asked);
      // A job that takes up what loom set aside stands where that job stood among its attempts.
      const resumed = mine.map(item => item.job ? setAside.get(item.job) : undefined).find(row => row !== undefined);
      // Place firings carry a trigger reference even in an ordinary conversation. A hand-started
      // wake may have only its place. Only schedule mail contributes trigger references.
      const fired = mine.filter(item => item.source === 'trigger' && item.fromKind === 'schedule').map(item => item.id);
      const refs = fired.length ? this.db.select({ id: inboxRefs.ref }).from(inboxRefs)
        .where(inArray(inboxRefs.item, fired)).all().map(row => row.id) : [];
      if (fired.length && !refs.length && conversation.venue === 'wake') {
        for (const id of wakePlaceTriggers(conversation.place)) {
          if (this.db.select({ id: triggers.id }).from(triggers).where(eq(triggers.id, id)).get()) { refs.push(id); break; }
        }
      }
      const lanes = refs.length ? this.db.select({ needs: triggers.needs, prefers: triggers.prefers }).from(triggers)
        .where(inArray(triggers.id, refs)).orderBy(asc(triggers.id)).all() : [];
      const needs = new Set(lanes.flatMap(lane => lane.needs ?? []));
      if (settings.gpu) needs.add('gpu');
      const prefers = lanes.some(lane => lane.prefers !== null)
        ? [...new Set(lanes.flatMap(lane => lane.prefers ?? []))] : settings.prefers;
      const job = this.db.insert(jobs).values({
        id: `job-${randomUUID()}`, agent: conversation.agent, conversation: conversationId,
        project: conversation.project, member: conversation.member, title: conversation.label,
        // Comms and handoff words are delivered ephemerally by ConversationMail.
        // No private conversation or encrypted brief is copied into the job.
        state: 'queued', prefers, brief: !keepJobText(conversation) ? '' : mine.filter(item => item.source !== 'handoff').map(item => mailWords(item.volume, item.words) ?? '').join('\n\n'), model: model.model,
        // Inbox admission is automatic work started by the receiving agent.
        // The actual sender and source remain on each inbox item.
        startedByKind: 'agent', startedBy: conversation.agent,
        houseRepository: settings.houseRepository, houseFile: settings.houseFile, houseBranch: settings.houseBranch, queuedAt: at,
        ...(resumed?.retryOf ? { retryOf: resumed.retryOf } : {}),
      }).returning().get();
      if (needs.size) this.db.insert(jobNeeds).values([...needs].map(need => ({ job: job.id, need }))).run();
      const waitingHere = and(eq(inbox.conversation, conversationId), eq(inbox.toKind, 'agent'), eq(inbox.to, conversation.agent), eq(inbox.state, 'waiting'), ne(inbox.volume, 'mute'));
      this.db.update(inbox).set({ job: job.id, changedAt: at }).where(and(waitingHere, inArray(inbox.id, mine.map(item => item.id)))).run();
      this.delivery(job.id,'held');
      for (const item of mail) this.mail.resolveSource('notice', `mail-not-admitted:${JSON.stringify([conversation.agent, item.id])}`, 'Work was started');
      return { job, started: true, ...(behind ? { behind: true } : {}) };
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
      if (job.startedByKind === 'terminal' || job.state !== 'queued' || (job.retryAt && job.retryAt > at)) return;
      const claimed = this.db.update(jobs).set({ box, state: 'starting', claimedAt: at, heardAt: at })
        .where(and(eq(jobs.id, id), eq(jobs.state, 'queued'))).returning().get();
      if(claimed)this.delivery(id,'sending');
      return claimed;
    }, { behavior: 'immediate' });
  }

  private assigned(id: string, box: string, states: readonly Job['state'][]): Job {
    const job = this.get(id);
    if (job.startedByKind === 'terminal' || job.box !== box || !states.includes(job.state)) throw new Error('Job is not assigned in this state');
    return job;
  }

  started(id: string, box: string, build: string): Job {
    return this.db.transaction(() => {
      // A worker may report "started" late or twice. Once the job is running that report changes nothing.
      const job = this.assigned(id, box, claimedJobStates);
      if (job.state !== 'starting') return job;
      const at = this.now();
      if (job.startedByKind === 'program' && job.conversation) this.mail.turn({
        conversation: job.conversation, kind: 'action', fromKind: 'schedule', fromId: job.startedBy, run: job.id, model: 'program',
      }, at);
      return this.db.update(jobs).set({ state: 'running', build, heardAt: at }).where(eq(jobs.id, id)).returning().get()!;
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
    new Threads(this.db, this.now, lateMailWaits).takeStop(asked.thread);
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
  finish(id: string, box: string, exitCode: number, logTail = '', exitBy?: WorkerExitBy): { job: Job; retry?: Job } {
    return this.db.transaction(() => {
      const before = this.assigned(id, box, claimedJobStates);
      const at = this.now();
      // A body that says it left for a Stop is believed only while that Stop is still waiting for this job.
      const stopped = exitCode === BODY_EXIT.stopped ? this.endIfStopAsked(before, { exitCode, exitBy: exitBy ?? null }) : undefined;
      if (stopped) return { job: stopped };
      // A runner's stdout/stderr can contain the private prompt or reply.
      const failed = before.state === 'starting' || exitCode !== 0;
      const held = (states: readonly (typeof inbox.$inferSelect)['state'][]) =>
        !!this.db.select({ id: inbox.id }).from(inbox).where(and(eq(inbox.job, id), inArray(inbox.state, states))).get();
      const progressed = !failed && held(['done']), unsettled = !failed && !progressed && held(['waiting', 'taken']);
      // Work someone asked to stop is not run again because its body died before noticing.
      if (failed || unsettled) { const asked = this.endIfStopAsked(before, { exitCode }); if (asked) return { job: asked }; }
      const job = this.end(before, failed ? 'failed' : 'done',
        { exitCode, exitBy: exitBy ?? null, logTail: this.keepText(before) ? logTail.slice(-LOG_TAIL_MAX) : null, endedAt: at, ...(unsettled ? { endedNote: UNSETTLED_NOTE } : {}) });
      if (progressed) { this.db.update(inbox).set({ job: null }).where(and(eq(inbox.job, id), eq(inbox.state, 'waiting'))).run(); return { job }; }
      const retry = this.retry(before, at);
      // Out of attempts: what this body left was not delivered, and says so like a failure's.
      if (unsettled && !retry) this.delivery(id, 'failed');
      return retry ? { job, retry } : { job };
    }, { behavior: 'immediate' });
  }

  /** Queue the next attempt of work whose last attempt ended with a reason to run again, if it has any left. */
  private retry(before: Job, at: string, earliest = -Infinity): Job | undefined {
    if (before.startedByKind === 'program' || hasChangeReview(this.db, before.id)) return undefined;
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
    const backoff = (before.state === 'starting' ? START_RETRY_MS : RUN_RETRY_MS)[depth];
    const retryAt = new Date(Math.max(earliest, Date.parse(at) + backoff)).toISOString();
    const retry = this.db.insert(jobs).values({ ...snapshot, brief: this.keepText(before) ? before.brief : '', id: `job-${randomUUID()}`, state: 'queued', box: null, account: null, harness: null,
      placementDecision: null, retryOf: before.id, retryAt, queuedAt: at,
      claimedAt: null, heardAt: null, endedAt: null, build: null, exitCode: null, exitBy: null, logTail: null, endedNote: null,
    }).returning().get();
    for (const need of this.db.select().from(jobNeeds).where(eq(jobNeeds.job, before.id)).all()) this.db.insert(jobNeeds).values({ job: retry.id, need: need.need }).run();
    this.db.update(inbox).set({ job: retry.id, changedAt: at }).where(unconfirmed).run();
    this.delivery(retry.id,'held');
    return retry;
  }

  /** `stop` is a person's Stop said where the work is: Comms' Stop, taken by the job (endIfStopAsked), or a
   * bridge's stop word (pieces/bridges/incoming.ts). `reset` and `write-off` are an owner ending a job by hand. */
  stop(id: string, member: string, reason: 'reset' | 'write-off' | 'stop'): Job {
    return this.db.transaction(() => {
      const job = this.get(id);
      if (job.startedByKind === 'terminal') throw new Error('This terminal is controlled on its machine');
      if (!jobUnended(job.state)) throw new Error('Job has ended');
      const ended = this.end(job, 'stopped', { endedBy: member, endedReason: reason, endedAt: this.now() });
      // A person ending an owners' job settles that request. Its mail is closed with the reason and does not wait: left
      // waiting, it would be jobbed again at owners' reach by the next mail on the owners' key, a firing's included,
      // and a stop would not stay said. A job on anybody else's key keeps its mail, which only that person's next
      // message takes up. Asked before anything is parked below: what is parked was never this job's request.
      const own = job.conversation ? this.db.select({ id: inbox.id }).from(inbox).where(and(eq(inbox.job, id), eq(inbox.state, 'waiting'))).all() : [];
      if (own.length) { const key = askers(this.db, { agent: job.agent, conversation: job.conversation! });
        if (own.every(item => key(item.id) === OWNERS_KEY)) for (const item of own) this.mail.resolveItem(item.id, STOPPED_NOTE[reason]); }
      // A person said stop where the work is. Mail waiting there that no person sent (a note from another
      // body, a trigger's firing) and that no job has taken would start the next job as if nobody had: it is
      // given to the stopped job, which is what "waits for fresh mail" means for the mail that job took
      // (end, above). It is not lost: the next thing a person says there brings it along.
      // Only in a bridge's place, where admission waits for a person to speak; elsewhere mail is left as it was.
      const venue = job.conversation ? this.db.select({ venue: conversations.venue }).from(conversations).where(eq(conversations.id, job.conversation)).get()?.venue : undefined;
      if (reason === 'stop' && job.conversation && (venue === 'discord' || venue === 'slack')) this.db.update(inbox).set({ job: job.id })
        .where(and(eq(inbox.conversation, job.conversation), eq(inbox.toKind, 'agent'), eq(inbox.state, 'waiting'), isNull(inbox.job), inArray(inbox.fromKind, ['agent', 'schedule']))).run();
      return ended;
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
  sweep(silenceMs = SILENCE_MS, queueMs = QUEUE_DEADLINE_MS, listeningSince = -Infinity): Job[] {
    if (!Number.isFinite(silenceMs) || silenceMs <= 0 || !Number.isFinite(queueMs) || queueMs <= 0) throw new Error('Invalid silence interval');
    return this.db.transaction(() => {
      const at = this.now(), now = Date.parse(at);
      // Only a clock that has since been set back leaves a report stamped later than now. Its true age is
      // unknown; counting from now delays noticing a dead job by one interval and never loses a live one.
      this.db.update(jobs).set({ heardAt: at }).where(and(ne(jobs.startedByKind, 'terminal'), inArray(jobs.state, claimedJobStates), gt(jobs.heardAt, at))).run();
      const lost = this.db.select().from(jobs).where(and(ne(jobs.startedByKind, 'terminal'), inArray(jobs.state, claimedJobStates))).all()
        .filter(job => now - Math.max(listeningSince, Date.parse(job.heardAt ?? job.claimedAt ?? job.queuedAt)) > silenceMs)
        .map(job => {
          const seconds = Math.floor((now - Math.max(listeningSince, Date.parse(job.heardAt ?? job.claimedAt ?? job.queuedAt))) / 1000);
          const endedNote = `Lost while ${job.state}: no worker report for ${seconds}s while loom was listening`;
          const asked = this.endIfStopAsked(job, { endedNote });
          if (asked) return asked;
          const ended = this.end(job, 'lost', { endedAt: at, endedNote });
          // Under a partition, the worker discovers silence on its next pulse, then
          // gets a full interval and a last probe. Avoid starting its successor while
          // the earlier slot can still be executing. A late sweep adds no extra wait.
          const lastReport = Date.parse(job.heardAt ?? job.claimedAt ?? job.queuedAt);
          this.retry(job, at, lastReport + silenceMs + WORKER_FAILURE_OBSERVATION_MS + CONTACT_PROBE_MS + REPORT_MS);
          return ended;
        });
      const unplaced = this.db.select().from(jobs).where(eq(jobs.state, 'queued')).all()
        .filter(job => now - Math.max(Date.parse(job.queuedAt), job.retryAt ? Date.parse(job.retryAt) : 0) > queueMs)
        .map(job => this.end(job, 'failed', { endedAt: at, exitCode: LOOM_EXIT.unplaced, exitBy: 'loom',
          endedNote: `Never started: no machine took it within ${Math.round(queueMs / 3_600_000)} hours` }));
      return [...lost, ...unplaced];
    }, { behavior: 'immediate' });
  }

  /** Ends a queued job that can never be placed, at once and with the reason, instead of leaving it to the
   * queue deadline. Like a job the deadline ends, it is failed by loom and not tried again. `settle` is the
   * mail that makes it unplaceable (for a job on anybody else's word, the mail that makes it so): that mail
   * is closed with the same reason, in the same write. Left waiting it would go to the job the next fresh
   * mail starts (admission marks everything that waits), make that job unplaceable too, and so on for every
   * later message in the conversation. The rest of its mail waits as before, for that next job. Whether a
   * job is such a one, and which mail makes it so, is the dispatcher's to say (Dispatcher.next). */
  unplaceable(id: string, note: string, settle: readonly string[] = []): Job | undefined {
    return this.db.transaction(() => {
      const job = this.db.select().from(jobs).where(eq(jobs.id, id)).get();
      if (!job || job.state !== 'queued') return undefined;
      const ended = this.end(job, 'failed', { endedAt: this.now(), exitCode: LOOM_EXIT.unplaced, exitBy: 'loom', endedNote: note });
      for (const item of this.db.select({ id: inbox.id }).from(inbox).where(and(eq(inbox.job, id), eq(inbox.state, 'waiting'))).all())
        if (settle.includes(item.id)) this.mail.resolveItem(item.id, note);
      return ended;
    }, { behavior: 'immediate' });
  }

  private end(job: Job, state: Job['state'], values: Partial<Job>): Job {
    const program = job.startedByKind === 'program';
    const firing = program && this.db.select().from(programFirings).where(eq(programFirings.job, job.id)).get();
    const line = firing && (state === 'done' ? firing.line : 'Program did not complete.');
    const ended = this.db.update(jobs).set({ ...values, ...(line && {endedNote: line}), state }).where(eq(jobs.id, job.id)).returning().get()!;
    closePendingReview(this.db, job.id, ended.endedAt ?? this.now());
    const started = program && this.db.select({ at: turns.at }).from(turns).where(and(eq(turns.run, job.id), eq(turns.kind, 'action'))).get();
    const began = program ? started && started.at : job.claimedAt;
    const wallMs = began && ended.endedAt ? Math.max(0, Date.parse(ended.endedAt) - Date.parse(began)) : null;
    if (program) {
      if (firing) {
        const woke = this.db.select({id: inbox.id}).from(inbox).where(and(eq(inbox.source, 'trigger'), eq(inbox.sourceId, firing.id), eq(inbox.to, job.agent))).get();
        const posted = this.db.select({seq: turns.seq}).from(turns).where(and(eq(turns.kind, 'reply'), eq(turns.run, job.id))).get();
        const decision = state === 'done' ? (woke ? 'Woke ' + job.agent : 'Did not wake') : state[0].toUpperCase() + state.slice(1);
        const note = [decision, posted && 'posted', wallMs !== null && wallMs + ' ms', line].filter(Boolean).join(' · ');
        logTrigger(this.db, ended.endedAt ?? this.now(), firing.trigger, 'program', note);
        if (state === 'failed' || state === 'lost') {
          for (const member of agentsPeople(job.agent, sharedSharing(this.db))) {
            this.mail.send({toKind:'person', to:member, member, agent:job.agent, source:'notice',
              sourceId:'program-failure:'+job.id, fromKind:'schedule', fromId:firing.trigger,
              words:`Scheduled program ${firing.program.name} for ${job.agent} ${state}.`, refs:[firing.trigger,job.id]});
          }
        }
      }
      if (firing && state !== 'done') finishProgramFiring(this.db, firing, 'failed', 'Program did not complete.');
      if (job.conversation) this.mail.turn({ conversation: job.conversation, kind: 'action', fromKind: 'schedule', fromId: job.startedBy,
        run: job.id, model: 'program', outcome: state === 'done' ? 'progressed' : 'failed', latencyMs: wallMs }, ended.endedAt ?? this.now());
    }
    this.db.insert(jobUsage).values({ job: job.id, source: program ? 'program' : 'none', harness: job.harness, model: job.model, wallMs,
      ...(program && { tokensIn: 0, tokensOut: 0, cacheRead: 0, cacheWritten: 0, modelCalls: 0, toolCalls: 0 }) })
      .onConflictDoUpdate({ target: jobUsage.job, set: { wallMs: sql`coalesce(${wallMs}, ${jobUsage.wallMs})` } }).run();
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

/** Every job filed under one project is filed under another: for a merge of the two (shared-projects.ts).
 * A job keeps the labels of its conversation, which is refiled in the same write. */
export function refileJobs(db: DataDatabase, from: string, into: string): void {
  db.update(jobs).set({ project: into }).where(eq(jobs.project, from)).run();
}
