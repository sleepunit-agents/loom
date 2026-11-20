import { sql, type AnyColumn } from 'drizzle-orm';
import { alias } from 'drizzle-orm/sqlite-core';
import { tasks, taskLinks } from './schema.js';
import { taskShelved } from './project-in-use.js';

export function taskReadiness(fields: Record<string, AnyColumn>) {
  const blocker = alias(tasks, 'data_ready_blocker');
  // A shelved task is not ready: its project is retired (project-in-use.ts, `taskShelved`).
  return sql`${fields.status} = 'open' and ${fields.type} <> 'epic' and not ${taskShelved({ status: fields.status, project: fields.project })} and not exists (select 1 from ${taskLinks} inner join ${tasks} as ${sql.identifier("data_ready_blocker")} on ${blocker.id} = ${taskLinks.dependsOn} where ${taskLinks.task} = ${fields.id} and ${taskLinks.type} = 'blocks' and ${blocker.status} <> 'closed')`;
}
