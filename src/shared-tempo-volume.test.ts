import Database from 'better-sqlite3';
import { afterEach,expect,it,vi } from 'vitest';
import { createHash } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { FakeClock } from './core/clock.js';
import { createDataSchema } from './core/data/database.js';
import { agents,members,memberAgents,projects,projectMembers,projectAgents,boxes,jobs,conversations,tokens,inbox,approvals } from './core/data/schema.js';
import type { SharedTempoOptions } from './shared-tempo.js';
import { sharedRoot } from './shared-root.js';
const cleanup:(()=>void|Promise<void>)[]=[];afterEach(async()=>{for(const close of cleanup.splice(0).reverse())await close();});
const body='body-volume-token-'.repeat(3),unbound='unbound-volume-'.repeat(3),hash=(v:string)=>createHash('sha256').update(v).digest('hex');
function fixture(tempo?:SharedTempoOptions){
 const client=new Database(':memory:'),clock=new FakeClock(),now=()=>new Date(clock.now()).toISOString(),db=createDataSchema(client,now);
 db.insert(members).values(['owner','sam','other'].map(id=>({id,role:id==='owner'?'owner' as const:'member' as const,joinedAt:now()}))).run();
 db.insert(agents).values({id:'art',about:'',markBg:'#fff',markFg:'#000',faceShape:'pebble',faceEyes:'dot'}).run();
 db.insert(boxes).values({id:'box',name:'Box',owner:'owner',sameMachineAsLoom:false,hostsAny:false,reportOnly:false,alwaysOn:false,enrolledAt:now()}).run();
 db.insert(memberAgents).values([{member:'owner',agent:'art'},{member:'sam',agent:'art'}]).run();
 db.insert(projects).values({id:'pond',name:'Pond'}).run();db.insert(projectMembers).values([{project:'pond',member:'sam'},{project:'pond',member:'other'}]).run();db.insert(projectAgents).values({project:'pond',agent:'art'}).run();
 const root=sharedRoot({db,clock,originAllowed:()=>true,tempo,reportError(error){throw error;}});
 const source=root.services.conversations.open({agent:'art',venue:'loom',place:'chat',label:'Sam chat',member:'sam',project:'pond'});
 db.insert(jobs).values({id:'body',box:'box',agent:'art',conversation:source.id,project:'pond',member:'sam',title:'Chat',state:'running',brief:'',model:'model',startedByKind:'agent',startedBy:'art',houseRepository:'repo',houseFile:'Housefile',houseBranch:'next',queuedAt:now()}).run();
 db.insert(tokens).values([{fingerprint:hash(body),label:'Body',kind:'agent',agent:'art',job:'body',createdAt:now()},{fingerprint:hash(unbound),label:'Agent',kind:'agent',agent:'art',createdAt:now()}]).run();
 const item=root.services.conversations.send({toKind:'person',to:'sam',source:'notice',fromKind:'agent',project:'pond',words:'Work to read'});
 const other=root.services.conversations.send({toKind:'person',to:'other',source:'notice',fromKind:'agent',project:'pond',words:'Other work'});
 cleanup.push(()=>{client.close();},()=>root.close());
 const call=async(operation:string,input:unknown,id:string,credential=body)=>root.http.request('http://loom/api/'+operation.replace('.','/'),{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+credential},body:JSON.stringify({input,id})});
 return {db,clock,root,item,other,call,source};
}
it('lets a current chat body set its recorded member volume, with a finite mute and named-ask reset',async()=>{
 const f=fixture();
 expect((await f.call('inbox.volume',{item:f.item.id,volume:'dim'},'dim')).status).toBe(200);
 expect(f.root.services.conversations.item(f.item.id)).toMatchObject({volume:'dim',quietUntil:new Date(f.clock.now()+86400000).toISOString()});
 f.root.writes.run(()=>f.root.services.tempo.volume.changed({kind:'person',id:'sam'},f.item.id));
 expect(f.root.services.conversations.item(f.item.id).volume).toBe('full');
 expect((await f.call('inbox.volume',{item:f.item.id,volume:'dim'},'dim-named')).status).toBe(200);
 expect(f.root.services.conversations.item(f.item.id).volume).toBe('dim');
 f.root.writes.run(()=>f.root.services.tempo.volume.changed({kind:'person',id:'sam'},f.item.id,true));
 expect(f.root.services.conversations.item(f.item.id).volume).toBe('full');
 expect((await f.call('inbox.volume',{item:f.item.id,volume:'mute'},'mute')).status).toBe(200);
 expect(f.root.services.conversations.item(f.item.id)).toMatchObject({volume:'mute',quietUntil:new Date(f.clock.now()+7*86400000).toISOString(),words:'Work to read',changedAt:f.item.changedAt});
 f.root.writes.run(()=>f.root.services.tempo.volume.changed({kind:'person',id:'sam'},f.item.id));
 expect(f.root.services.conversations.item(f.item.id).volume).toBe('mute');
 f.root.writes.run(()=>f.root.services.tempo.volume.changed({kind:'person',id:'sam'},f.item.id,true));
 expect(f.root.services.conversations.item(f.item.id)).toMatchObject({volume:'full',quietUntil:null});
 expect((await f.call('inbox.volume',{item:f.item.id,volume:'mute'},'mute-again')).status).toBe(200);
 // Isolate the seven-day volume boundary from worker-silence reconciliation;
 // this fixture supplies no worker heartbeats during the simulated week.
 f.root.services.runtime.close();
 f.clock.advance(7*86400000);expect(f.root.services.conversations.item(f.item.id).volume).toBe('full');
 expect((await f.call('inbox.volume',{item:f.item.id,volume:'mute'},'mute-before-full')).status).toBe(200);
 expect(f.root.services.conversations.item(f.item.id).volume).toBe('mute');
 expect((await f.call('inbox.volume',{item:f.item.id,volume:'full'},'full')).status).toBe(200);
 expect(f.root.services.conversations.item(f.item.id)).toMatchObject({volume:'full',quietUntil:null});
 expect(f.db.select().from(approvals).all()).toEqual([]);
});
it('refuses another recipient, an unbound agent, and stale source authority even on receipt replay',async()=>{
 const f=fixture();
 expect((await f.call('inbox.volume',{item:f.other.id,volume:'mute'},'other')).status).toBe(403);
 expect((await f.call('inbox.volume',{item:f.item.id,volume:'mute'},'unbound',unbound)).status).toBe(403);
 expect((await f.call('inbox.volume',{item:f.item.id,volume:'mute'},'mute')).status).toBe(200);
 f.db.update(jobs).set({conversation:null}).where(eq(jobs.id,'body')).run();
 expect((await f.call('inbox.volume',{item:f.item.id,volume:'mute'},'mute')).status).toBe(403);
 f.db.update(jobs).set({conversation:f.source.id}).where(eq(jobs.id,'body')).run();
 f.db.update(jobs).set({state:'done'}).where(eq(jobs.id,'body')).run();
 expect((await f.call('inbox.volume',{item:f.item.id,volume:'mute'},'mute')).status).toBe(401);
 expect(f.root.services.conversations.item(f.other.id).volume).toBe('full');
});
it('does not turn a background conversation fallback owner into mailbox delegation',async()=>{
 const f=fixture();
 f.db.update(conversations).set({member:null,venue:'wake'}).where(eq(conversations.id,f.source.id)).run();
 f.db.update(jobs).set({member:null}).where(eq(jobs.id,'body')).run();
 const owner=f.root.services.conversations.send({toKind:'person',to:'owner',source:'notice',fromKind:'agent',words:'Owner work'});
 expect((await f.call('inbox.volume',{item:owner.id,volume:'mute'},'owner')).status).toBe(403);
 expect((await f.call('inbox.volume',{item:f.item.id,volume:'mute'},'sam')).status).toBe(403);
});

it('preserves direct member, owner and agent recipient authority without chat delegation',async()=>{
 const f=fixture(),sam='direct-sam-volume-'.repeat(3),owner='direct-owner-volume-'.repeat(3),at=new Date(f.clock.now()).toISOString();
 f.db.insert(tokens).values([{fingerprint:hash(sam),label:'Sam',kind:'owner',member:'sam',createdAt:at},{fingerprint:hash(owner),label:'Owner',kind:'owner',member:'owner',createdAt:at}]).run();
 expect((await f.call('inbox.volume',{item:f.item.id,volume:'dim'},'direct-sam',sam)).status).toBe(200);
 expect(f.root.services.conversations.item(f.item.id).volume).toBe('dim');
 expect((await f.call('inbox.volume',{item:f.other.id,volume:'mute'},'direct-other',sam)).status).toBe(403);
 expect((await f.call('inbox.volume',{item:f.other.id,volume:'mute'},'direct-owner',owner)).status).toBe(200);
 expect(f.root.services.conversations.item(f.other.id).volume).toBe('mute');
 const agent=f.root.services.conversations.send({toKind:'agent',to:'art',source:'notice',fromKind:'schedule',words:'Agent work'});
 expect((await f.call('inbox.volume',{item:agent.id,volume:'mute'},'direct-agent',unbound)).status).toBe(200);
 expect(f.root.services.conversations.item(agent.id).volume).toBe('mute');
});
