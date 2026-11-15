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
 db.insert(members).values([{id:'owner',role:'owner',joinedAt:now()},{id:'sam',role:'member',joinedAt:now()},{id:'other',role:'member',joinedAt:now()}]).run();
 for(const id of ['art','mark'])db.insert(agents).values({id,about:'',markBg:'#fff',markFg:'#000',faceShape:'pebble',faceEyes:'dot'}).run();
 db.insert(memberAgents).values({member:'sam',agent:'art'}).run();
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
 expect(f.can('member','sam',{action:'settings',who:{kind:'person',id:'other'}})).toBe(false);
 f.client.exec('DELETE FROM member_agents');expect(f.can('member','sam',f.set)).toBe(false);
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
 for(const action of ['stop','runNow'] as const){
  expect(f.can('member','owner',{action,trigger})).toBe(true);
  expect(f.can('member','sam',{action,trigger})).toBe(true);
  expect(f.can('member','other',{action,trigger})).toBe(false);
  expect(f.can('agent','mark',{action,trigger})).toBe(true);
 }
 f.client.exec('DELETE FROM project_members');
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
