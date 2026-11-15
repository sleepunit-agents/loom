import { sql, getTableColumns, type SQL, type AnyColumn } from 'drizzle-orm';
import { alias } from 'drizzle-orm/sqlite-core';
import type { Viewer } from '../../policy.js';
import { members, memberAgents, projectMembers, projectAgents, tasks } from './schema.js';
import type { QueryVisibility } from './queries.js';

type Fields = Record<string, AnyColumn>;
/** Current sharing facts stay in SQL, so a retained schema cannot retain a grant. */
export function taskVisibility(viewer: Viewer): QueryVisibility {
  const agentProjects = alias(projectAgents, 'visibility_agent_projects');
  const owner = viewer.kind === 'member' ? sql`exists (select 1 from ${members} where ${members.id} = ${viewer.id} and ${members.role} = 'owner')` : sql`false`;
  const project = (id: AnyColumn): SQL => viewer.kind === 'member'
    ? sql`exists (select 1 from ${projectMembers} where ${projectMembers.project} = ${id} and ${projectMembers.member} = ${viewer.id})`
    : viewer.kind === 'agent' ? sql`exists (select 1 from ${projectAgents} as ${sql.identifier("visibility_agent_projects")} where ${agentProjects.project} = ${id} and ${agentProjects.agent} = ${viewer.id})` : sql`false`;
  const agent = (id: AnyColumn): SQL => viewer.kind === 'member'
    ? sql`exists (select 1 from ${memberAgents} where ${memberAgents.agent} = ${id} and ${memberAgents.member} = ${viewer.id})`
    : viewer.kind === 'agent' ? sql`${id} = ${viewer.id}` : sql`false`;
  const task = (f: Fields): SQL => sql`(${owner} or case
    when ${f.project} is not null then ${project(f.project)}
    when ${f.ownerKind} = 'member' then ${viewer.kind === 'member' ? sql`${f.owner} = ${viewer.id}` : sql`false`}
    when ${f.ownerKind} = 'agent' then ${agent(f.owner)}
    else false end)`;
  const parent = (id: AnyColumn): SQL => sql`exists (select 1 from ${tasks} where ${tasks.id} = ${id} and ${task(getTableColumns(tasks))})`;
  return {
    tasks: task,
    taskComments: f => parent(f.task),
    // Both ends are part of this row, even when the caller selects only IDs.
    taskLinks: f => sql`${parent(f.task)} and ${parent(f.dependsOn)}`,
    // Membership IDs are part of a visible project, not a member directory.
    projectMembers: f => sql`${owner} or ${project(f.project)}`,
    projects: f => sql`${owner} or ${project(f.id)}`,
    agents: f => sql`${owner} or ${agent(f.id)} or exists (select 1 from ${projectAgents} where ${projectAgents.agent} = ${f.id} and ${project(projectAgents.project)})`,
  };
}
