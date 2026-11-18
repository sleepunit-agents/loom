import {afterEach,expect,it} from 'vitest';
import {randomUUID} from 'node:crypto';
import {eq} from 'drizzle-orm';
import {bodyFixture,bodyCredentials as raw,credentialHash as hash} from '../test/fixtures/conversation-body.js';
import * as s from './core/data/schema.js';
const clean:(()=>void|Promise<void>)[]=[];afterEach(async()=>{for(const stop of clean.splice(0).reverse())await stop();});
const change='github:acme/app#1',head='a'.repeat(40),target={kind:'merge' as const,target:change+'@'+head};
const request={...target,what:'Merge the pump',why:'Ready',ask:'Merge?',ifYes:'Agent merges exact head',ifNo:'Wait'};
async function fixture(){
 const f=await bodyFixture(clean),at=new Date(f.clock.now()).toISOString(),owner='o'.repeat(64);
 f.db.insert(s.members).values({id:'pat',role:'owner',joinedAt:at}).run();f.db.insert(s.tokens).values({fingerprint:hash(owner),label:'Fixture owner',kind:'owner',member:'pat',createdAt:at}).run();
 f.db.insert(s.changes).values({id:change,repository:'acme/app',number:1,title:'Pump',body:'',url:'',state:'open',draft:false,authorLogin:'art',agent:'art',project:'pond',branch:'work',headCommit:head,baseBranch:'next',checks:'passing',review:'approved',mergeable:'yes',waitingOn:'you',openedAt:at,updatedAt:at}).run();
 const call=(name:string,input:unknown,id:string=randomUUID(),token=raw.body)=>f.root.http.request('/api/approvals/'+name,{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+token},body:JSON.stringify({input,id})});
 const ask=async(id:string=randomUUID())=>{const response=await call('request',request,id);expect(response.status).toBe(200);return (await response.json()).value.id as string;};
 const snapshot=()=>({cards:f.db.select().from(s.approvals).all(),record:f.db.select().from(s.approvalRecord).all(),notices:f.db.select().from(s.approvalNotices).all(),receipts:f.db.select().from(s.operationResults).all()});
 return {...f,owner,call,ask,snapshot};
}
it('requests through the actual mounted HTTP body proof with server-derived provenance and one receipt',async()=>{
 const f=await fixture();// A member and a worker have no door here. The agent's terminal credential has had one since 2026-11-17 (shared-work-own.test.ts).
 for(const token of [raw.member,raw.runner])expect((await f.call('request',request,'denied-'+token[0],token)).status).toBe(403);
 for(const claim of [{agent:'mark'},{actingFor:'pat'},{member:'bob'},{project:'other'},{conversation:'forged'},{askedFrom:'forged'},{job:'other'}])expect((await f.call('request',{...request,...claim})).status).toBe(400);
 const id=await f.ask('same');expect(await f.ask('same')).toBe(id);
 expect(f.db.select().from(s.approvals).all()).toEqual([expect.objectContaining({id,agent:'art',actingFor:'alice',member:'alice',project:'pond',conversation:f.thread.conversation,askedFrom:f.thread.conversation,state:'pending'})]);
 expect(f.db.select().from(s.inbox).all().filter(row=>row.source==='approval')).toEqual([expect.objectContaining({to:'pat',waitsOnId:id,member:'alice'})]);
 expect(f.db.select().from(s.approvalRecord).all().map(row=>row.event)).toEqual(['request']);
 const cookie=await f.root.http.request('/api/approvals/request',{method:'POST',headers:{'content-type':'application/json',cookie:'loom_ui='+raw.memberCookie},body:JSON.stringify({input:request,id:'cookie'})});expect(cookie.status).toBe(403);
});
it('reads current named-person grants without treating visibility, unknown context or owner words as authority',async()=>{
 const f=await fixture(),rules=f.root.services.approvalRules;
 rules.set({kind:'merge',scope:'project:pond',tier:'do'},'pat');expect((await (await f.call('rule',target)).json()).value).toEqual({tier:'ask',scope:null,person:null});
 rules.set({kind:'merge',scope:'project:pond',person:'alice',tier:'tell'},'pat');expect((await (await f.call('rule',target)).json()).value).toEqual({tier:'tell',scope:'project:pond',person:'alice'});
 f.root.writes.run(()=>f.db.update(s.members).set({role:'member'}).where(eq(s.members.id,'pat')).run());expect((await (await f.call('rule',target)).json()).value.tier).toBe('ask');
 f.root.writes.run(()=>f.db.update(s.members).set({role:'owner'}).where(eq(s.members.id,'pat')).run());
 f.root.writes.run(()=>{f.db.update(s.jobs).set({member:null}).run();f.db.update(s.conversations).set({member:null}).where(eq(s.conversations.id,f.thread.conversation)).run();});
 expect((await (await f.call('rule',target)).json()).value.tier).toBe('ask');const id=await f.ask();expect(f.root.services.approvals.get(id)).toMatchObject({actingFor:'unknown',member:null});
 expect(f.db.select().from(s.approvalNotices).all()).toEqual([]);
});
it('spends one exact allowance without forge effects, records refused uses, and withdraws only its conversation cards',async()=>{
 const f=await fixture(),id=await f.ask();
 expect((await f.call('answer',{id,answer:'allow'},randomUUID(),f.owner)).status).toBe(200);
 expect((await (await f.call('use',{id,...target,kind:'command'},'wrong')).json()).value).toEqual({id,used:false});
 expect((await (await f.call('use',{id,...target},'use')).json()).value).toEqual({id,used:true});expect((await (await f.call('use',{id,...target},'use')).json()).value).toEqual({id,used:true});
 expect((await (await f.call('use',{id,...target},'second')).json()).value).toEqual({id,used:false});
 expect(f.db.select().from(s.approvalRecord).all().map(row=>row.event)).toEqual(['request','allow','refused-use','use','refused-use']);expect(f.db.select().from(s.changes).get()?.state).toBe('open');
 const next=await f.ask();expect((await f.call('withdraw',{id:next},'withdraw')).status).toBe(200);expect((await f.call('withdraw',{id:next},'withdraw')).status).toBe(200);expect(f.root.services.approvals.get(next).state).toBe('withdrawn');
 f.db.update(s.approvals).set({conversation:null}).where(eq(s.approvals.id,next)).run();expect((await f.call('withdraw',{id:next},'withdraw')).status).toBe(403);
});
it('rechecks exact head, labels, current body and conversation bindings before fresh and cached results',async()=>{
 const f=await fixture(),id=await f.ask('request');const before=f.snapshot();
 f.root.writes.run(()=>f.db.update(s.changes).set({headCommit:'b'.repeat(40)}).run());expect((await f.call('request',request,'request')).status).toBe(403);expect((await f.call('rule',target)).status).toBe(409);expect((await f.call('use',{id,...target})).status).toBe(403);expect(f.snapshot()).toEqual({...before,record:[...before.record,expect.objectContaining({approval:id,event:'refused-use'})]});
 f.root.writes.run(()=>f.db.update(s.changes).set({headCommit:head,project:'other'}).run());expect((await f.call('request',request,'request')).status).toBe(403);
 f.root.writes.run(()=>f.db.update(s.changes).set({project:'pond',agent:'mark'}).run());expect((await f.call('request',request,'request')).status).toBe(403);
 f.root.writes.run(()=>f.db.update(s.changes).set({agent:'art'}).run());
 const other=f.root.services.comms!.threads.open({member:'alice',agent:'art',project:'pond',title:'Other'});
 f.root.writes.run(()=>{f.db.update(s.jobs).set({conversation:other.conversation}).where(eq(s.jobs.id,'job')).run();});
 expect((await f.call('request',request,'request')).status).toBe(409);expect((await f.call('withdraw',{id})).status).toBe(403);
 f.root.writes.run(()=>f.db.delete(s.memberAgents).run());expect((await f.call('request',request,'new')).status).toBe(403);
});
it('has no partial approval, question, audit or receipt if transaction persistence fails',async()=>{
 const f=await fixture(),before=f.snapshot(),inbox=f.db.select().from(s.inbox).all();
 f.db.$client.exec("CREATE TRIGGER fail_work_receipt BEFORE INSERT ON operation_results BEGIN SELECT RAISE(ABORT,'fixture failure'); END");
 expect((await f.call('request',request,'broken')).status).toBe(503);expect(f.snapshot()).toEqual(before);expect(f.db.select().from(s.inbox).all()).toEqual(inbox);
});

it.each(['stopped','revoked','box'] as const)('denies fresh and cached Work requests after body %s',async mutation=>{
 const f=await fixture();await f.ask('request');const before=f.snapshot();
 f.root.writes.run(()=>{if(mutation==='stopped')f.db.update(s.jobs).set({state:'done'}).run();else if(mutation==='box')f.db.update(s.boxes).set({revokedAt:new Date(f.clock.now()).toISOString()}).run();else f.db.update(s.tokens).set({revokedAt:new Date(f.clock.now()).toISOString()}).where(eq(s.tokens.fingerprint,hash(raw.body))).run();});
 expect([401,403]).toContain((await f.call('request',request,'request')).status);expect([401,403]).toContain((await f.call('request',request,'new')).status);expect(f.snapshot()).toEqual(before);
});

it('reads all four rule kinds without creating requests or running any effect',async()=>{
 const f=await fixture();for(const kind of ['merge','command','setting','dangerous'] as const){f.root.services.approvalRules.set({kind,scope:'*',person:'alice',tier:'do'},'pat');const input={kind,target:kind==='merge'?target.target:'fixture:target'};expect((await (await f.call('rule',input)).json()).value).toEqual({tier:'do',scope:'*',person:'alice'});}
 expect(f.db.select().from(s.approvals).all()).toEqual([]);expect(f.db.select().from(s.approvalRecord).all()).toEqual([]);expect(f.db.select().from(s.tempoSettings).all()).toEqual([]);expect(f.db.select().from(s.changes).get()?.state).toBe('open');
});
it('publishes a native HTTP body request and its audit atomically to two actual shared sockets',async()=>{
 const {createServer}=await import('node:http'),{getRequestListener}=await import('@hono/node-server'),{once}=await import('node:events'),{default:WebSocket}=await import('ws');
 const f=await fixture(),server=createServer(getRequestListener(f.root.http.fetch)),detach=f.root.attach(server);
 await new Promise<void>(ok=>server.listen(0,'127.0.0.1',ok));const address=server.address();if(!address||typeof address==='string')throw Error('No fixture listener');
 const url='http://127.0.0.1:'+address.port,sockets=[new WebSocket(url.replace('http:','ws:')+'/graphql','graphql-transport-ws',{headers:{authorization:'Bearer '+f.owner}}),new WebSocket(url.replace('http:','ws:')+'/graphql','graphql-transport-ws',{headers:{authorization:'Bearer '+f.owner}})];
 const opened=sockets.map(socket=>once(socket,'open'));
 try{
  await Promise.all(opened);
  for(const socket of sockets){let next=once(socket,'message');socket.send(JSON.stringify({type:'connection_init'}));expect(JSON.parse(String((await next)[0])).type).toBe('connection_ack');next=once(socket,'message');socket.send(JSON.stringify({type:'subscribe',id:'work',payload:{query:'subscription { observe(query:"{ approvals { id state actingFor } approvalRecord { approval event } }") { revision patches { path value removed } } }'}}));expect(JSON.parse(String((await next)[0])).payload.data.observe.patches[0].value).toEqual({approvals:[],approvalRecord:[]});}
  const updates=sockets.map(socket=>once(socket,'message'));
  const response=await fetch(url+'/api/approvals/request',{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+raw.body},body:JSON.stringify({input:request,id:'wire-request'})});expect(response.status).toBe(200);const id=(await response.json()).value.id;
  const frames=await Promise.all(updates);for(const frame of frames){const patches=JSON.parse(String(frame[0])).payload.data.observe.patches;expect(patches).toContainEqual({path:['approvals',0],value:{id,state:'pending',actingFor:'alice'},removed:false});expect(patches).toContainEqual({path:['approvalRecord',0],value:{approval:id,event:'request'},removed:false});}
  expect(frames[0][0].toString()).toBe(frames[1][0].toString());
 }finally{for(const socket of sockets)socket.terminate();detach();server.closeAllConnections();await new Promise<void>(ok=>server.close(()=>ok()));}
});

it.each(['closed','merged'] as const)('rejects fresh requests and rule reads for a %s change',async state=>{
 const f=await fixture();f.root.writes.run(()=>f.db.update(s.changes).set({state}).run());const before=f.snapshot();expect((await f.call('request',request)).status).toBe(403);expect((await f.call('rule',target)).status).toBe(409);expect(f.snapshot()).toEqual(before);
});
it('withdraws its own approval after the cached head moves',async()=>{
 const f=await fixture(),id=await f.ask();f.root.writes.run(()=>f.db.update(s.changes).set({headCommit:'b'.repeat(40)}).run());expect((await f.call('withdraw',{id},'stale-withdraw')).status).toBe(200);expect(f.root.services.approvals.get(id).state).toBe('withdrawn');expect(f.db.select().from(s.approvalRecord).all().map(row=>row.event)).toEqual(['request','withdraw']);
});
it('accepts command requests and spends their exact allowance without executing command text',async()=>{
 const f=await fixture(),command={...request,kind:'command',target:'box:box:echo fictitious'};const response=await f.call('request',command,'command');expect(response.status).toBe(200);const id=(await response.json()).value.id;
 expect(f.root.services.approvals.get(id)).toMatchObject({kind:'command',target:command.target,operation:null,state:'pending',agent:'art'});expect((await f.call('answer',{id,answer:'allow'},randomUUID(),f.owner)).status).toBe(200);
 expect((await (await f.call('use',{id,kind:'command',target:command.target})).json()).value).toEqual({id,used:true});expect(f.db.select().from(s.approvalRecord).all().map(row=>row.event)).toEqual(['request','allow','use']);expect(f.db.select().from(s.changes).get()?.state).toBe('open');
});
it('audits a stale-head refusal instead of replaying a cached successful spend',async()=>{
 const f=await fixture(),id=await f.ask();expect((await f.call('answer',{id,answer:'allow'},randomUUID(),f.owner)).status).toBe(200);expect((await f.call('use',{id,...target},'spent')).status).toBe(200);
 f.root.writes.run(()=>f.db.update(s.changes).set({headCommit:'b'.repeat(40)}).run());expect((await f.call('use',{id,...target},'spent')).status).toBe(403);expect(f.root.services.approvals.get(id).state).toBe('used');expect(f.db.select().from(s.approvalRecord).all().map(row=>row.event)).toEqual(['request','allow','use','refused-use']);
});
it('offers all four body Work operations only through HTTP, including for a valid proved body',async()=>{
 const f=await fixture(),id=await f.ask();expect((await f.call('answer',{id,answer:'allow'},randomUUID(),f.owner)).status).toBe(200);
 const auth=f.root.credentials.authenticate(new Request('http://loom/graphql',{headers:{authorization:'Bearer '+raw.body}}));expect(auth?.valid()).toBe(true);if(!auth)throw Error('No fixture body proof');
 const before=f.snapshot();for(const door of ['direct'] as const)for(const [name,input] of [['request',request],['rule',target],['use',{id,...target}],['withdraw',{id}]] as const){expect(f.root.operations.offered(door).some(row=>row.name==='approvals.'+name)).toBe(false);expect(f.root.operations.call(door,auth.viewer,'approvals.'+name,input,randomUUID())).toMatchObject({ok:false,code:'denied'});}
 expect(f.snapshot()).toEqual(before);
});
it.each(['member','project','job'] as const)('binds receipts against a valid same-conversation %s reassignment',async field=>{
 const f=await fixture(),id=await f.ask('original');
 f.root.writes.run(()=>{
  if(field==='member'){f.db.insert(s.memberAgents).values({member:'bob',agent:'art'}).run();f.db.insert(s.projectMembers).values({project:'pond',member:'bob'}).run();f.db.update(s.jobs).set({member:'bob'}).run();f.db.update(s.conversations).set({member:'bob'}).where(eq(s.conversations.id,f.thread.conversation)).run();}
  else if(field==='project'){f.db.insert(s.projectMembers).values({project:'other',member:'alice'}).run();f.db.insert(s.projectAgents).values({project:'other',agent:'art'}).run();f.db.update(s.jobs).set({project:'other'}).run();f.db.update(s.conversations).set({project:'other'}).where(eq(s.conversations.id,f.thread.conversation)).run();f.db.update(s.changes).set({project:'other'}).run();}
  else {const old=f.db.select().from(s.jobs).get()!;f.db.update(s.jobs).set({state:'done'}).where(eq(s.jobs.id,old.id)).run();f.db.insert(s.jobs).values({...old,id:'replacement'}).run();f.db.update(s.tokens).set({job:'replacement'}).where(eq(s.tokens.fingerprint,hash(raw.body))).run();}
 });
 expect((await f.call('rule',target)).status).toBe(200);expect((await f.call('request',request,'original')).status).toBe(409);expect(f.db.select().from(s.approvals).all().map(row=>row.id)).toEqual([id]);
});

it('isolates receipt namespaces after a valid current agent reassignment',async()=>{
 const f=await fixture(),old=await f.ask('actor-receipt');f.root.writes.run(()=>{f.db.insert(s.memberAgents).values({member:'alice',agent:'mark'}).run();f.db.insert(s.projectAgents).values({project:'pond',agent:'mark'}).run();f.db.update(s.jobs).set({agent:'mark'}).run();f.db.update(s.conversations).set({agent:'mark'}).where(eq(s.conversations.id,f.thread.conversation)).run();f.db.update(s.changes).set({agent:'mark'}).run();f.db.update(s.tokens).set({agent:'mark'}).where(eq(s.tokens.fingerprint,hash(raw.body))).run();});
 expect((await f.call('rule',target)).status).toBe(200);const next=await f.ask('actor-receipt');expect(next).not.toBe(old);expect(f.root.services.approvals.get(next).agent).toBe('mark');expect((await f.call('withdraw',{id:old})).status).toBe(403);expect(f.root.services.approvals.get(old).state).toBe('pending');
});

it('normalizes rule targets exactly like stored requests before reading an exact ask decision',async()=>{
 const f=await fixture();for(const [scope,tier] of [['box:box:echo','ask'],['box:box:echo *','do']] as const)f.root.services.approvalRules.set({kind:'command',scope,person:'alice',tier},'pat');
 const target='box:box:echo ';expect((await (await f.call('rule',{kind:'command',target})).json()).value).toEqual({tier:'ask',scope:'box:box:echo',person:'alice'});
 const response=await f.call('request',{...request,kind:'command',target});expect(response.status).toBe(200);const id=(await response.json()).value.id;expect(f.root.services.approvals.get(id)).toMatchObject({target:'box:box:echo',state:'pending'});
});

it('returns Ask after an exact owner No even when a standing rule says Do',async()=>{
 const f=await fixture(),id=await f.ask();expect((await f.call('answer',{id,answer:'deny'},randomUUID(),f.owner)).status).toBe(200);f.root.services.approvalRules.set({kind:'merge',scope:'project:pond',person:'alice',tier:'do'},'pat');expect((await (await f.call('rule',target)).json()).value).toEqual({tier:'ask',scope:null,person:null});
});

it('validates the exact conversation approval selection through the shared query door for its private member',async()=>{
 const {conversationApprovalsQuery}=await import('../web/src/pieces/comms/work-query.js');
 const f=await fixture(),id=await f.ask();
 // A settings card filed in this conversation, as a proposal would file it.
 const setting=f.root.services.approvals.request({kind:'setting',operation:'household.change',target:'household:tempoTimings:person alice',details:'{}',changeSummary:'Tempo timings for person alice: before → after',what:'Change Tempo timings',ask:'Change Tempo timings for person alice?',ifYes:'Make the change shown on this card.',ifNo:'Leave it as it is.',agent:'art',askedFrom:f.thread.conversation,actingFor:'alice',project:'pond',member:'alice',conversation:f.thread.conversation,why:'Requested here'});
 const response=await f.root.http.request('/graphql',{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+raw.member},body:JSON.stringify({query:conversationApprovalsQuery,variables:{conversation:f.thread.conversation,offset:0}})});
 const result=await response.json();expect(result.errors).toBeUndefined();expect(result.data.approvals).toHaveLength(2);expect(result.data.approvals).toEqual(expect.arrayContaining([{id},{id:setting.id}]));expect(result.data.inboxItems).toEqual([]);
});

it.each(['verified','quote only','ambiguous','guest quote','member quote','missing quote','no words','wrong item','wrong writer','wrong quote','generated mail','other word','own work','moved head'] as const)('checks owner mail before answering: %s', async scenario => {
 const f=await fixture(), id=await f.ask(), second=await f.ask();
 if(scenario!=='wrong writer' && scenario!=='member quote') f.db.update(s.members).set({role:'owner'}).where(eq(s.members.id,'alice')).run();
 expect((await f.send('Yes to both changes','word')).status).toBe(200);
 if(scenario==='quote only') expect((await f.send('A different instruction','distinct')).status).toBe(200);
 if(scenario==='ambiguous') expect((await f.send('Yes to both changes again','also')).status).toBe(200);
 const delivery=await f.root.http.request('/api/conversation/take',{method:'POST',headers:{authorization:'Bearer '+raw.body,'content-type':'application/json'},body:JSON.stringify({input:{}})});
 expect(delivery.status).toBe(200);
 const mail=(await delivery.json()).value.items as {id:string;words:string|null}[];
 const item=mail.find(row=>row.words==='Yes to both changes')!;
 expect(item).toBeDefined();
 let evidenceItem=item.id;
 if(scenario==='wrong item'){
  const thread=f.root.services.comms!.threads.open({member:'alice',agent:'art',project:'pond',title:'Another job'});
  const job=f.db.select().from(s.jobs).where(eq(s.jobs.id,'job')).get()!;
  f.db.insert(s.jobs).values({...job,id:'other-job',conversation:thread.conversation}).run();
  await f.root.services.comms!.send({thread:thread.id,sender:'alice',kind:'message',words:'Yes to both changes'});
  const [other]=f.root.services.conversations.take(thread.conversation,'other-job');
  expect(other).toMatchObject({job:'other-job',fromId:'alice'});
  evidenceItem=other.id;
 }
 if(scenario==='generated mail') f.db.update(s.inbox).set({source:'notice'}).where(eq(s.inbox.id,item.id)).run();
 if(scenario==='other word'||scenario==='guest quote') f.db.update(s.inbox).set({fromKind:'unknown',fromId:'guest'}).where(eq(s.inbox.id,item.id)).run();
 if(scenario==='own work'){
  f.db.update(s.conversations).set({member:null}).where(eq(s.conversations.id,f.thread.conversation)).run();
  f.db.update(s.inbox).set({source:'trigger',fromKind:'schedule',fromId:null}).where(eq(s.inbox.id,item.id)).run();
 }
 if(scenario==='moved head') f.db.update(s.changes).set({headCommit:'b'.repeat(40)}).run();
 const onWord={...(['quote only','ambiguous','guest quote','member quote','missing quote'].includes(scenario)?{}:{item:evidenceItem}),quote:scenario==='wrong quote'||scenario==='missing quote'?'fabricated':'Yes to both changes'};
 const answer=(card:string,decision:string)=>f.call('answer',{id:card,answer:decision,...(scenario==='no words'?{}:{onWord})});
 const snapshot=()=>({...f.snapshot(),mail:f.db.select().from(s.inbox).all()});
 const before=snapshot();
 const result=await (await answer(id,'allow')).json();
 if(scenario==='verified'||scenario==='quote only'){
  expect(result.ok).toBe(true);
  expect((await (await answer(second,'deny')).json()).ok).toBe(true);
  for(const card of [id,second]){
   const note=f.root.services.approvals.record(card).find(e=>['allow','deny'].includes(e.event))!.note;
   for(const part of ['alice through art','Yes to both changes',item.id,f.thread.conversation]) expect(note).toContain(part);
   expect(f.root.services.approvals.get(card).decidedBy).toBe('alice');
  }
 }else{
  const refusals={'member quote':'Those words do not appear in that message.','guest quote':'This job is not working on the owners’ word.','ambiguous':'Those words appear in more than one message. Quote a longer passage.','missing quote':'Those words do not appear in that message.','no words':'Name the owner’s message and quote their words.','wrong item':'That message is outside this job.','wrong writer':'The writer is not a household owner.','wrong quote':'Those words do not appear in that message.','generated mail':'Choose a message written by a person.','other word':'This job is not working on the owners’ word.','own work':'This job is not working on the owners’ word.','moved head':'The change head moved. Open it again.'};
  expect(result).toMatchObject({ok:false,message:refusals[scenario]});
  expect(snapshot()).toEqual(before);
 }
});

it('checks quote uniqueness again before returning a cached approval answer', async () => {
 const f=await fixture(), id=await f.ask();
 f.db.update(s.members).set({role:'owner'}).where(eq(s.members.id,'alice')).run();
 const take=()=>f.root.http.request('/api/conversation/take',{method:'POST',headers:{authorization:'Bearer '+raw.body,'content-type':'application/json'},body:JSON.stringify({input:{}})});
 const answer=()=>f.call('answer',{id,answer:'allow',onWord:{quote:'yes to the pump'}},'one-answer');
 expect((await f.send('yes to the pump change','first')).status).toBe(200);
 expect((await take()).status).toBe(200);
 expect((await answer()).status).toBe(200);
 expect((await answer()).status).toBe(200);
 expect((await f.send('yes to the pump again','second')).status).toBe(200);
 expect((await take()).status).toBe(200);
 const before=f.snapshot();
 expect(await (await answer()).json()).toMatchObject({ok:false,message:'Those words appear in more than one message. Quote a longer passage.'});
 expect(f.snapshot()).toEqual(before);
 const original=f.db.select().from(s.messages).where(eq(s.messages.sender,'alice')).all().find(row=>row.clientId==='first');
 expect(original).toBeDefined();
 f.db.update(s.messages).set({words:null}).where(eq(s.messages.inboxItem,original!.inboxItem!)).run();
 expect(await (await answer()).json()).toMatchObject({ok:false,message:'The message changed. Read it again.'});
 expect(f.snapshot()).toEqual(before);
});
