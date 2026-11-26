import { and, desc, eq, getTableColumns, inArray, isNotNull, ne, or, sql } from 'drizzle-orm';
import {
  GraphQLList,
  GraphQLNonNull,
  GraphQLObjectType,
  GraphQLString,
  type GraphQLFieldConfigMap,
} from 'graphql/index.js';
import { sqlVisibility } from '../../policy-sql.js';
import type { Viewer } from '../../policy.js';
import { terminalSilenceMs } from '../conversations/terminal-sessions.js';
import { unendedJobStates } from './job-states.js';
import type { DataDatabase } from './database.js';
import { changeReviewRounds, changeTasks, conversations, jobs, projects, tasks } from './schema.js';

/** Only a recorded job relationship can establish runtime work. A claim is shown separately. */
export function workJobFields(
  db: DataDatabase,
  now: () => number,
  observed: () => void,
): GraphQLFieldConfigMap<unknown, { viewer: Viewer }> {
  const text = new GraphQLNonNull(GraphQLString);
  const job = new GraphQLObjectType({
    name: 'ContextWorkJob',
    fields: {
      id: { type: text },
      agent: { type: text },
      state: { type: text },
      heardAt: { type: GraphQLString },
      queuedAt: { type: text },
      basis: { type: text },
    },
  });
  return {
    contextWorkJobs: {
      type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(job))),
      args: { project: { type: GraphQLString }, task: { type: GraphQLString } },
      resolve(_row, { project, task }, { viewer }) {
        if ((project == null) === (task == null)) throw Error('Choose a project or ticket');
        observed();
        const scope = sqlVisibility(viewer, ['jobs', 'tasks', 'projects', 'conversations', 'changeTasks']);
        const review = db
          .select({ id: changeReviewRounds.job })
          .from(changeReviewRounds)
          .innerJoin(changeTasks, eq(changeReviewRounds.change, changeTasks.change))
          .where(and(eq(changeTasks.task, task ?? ''), scope.changeTasks(getTableColumns(changeTasks))));
        const source = db
          .select({ id: conversations.id })
          .from(conversations)
          .innerJoin(tasks, and(eq(tasks.sourceKind, 'conversation'), eq(tasks.sourceId, conversations.id)))
          .where(
            and(
              eq(tasks.id, task ?? ''),
              scope.tasks(getTableColumns(tasks)),
              scope.conversations(getTableColumns(conversations)),
            ),
          );
        const projectIds = db
          .select({ id: projects.id })
          .from(projects)
          .where(and(eq(projects.id, project ?? ''), scope.projects(getTableColumns(projects))));
        const cutoff = new Date(now() - terminalSilenceMs).toISOString();
        return db
          .select({
            id: jobs.id,
            agent: jobs.agent,
            state: jobs.state,
            heardAt: jobs.heardAt,
            queuedAt: jobs.queuedAt,
            basis:
              project != null
                ? sql<string>`'Project job'`
                : sql<string>`case when ${jobs.id} in ${review} then 'Linked PR review' else 'Ticket source conversation' end`,
          })
          .from(jobs)
          .where(
            and(
              scope.jobs(getTableColumns(jobs)),
              inArray(jobs.state, unendedJobStates),
              or(
                ne(jobs.startedByKind, 'terminal'),
                and(isNotNull(jobs.conversation), sql`julianday(${jobs.heardAt}) > julianday(${cutoff})`),
              ),
              project != null
                ? inArray(jobs.project, projectIds)
                : or(inArray(jobs.id, review), inArray(jobs.conversation, source)),
            ),
          )
          .orderBy(desc(jobs.heardAt), jobs.id)
          .all();
      },
    },
  };
}
