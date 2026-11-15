import Database from 'better-sqlite3';
import { afterEach, expect, it } from 'vitest';
import { createDataSchema } from './core/data/database.js';
import { Conversations } from './core/conversations/index.js';
import { members, agents, memberAgents, projectMembers, projects } from './core/data/schema.js';
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
