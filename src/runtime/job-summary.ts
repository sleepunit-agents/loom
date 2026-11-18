/** Home's current-job projection. The outside composition supplies its current
 * jobs SQL policy; this module never invents sharing rules or reads credentials. */
import { and, asc, desc, eq, getTableColumns, inArray, is, ne, or, isNotNull, sql, SQL } from 'drizzle-orm';
import { GraphQLInt, GraphQLList, GraphQLNonNull, GraphQLObjectType, GraphQLString } from 'graphql/index.js';
import type { DataDatabase } from '../core/data/database.js';
import type { QueryVisibility } from '../core/data/queries.js';
import { jobs, terminalRuns } from '../core/data/schema.js';
import { unendedJobStates } from '../core/data/job-states.js';
import { jobUsageFields } from './job-usage-queries.js';
import { exitStage } from './job-exit.js';

import { terminalSilenceMs } from '../core/conversations/terminal-sessions.js';
export function nextTerminalDeadline(db: DataDatabase, now: number) {
  const cutoff = new Date(now - terminalSilenceMs).toISOString();
  const found = db.select({at: jobs.heardAt}).from(jobs).where(and(eq(jobs.startedByKind, 'terminal'),
    isNotNull(jobs.conversation), inArray(jobs.state, unendedJobStates), sql`julianday(${jobs.heardAt}) > julianday(${cutoff})`))
    .orderBy(asc(sql`julianday(${jobs.heardAt})`)).limit(1).get();
  return found?.at ? Date.parse(found.at) + terminalSilenceMs : undefined;
}

export class JobSummaries {
  constructor(readonly db: DataDatabase, readonly visibility: () => QueryVisibility, readonly now = Date.now, readonly observed?: () => void) {}
  allowed() {
    const allowed = this.visibility().jobs?.(getTableColumns(jobs));
    if (!is(allowed, SQL)) throw new Error('SQL visibility required for jobs');
    return allowed;
  }
  current(agent: string) {
    const allowed = this.allowed();
    this.observed?.();
    const cutoff = new Date(this.now() - terminalSilenceMs).toISOString();
    return this.db.select({ id: jobs.id, agent: jobs.agent, title: jobs.title,
      kind: sql<string>`case when ${jobs.startedByKind} = 'terminal' then 'terminal' else 'job' end`,
      state: jobs.state, box: jobs.box, queuedAt: jobs.queuedAt }).from(jobs)
      .where(and(allowed, eq(jobs.agent, agent), inArray(jobs.state, unendedJobStates),
        or(ne(jobs.startedByKind, 'terminal'), and(isNotNull(jobs.conversation), sql`julianday(${jobs.heardAt}) > julianday(${cutoff})`))))
      .orderBy(asc(jobs.queuedAt), asc(jobs.id)).all();
  }
  /** An agent's jobs, ended ones included, newest first. Same visibility as current(). */
  history(agent: string, first = 20, id?: string) {
    const allowed = this.allowed();
    const visibleParents = this.db.select({id:jobs.id}).from(jobs).where(allowed);
    const visibleRuns = this.db.select({id:terminalRuns.job}).from(terminalRuns).where(inArray(terminalRuns.parent,visibleParents));
    return this.db.select({ id: jobs.id, agent: jobs.agent, title: jobs.title, state: jobs.state, box: jobs.box,
      prefers: jobs.prefers, placementDecision: jobs.placementDecision,
      conversation: jobs.conversation, project: jobs.project, brief: jobs.brief, model: jobs.model,
      startedByKind: jobs.startedByKind, startedBy: jobs.startedBy, retryOf: jobs.retryOf, exitCode: jobs.exitCode, exitBy: jobs.exitBy, logTail: jobs.logTail,
      endedBy: jobs.endedBy, endedReason: jobs.endedReason, endedNote: jobs.endedNote, queuedAt: jobs.queuedAt, claimedAt: jobs.claimedAt, heardAt: jobs.heardAt, endedAt: jobs.endedAt }).from(jobs)
      .where(and(allowed, eq(jobs.agent, agent), id === undefined ? undefined : eq(jobs.id, id), or(ne(jobs.startedByKind,'terminal'),inArray(jobs.id,visibleRuns)))).orderBy(desc(jobs.queuedAt), desc(jobs.id)).limit(Math.min(Math.max(first, 1), 100)).all()
      // Where a failed job failed, read from its exit code and whose code it is: what a private conversation's job keeps.
      .map(row => ({ ...row, exitStage: exitStage(row.exitCode, row.exitBy) ?? null }));
  }
}
const text = { type: GraphQLString };
const placementCandidate = new GraphQLObjectType({ name: 'JobPlacementCandidate', fields: {
  box: { type: new GraphQLNonNull(GraphQLString) }, outcome: { type: new GraphQLNonNull(GraphQLString) },
  reason: { type: new GraphQLNonNull(GraphQLString) },
} });
const job = new GraphQLObjectType({ name: 'JobRecord', fields: {
  id: { type: new GraphQLNonNull(GraphQLString) }, agent: { type: new GraphQLNonNull(GraphQLString) },
  title: { type: new GraphQLNonNull(GraphQLString) }, state: { type: new GraphQLNonNull(GraphQLString) },
  prefers: { type: new GraphQLList(new GraphQLNonNull(GraphQLString)) },
  placementDecision: { type: new GraphQLList(new GraphQLNonNull(placementCandidate)) },
  box: text, conversation: text, project: text, brief: text, model: text, startedByKind: text, startedBy: text, retryOf: text,
  exitCode: { type: GraphQLInt }, exitBy: text, exitStage: text, logTail: text, endedBy: text, endedReason: text, endedNote: text,
  queuedAt: { type: new GraphQLNonNull(GraphQLString) }, claimedAt: text, heardAt: text, endedAt: text,
} });
const currentJob = new GraphQLObjectType({ name: 'CurrentJobSummary', fields: {
  kind: text,
  id: { type: new GraphQLNonNull(GraphQLString) },
  agent: { type: new GraphQLNonNull(GraphQLString) },
  title: { type: new GraphQLNonNull(GraphQLString) },
  state: { type: new GraphQLNonNull(GraphQLString) },
  // This is the assigned machine ID on the visible job, not a separate box read.
  box: { type: GraphQLString },
  queuedAt: { type: new GraphQLNonNull(GraphQLString) },
} });
/** Add to the existing generated query root. Root owns authentication, current
 * SQL policy and subscriptions; use the same field in subscription selections. */
export function jobSummaryFields(summaries: JobSummaries, canReadUsage = () => true) {
  return { ...jobUsageFields(summaries, canReadUsage), currentJobs: {
    type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(currentJob))),
    args: { agent: { type: new GraphQLNonNull(GraphQLString) } },
    resolve: (_source: unknown, args: { agent: string }) => summaries.current(args.agent),
  }, jobHistory: {
    type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(job))),
    args: { agent: { type: new GraphQLNonNull(GraphQLString) }, first: { type: GraphQLInt }, id: { type: GraphQLString } },
    resolve: (_source: unknown, args: { agent: string; first?: number | null; id?: string | null }) => summaries.history(args.agent, args.first ?? undefined, args.id ?? undefined),
  } };
}
