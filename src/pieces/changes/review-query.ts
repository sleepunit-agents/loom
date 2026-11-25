import { and, desc, eq, getTableColumns, lt, or } from 'drizzle-orm';
import { GraphQLInt, GraphQLList, GraphQLNonNull, GraphQLObjectType, GraphQLString, type GraphQLFieldConfigMap } from 'graphql/index.js';
import { changeReviewStore } from '../../apps/change-reviews.js';
import type { DataDatabase } from '../../core/data/database.js';
import { changes, changeTasks, githubReviews, changeReviewRounds as rounds, jobs } from '../../core/data/schema.js';
import type { Viewer } from '../../policy.js';
import { sqlVisibility } from '../../policy-sql.js';

export function changeReviewFields(db: DataDatabase): GraphQLFieldConfigMap<unknown, { viewer: Viewer }> {
  const text = new GraphQLNonNull(GraphQLString);
  const reviewRoundType = new GraphQLObjectType({ name: 'ChangeReviewRound', fields: {
    change: { type: text }, job: { type: text }, headCommit: { type: text }, tier: { type: text },
    round: { type: new GraphQLNonNull(GraphQLInt) }, requestedAt: { type: text },
    completedAt: { type: GraphQLString }, verdict: { type: GraphQLString }, findings: { type: GraphQLString },
  } });
  const store = changeReviewStore(db);
  const submitted = new GraphQLObjectType({name:'SubmittedGithubReview',fields:{
    id:{type:text}, change:{type:text}, login:{type:GraphQLString}, submittedAt:{type:text},
    state:{type:text}, headCommit:{type:GraphQLString}, body:{type:text}, url:{type:text},
  }});
  return { taskGithubReviews:{
    type:new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(submitted))),
    args:{task:{type:text},beforeAt:{type:GraphQLString},beforeId:{type:GraphQLString}},
    resolve(_,args,{viewer}){
      const scope=sqlVisibility(viewer,['changeTasks']);
      const cursor=args.beforeAt && args.beforeId
        ? or(lt(githubReviews.submittedAt,args.beforeAt),and(eq(githubReviews.submittedAt,args.beforeAt),lt(githubReviews.id,args.beforeId)))
        : undefined;
      return db.select(getTableColumns(githubReviews)).from(changeTasks)
        .innerJoin(githubReviews,eq(changeTasks.change,githubReviews.change))
        .where(and(eq(changeTasks.task,args.task),scope.changeTasks(getTableColumns(changeTasks)),cursor))
        .orderBy(desc(githubReviews.submittedAt),desc(githubReviews.id)).limit(31).all();
    },
  }, changeReviewHistory: {
    type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(reviewRoundType))),
    args: { change: { type: text } },
    resolve: (_source, args, { viewer }) => {
      const scope = sqlVisibility(viewer, ['changes', 'jobs']);
      return store.history(args.change, { change: scope.changes(getTableColumns(changes)), job: scope.jobs(getTableColumns(jobs)) });
    },
  }, taskReviewHistory: {
    type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(reviewRoundType))),
    args: { task: { type: text } },
    resolve: (_source, args, { viewer }) => {
      const scope = sqlVisibility(viewer, ['changeTasks', 'jobs']);
      // The link policy checks both endpoints; review findings also belong to the review job.
      return db.select(getTableColumns(rounds)).from(changeTasks)
        .innerJoin(rounds, eq(rounds.change, changeTasks.change))
        .innerJoin(jobs, eq(jobs.id, rounds.job))
        .where(and(eq(changeTasks.task, args.task), scope.changeTasks(getTableColumns(changeTasks)), scope.jobs(getTableColumns(jobs))))
        .orderBy(rounds.requestedAt, rounds.job).all();
    },
  } };
}
