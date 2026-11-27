import { and, eq, getTableColumns, sql } from 'drizzle-orm';
import { sqlVisibility } from '../../policy-sql.js';
import type { Viewer } from '../../policy.js';
import type { DataDatabase } from './database.js';
import { taskLinks, tasks, projects } from './schema.js';

/** The root task and reachable children. Every step follows a link the reader can see.
 * UNION also terminates on legacy data with duplicate paths or a cycle. */
export function workScope(
  db: DataDatabase,
  viewer: Viewer,
  project: string | undefined,
  task: string | undefined,
) {
  const scope = sqlVisibility(viewer, ['tasks', 'taskLinks', 'projects']);
  if (project != null) {
    const allowedProjects = db
      .select({ id: projects.id })
      .from(projects)
      .where(and(eq(projects.id, project), scope.projects(getTableColumns(projects))));
    return sql`select ${tasks.id} from ${tasks} where ${tasks.project} in ${allowedProjects} and ${scope.tasks(getTableColumns(tasks))}`;
  }
  const root = db
    .select({ id: tasks.id })
    .from(tasks)
    .where(and(eq(tasks.id, task!), scope.tasks(getTableColumns(tasks))));
  return sql`with recursive visible_work(id) as (
    select id from ${root}
    union select ${taskLinks.task} from ${taskLinks} join visible_work on visible_work.id=${taskLinks.dependsOn}
    where ${taskLinks.type}='parent-child' and ${scope.taskLinks(getTableColumns(taskLinks))}
  ) select id from visible_work`;
}
