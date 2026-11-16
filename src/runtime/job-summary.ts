/** Home's current-job projection. The outside composition supplies its current
 * jobs SQL policy; this module never invents sharing rules or reads credentials. */
import { readCurrentJobs } from '../core/data/current-jobs-read.js';
import { GraphQLList, GraphQLNonNull, GraphQLObjectType, GraphQLString } from 'graphql/index.js';
import type { DataDatabase } from '../core/data/database.js';
import type { QueryVisibility } from '../core/data/queries.js';

export class JobSummaries {
  constructor(readonly db: DataDatabase, readonly visibility: () => QueryVisibility) {}
  current(agent: string) {
    return readCurrentJobs(this.db,this.visibility(),agent);
  }
}
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
  } };
}
