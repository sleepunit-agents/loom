import { and, desc, eq, getTableColumns, inArray, or, sql } from 'drizzle-orm';
import {
  GraphQLInt,
  GraphQLList,
  GraphQLNonNull,
  GraphQLObjectType,
  GraphQLString,
  type GraphQLFieldConfigMap,
} from 'graphql/index.js';
import { sqlVisibility } from '../../policy-sql.js';
import type { Viewer } from '../../policy.js';
import type { DataDatabase } from './database.js';
import { workScope } from './work-scope.js';
import { changes, changeTasks, tasks, projects } from './schema.js';

export function epicWorkFields(db: DataDatabase): GraphQLFieldConfigMap<unknown, { viewer: Viewer }> {
  const text = new GraphQLNonNull(GraphQLString),
    integer = new GraphQLNonNull(GraphQLInt);
  const pull = new GraphQLObjectType({
    name: 'EpicLinkedPull',
    fields: {
      id: { type: text },
      title: { type: text },
      repository: { type: text },
      number: { type: integer },
      state: { type: text },
      review: { type: text },
      checks: { type: text },
    },
  });
  const total = new GraphQLObjectType({
    name: 'EpicWorkTotal',
    fields: { status: { type: text }, count: { type: integer } },
  });
  return {
    contextScopeWork: {
      type: new GraphQLObjectType({
        name: 'ContextEpicWork',
        fields: {
          totals: { type: new GraphQLList(total) },
          pullTotals: { type: new GraphQLList(total) },
          pulls: { type: new GraphQLList(pull) },
          pullCount: { type: integer },
        },
      }),
      args: {
        task: { type: GraphQLString },
        project: { type: GraphQLString },
        offset: { type: integer },
        state: { type: GraphQLString },
      },
      resolve: (_, args, { viewer }) => {
        if (args.offset < 0) throw Error('Invalid PR offset');
        const scope = sqlVisibility(viewer, ['tasks', 'changeTasks', 'changes', 'projects']);
        if ((args.project == null) === (args.task == null)) throw Error('Choose a project or task');
        if (
          args.project != null &&
          !db
            .select({ id: projects.id })
            .from(projects)
            .where(and(eq(projects.id, args.project), scope.projects(getTableColumns(projects))))
            .get()
        )
          return null;
        if (
          args.task != null &&
          !db
            .select({ id: tasks.id })
            .from(tasks)
            .where(and(eq(tasks.id, args.task), scope.tasks(getTableColumns(tasks))))
            .get()
        )
          return null;
        const tree = workScope(db, viewer, args.project, args.task);
        const totals = db
          .select({ status: tasks.status, count: sql<number>`count(*)` })
          .from(tasks)
          .where(
            and(
              sql`${tasks.id} in (${tree})`,
              args.task != null ? sql`${tasks.id} <> ${args.task}` : undefined,
            ),
          )
          .groupBy(tasks.status)
          .all();
        const linked = db
          .select({ id: changeTasks.change })
          .from(changeTasks)
          .where(and(sql`${changeTasks.task} in (${tree})`, scope.changeTasks(getTableColumns(changeTasks))));
        const allowed = and(
          scope.changes(getTableColumns(changes)),
          or(
            args.project != null ? eq(changes.project, args.project) : undefined,
            inArray(changes.id, linked),
          ),
        );
        const pullCount = db
          .select({ n: sql<number>`count(*)` })
          .from(changes)
          .where(allowed)
          .get()!.n;
        const pullTotals = db
          .select({ status: changes.state, count: sql<number>`count(*)` })
          .from(changes)
          .where(allowed)
          .groupBy(changes.state)
          .all();
        if (args.state != null && !['open', 'merged', 'closed'].includes(args.state))
          throw Error('Unknown pull request state');
        const pulls = db
          .select({
            id: changes.id,
            title: changes.title,
            repository: changes.repository,
            number: changes.number,
            state: changes.state,
            review: changes.review,
            checks: changes.checks,
          })
          .from(changes)
          .where(and(allowed, args.state == null ? undefined : eq(changes.state, args.state)))
          .orderBy(desc(changes.updatedAt), changes.id)
          .offset(args.offset)
          .limit(30)
          .all();
        return { totals, pulls, pullCount, pullTotals };
      },
    },
  };
}
