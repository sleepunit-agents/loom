import { and, desc, eq, getTableColumns, isNotNull, ne, sql } from 'drizzle-orm';
import {
  GraphQLInt,
  GraphQLList,
  GraphQLNonNull,
  GraphQLObjectType,
  GraphQLString,
  type GraphQLFieldConfigMap,
} from 'graphql/index.js';
import { alias } from 'drizzle-orm/sqlite-core';
import { sqlVisibility } from '../../policy-sql.js';
import type { Viewer } from '../../policy.js';
import type { DataDatabase } from './database.js';
import { projects, tasks, taskLinks } from './schema.js';

export function contextTicketFields(db: DataDatabase): GraphQLFieldConfigMap<unknown, { viewer: Viewer }> {
  const text = new GraphQLNonNull(GraphQLString),
    integer = new GraphQLNonNull(GraphQLInt);
  const row = new GraphQLObjectType({
    name: 'ContextTicketRow',
    fields: { id: { type: text }, title: { type: text }, assignee: { type: GraphQLString } },
  });
  const count = new GraphQLObjectType({
    name: 'ContextTicketCount',
    fields: { group: { type: text }, count: { type: integer } },
  });
  return {
    contextProjectTickets: {
      type: new GraphQLObjectType({
        name: 'ContextProjectTickets',
        fields: { rows: { type: new GraphQLList(row) }, counts: { type: new GraphQLList(count) } },
      }),
      args: { id: { type: text }, group: { type: text }, offset: { type: integer } },
      resolve: (_row, args, { viewer }) => {
        const scope = sqlVisibility(viewer, ['projects', 'tasks']);
        const project = db
          .select({ id: projects.id })
          .from(projects)
          .where(and(eq(projects.id, args.id), scope.projects(getTableColumns(projects))))
          .get();
        if (!project) return null;
        const visible = and(eq(tasks.project, project.id), scope.tasks(getTableColumns(tasks)));
        const blocker = alias(tasks, 'unfinished_dependency');
        const blocks = db
          .select({ id: taskLinks.task })
          .from(taskLinks)
          .innerJoin(blocker, eq(blocker.id, taskLinks.dependsOn))
          .where(
            and(eq(taskLinks.task, tasks.id), eq(taskLinks.type, 'blocks'), ne(blocker.status, 'closed')),
          );
        // A ticket's readiness already accounts for an unreadable blocker. Do not disclose its ID or title.
        const filters = {
          'In progress': eq(tasks.status, 'in_progress'),
          Open: eq(tasks.status, 'open'),
          Blocked: and(ne(tasks.status, 'closed'), sql`exists ${blocks}`)!,
          Questions: and(ne(tasks.status, 'closed'), isNotNull(tasks.ask))!,
          Epics: eq(tasks.type, 'epic'),
          Closed: eq(tasks.status, 'closed'),
        };
        if (args.offset < 0 || !Object.hasOwn(filters, args.group))
          throw Error('Invalid project ticket page');
        const keys = Object.keys(filters) as (keyof typeof filters)[];
        const counts = db
          .select(
            Object.fromEntries(keys.map((key) => [key, sql<number>`count(*) filter(where ${filters[key]})`])),
          )
          .from(tasks)
          .where(visible)
          .get()!;
        const rows = db
          .select({ id: tasks.id, title: tasks.title, assignee: tasks.assignee })
          .from(tasks)
          .where(and(visible, filters[args.group as keyof typeof filters]))
          .orderBy(desc(tasks.changedAt), tasks.id)
          .offset(args.offset)
          .limit(30)
          .all();
        return { rows, counts: keys.map((group) => ({ group, count: counts[group] })) };
      },
    },
  };
}
