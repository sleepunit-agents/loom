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

function prepareSharingReads(db: DataDatabase) {
  return {
    ownership: db.query.memberAgents.findMany({columns:{member:true,agent:true}}).prepare(),
    people: db.query.projectMembers.findMany({columns:{project:true,member:true}}).prepare(),
    bodies: db.query.projectAgents.findMany({columns:{project:true,agent:true}}).prepare(),
    members: db.query.members.findMany({columns:{id:true,role:true},where:(f,{isNull})=>isNull(f.removedAt)}).prepare(),
    projects: db.query.projects.findMany({columns:{id:true},where:(f,{isNull})=>isNull(f.removedAt)}).prepare(),
    agents: db.query.agents.findMany({columns:{id:true},where:(f,{isNull})=>isNull(f.removedAt)}).prepare(),
  };
}

const sharingReads = new WeakMap<DataDatabase, ReturnType<typeof prepareSharingReads>>();

/** Reuse statement preparation per database. Read all six sets of current
 * facts on each call so membership changes apply inside their transaction. */
export function readSharingPolicy(db: DataDatabase) {
  let reads = sharingReads.get(db);
  if (!reads) {
    reads = prepareSharingReads(db);
    sharingReads.set(db, reads);
  }
  const ownership = reads.ownership.all();
  const people = reads.people.all();
  const bodies = reads.bodies.all();
  const members = reads.members.all();
  const projects = reads.projects.all();
  const agents = reads.agents.all();
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
