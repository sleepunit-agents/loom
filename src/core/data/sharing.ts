import type { DataDatabase } from './database.js';

/** The owner-only Sharing projection uses the schema-generated relational
 * reader. Each table is read once, regardless of the number of projects.
 * Authorization remains at the outside resolver; installed parts are trusted.
 */
export function readSharing(db: DataDatabase) {
  const memberRows = db.query.members.findMany({ columns: { id: true } }).sync();
  const agentRows = db.query.agents.findMany({ columns: { id: true } }).sync();
  const projectRows = db.query.projects.findMany().sync();
  const memberLinks = db.query.projectMembers.findMany().sync();
  const agentLinks = db.query.projectAgents.findMany().sync();
  const repositoryLinks = db.query.projectRepositories.findMany().sync();
  const group = <T extends { project: string }>(rows: T[], value: (row: T) => string) => {
    const grouped = new Map<string, string[]>();
    for (const row of rows) {
      const items = grouped.get(row.project) ?? [];
      items.push(value(row));
      grouped.set(row.project, items);
    }
    return grouped;
  };
  const members = group(memberLinks, row => row.member);
  const agents = group(agentLinks, row => row.agent);
  const repositories = group(repositoryLinks, row => row.repository);
  return {
    members: memberRows.map(row => row.id), agents: agentRows.map(row => row.id),
    projects: projectRows.map(row => ({ ...row, members: members.get(row.id) ?? [],
      agents: agents.get(row.id) ?? [], repositories: repositories.get(row.id) ?? [] })),
  };
}
