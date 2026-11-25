import { sql, type AnyColumn } from 'drizzle-orm';
import { alias } from 'drizzle-orm/sqlite-core';
import { tasks, taskLinks,projectClaimDirections } from './schema.js';
import { taskShelved } from './project-in-use.js';

export function taskReadiness(fields: Record<string, AnyColumn>,agent?:string) {
  const blocker = alias(tasks, 'data_ready_blocker');
  // A shelved task is not ready: its project is retired (project-in-use.ts, `taskShelved`).
  const d=projectClaimDirections;
  const claims=agent===undefined ? sql`true` : sql`coalesce((select ${d.paused} from ${d}
    where ${d.project}=${fields.project} and ${d.agent}=${agent} order by ${d.seq} desc limit 1),0)=0`;
  return sql`${claims} and ${fields.status} = 'open' and ${fields.ask} is null and ${fields.type} <> 'epic' and not ${taskShelved({ status: fields.status, project: fields.project })} and not exists (select 1 from ${taskLinks} inner join ${tasks} as ${sql.identifier("data_ready_blocker")} on ${blocker.id} = ${taskLinks.dependsOn} where ${taskLinks.task} = ${fields.id} and ${taskLinks.type} = 'blocks' and ${blocker.status} <> 'closed')`;
}
