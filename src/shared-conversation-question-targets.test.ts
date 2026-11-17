import {afterEach,expect,it} from 'vitest';
import {bodyFixture,bodyCredentials as raw} from '../test/fixtures/conversation-body.js';
const clean:(()=>void|Promise<void>)[]=[];afterEach(async()=>{for(const close of clean.splice(0).reverse())await close();});
it('refuses a wait-on link to another member private task instead of routing its eventual close reason into this Inbox',async()=>{
 const f=await bodyFixture(clean),task=f.root.services.tasks.create({title:'Bob task',goal:'Private',why:'Private',owner:{kind:'member',id:'bob'}},{kind:'member',id:'bob'});
 const before=await f.root.http.request('/graphql',{method:'POST',headers:{cookie:'loom_ui='+raw.memberCookie,'content-type':'application/json'},body:JSON.stringify({query:'{tasks{id}}'})});expect(await before.json()).toEqual({data:{tasks:[]}});
 const response=await f.call('digest',{summary:'A harmless question',question:{to:'alice',answers:'yes-no',words:'Continue?',waitsOnKind:'task',waitsOnId:task.id}},'foreign-wait');expect(response.status).toBe(403);
});

import {eq} from 'drizzle-orm';
import * as s from './core/data/schema.js';
const question=(id:string)=>({summary:'Work',question:{to:'alice',answers:'yes-no',words:'Continue?',waitsOnKind:'task',waitsOnId:id}});
const query=async(f:Awaited<ReturnType<typeof bodyFixture>>,q:string)=>await(await f.root.http.request('/graphql',{method:'POST',headers:{cookie:'loom_ui='+raw.memberCookie,'content-type':'application/json'},body:JSON.stringify({query:q})})).json();
it('allows current private context but refuses the same member registry outside that context and unknown sources',async()=>{
 const f=await bodyFixture(clean);
 const task=f.root.services.tasks.create({title:'Private task',goal:'Do',why:'Because',owner:{kind:'member',id:'alice'}},{kind:'member',id:'alice'});
 expect((await f.call('digest',question(task.id),'outside-context')).status).toBe(403);
 f.root.writes.run(()=>f.db.update(s.tasks).set({sourceKind:'conversation',sourceId:f.thread.conversation}).where(eq(s.tasks.id,task.id)).run());
 expect((await f.call('digest',question(task.id),'current-context')).status).toBe(200);
 expect((await f.call('digest',question('missing'),'unknown')).status).toBe(403);
 expect((await f.call('digest',{summary:'Work',question:{to:'alice',answers:'yes-no',words:'Continue?',waitsOnId:task.id}},'unpaired')).status).toBe(400);
});
it('links a task raised in this conversation whenever its member may read it by the tasks rule, with no rule of its own',async()=>{
 const f=await bodyFixture(clean);
 // Raised from this thread, and owned by another agent Alice has: hers to read by the tasks rule, though not this agent's task.
 f.root.writes.run(()=>f.db.insert(s.memberAgents).values({member:'alice',agent:'mark'}).run());
 const task=f.root.services.tasks.create({title:'Mark task',goal:'Do',why:'Because',owner:{kind:'agent',id:'mark'}},{kind:'member',id:'alice'});
 f.root.writes.run(()=>f.db.update(s.tasks).set({sourceKind:'conversation',sourceId:f.thread.conversation}).where(eq(s.tasks.id,task.id)).run());
 expect((await f.call('digest',question(task.id),'readable')).status).toBe(200);
 // Once the tasks rule no longer shows it to her, the same link is refused.
 f.root.writes.run(()=>f.db.delete(s.memberAgents).where(eq(s.memberAgents.agent,'mark')).run());
 expect((await f.call('digest',question(task.id),'unreadable')).status).toBe(403);
});
it('rechecks source authority after encryption and on receipt replay',async()=>{
 const f=await bodyFixture(clean),task=f.root.services.tasks.create({title:'Private task',goal:'Do',why:'Because',owner:{kind:'member',id:'alice'}},{kind:'member',id:'alice'});
 f.root.writes.run(()=>f.db.update(s.tasks).set({sourceKind:'conversation',sourceId:f.thread.conversation}).where(eq(s.tasks.id,task.id)).run());
 f.gate(async()=>{f.root.writes.run(()=>f.db.update(s.tasks).set({owner:'bob'}).where(eq(s.tasks.id,task.id)).run());});
 expect((await f.call('digest',question(task.id),'during-seal')).status).toBe(403);
 expect(f.db.select().from(s.digests).all()).toEqual([]);
 f.gate(async()=>{});f.root.writes.run(()=>f.db.update(s.tasks).set({owner:'alice'}).where(eq(s.tasks.id,task.id)).run());
 expect((await f.call('digest',question(task.id),'saved')).status).toBe(200);
 f.root.writes.run(()=>f.db.update(s.tasks).set({owner:'bob'}).where(eq(s.tasks.id,task.id)).run());
 expect((await f.call('digest',question(task.id),'saved')).status).toBe(403);
});
it('withholds a linked question and its eventual resolution after source access is lost',async()=>{
 const f=await bodyFixture(clean),task=f.root.services.tasks.create({title:'Project task',goal:'Do',why:'Because',project:'pond',owner:{kind:'member',id:'bob'}},{kind:'member',id:'bob'});
 expect((await f.call('digest',question(task.id),'project')).status).toBe(200);
 const item=f.db.select().from(s.digests).get()!.inboxItem!;
 expect(await query(f,'{inboxItem(id:"'+item+'"){id}}')).toEqual({data:{inboxItem:{id:item}}});
 const held=await f.root.http.request('/graphql',{method:'POST',headers:{cookie:'loom_ui='+raw.memberCookie,'content-type':'application/json'},body:JSON.stringify({query:'{inboxItem(id:"'+item+'"){id}}'})});
 f.root.writes.run(()=>f.db.delete(s.projectMembers).run());
 f.root.services.tasks.close(task.id,'PRIVATE CLOSE REASON');
 expect(f.db.select().from(s.inbox).where(eq(s.inbox.id,item)).get()?.resolution).toBe('PRIVATE CLOSE REASON');
 expect(await query(f,'{inboxItem(id:"'+item+'"){id state resolution} inboxItems(search:"PRIVATE CLOSE REASON"){id}}')).toEqual({data:{inboxItem:null,inboxItems:[]}});
 expect(await query(f,'{inboxFolders{needs alerts answered fyi all agents{id count}}}')).toEqual({data:{inboxFolders:{needs:0,alerts:0,answered:0,fyi:0,all:0,agents:[]}}});
 await expect(held.text()).rejects.toThrow();
 const denied=await f.root.http.request('/api/inbox/read',{method:'POST',headers:{cookie:'loom_ui='+raw.memberCookie,'content-type':'application/json'},body:JSON.stringify({input:{item},id:'read-hidden'})});
 expect(denied.status).toBe(403);
 const volume=await f.root.http.request('/api/inbox/volume',{method:'POST',headers:{cookie:'loom_ui='+raw.memberCookie,'content-type':'application/json'},body:JSON.stringify({input:{item,volume:'mute'},id:'hidden-volume'})});expect(volume.status).toBe(403);
 const watch=await f.root.http.request('/api/tempo/set',{method:'POST',headers:{cookie:'loom_ui='+raw.memberCookie,'content-type':'application/json'},body:JSON.stringify({input:{id:'hidden-watch',ownerKind:'member',owner:'alice',sourceKind:'answer',watches:'question:'+item,lifespan:'once',targetKind:'inbox',toKind:'person',to:'alice',instructions:'Follow up',note:'Follow up'},id:'hidden-watch'})});expect(watch.status).toBe(403);
});

it('checks approval links against the exact private context',async()=>{
 const f=await bodyFixture(clean),at=new Date(f.clock.now()).toISOString();
 const insert=(id:string,conversation:string,member='alice')=>f.db.insert(s.approvals).values({id,kind:'command',what:'Private approval',why:'Because',ask:'Proceed?',ifYes:'Proceed',ifNo:'Wait',agent:'art',actingFor:member,member,project:'pond',conversation,askedFrom:conversation,target:'fixture',state:'pending',minutes:5,details:'',askedAt:at}).run();
 const other=f.root.services.comms!.threads.open({member:'alice',agent:'art',project:'pond',title:'Other'});insert('approval-current',f.thread.conversation);insert('approval-other',other.conversation);
 const input=(id:string)=>({summary:'Work',question:{to:'alice',answers:'yes-no',words:'Continue?',waitsOnKind:'approval',waitsOnId:id}});
 expect((await f.call('digest',input('approval-current'),'current')).status).toBe(200);
 expect((await f.call('digest',input('approval-other'),'other')).status).toBe(403);
 const item=f.db.select().from(s.digests).get()!.inboxItem!;
 expect(await query(f,'{inboxItem(id:"'+item+'"){id}}')).toEqual({data:{inboxItem:{id:item}}});
 const held=await f.root.http.request('/graphql',{method:'POST',headers:{cookie:'loom_ui='+raw.memberCookie,'content-type':'application/json'},body:JSON.stringify({query:'{inboxItem(id:"'+item+'"){id}}'})});
 f.root.writes.run(()=>f.db.update(s.approvals).set({member:'bob'}).where(eq(s.approvals.id,'approval-current')).run());
 expect(await query(f,'{inboxItem(id:"'+item+'"){id} inboxItems(search:"Continue?"){id} inboxFolders{all}}')).toEqual({data:{inboxItem:null,inboxItems:[],inboxFolders:{all:0}}});
 await expect(held.text()).rejects.toThrow();
 for(const [name,extra] of [['read',{}],['volume',{volume:'mute'}]] as const){
  const response=await f.root.http.request('/api/inbox/'+name,{method:'POST',headers:{cookie:'loom_ui='+raw.memberCookie,'content-type':'application/json'},body:JSON.stringify({input:{item,...extra},id:'approval-hidden-'+name})});expect(response.status).toBe(403);
 }

});

it('requires a public question recipient to see the current context',async()=>{
 const f=await bodyFixture(clean);
 f.root.writes.run(()=>{f.db.update(s.conversations).set({member:null,venue:'wake'}).where(eq(s.conversations.id,f.thread.conversation)).run();f.db.update(s.jobs).set({member:null}).where(eq(s.jobs.id,'job')).run();});
 const input={summary:'Work',question:{to:'bob',answers:'yes-no',words:'Continue?'}};
 expect((await f.call('digest',input,'invisible-recipient')).status).toBe(403);
 f.root.writes.run(()=>f.db.insert(s.projectMembers).values({member:'bob',project:'pond'}).run());
 expect((await f.call('digest',input,'visible-recipient')).status).toBe(200);
 const task=f.root.services.tasks.create({title:'Agent private',goal:'Do',why:'Because',owner:{kind:'agent',id:'art'}},{kind:'agent',id:'art'});
 expect((await f.call('digest',{...input,question:{...input.question,waitsOnKind:'task',waitsOnId:task.id}},'recipient-source-hidden')).status).toBe(403);
});

it('filters linked hidden rows before paging and counts',async()=>{
 const f=await bodyFixture(clean);
 const a=f.root.services.tasks.create({title:'Visible',goal:'Do',why:'Because',project:'pond',owner:{kind:'member',id:'alice'}},{kind:'member',id:'alice'});
 const b=f.root.services.tasks.create({title:'Hidden later',goal:'Do',why:'Because',project:'pond',owner:{kind:'member',id:'bob'}},{kind:'member',id:'bob'});
 expect((await f.call('digest',question(a.id),'visible')).status).toBe(200);
 const visible=f.db.select().from(s.digests).get()!.inboxItem!;
 f.clock.advance(1000);
 expect((await f.call('digest',question(b.id),'hidden')).status).toBe(200);
 f.root.writes.run(()=>f.db.update(s.tasks).set({project:null}).where(eq(s.tasks.id,b.id)).run());
 expect(await query(f,'{inboxItems(limit:1){id} inboxFolders{all}}')).toEqual({data:{inboxItems:[{id:visible}],inboxFolders:{all:1}}});
 expect(await query(f,'{inboxItems(limit:1,offset:1){id}}')).toEqual({data:{inboxItems:[]}});
});

it('refuses recipient access withdrawn while private question encryption is pending',async()=>{
 const f=await bodyFixture(clean);
 f.gate(async()=>{f.root.writes.run(()=>f.db.delete(s.projectMembers).run());});
 expect((await f.call('digest',{summary:'Work',question:{to:'alice',answers:'yes-no',words:'Continue?'}},'recipient-race')).status).toBe(403);
 expect(f.db.select().from(s.digests).all()).toEqual([]);
 expect(f.db.select().from(s.inbox).all()).toEqual([]);
 expect(f.db.select().from(s.operationResults).all()).toEqual([]);
});

it('withdraws connected notice counts and delegated body volume controls with source access',async()=>{
 const f=await bodyFixture(clean),task=f.root.services.tasks.create({title:'Project',goal:'Do',why:'Because',project:'pond',owner:{kind:'member',id:'bob'}},{kind:'member',id:'bob'});
 expect((await f.call('digest',question(task.id),'notice')).status).toBe(200);
 const item=f.db.select().from(s.digests).get()!.inboxItem!;
 const volume=(id:string)=>f.root.http.request('/api/inbox/volume',{method:'POST',headers:{authorization:'Bearer '+raw.body,'content-type':'application/json'},body:JSON.stringify({input:{item,volume:'full'},id})});
 expect((await volume('visible-body-volume')).status).toBe(200);
 f.clock.advance(5000);
 expect(await query(f,'{settledInboxNotice{count}}')).toEqual({data:{settledInboxNotice:{count:1}}});
 f.root.writes.run(()=>f.db.update(s.tasks).set({project:null}).where(eq(s.tasks.id,task.id)).run());
 expect(await query(f,'{settledInboxNotice{count}}')).toEqual({data:{settledInboxNotice:null}});
 expect((await volume('hidden-body-volume')).status).toBe(403);
 expect((await volume('visible-body-volume')).status).toBe(403);
});
