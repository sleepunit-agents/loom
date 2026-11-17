/** The SQL face of policy.ts: turns a rule into a filter for a list read.
 *
 * No rule is stated here. Each term of a rule becomes a subquery over the live
 * sharing tables, so a query schema that is kept open still sees a member
 * removed, an agent taken off a list or a project left. policy-sql.test.ts
 * checks, for every rule, that this face and holds() give the same answer. */
import { getTableColumns, sql, type AnyColumn, type SQL } from 'drizzle-orm';
import { alias, type AnySQLiteTable } from 'drizzle-orm/sqlite-core';
import { tableRules, type Rule, type TableWithRule, type Viewer } from './policy.js';
import * as schema from './core/data/schema.js';

const { members, agents, memberAgents, projects, projectMembers, projectAgents } = schema;
/** The columns, or SQL values, a rule's fields are read from, by schema key. */
export type RuleFields = Readonly<Record<string, AnyColumn | SQL>>;

// Every table a subquery reads has its own alias, so a rule can be placed inside
// any query, including one over the same table, without capturing its columns.
const viewerRow = alias(members, 'policy_viewer'), viewerAgent = alias(agents, 'policy_viewer_agent');
const namedMember = alias(members, 'policy_named_member'), namedAgent = alias(agents, 'policy_named_agent');
const owned = alias(memberAgents, 'policy_member_agents');
const people = alias(projectMembers, 'policy_project_members');
const bodies = alias(projectAgents, 'policy_project_agents'), shared = alias(projectAgents, 'policy_agent_projects');
const inUse = alias(projects, 'policy_project_in_use');
const as = (table: AnySQLiteTable, name: string): SQL => sql`${table} as ${sql.identifier(name)}`;
const no = sql`false`, yes = sql`true`;
const text = (value: string): SQL => sql.raw(`'${value.replaceAll("'", "''")}'`);

/** The SQL filter for one rule. `fields` are the columns of the row being filtered.
 * Only members and agents read lists; for any other viewer the filter is false. */
export function sqlRule(rule: Rule, viewer: Viewer, fields: RuleFields): SQL {
  return filter(rule, viewer, fields, 0);
}
function filter(rule: Rule, viewer: Viewer, fields: RuleFields, startDepth: number): SQL {
  // Copy the scalars: changing the caller's viewer object later cannot change this filter.
  const { kind, id } = viewer;
  if (kind !== 'member' && kind !== 'agent') return no;
  const member = kind === 'member';
  // A body working for a member (policy.ts, Viewer): each of the agent's own terms also asks this of that member.
  const bound = viewer.kind === 'agent' ? viewer.workingFor : undefined;
  const current = sql`exists (select 1 from ${as(members, 'policy_viewer')} where ${viewerRow.id} = ${member ? id : bound ?? null} and ${viewerRow.removedAt} is null)`;
  const itsOwner = sql`exists (select 1 from ${as(members, 'policy_viewer')} where ${viewerRow.id} = ${bound ?? null} and ${viewerRow.role} = 'owner' and ${viewerRow.removedAt} is null)`;
  const onItsList = sql`(${current} and exists (select 1 from ${as(memberAgents, 'policy_member_agents')} where ${owned.agent} = ${id} and ${owned.member} = ${bound ?? null}))`;
  // A removed project keeps its links for a restore and grants nothing through them (shared-sharing.ts leaves it out).
  const live = (project: AnyColumn | SQL): SQL =>
    sql`exists (select 1 from ${as(projects, 'policy_project_in_use')} where ${inUse.id} = ${project} and ${inUse.removedAt} is null)`;
  const memberIn = (project: AnyColumn | SQL, who: string): SQL =>
    sql`(${current} and ${live(project)} and exists (select 1 from ${as(projectMembers, 'policy_project_members')} where ${people.project} = ${project} and ${people.member} = ${who}))`;
  const agentIn = (project: AnyColumn | SQL): SQL =>
    sql`(${live(project)} and exists (select 1 from ${as(projectAgents, 'policy_project_agents')} where ${bodies.project} = ${project} and ${bodies.agent} = ${id}))`;
  const inProject = (project: AnyColumn | SQL): SQL => member ? memberIn(project, id)
    : bound === undefined ? agentIn(project) : sql`(${agentIn(project)} and (${itsOwner} or ${memberIn(project, bound)}))`;
  const build = (part: Rule, row: RuleFields, depth: number): SQL => {
    const field = (name: string) => {
      const value = row[name];
      if (value === undefined) throw new Error(`Rule reads a field the row does not have: ${name}`);
      return value;
    };
    const group = (parts: readonly Rule[], word: 'or' | 'and', empty: SQL): SQL => parts.length
      ? sql`(${sql.join(parts.map(each => build(each, row, depth)), sql.raw(` ${word} `))})` : empty;
    switch (part.is) {
      case 'never': return no;
      case 'householdOwner': return member
        ? sql`exists (select 1 from ${as(members, 'policy_viewer')} where ${viewerRow.id} = ${id} and ${viewerRow.role} = 'owner' and ${viewerRow.removedAt} is null)` : no;
      case 'viewerIs': return kind === part.kind ? yes : no;
      case 'currentViewer': {
        if (member) return current;
        const agent = sql`exists (select 1 from ${as(agents, 'policy_viewer_agent')} where ${viewerAgent.id} = ${id} and ${viewerAgent.removedAt} is null)`;
        return bound === undefined ? agent : sql`(${agent} and ${current})`;
      }
      case 'self': return member ? sql`(${current} and ${field(part.field)} is ${id})` : no;
      case 'inProject': return inProject(field(part.field));
      case 'ownsAgent': return member
        ? sql`(${current} and exists (select 1 from ${as(memberAgents, 'policy_member_agents')} where ${owned.agent} = ${field(part.field)} and ${owned.member} = ${id}))`
        : bound === undefined ? sql`${field(part.field)} is ${id}` : sql`(${field(part.field)} is ${id} and ${onItsList})`;
      case 'sharesProjectWithAgent':
        return sql`exists (select 1 from ${as(projectAgents, 'policy_agent_projects')} where ${shared.agent} = ${field(part.field)} and ${inProject(shared.project)})`;
      case 'names': return part.kind === 'member'
        ? sql`exists (select 1 from ${as(members, 'policy_named_member')} where ${namedMember.id} = ${field(part.field)} and ${namedMember.removedAt} is null)`
        : sql`exists (select 1 from ${as(agents, 'policy_named_agent')} where ${namedAgent.id} = ${field(part.field)} and ${namedAgent.removedAt} is null)`;
      case 'equal': return part.value === null ? sql`${field(part.field)} is null`
        : typeof part.value === 'boolean' ? sql`${field(part.field)} is ${sql.raw(part.value ? '1' : '0')}` : sql`${field(part.field)} is ${text(part.value)}`;
      case 'set': return sql`${field(part.field)} is not null`;
      case 'any': return group(part.of, 'or', no);
      case 'all': return group(part.of, 'and', yes);
      case 'first': return sql`case ${sql.join(part.cases.map(([when, then]) => sql`when ${build(when, row, depth)} then ${build(then, row, depth)}`), sql.raw(' '))} else ${build(part.otherwise, row, depth)} end`;
      case 'seenWith': {
        const table = schema[part.table], name = `policy_parent_${depth}`, parent = alias(table, name);
        return sql`exists (select 1 from ${as(table, name)} where ${parent.id} = ${field(part.field)} and ${build(part.as ?? tableRules[part.table], getTableColumns(parent), depth + 1)})`;
      }
      // The same rule, read for the member the body works for, while that member has the agent on their list.
      case 'forItsMember': return bound === undefined ? no : sql`(${onItsList} and ${filter(part.rule, { kind: 'member', id: bound }, row, depth)})`;
    }
  };
  return build(rule, fields, startDepth);
}

/** A rule that reads no row, answered in one statement. For a read that must stay at a fixed number of
 * statements; everything else asks holds() with the sharing snapshot. Both give the same answer. */
export function sqlHolds(db: { get<T>(query: SQL): T }, rule: Rule, viewer: Viewer): boolean {
  return db.get<{ allowed: number }>(sql`select (${sqlRule(rule, viewer, {})}) as allowed`).allowed === 1;
}

/** The read filters for these tables, in the shape the shared query door takes. */
export function sqlVisibility<const T extends TableWithRule>(viewer: Viewer, tables: readonly T[]): Record<T, (fields: RuleFields) => SQL> {
  // Copy what the rules read of the viewer, once: a later change to the caller's object changes no filter.
  const fixed: Viewer = viewer.kind === 'agent' ? { kind: viewer.kind, id: viewer.id, workingFor: viewer.workingFor } : { kind: viewer.kind, id: viewer.id };
  return Object.fromEntries(tables.map(name => [name, (fields: RuleFields) => sqlRule(tableRules[name], fixed, fields)])) as Record<T, (fields: RuleFields) => SQL>;
}
