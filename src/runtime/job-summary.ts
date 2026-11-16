/** Home's current-job projection. The outside composition supplies its current
 * jobs SQL policy; this module never invents sharing rules or reads credentials. */
import { and, asc, desc, eq, getTableColumns, inArray, is, SQL } from 'drizzle-orm';
import { GraphQLInt, GraphQLList, GraphQLNonNull, GraphQLObjectType, GraphQLString } from 'graphql/index.js';
import type { DataDatabase } from '../core/data/database.js';
import type { QueryVisibility } from '../core/data/queries.js';
import { jobs } from '../core/data/schema.js';

export class JobSummaries {
  constructor(readonly db: DataDatabase, readonly visibility: () => QueryVisibility) {}
  current(agent: string) {
    const allowed = this.visibility().jobs?.(getTableColumns(jobs));
    if (!is(allowed, SQL)) throw new Error('SQL visibility required for jobs');
    return this.db.select({ id: jobs.id, agent: jobs.agent, title: jobs.title,
      state: jobs.state, box: jobs.box, queuedAt: jobs.queuedAt }).from(jobs)
      .where(and(allowed, eq(jobs.agent, agent), inArray(jobs.state, ['queued', 'starting', 'running', 'waiting'])))
      .orderBy(asc(jobs.queuedAt), asc(jobs.id)).all();
  }
  /** An agent's jobs, ended ones included, newest first. Same visibility as current(). */
  history(agent: string, first = 20) {
    const allowed = this.visibility().jobs?.(getTableColumns(jobs));
    if (!is(allowed, SQL)) throw new Error('SQL visibility required for jobs');
    return this.db.select({ id: jobs.id, agent: jobs.agent, title: jobs.title, state: jobs.state, box: jobs.box,
      conversation: jobs.conversation, project: jobs.project, brief: jobs.brief, model: jobs.model,
      startedByKind: jobs.startedByKind, startedBy: jobs.startedBy, retryOf: jobs.retryOf, exitCode: jobs.exitCode, logTail: jobs.logTail,
      endedBy: jobs.endedBy, endedReason: jobs.endedReason, queuedAt: jobs.queuedAt, claimedAt: jobs.claimedAt, heardAt: jobs.heardAt, endedAt: jobs.endedAt }).from(jobs)
      .where(and(allowed, eq(jobs.agent, agent))).orderBy(desc(jobs.queuedAt), desc(jobs.id)).limit(Math.min(Math.max(first, 1), 100)).all();
  }
}
const text = { type: GraphQLString };
const job = new GraphQLObjectType({ name: 'JobRecord', fields: {
  id: { type: new GraphQLNonNull(GraphQLString) }, agent: { type: new GraphQLNonNull(GraphQLString) },
  title: { type: new GraphQLNonNull(GraphQLString) }, state: { type: new GraphQLNonNull(GraphQLString) },
  box: text, conversation: text, project: text, brief: text, model: text, startedByKind: text, startedBy: text, retryOf: text,
  exitCode: { type: GraphQLInt }, logTail: text, endedBy: text, endedReason: text,
  queuedAt: { type: new GraphQLNonNull(GraphQLString) }, claimedAt: text, heardAt: text, endedAt: text,
} });
const currentJob = new GraphQLObjectType({ name: 'CurrentJobSummary', fields: {
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
export function jobSummaryFields(summaries: JobSummaries) {
  return { currentJobs: {
    type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(currentJob))),
    args: { agent: { type: new GraphQLNonNull(GraphQLString) } },
    resolve: (_source: unknown, args: { agent: string }) => summaries.current(args.agent),
  }, jobHistory: {
    type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(job))),
    args: { agent: { type: new GraphQLNonNull(GraphQLString) }, first: { type: GraphQLInt } },
    resolve: (_source: unknown, args: { agent: string; first?: number | null }) => summaries.history(args.agent, args.first ?? undefined),
  } };
}
