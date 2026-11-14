import { getTableColumns, sql, type AnyColumn, type SQL } from 'drizzle-orm';
import { alias } from 'drizzle-orm/sqlite-core';
import type { Viewer } from '../../policy.js';
import { approvals, changes, members, memberAgents, projectMembers, projectAgents, tasks } from './schema.js';
import type { QueryVisibility } from './queries.js';
import { taskVisibility } from './visibility.js';

type Fields = Record<string, AnyColumn>;
/** Outside read policy only. No write authority or installed-module gates.
 * Private approval membership wins over project and agent access. All sharing
 * facts remain SQL subqueries so retained query schemas see revocation.
 */
export function workVisibility(viewer: Viewer): QueryVisibility {
  const member = alias(members, 'work_viewer');
  const owned = alias(memberAgents, 'work_owned_agents');
  const people = alias(projectMembers, 'work_project_members');
  const agents = alias(projectAgents, 'work_project_agents');
  const existsMember = viewer.kind === 'member'
    ? sql`exists (select 1 from ${members} as ${sql.identifier("work_viewer")} where ${member.id} = ${viewer.id})` : sql`false`;
  const owner = viewer.kind === 'member'
    ? sql`exists (select 1 from ${members} as ${sql.identifier("work_viewer")} where ${member.id} = ${viewer.id} and ${member.role} = 'owner')` : sql`false`;
  const project = (id: AnyColumn): SQL => viewer.kind === 'member'
    ? sql`exists (select 1 from ${projectMembers} as ${sql.identifier("work_project_members")} where ${people.project} = ${id} and ${people.member} = ${viewer.id})`
    : viewer.kind === 'agent'
      ? sql`exists (select 1 from ${projectAgents} as ${sql.identifier("work_project_agents")} where ${agents.project} = ${id} and ${agents.agent} = ${viewer.id})` : sql`false`;
  const agent = (id: AnyColumn): SQL => viewer.kind === 'member'
    ? sql`exists (select 1 from ${memberAgents} as ${sql.identifier("work_owned_agents")} where ${owned.agent} = ${id} and ${owned.member} = ${viewer.id})`
    : viewer.kind === 'agent' ? sql`${id} = ${viewer.id}` : sql`false`;
  const change = (f: Fields): SQL => sql`(${owner} or ${project(f.project)} or ${agent(f.agent)})`;
  const approval = (f: Fields): SQL => sql`(${owner} or case when ${f.member} is not null
    then ${viewer.kind === 'member' ? sql`${existsMember} and ${f.member} = ${viewer.id}` : sql`false`}
    else (${project(f.project)} or ${agent(f.agent)}) end)`;
  const changeParent = (id: AnyColumn): SQL => sql`exists (select 1 from ${changes} where ${changes.id} = ${id} and ${change(getTableColumns(changes))})`;
  const taskPolicy = taskVisibility(viewer).tasks!;
  const taskParent = (id: AnyColumn): SQL => sql`exists (select 1 from ${tasks} where ${tasks.id} = ${id} and ${taskPolicy(getTableColumns(tasks))})`;
  return {
    approvals: approval,
    approvalRecord: f => sql`exists (select 1 from ${approvals} where ${approvals.id} = ${f.approval} and ${approval(getTableColumns(approvals))})`,
    // No project/member labels exist on notices; never infer them from target text.
    approvalNotices: f => sql`${owner} or ${agent(f.agent)}`,
    // Global configuration and global sync telemetry have no row sharing labels.
    // Keep them owner-only until composition supplies a narrower projection.
    approvalRules: () => owner,
    changeSync: () => owner,
    changes: change,
    changeChecks: f => changeParent(f.change),
    changePeople: f => changeParent(f.change),
    changeTasks: f => sql`${changeParent(f.change)} and ${taskParent(f.task)}`,
  };
}
