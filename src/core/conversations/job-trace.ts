/** The live work trace of a handed-off job (docs/specs/boards.md, "Sessions").
 *
 * A job handed off from a member's private thread works in a child conversation that has no thread, so its
 * work steps cannot be messages. They are kept here instead, beside the child conversation, and never enter the
 * originating thread's transcript: only the child's final reply does (review-result.ts).
 *
 * Words are sealed with the household's words key, stamped with the keep time a message written at the same
 * moment gets, erased by the same sweep, and removed when the originating thread is deleted. They are read
 * by the member the child conversation belongs to, who is the member of the originating thread, and by nobody else. */
import { and, desc, eq, getTableColumns, inArray, isNotNull, like, max, min, or, sql } from 'drizzle-orm';
import { GraphQLInt, GraphQLList, GraphQLNonNull, GraphQLObjectType, GraphQLString, type GraphQLFieldConfigMap } from 'graphql/index.js';
import type { Viewer } from '../../policy.js';
import type { DataDatabase } from '../data/database.js';
import { commsKeepDays } from '../data/comms-days.js';
import { selectedQueryFields } from '../data/queries.js';
import { keepReadUntil } from '../data/read-lease.js';
import { conversations, jobs, jobTrace } from '../data/schema.js';
import { OperationError } from '../operations/index.js';
import type { CommsQueryPolicy } from './comms-query.js';
import type { CommsMessages } from './messages.js';
import { ageLimit, keepUntilFor, validKeepDays, wordsDeadline, wordsKept } from './retention.js';
import { reviewParent, reviewThread } from './review-place.js';
import type { WordsKey } from './words.js';

type Step = typeof jobTrace.$inferSelect;
export type TraceCard = Pick<Step, 'clientId' | 'tool' | 'cardState'> & { words: string };
const NO_TRACE = 'Current conversation has no Comms thread';

/** Seal one step before the operation transaction; the returned commit writes it. Only a handoff whose result
 * returns to a member's open private thread keeps a trace: any other is refused as it was before. */
export async function prepareJobTrace(service: CommsMessages, cv: typeof conversations.$inferSelect, job: string, card: TraceCard): Promise<() => { seq: number }> {
  const { db } = service;
  const origin = () => cv.venue === 'handoff' && cv.member ? reviewThread(db, cv) : undefined;
  if (!origin()) throw new OperationError('not-found', NO_TRACE);
  const clientId = job + ':' + card.clientId;
  const saved = () => db.select({ seq: jobTrace.seq }).from(jobTrace).where(and(eq(jobTrace.conversation, cv.id), eq(jobTrace.clientId, clientId))).get();
  const old = saved();
  if (old) return () => old;
  const words = await service.key.seal(card.words);
  return () => {
    if (!origin()) throw new OperationError('not-found', NO_TRACE);
    const retry = saved();
    if (retry) return retry;
    const days = commsKeepDays(db), at = service.now();
    if (!validKeepDays(days)) throw new Error('Invalid Comms keep time');
    const seq = (db.select({ seq: max(jobTrace.seq) }).from(jobTrace).where(eq(jobTrace.conversation, cv.id)).get()?.seq ?? 0) + 1;
    db.insert(jobTrace).values({ conversation: cv.id, seq, job, at, tool: card.tool, cardState: card.cardState, clientId, words, keepUntil: keepUntilFor(at, days) }).run();
    return { seq };
  };
}

/** The sweep's part (CommsMessages.expire): the same two limits a message's words have. */
export function expireJobTrace(db: DataDatabase, at: string, cutoff: string): number {
  return db.update(jobTrace).set({ words: null }).where(and(isNotNull(jobTrace.words),
    or(sql`julianday(${jobTrace.keepUntil}) <= julianday(${at})`, sql`julianday(${jobTrace.at}) <= julianday(${cutoff})`))).returning({ seq: jobTrace.seq }).all().length;
}

/** When the sweep is next needed for a step's words, for the one timer that runs it (lifetime.ts). */
export function nextJobTraceExpiry(db: DataDatabase, days: number): number | undefined {
  const oldest = db.select({ at: min(jobTrace.at), until: min(jobTrace.keepUntil) }).from(jobTrace).where(isNotNull(jobTrace.words)).get();
  const ends = [oldest?.at ? ageLimit(Date.parse(oldest.at), days) : NaN, Date.parse(oldest?.until ?? '')].filter(Number.isFinite);
  return ends.length ? Math.min(...ends) : undefined;
}

/** A deleted thread takes the traces of the work handed off from it, as it takes its messages. Call before the thread row goes. */
export function eraseThreadJobTrace(db: DataDatabase, origin: string): void {
  const parents = new Set(db.select({ id: jobs.id }).from(jobs).where(eq(jobs.conversation, origin)).all().map(row => row.id));
  if (!parents.size) return;
  const children = db.select({ id: conversations.id, venue: conversations.venue, place: conversations.place }).from(conversations)
    .where(and(eq(conversations.venue, 'handoff'), like(conversations.place, '["codex-review",%'))).all()
    .filter(cv => parents.has(reviewParent(cv) ?? '')).map(cv => cv.id);
  if (children.length) db.delete(jobTrace).where(inArray(jobTrace.conversation, children)).run();
}

export class JobTraceQueries {
  constructor(readonly db: DataDatabase, readonly key: WordsKey, readonly policy: CommsQueryPolicy, readonly now: () => string = () => new Date().toISOString()) {}

  /** The latest steps, oldest first. The viewer must be the member the handoff conversation belongs to, under
   * the same conversation rule every Comms read uses; anybody else, and any other venue, reads nothing. */
  steps(viewer: Viewer, input: { conversation: string; job?: string | null; limit?: number | null }): Step[] {
    const page = input.limit ?? 100;
    if (!Number.isInteger(page) || page < 1 || page > 200) throw new Error('Invalid trace page size');
    if (viewer.kind !== 'member') return [];
    return this.db.select(getTableColumns(jobTrace)).from(jobTrace).innerJoin(conversations, eq(conversations.id, jobTrace.conversation))
      .where(and(eq(jobTrace.conversation, input.conversation), input.job ? eq(jobTrace.job, input.job) : undefined,
        eq(conversations.venue, 'handoff'), eq(conversations.member, viewer.id), this.policy(viewer, getTableColumns(conversations))))
      .orderBy(desc(jobTrace.seq)).limit(page).all().reverse();
  }

  /** Open the kept words. The rows are read again afterwards under the viewer's current rule: a step that is no
   * longer readable, or whose words changed or expired while they were being opened, gives none. */
  async opened(viewer: Viewer, input: Parameters<JobTraceQueries['steps']>[1], retain: (at: number) => void) {
    const kept = (row: Step, days: number) => !!row.words && wordsKept(row, days, this.now());
    const before = this.steps(viewer, input), days = commsKeepDays(this.db), texts = new Map<number, string>();
    for (const row of before) if (kept(row, days)) texts.set(row.seq, await this.key.open(row.words!));
    const was = new Map(before.map(row => [row.seq, row])), keep = commsKeepDays(this.db);
    return this.steps(viewer, input).map(row => {
      const prior = was.get(row.seq), same = keep === days && kept(row, keep) && !!prior?.words && prior.words.equals(row.words!) && texts.has(row.seq);
      if (same) retain(wordsDeadline(row, keep));
      return { ...row, text: same ? texts.get(row.seq)! : null };
    });
  }

  keepUntil(row: Step): string | null {
    const deadline = row.words ? wordsDeadline(row, commsKeepDays(this.db)) : NaN;
    return Number.isFinite(deadline) && deadline > Date.parse(this.now()) ? new Date(deadline).toISOString() : null;
  }
}

export function jobTraceFields(service: JobTraceQueries): GraphQLFieldConfigMap<unknown, { viewer: Viewer }> {
  const text = { type: new GraphQLNonNull(GraphQLString) };
  const step = new GraphQLObjectType<Step & { text?: string | null }, { viewer: Viewer }>({ name: 'SessionTraceStep', fields: {
    conversation: text, job: text, at: text, tool: text, cardState: text, clientId: text,
    seq: { type: new GraphQLNonNull(GraphQLInt) },
    words: { type: GraphQLString, resolve: row => row.text ?? null },
    wordsKeepUntil: { type: GraphQLString, resolve: row => service.keepUntil(row) },
  } });
  return {
    sessionTrace: { type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(step))),
      args: { conversation: text, job: { type: GraphQLString }, limit: { type: GraphQLInt, defaultValue: 100 } },
      resolve: (_row, args: { conversation: string; job?: string | null; limit?: number | null }, context, info) =>
        selectedQueryFields(info).has('words') ? service.opened(context.viewer, args, until => keepReadUntil(context, until)) : service.steps(context.viewer, args) },
  };
}
