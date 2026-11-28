/** The live work trace of a handed-off job (docs/specs/boards.md, "Sessions").
 *
 * A job handed off from a member's private thread works in a child conversation that has no thread, so its
 * work steps cannot be messages. They are kept here instead, beside the child conversation, and never enter the
 * originating thread's transcript: only the child's final reply does (review-result.ts).
 *
 * Words are sealed with the household's words key and kept on the trace's own clock (retention.ts,
 * TRACE_KEEP_DAYS from when the step was written), whatever the household's Comms keep time is. The sweep that
 * erases expired message words deletes an expired step's whole row, so nothing a body reported outlives its keep
 * time, and deleting the originating thread removes the rows. They are read by the member the child conversation
 * belongs to, who is the member of the originating thread, and by nobody else. */
import { and, asc, count, desc, eq, getTableColumns, gt, inArray, like, lt, max, min, or, sql } from 'drizzle-orm';
import { GraphQLBoolean, GraphQLInt, GraphQLList, GraphQLNonNull, GraphQLObjectType, GraphQLString, type GraphQLFieldConfigMap } from 'graphql/index.js';
import type { Viewer } from '../../policy.js';
import type { DataDatabase } from '../data/database.js';
import { selectedQueryFields } from '../data/queries.js';
import { keepReadUntil } from '../data/read-lease.js';
import { markUnscoped, readsOnlyTables } from '../data/table-tracker.js';
import { conversations, jobs, jobTrace } from '../data/schema.js';
import { unlinkHandoffTickets } from './handoff-tickets.js';
import { isCleanLine } from '../line-name.js';
import { OperationError } from '../operations/index.js';
import type { CommsQueryPolicy } from './comms-query.js';
import type { CommsMessages } from './messages.js';
import { traceCutoff, traceDeadline, traceKeepUntil, traceKept } from './retention.js';
import { reviewParent, reviewThread } from './review-place.js';
import type { WordsKey } from './words.js';

type Step = typeof jobTrace.$inferSelect;
/** What a step is (schema 55). `tool`: a tool call or its result, as every step was before. `words`: what the agent
 * said between its tool calls, its own message text. `reasoning`: its reasoning, where the harness gives it readably.
 * All three are sealed, kept, swept and read alike: the kind changes how a step is drawn and nothing else. */
export type TraceKind = Step['kind'];
export const TRACE_KINDS = jobTrace.kind.enumValues;
/** The tool line a step that is not a tool's carries. loom writes it, never the body, so a tool of the same name is
 * still told apart by its kind. */
export const TRACE_KIND_TOOL: Readonly<Record<Exclude<TraceKind, 'tool'>, string>> = Object.freeze({ words: 'Words', reasoning: 'Reasoning' });
export type TraceCard = Pick<Step, 'clientId' | 'tool' | 'cardState'> & { words: string; kind?: TraceKind };
const NO_TRACE = 'Current conversation has no Comms thread';
/** The most steps loom keeps for one job, and for one handoff conversation over all its jobs. A step past either is
 * refused and nothing is stored; the body goes on working (runtime/body-program.ts drops a refused step). A step's
 * words are bounded where they come in: MESSAGE_WORDS_MAX at the door, and the body cuts them at 16,000 characters. */
export const TRACE_STEPS_PER_JOB_MAX = 2_000;
export const TRACE_STEPS_PER_CONVERSATION_MAX = 10_000;
/** A step's tool is the one thing of a step kept unsealed: a short single clean line (core/line-name.ts). */
export const TRACE_TOOL_MAX = 200;
/** The steps one read returns: what it takes when not told, and the most it may be asked for. */
export const TRACE_PAGE_DEFAULT = 100;
export const TRACE_PAGE_MAX = 200;

/** Seal one step before the operation transaction; the returned commit writes it. Only a handoff whose result
 * returns to a member's open private thread keeps a trace: any other is refused as it was before. */
export async function prepareJobTrace(service: CommsMessages, cv: typeof conversations.$inferSelect, job: string, card: TraceCard): Promise<() => { seq: number }> {
  const { db } = service;
  // Checked here, on the server, each time: the job is this conversation's own, and the conversation is a handoff
  // with a member whose result returns to that member's own open thread.
  const origin = () => cv.venue === 'handoff' && cv.member
    && db.select({ id: jobs.id }).from(jobs).where(and(eq(jobs.id, job), eq(jobs.conversation, cv.id))).get() ? reviewThread(db, cv) : undefined;
  if (!origin()) throw new OperationError('not-found', NO_TRACE);
  const kind = card.kind ?? 'tool', tool = kind === 'tool' ? card.tool : TRACE_KIND_TOOL[kind];
  if (tool.length > TRACE_TOOL_MAX || !isCleanLine(tool)) throw new OperationError('invalid', `A step's tool is one line of at most ${TRACE_TOOL_MAX} characters, with no control or invisible formatting characters.`);
  const clientId = job + ':' + card.clientId;
  const saved = () => db.select({ seq: jobTrace.seq }).from(jobTrace).where(and(eq(jobTrace.conversation, cv.id), eq(jobTrace.clientId, clientId))).get();
  const room = () => {
    const kept = (where: ReturnType<typeof eq>) => db.select({ n: count() }).from(jobTrace).where(and(eq(jobTrace.conversation, cv.id), where)).get()!.n;
    if (kept(eq(jobTrace.job, job)) >= TRACE_STEPS_PER_JOB_MAX)
      throw new OperationError('invalid', `This job has reported ${TRACE_STEPS_PER_JOB_MAX} steps, the most loom keeps for one job. Later steps are not recorded; the work itself is not affected.`);
    if (kept(eq(jobTrace.conversation, cv.id)) >= TRACE_STEPS_PER_CONVERSATION_MAX)
      throw new OperationError('invalid', `This session has reported ${TRACE_STEPS_PER_CONVERSATION_MAX} steps, the most loom keeps for one session. Later steps are not recorded; the work itself is not affected.`);
  };
  const old = saved();
  if (old) return () => old;
  room();
  const words = await service.key.seal(card.words);
  return () => {
    if (!origin()) throw new OperationError('not-found', NO_TRACE);
    const retry = saved();
    if (retry) return retry;
    room();
    const at = service.now();
    const seq = (db.select({ seq: max(jobTrace.seq) }).from(jobTrace).where(eq(jobTrace.conversation, cv.id)).get()?.seq ?? 0) + 1;
    db.insert(jobTrace).values({ conversation: cv.id, seq, job, at, tool, cardState: kind === 'tool' ? card.cardState : 'done', clientId, words, keepUntil: traceKeepUntil(at), kind }).run();
    return { seq };
  };
}

/** The sweep's part (CommsMessages.expire): a step goes, row and all, at the earlier of its stamped limit and the
 * trace's age limit. Nothing of it is left: not its tool, not that it happened. A row whose words an earlier program
 * erased and left behind goes at the same time. */
export function expireJobTrace(db: DataDatabase, at: string): number {
  const cutoff = traceCutoff(at);
  return db.delete(jobTrace).where(or(sql`julianday(${jobTrace.keepUntil}) <= julianday(${at})`, sql`julianday(${jobTrace.at}) <= julianday(${cutoff})`))
    .returning({ seq: jobTrace.seq }).all().length;
}

/** When the sweep is next needed for a step, for the one timer that runs it (lifetime.ts). */
export function nextJobTraceExpiry(db: DataDatabase): number | undefined {
  const oldest = db.select({ at: min(jobTrace.at), until: min(jobTrace.keepUntil) }).from(jobTrace).get();
  const next = oldest?.at ? traceDeadline({ at: oldest.at, keepUntil: oldest.until }) : NaN;
  return Number.isFinite(next) ? next : undefined;
}

/** A deleted thread takes the traces of the work handed off from it, as it takes its messages, and the links
 * from those sessions to their tickets: a ticket no longer lists a session whose thread is gone (ticket-sessions.ts).
 * Call before the thread row goes. */
export function eraseThreadJobTrace(db: DataDatabase, origin: string): void {
  const parents = new Set(db.select({ id: jobs.id }).from(jobs).where(eq(jobs.conversation, origin)).all().map(row => row.id));
  if (!parents.size) return;
  const children = db.select({ id: conversations.id, venue: conversations.venue, place: conversations.place }).from(conversations)
    .where(and(eq(conversations.venue, 'handoff'), like(conversations.place, '["codex-review",%'))).all()
    .filter(cv => parents.has(reviewParent(cv) ?? '')).map(cv => cv.id);
  if (!children.length) return;
  db.delete(jobTrace).where(inArray(jobTrace.conversation, children)).run();
  unlinkHandoffTickets(db, children);
}

export class JobTraceQueries {
  constructor(readonly db: DataDatabase, readonly key: WordsKey, readonly policy: CommsQueryPolicy, readonly now: () => string = () => new Date().toISOString()) {}

  private mine(viewer: Viewer, conversation: string) {
    return and(eq(conversations.id, conversation), eq(conversations.venue, 'handoff'), eq(conversations.member, viewer.id), this.policy(viewer, getTableColumns(conversations)));
  }
  /** The latest steps, oldest first; or, with `after`, the earliest steps after that one, so a reader that has a
   * page asks only for what is newer and opens no step twice (a stored step never changes); or, with `before`, the
   * latest steps before that one, oldest first, so a reader can page back to earlier steps. The viewer must be the
   * member the handoff conversation belongs to, under the same conversation rule every Comms read uses; anybody
   * else, and any other venue, reads nothing. */
  steps(viewer: Viewer, input: { conversation: string; job?: string | null; kind?: string | null; limit?: number | null; after?: number | null; before?: number | null }): Step[] {
    const page = input.limit ?? TRACE_PAGE_DEFAULT, after = input.after ?? null, before = input.before ?? null;
    if (!Number.isInteger(page) || page < 1 || page > TRACE_PAGE_MAX) throw new Error('Invalid trace page size');
    if (after !== null && (!Number.isInteger(after) || after < 0)) throw new Error('Invalid trace position');
    if (before !== null && (!Number.isInteger(before) || before < 1)) throw new Error('Invalid trace position');
    if (after !== null && before !== null) throw new Error('Ask for steps after one or before one, not both');
    const kind = input.kind ?? null;
    if (kind !== null && !(TRACE_KINDS as readonly string[]).includes(kind)) throw new Error('Invalid trace step kind');
    if (viewer.kind !== 'member') return [];
    const found = this.db.select(getTableColumns(jobTrace)).from(jobTrace).innerJoin(conversations, eq(conversations.id, jobTrace.conversation))
      .where(and(eq(jobTrace.conversation, input.conversation), input.job ? eq(jobTrace.job, input.job) : undefined,
        kind === null ? undefined : eq(jobTrace.kind, kind as TraceKind), after === null ? undefined : gt(jobTrace.seq, after), before === null ? undefined : lt(jobTrace.seq, before), this.mine(viewer, input.conversation)));
    return after === null ? found.orderBy(desc(jobTrace.seq)).limit(page).all().reverse() : found.orderBy(asc(jobTrace.seq)).limit(page).all();
  }

  /** How many steps the trace holds in all, under the same rule as `steps`: nought for anybody who may not read it. */
  total(viewer: Viewer, input: { conversation: string; job?: string | null }): number {
    if (viewer.kind !== 'member') return 0;
    return this.db.select({ n: count() }).from(jobTrace).innerJoin(conversations, eq(conversations.id, jobTrace.conversation))
      .where(and(eq(jobTrace.conversation, input.conversation), input.job ? eq(jobTrace.job, input.job) : undefined, this.mine(viewer, input.conversation))).get()?.n ?? 0;
  }

  /** Whether a job's steps are past their keep time: it has none, and it was queued longer ago than a step is kept.
   * A step's row goes when it expires, so this is how a reader tells "its steps are no longer kept" from "it never
   * reported one". Worked out from the job's age; nothing is stored for it. False for anybody who may not read the trace. */
  expired(viewer: Viewer, input: { conversation: string; job: string }): boolean {
    if (viewer.kind !== 'member') return false;
    const job = this.db.select({ queuedAt: jobs.queuedAt }).from(jobs).innerJoin(conversations, eq(conversations.id, jobs.conversation))
      .where(and(eq(jobs.id, input.job), this.mine(viewer, input.conversation))).get();
    if (!job || Date.parse(job.queuedAt) > Date.parse(traceCutoff(this.now()))) return false;
    return !this.db.select({ seq: jobTrace.seq }).from(jobTrace).where(and(eq(jobTrace.conversation, input.conversation), eq(jobTrace.job, input.job))).limit(1).get();
  }

  /** Open the kept words. The rows are read again afterwards under the viewer's current rule: a step that is no
   * longer readable, or whose words changed or expired while they were being opened, gives none. */
  async opened(viewer: Viewer, input: Parameters<JobTraceQueries['steps']>[1], retain: (at: number) => void) {
    const kept = (row: Step) => !!row.words && traceKept(row, this.now());
    const before = this.steps(viewer, input), texts = new Map<number, string>();
    for (const row of before) if (kept(row)) texts.set(row.seq, await this.key.open(row.words!));
    const was = new Map(before.map(row => [row.seq, row]));
    return this.steps(viewer, input).map(row => {
      const prior = was.get(row.seq), same = kept(row) && !!prior?.words && prior.words.equals(row.words!) && texts.has(row.seq);
      if (same) retain(traceDeadline(row));
      return { ...row, text: same ? texts.get(row.seq)! : null };
    });
  }

  keepUntil(row: Step): string | null {
    const deadline = row.words ? traceDeadline(row) : NaN;
    return Number.isFinite(deadline) && deadline > Date.parse(this.now()) ? new Date(deadline).toISOString() : null;
  }
}

export function jobTraceFields(service: JobTraceQueries): GraphQLFieldConfigMap<unknown, { viewer: Viewer }> {
  const text = { type: new GraphQLNonNull(GraphQLString) };
  const step = new GraphQLObjectType<Step & { text?: string | null }, { viewer: Viewer }>({ name: 'SessionTraceStep', fields: {
    conversation: text, job: text, at: text, tool: text, cardState: text, clientId: text,
    kind: { type: new GraphQLNonNull(GraphQLString), description: 'tool, words (the agent\'s own words between its tool calls) or reasoning (its reasoning, where the harness gave it readably). Every step before schema 55 is tool.' },
    seq: { type: new GraphQLNonNull(GraphQLInt) },
    words: { type: GraphQLString, resolve: row => row.text ?? null },
    wordsKeepUntil: { type: GraphQLString, resolve: row => service.keepUntil(row) },
  } });
  // Inspected for live scoping (t-2431): the trace and its count read only the shared connection, and the steps'
  // keeping time is when the conversation lifetime sweep writes them (lifetime.ts). Whether a job's steps have
  // all expired turns on its age alone, which nothing writes at: that one reads the clock.
  return {
    ...readsOnlyTables({ sessionTrace: { type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(step))),
      args: { conversation: text, job: { type: GraphQLString },
        kind: { type: GraphQLString, description: 'Only steps of this kind: tool, words or reasoning.' }, limit: { type: GraphQLInt, defaultValue: TRACE_PAGE_DEFAULT },
        after: { type: GraphQLInt, description: 'Only steps after this seq, earliest first. A stored step never changes, so a reader that has some asks only for newer ones.' },
        before: { type: GraphQLInt, description: 'Only steps before this seq: the latest page of them, oldest first. How a reader loads earlier steps.' } },
      resolve: (_row, args: { conversation: string; job?: string | null; kind?: string | null; limit?: number | null; after?: number | null; before?: number | null }, context, info) =>
        selectedQueryFields(info).has('words') ? service.opened(context.viewer, args, until => keepReadUntil(context, until)) : service.steps(context.viewer, args) },
    sessionTraceCount: { type: new GraphQLNonNull(GraphQLInt), args: { conversation: text, job: { type: GraphQLString } },
      description: 'How many steps the trace holds in all; nought for anybody who may not read it.',
      resolve: (_row, args: { conversation: string; job?: string | null }, context) => service.total(context.viewer, args) } }),
    sessionTraceExpired: { type: new GraphQLNonNull(GraphQLBoolean), args: { conversation: text, job: text },
      description: 'The job has no steps and is older than a step is kept: any it reported are no longer kept.',
      resolve: (_row, args: { conversation: string; job: string }, context) => { markUnscoped('the clock (a job\'s age)'); return service.expired(context.viewer, args); } },
  };
}
