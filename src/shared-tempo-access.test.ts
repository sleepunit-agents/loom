import Database from 'better-sqlite3';
import { afterEach, expect, it } from 'vitest';
import { createDataSchema } from './core/data/database.js';
import { Conversations } from './core/conversations/index.js';
import { members, agents, memberAgents, projectMembers, projects, triggers, approvals, changes, jobs, secrets, secretRequests } from './core/data/schema.js';
import { tempoCommandAllowed } from './shared-tempo-access.js';
import type { TempoAccess } from './core/tempo/operations.js';
const closes:(()=>void)[]=[];afterEach(()=>closes.splice(0).forEach(close=>close()));
function fixture(){
 const client=new Database(':memory:'),now=()=> '2026-11-15T00:00:00Z',db=createDataSchema(client,now);closes.push(()=>client.close());
 // 'owner' is a full owner, with every agent on their list as Setup keeps it; 'scoped' has the owner role and no agent.
 db.insert(members).values([{id:'owner',role:'owner',fullOwner:true,joinedAt:now()},{id:'scoped',role:'owner',joinedAt:now()},{id:'sam',role:'member',joinedAt:now()},{id:'other',role:'member',joinedAt:now()}]).run();
 for(const id of ['art','mark'])db.insert(agents).values({id,about:'',markBg:'#fff',markFg:'#000',faceShape:'pebble',faceEyes:'dot'}).run();
 db.insert(memberAgents).values([{member:'sam',agent:'art'},{member:'owner',agent:'art'},{member:'owner',agent:'mark'}]).run();
 db.insert(projects).values({id:'pond',name:'Pond'}).run();db.insert(projectMembers).values({project:'pond',member:'sam'}).run();
 const can=(kind:'member'|'agent'|'runner'|'service',id:string,access:TempoAccess)=>tempoCommandAllowed(db,{kind,id},access);
 const set:TempoAccess={action:'set',trigger:{ownerKind:'member',owner:'sam',sourceKind:'time',times:'09:00',lifespan:'once',targetKind:'inbox',toKind:'agent',to:'art',note:'Work'}};
 return {db,client,can,set,now};
}
it('requires current ownership for new work, pauses and settings; rejects forged household owners and recipients',()=>{
 const f=fixture();expect(f.can('member','sam',f.set)).toBe(true);
 expect(f.can('member','other',f.set)).toBe(false);expect(f.can('member','absent',f.set)).toBe(false);
 expect(f.can('runner','sam',f.set)).toBe(false);expect(f.can('service','sam',f.set)).toBe(false);
 expect(f.can('member','sam',{action:'set',trigger:{...f.set.trigger,ownerKind:'household',owner:null}})).toBe(false);
 expect(f.can('member','sam',{action:'set',trigger:{...f.set.trigger,to:'mark'}})).toBe(false);
 expect(f.can('agent','art',{action:'set',trigger:{...f.set.trigger,ownerKind:'agent',owner:'art'}})).toBe(true);
 expect(f.can('member','sam',{action:'pause',agent:'art'})).toBe(true);
 f.client.exec("DELETE FROM member_agents WHERE member='sam'");expect(f.can('member','sam',f.set)).toBe(false);
 expect(f.can('member','sam',{action:'pause',agent:'art'})).toBe(false);
});
it('volume belongs to its recipient, including when someone else can see a shared project item',()=>{
 const f=fixture();const item=new Conversations(f.db,f.now).send({toKind:'person',to:'other',source:'notice',fromKind:'agent',project:'pond',words:'Private volume'});
 expect(f.can('member','sam',{action:'volume',item})).toBe(false);
 expect(f.can('member','other',{action:'volume',item})).toBe(true);
 // Owners can operate household controls on behalf of its recipients.
 expect(f.can('member','owner',{action:'volume',item})).toBe(true);
});
it('does not allow an owned recipient to turn a hidden question into a source watch',()=>{
 const f=fixture();const mail=new Conversations(f.db,f.now);
 const item=mail.send({toKind:'person',to:'other',source:'thread',fromKind:'agent',words:'Secret question',answers:'yes-no'});
 expect(f.can('member','sam',{action:'set',trigger:{...f.set.trigger,sourceKind:'answer',watches:`question:${item.id}`}})).toBe(false);
 expect(f.can('member','sam',{action:'set',trigger:{...f.set.trigger,sourceKind:'answer',watches:'question:missing'}})).toBe(false);
});

it('shares existing trigger controls by project, agent ownership and owner role, and rechecks revocation',()=>{
 const f=fixture();
 f.client.prepare(`INSERT INTO triggers(id,owner_kind,source_kind,lifespan,target_kind,to_kind,"to",project,note,enabled,state,created_at,changed_at) VALUES('shared','household','time','once','inbox','agent','mark','pond','Shared',1,'standing',?,?)`).run(f.now(),f.now());
 const trigger=f.db.select().from(triggers).get()!;
 for(const action of ['stop','start','runNow'] as const){
  expect(f.can('member','owner',{action,trigger})).toBe(true);
  // Sam is in the trigger's project and does not direct mark: sees it, may stop it, may not put mark to work.
  expect([action,f.can('member','sam',{action,trigger})]).toEqual([action,action==='stop']);
  // The owner role alone directs no agent either.
  expect([action,f.can('member','scoped',{action,trigger})]).toEqual([action,action==='stop']);
  expect(f.can('member','other',{action,trigger})).toBe(false);
  expect(f.can('agent','mark',{action,trigger})).toBe(true);
  // An agent in the project that is not the one the trigger puts to work.
  f.client.exec("INSERT INTO project_agents(project,agent) VALUES('pond','art')");
  expect([action,f.can('agent','art',{action,trigger})]).toEqual([action,action==='stop']);
  f.client.exec('DELETE FROM project_agents');
 }
 // With mark on their list, sam starts it; without the project sam no longer reads it through the project, but does as mark's owner.
 f.db.insert(memberAgents).values({member:'sam',agent:'mark'}).run();
 expect(f.can('member','sam',{action:'runNow',trigger})).toBe(true);
 f.client.exec("DELETE FROM member_agents WHERE member='sam' AND agent='mark'");
 f.client.exec('DELETE FROM project_members');
 expect(f.can('member','sam',{action:'stop',trigger})).toBe(false);
 expect(f.can('member','sam',{action:'runNow',trigger})).toBe(false);
});

it('rejects hidden Changes, Jobs, Approvals and secret-request watches despite owning the target agent',()=>{
 const f=fixture(),at=f.now();
 f.db.insert(changes).values({id:'pr',repository:'org/repo',number:1,title:'Hidden',body:'',url:'https://example.test/pr',state:'open',draft:false,authorLogin:'mark',agent:'mark',branch:'feature',headCommit:'abc',baseBranch:'next',checks:'running',review:'required',mergeable:'unknown',waitingOn:'ci',openedAt:at,updatedAt:at}).run();
 f.db.insert(jobs).values({id:'job',agent:'mark',title:'Hidden',state:'running',brief:'',model:'model',startedByKind:'agent',startedBy:'mark',houseRepository:'repo',houseFile:'Housefile',houseBranch:'next',queuedAt:at}).run();
 f.db.insert(approvals).values({id:'approval',kind:'command',target:'test',what:'test',why:'test',agent:'art',member:'other',askedFrom:'test',actingFor:'other',state:'pending',minutes:1,ask:'Run?',ifYes:'Run',ifNo:'Stop',details:'',askedAt:at}).run();
 f.db.insert(secrets).values({name:'secret',description:'',changedBy:'owner',changedAt:at}).run();
 f.db.insert(secretRequests).values({id:'request',secret:'secret',agent:'mark',why:'test',state:'pending',minutes:1,always:false,askedAt:at}).run();
 for(const [sourceKind,watches] of [['pull-request','change:pr'],['job','job:job'],['answer','approval:approval'],['answer','secret-request:request']] as const){
  const access:TempoAccess={action:'set',trigger:{...f.set.trigger,sourceKind,watches}};
  expect(f.can('member','sam',access)).toBe(false);
  expect(f.can('member','owner',access)).toBe(true);
 }
});

it('binds a parked secret verdict to the agent and the private work that asked for it', () => {
 const f=fixture(), at=f.now();
 f.db.insert(jobs).values({id:'sam-job',agent:'art',member:'sam',project:'pond',title:'Private',state:'running',brief:'',
   model:'model',startedByKind:'agent',startedBy:'art',houseRepository:'repo',houseFile:'Housefile',houseBranch:'next',queuedAt:at}).run();
 f.db.insert(secrets).values({name:'fixture',description:'',changedBy:'owner',changedAt:at}).run();
 f.db.insert(secretRequests).values({id:'q-bound',secret:'fixture',agent:'art',job:'sam-job',why:'private',state:'pending',minutes:1,always:false,askedAt:at}).run();
 const trigger={...f.set.trigger,sourceKind:'answer' as const,times:null,watches:'park-secret:q-bound',project:'pond'};
 const can=(member:string,change:Partial<Extract<TempoAccess,{action:'set'}>['trigger']>)=>f.can('member',member,{action:'set',trigger:{...trigger,...change}});
 expect(can('sam',{})).toBe(true);
 expect(can('sam',{project:undefined})).toBe(false);
 expect(can('owner',{ownerKind:'agent',owner:'art'})).toBe(false);
 expect(can('owner',{ownerKind:'agent',owner:'mark',to:'mark'})).toBe(false);
});

it('lets the owning agent control its operation trigger without inventing a recipient',()=>{
 const f=fixture();
 f.client.prepare(`INSERT INTO triggers(id,owner_kind,owner,source_kind,lifespan,target_kind,target,note,enabled,state,created_at,changed_at) VALUES('operation','agent','art','time','until-stopped','operation','custom','Operation',1,'standing',?,?)`).run(f.now(),f.now());
 const trigger=f.db.select().from(triggers).get()!;
 for(const action of ['stop','start','runNow'] as const){
  expect(f.can('agent','art',{action,trigger})).toBe(true);
  expect(f.can('member','sam',{action,trigger})).toBe(true);
  expect(f.can('agent','mark',{action,trigger})).toBe(false);
  expect(f.can('member','other',{action,trigger})).toBe(false);
 }
});
it('lets whoever could set a trigger edit it: a project member can stop a shared trigger but not rewrite it',()=>{
 const f=fixture(),insert=f.client.prepare(`INSERT INTO triggers(id,owner_kind,owner,source_kind,lifespan,target_kind,to_kind,"to",project,note,enabled,state,created_at,changed_at) VALUES(?,?,?,'time','until-stopped','inbox','agent',?,?,'Lane',1,'standing',?,?)`);
 insert.run('shared','household',null,'mark','pond',f.now(),f.now());insert.run('lane','agent','art','art',null,f.now(),f.now());
 const row=(id:string)=>f.db.select().from(triggers).all().find(t=>t.id===id)!;
 expect(f.can('member','sam',{action:'stop',trigger:row('shared')})).toBe(true);
 expect(f.can('member','sam',{action:'edit',trigger:row('shared')})).toBe(false);
 expect(f.can('agent','mark',{action:'edit',trigger:row('shared')})).toBe(false);
 expect(f.can('member','owner',{action:'edit',trigger:row('shared')})).toBe(true);
 expect(f.can('agent','art',{action:'edit',trigger:row('lane')})).toBe(true);
 // Sam has art and is not a household owner: words sam gives art are work for sam, so sam does not reword art's own lane.
 expect(f.can('member','sam',{action:'edit',trigger:row('lane')})).toBe(false);
 insert.run('sams','member','sam','art',null,f.now(),f.now());expect(f.can('member','sam',{action:'edit',trigger:row('sams')})).toBe(true);
 expect(f.can('agent','art',{action:'edit',trigger:row('sams')})).toBe(false);expect(tempoCommandAllowed(f.db,{kind:'agent',id:'art',workingFor:'sam'},{action:'edit',trigger:row('sams')})).toBe(true);
 expect(tempoCommandAllowed(f.db,{kind:'agent',id:'art',workingFor:'sam'},{action:'edit',trigger:row('lane')})).toBe(false);
 expect(f.can('member','other',{action:'edit',trigger:row('lane')})).toBe(false);
 expect(f.can('agent','mark',{action:'edit',trigger:row('lane')})).toBe(false);
 expect(f.can('runner','art',{action:'edit',trigger:row('lane')})).toBe(false);
 f.client.exec("DELETE FROM member_agents WHERE member='sam'");expect(f.can('member','sam',{action:'edit',trigger:row('sams')})).toBe(false);
});

it('gives the owner role sight of every trigger but not direction of an agent off its own list',()=>{
 const f=fixture(),insert=f.client.prepare(`INSERT INTO triggers(id,owner_kind,owner,source_kind,lifespan,target_kind,to_kind,"to",project,note,enabled,state,created_at,changed_at) VALUES('lane','agent','art','time','until-stopped','inbox','agent','art',null,'Lane',1,'standing',?,?)`);
 insert.run(f.now(),f.now());const trigger=f.db.select().from(triggers).get()!;
 // Seeing, and so stopping, follows the read rule: a household owner sees everything.
 expect(f.can('member','scoped',{action:'stop',trigger})).toBe(true);
 // Putting an agent to work does not: the agent must be on the member's own list.
 expect(f.can('member','scoped',{action:'set',trigger:{...f.set.trigger,ownerKind:'member',owner:'scoped'}})).toBe(false);
 expect(f.can('member','scoped',{action:'edit',trigger})).toBe(false);
 expect(f.can('member','scoped',{action:'pause',agent:'art'})).toBe(false);
 expect(f.can('member','scoped',{action:'resume',agent:'art'})).toBe(false);
 // A person is different: an owner may set a reminder for someone in the household.
 expect(f.can('member','scoped',{action:'set',trigger:{...f.set.trigger,ownerKind:'member',owner:'scoped',toKind:'person',to:'sam'}})).toBe(true);
 f.db.insert(memberAgents).values({member:'scoped',agent:'art'}).run();
 expect(f.can('member','scoped',{action:'pause',agent:'art'})).toBe(true);
 expect(f.can('member','scoped',{action:'edit',trigger})).toBe(true);
 // The full owner has every agent on their list.
 expect(f.can('member','owner',{action:'pause',agent:'mark'})).toBe(true);
});
it('treats a removed member as nobody, owner role and leftover links included',()=>{
 const f=fixture();f.db.insert(memberAgents).values({member:'scoped',agent:'art'}).run();
 expect(f.can('member','scoped',{action:'pause',agent:'art'})).toBe(true);
 f.client.prepare("UPDATE members SET removed_at=? WHERE id IN ('scoped','sam')").run(f.now());
 expect(f.can('member','scoped',{action:'pause',agent:'art'})).toBe(false);
 expect(f.can('member','sam',f.set)).toBe(false);
 // Nor can anyone address work to someone who has been removed.
 expect(f.can('member','owner',{action:'set',trigger:{...f.set.trigger,ownerKind:'member',owner:'owner',toKind:'person',to:'sam'}})).toBe(false);
});
it('lets nobody watch a job they cannot read: a household owner cannot watch a job of another member\'s private thread',()=>{
 const f=fixture(),at=f.now();
 const row={agent:'art',title:'Private',state:'running' as const,brief:'',model:'model',startedByKind:'member' as const,houseRepository:'repo',houseFile:'Housefile',houseBranch:'next',queuedAt:at};
 f.db.insert(jobs).values([{...row,id:'private',member:'sam',startedBy:'sam'},{...row,id:'room',startedBy:'sam'}]).run();
 const watch=(job:string):TempoAccess=>({action:'set',trigger:{...f.set.trigger,ownerKind:'member',owner:'owner',toKind:'person',to:'owner',sourceKind:'job',watches:`job:${job}`}});
 const mine=(job:string):TempoAccess=>({action:'set',trigger:{...f.set.trigger,toKind:'person',to:'sam',sourceKind:'job',watches:`job:${job}`}});
 // Its member watches it. A full owner, who has the role and the agent, and a scoped owner do not.
 expect(f.can('member','sam',mine('private'))).toBe(true);
 expect(f.can('member','owner',watch('private'))).toBe(false);
 expect(f.can('member','scoped',{action:'set',trigger:{...watch('private').trigger,owner:'scoped',to:'scoped'}})).toBe(false);
 // A job that is nobody's private work is watched by an owner as before; one that does not exist by nobody.
 expect(f.can('member','owner',watch('room'))).toBe(true);
 expect(f.can('member','owner',watch('missing'))).toBe(false);
 expect(f.can('member','owner',{action:'set',trigger:{...watch('room').trigger,watches:null}})).toBe(false);
});
