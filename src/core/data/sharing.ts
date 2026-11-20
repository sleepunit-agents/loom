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

/** Current policy facts. No record bodies, credentials or stale grant cache. */
export function readSharingPolicy(db: DataDatabase) {
  const ownership=db.query.memberAgents.findMany({columns:{member:true,agent:true}}).sync();
  const people=db.query.projectMembers.findMany({columns:{project:true,member:true}}).sync();
  const bodies=db.query.projectAgents.findMany({columns:{project:true,agent:true}}).sync();
  const members=db.query.members.findMany({columns:{id:true,role:true},where:(f,{isNull})=>isNull(f.removedAt)}).sync();
  const projects=db.query.projects.findMany({columns:{id:true},where:(f,{isNull})=>isNull(f.removedAt)}).sync();
  const agents=db.query.agents.findMany({columns:{id:true},where:(f,{isNull})=>isNull(f.removedAt)}).sync();
  const group=<T>(rows:T[],key:(row:T)=>string,value:(row:T)=>string)=>{
    const result=new Map<string,string[]>();
    for(const row of rows){const id=key(row),items=result.get(id)??[];items.push(value(row));result.set(id,items);}
    return result;
  };
  const owned=group(ownership,r=>r.member,r=>r.agent),projectPeople=group(people,r=>r.project,r=>r.member),projectBodies=group(bodies,r=>r.project,r=>r.agent);
  return {agents:agents.map(row=>row.id),members:Object.fromEntries(members.map(row=>[row.id,{owner:row.role==='owner',agents:owned.get(row.id)??[]}])),
    projects:Object.fromEntries(projects.map(row=>[row.id,{members:projectPeople.get(row.id)??[],agents:projectBodies.get(row.id)??[]}]))};
}
export function readConversationScope(db: DataDatabase,id:string){
  return db.query.conversations.findFirst({columns:{agent:true,project:true,member:true,direct:true},where:(f,{eq})=>eq(f.id,id)}).sync();
}
