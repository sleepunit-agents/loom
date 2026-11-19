/** Which kits this agent has on the current word of a credential-bound job. The
 * person comes from admitted mail. Project membership is independent of the job's project. */
import { createHash } from 'node:crypto';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import { z } from 'zod';
import type { DataDatabase } from './core/data/database.js';
import { agentKitMembers, agentKitOutsidePeople, agentKitProjects, agentKits, agents, bridgePeople, jobs,
  projectMembers, projectOutsidePeople, projects } from './core/data/schema.js';
import { holds, rules, type OnWord, type Viewer, type Woke } from './policy.js';
import { kitRoom, stillKnown } from './shared-place-mail.js';
import { sharedSharing } from './shared-sharing.js';
import { deniedTools } from './runtime/harness-traits.js';
import { kitToolDenied } from './runtime/kit-manifest.js';
import type { sharedCredentials } from './shared-credentials.js';

type Word = { woke: Woke; person?: OnWord };
const outside = z.tuple([z.enum(['discord','slack']), z.string(), z.string()]);
export function kitAccess(db: DataDatabase, agent: string, word: Word) {
  const definitions = db.select().from(agentKits).where(eq(agentKits.agent,agent)).all();
  const unrestricted = word.woke!=='others';
  const all = definitions.map(kit => ({...kit,reasons:[word.woke==='own' ? "the agent's own work" : "owners' word"]}));
  const empty = {kits:unrestricted ? all : [], projects:[] as string[]};
  const person = word.person;
  if (!person || !stillKnown(db,agent,person)) return empty;
  let direct: {kit:string}[], roster: {project:string}[];
  if (person.kind === 'member') {
    direct = db.select({kit:agentKitMembers.kit}).from(agentKitMembers)
      .where(and(eq(agentKitMembers.agent,agent),eq(agentKitMembers.member,person.id))).all();
    roster = db.select({project:projectMembers.project}).from(projectMembers)
      .where(eq(projectMembers.member,person.id)).all();
  } else {
    let identity: unknown;
    try { identity = JSON.parse(person.id); } catch { return empty; }
    const parsed = outside.safeParse(identity);
    if (!parsed.success) return empty;
    const [platform,workspace,user] = parsed.data;
    // A subsequently linked account no longer speaks on the former outside identity's grants.
    if (db.select({member:bridgePeople.member}).from(bridgePeople).where(and(eq(bridgePeople.platform,platform),
      eq(bridgePeople.workspace,workspace),eq(bridgePeople.user,user))).get()?.member) return empty;
    direct = db.select({kit:agentKitOutsidePeople.kit}).from(agentKitOutsidePeople)
      .where(and(eq(agentKitOutsidePeople.agent,agent),eq(agentKitOutsidePeople.platform,platform),
        eq(agentKitOutsidePeople.workspace,workspace),eq(agentKitOutsidePeople.user,user))).all();
    roster = db.select({project:projectOutsidePeople.project}).from(projectOutsidePeople)
      .where(and(eq(projectOutsidePeople.platform,platform),eq(projectOutsidePeople.workspace,workspace),
        eq(projectOutsidePeople.user,user))).all();
  }
  const activeProjects=db.select({id:projects.id}).from(projects).where(and(isNull(projects.removedAt),isNull(projects.retiredAt),
    inArray(projects.id,roster.map(row=>row.project)))).all().map(row=>row.id).sort();
  if (unrestricted) return {kits:all,projects:activeProjects};
  const grants = db.select({kit:agentKitProjects.kit, project:agentKitProjects.project}).from(agentKitProjects)
    .where(and(eq(agentKitProjects.agent,agent),inArray(agentKitProjects.project,activeProjects))).all();
  const kits=definitions.flatMap(kit => {
    const reasons = grants.filter(row=>row.kit===kit.kit).map(row=>'grant to project '+row.project);
    if (direct.some(row=>row.kit===kit.kit)) reasons.unshift('direct grant to '+person.id);
    return reasons.length ? [{...kit,reasons}] : [];
  });
  return {kits,projects:activeProjects};
}

export function currentKitJob(db:DataDatabase, credentials:Pick<ReturnType<typeof sharedCredentials>,'body'>, viewer: Viewer) {
  const body = credentials.body(viewer);
  if (!body || !holds(rules.agentItself,viewer,{agent:body.agent},sharedSharing(db))) return;
  const job = db.select().from(jobs).where(and(eq(jobs.id,body.job),eq(jobs.agent,body.agent),
    eq(jobs.box,body.box),eq(jobs.state,'running'))).get();
  if (!job || !db.select({id:agents.id}).from(agents).where(and(eq(agents.id,body.agent),isNull(agents.removedAt))).get()) return;
  const {word,room} = kitRoom(db,job), denials=deniedTools(room);
  const access=kitAccess(db,job.agent,word);
  const tools = access.kits.flatMap(({kit,tools,reasons})=>tools.filter(tool=>!kitToolDenied(tool.name,denials)).map(tool=>({
    kit,tool,reasons,definition:createHash('sha256').update(JSON.stringify(tool)).digest('hex'),
  })));
  return {job,word,tools,projects:access.projects};
}
