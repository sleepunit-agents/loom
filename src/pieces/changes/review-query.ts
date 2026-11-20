import { getTableColumns } from 'drizzle-orm';
import { GraphQLInt, GraphQLList, GraphQLNonNull, GraphQLObjectType, GraphQLString, type GraphQLFieldConfigMap } from 'graphql/index.js';
import { changeReviewStore } from '../../apps/change-reviews.js';
import type { DataDatabase } from '../../core/data/database.js';
import { changes, jobs } from '../../core/data/schema.js';
import type { Viewer } from '../../policy.js';
import { sqlVisibility } from '../../policy-sql.js';

export function changeReviewFields(db: DataDatabase): GraphQLFieldConfigMap<unknown, { viewer: Viewer }> {
  const text = new GraphQLNonNull(GraphQLString);
  const item = new GraphQLObjectType({ name: 'ChangeReviewRound', fields: {
    change: { type: text }, job: { type: text }, headCommit: { type: text }, tier: { type: text },
    round: { type: new GraphQLNonNull(GraphQLInt) }, requestedAt: { type: text },
    completedAt: { type: GraphQLString }, verdict: { type: GraphQLString }, findings: { type: GraphQLString },
  } });
  const store = changeReviewStore(db);
  return { changeReviewHistory: {
    type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(item))),
    args: { change: { type: text } },
    resolve: (_source, args, { viewer }) => {
      const scope = sqlVisibility(viewer, ['changes', 'jobs']);
      return store.history(args.change, { change: scope.changes(getTableColumns(changes)), job: scope.jobs(getTableColumns(jobs)) });
    },
  } };
}
