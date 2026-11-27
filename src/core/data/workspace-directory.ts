import { and, eq, getTableColumns, sql } from 'drizzle-orm';
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
import { changes, projects, tasks, taskComments } from './schema.js';

export function workspaceDirectoryFields(
  db: DataDatabase,
): GraphQLFieldConfigMap<unknown, { viewer: Viewer }> {
  const text = new GraphQLNonNull(GraphQLString),
    integer = new GraphQLNonNull(GraphQLInt);
  return {
    workspaceRepositories: {
      type: new GraphQLList(
        new GraphQLObjectType({
          name: 'WorkspaceRepositoryActivity',
          fields: {
            repository: { type: text },
            project: { type: GraphQLString },
            count: { type: integer },
          },
        }),
      ),
      resolve: (_, _args, { viewer }) => {
        const scope = sqlVisibility(viewer, ['changes', 'projects']);
        const readable = db
          .select({ id: projects.id })
          .from(projects)
          .where(scope.projects(getTableColumns(projects)));
        const project = sql<
          string | null
        >`case when ${changes.project} in (${readable}) then ${changes.project} end`;
        return db
          .select({ repository: changes.repository, project, count: sql<number>`count(*)` })
          .from(changes)
          .where(scope.changes(getTableColumns(changes)))
          .groupBy(changes.repository, project)
          .all();
      },
    },
    workspaceListCount: {
      type: integer,
      args: {
        list: { type: text },
        assignee: { type: GraphQLString },
        actorKind: { type: GraphQLString },
        repository: { type: GraphQLString },
      },
      resolve: (_, { list, assignee, actorKind, repository }, { viewer }) => {
        const count = { n: sql<number>`count(*)` };
        if (list === 'tickets' || list === 'epics') {
          const scope = sqlVisibility(viewer, ['tasks']);
          return db
            .select(count)
            .from(tasks)
            .where(
              and(
                scope.tasks(getTableColumns(tasks)),
                list === 'epics' ? eq(tasks.type, 'epic') : undefined,
                assignee ? eq(tasks.assignee, assignee) : undefined,
                actorKind === 'member' || actorKind === 'agent'
                  ? eq(tasks.assigneeKind, actorKind)
                  : undefined,
              ),
            )
            .get()!.n;
        }
        if (list === 'pulls') {
          const scope = sqlVisibility(viewer, ['changes']);
          return db
            .select(count)
            .from(changes)
            .where(
              and(
                scope.changes(getTableColumns(changes)),
                repository ? eq(changes.repository, repository) : undefined,
              ),
            )
            .get()!.n;
        }
        if (list === 'comments') {
          const scope = sqlVisibility(viewer, ['taskComments']);
          return db
            .select(count)
            .from(taskComments)
            .where(scope.taskComments(getTableColumns(taskComments)))
            .get()!.n;
        }
        throw Error('Unknown workspace list');
      },
    },
  };
}
