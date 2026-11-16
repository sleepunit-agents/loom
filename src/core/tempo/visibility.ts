import { getTableColumns, sql, type AnyColumn, type SQL } from 'drizzle-orm';
import { alias } from 'drizzle-orm/sqlite-core';
import type { Viewer } from '../../policy.js';
import type { QueryVisibility } from '../data/queries.js';
import { members, memberAgents, projectAgents, projectMembers, triggers } from '../data/schema.js';

type Fields = Record<string, AnyColumn>;
/** Read predicates for the outside door, not authentication or write authority.
 * Compose with other modules' policies in the generated schema. Installed code
 * reads directly. Sharing stays in SQL so retained schemas observe revocation.
 */
export function tempoVisibility(viewer: Viewer): QueryVisibility {
  const { kind, id } = viewer;
  const agentProjects = alias(projectAgents, 'tempo_viewer_projects');
  const owner = kind === 'member'
    ? sql`exists (select 1 from ${members} where ${members.id} = ${id} and ${members.role} = 'owner')`
    : sql`false`;
  const project = (column: AnyColumn): SQL => kind === 'member'
    ? sql`exists (select 1 from ${projectMembers} where ${projectMembers.project} = ${column} and ${projectMembers.member} = ${id})`
    : kind === 'agent'
      ? sql`exists (select 1 from ${projectAgents} as ${sql.identifier('tempo_viewer_projects')} where ${agentProjects.project} = ${column} and ${agentProjects.agent} = ${id})`
      : sql`false`;
  const ownedAgent = (column: AnyColumn): SQL => kind === 'member'
    ? sql`exists (select 1 from ${memberAgents} where ${memberAgents.agent} = ${column} and ${memberAgents.member} = ${id})`
    : kind === 'agent' ? sql`${column} = ${id}` : sql`false`;
  // A person can see, and so cancel, a trigger they set for themselves or one that is for them.
  const mine = (f: Fields): SQL => kind === 'member'
    ? sql`((${f.ownerKind} = 'member' and ${f.owner} = ${id}) or (${f.toKind} = 'person' and ${f.to} = ${id}))`
    : sql`false`;
  const trigger = (f: Fields): SQL => sql`(${owner} or ${mine(f)} or ${project(f.project)} or (${f.toKind} = 'agent' and ${ownedAgent(f.to)})
    or (${f.targetKind} = 'operation' and ${f.toKind} is null and ${f.to} is null and ${f.ownerKind} = 'agent' and ${ownedAgent(f.owner)}))`;
  return {
    triggers: trigger,
    triggerEdits: f => sql`exists (select 1 from ${triggers} where ${triggers.id} = ${f.trigger} and ${trigger(getTableColumns(triggers))})`,
    triggerLog: f => sql`exists (select 1 from ${triggers} where ${triggers.id} = ${f.trigger} and ${trigger(getTableColumns(triggers))})`,
    agentPauses: f => sql`(${owner} or ${ownedAgent(f.agent)} or exists (select 1 from ${projectAgents} where ${projectAgents.agent} = ${f.agent} and ${project(projectAgents.project)}))`,
  };
}
