import {afterEach,expect,it} from 'vitest';
import {randomUUID} from 'node:crypto';
import {eq} from 'drizzle-orm';
import {bodyFixture,bodyCredentials as raw} from '../test/fixtures/conversation-body.js';
import type {WorkAnswerAuthority} from './shared-work-commands.js';
import * as s from './core/data/schema.js';
const clean:(()=>void|Promise<void>)[]=[];afterEach(async()=>{for(const stop of clean.splice(0).reverse())await stop();});
const change='github:acme/app#1',head='a'.repeat(40),request={kind:'merge',target:change+'@'+head,what:'Merge pump',why:'Ready',ask:'Merge?',ifYes:'Agent merges exact head',ifNo:'Wait'};
async function fixture(authority?:WorkAnswerAuthority){
 const f=await bodyFixture(clean,{workAnswerAuthority:authority}),at=new Date(f.clock.now()).toISOString();
 f.db.insert(s.members).values({id:'pat',role:'owner',joinedAt:at}).run();
 f.db.insert(s.changes).values({id:change,repository:'acme/app',number:1,title:'Pump',body:'',url:'',state:'open',draft:false,authorLogin:'art',agent:'art',project:'pond',branch:'work',headCommit:head,baseBranch:'next',checks:'passing',review:'approved',mergeable:'yes',waitingOn:'you',openedAt:at,updatedAt:at}).run();
 const call=(name:string,input:unknown,id:string=randomUUID())=>f.root.http.request('/api/approvals/'+name,{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+raw.body},body:JSON.stringify({input,id})});
 const grant=(tier:'ask'|'tell'|'do',person='alice')=>f.root.services.approvalRules.set({kind:'merge',scope:'project:pond',person,tier},'pat');
 const ask=async(id='standing',input:unknown=request)=>{const response=await call('request',input,id);expect(response.status).toBe(200);return (await response.json()).value as {id:string;state:string};};
 return {...f,call,grant,ask};
}
it.each(['do','tell'] as const)('atomically applies a current personal %s rule without a pending owner question or forge merge',async tier=>{
 const f=await fixture();f.grant(tier);const first=await f.ask();expect(first.state).toBe('allowed');expect(await f.ask()).toEqual(first);
 expect(f.root.services.approvals.get(first.id)).toMatchObject({state:'allowed',decidedBy:'pat',actingFor:'alice',operation:null});
 expect(f.db.select().from(s.approvalRecord).all()).toMatchObject([{event:'request'},{event:'allow',note:`Standing ${tier} rule project:pond for alice, set by pat`}]);
 expect(f.db.select().from(s.inbox).all().filter(row=>row.source==='approval'&&row.toKind==='person'&&row.state==='waiting')).toEqual([]);
 expect(f.db.select().from(s.inbox).all().filter(row=>row.toKind==='agent'&&row.source==='answer')).toHaveLength(1);expect(f.db.select().from(s.approvalNotices).all()).toEqual([]);
 expect(f.db.select().from(s.changes).get()).toMatchObject({state:'open',headCommit:head,waitingOn:'agent'});
 expect((await (await f.call('use',{id:first.id,kind:'merge',target:request.target},'use')).json()).value.used).toBe(true);expect((await (await f.call('use',{id:first.id,kind:'merge',target:request.target},'again')).json()).value.used).toBe(false);
});
it.each(['ci','reviewer','author'] as const)('preserves the %s blocker while recording the standing merge allowance',async waitingOn=>{
 const f=await fixture();f.grant('do');f.root.writes.run(()=>f.db.update(s.changes).set({waitingOn}).run());expect((await f.ask()).state).toBe('allowed');expect(f.db.select().from(s.changes).get()?.waitingOn).toBe(waitingOn);
});
it.each(['unknown','other-person','ask','stale-setter'] as const)('keeps a pending explicit request for %s context',async mode=>{
 const f=await fixture();f.grant(mode==='ask'?'ask':'do',mode==='other-person'?'bob':'alice');
 if(mode==='unknown')f.root.writes.run(()=>{f.db.update(s.jobs).set({member:null}).run();f.db.update(s.conversations).set({member:null}).where(eq(s.conversations.id,f.thread.conversation)).run();});
 if(mode==='stale-setter')f.root.writes.run(()=>{f.db.update(s.members).set({role:'owner'}).where(eq(s.members.id,'bob')).run();f.db.update(s.members).set({role:'member'}).where(eq(s.members.id,'pat')).run();});
 expect((await f.ask()).state).toBe('pending');expect(f.db.select().from(s.approvalRecord).all().map(row=>row.event)).toEqual(['request']);expect(f.db.select().from(s.inbox).all().some(row=>row.toKind==='person'&&row.source==='approval'&&row.state==='waiting')).toBe(true);expect(f.db.select().from(s.changes).get()?.waitingOn).toBe('you');
});
it('uses household rules only for a concrete current household-owner principal',async()=>{
 const f=await fixture();f.grant('do','');expect((await f.ask('member')).state).toBe('pending');f.root.writes.run(()=>f.db.update(s.members).set({role:'owner'}).where(eq(s.members.id,'alice')).run());expect((await f.ask('owner')).state).toBe('allowed');
});
it.each(['approval','change'] as const)('honors the optional %s narrowing callback before a standing answer',async gate=>{
 const f=await fixture({approval:()=>gate!=='approval',change:()=>gate!=='change'});f.grant('do');expect((await f.ask()).state).toBe('pending');expect(f.db.select().from(s.approvalRecord).all().map(row=>row.event)).toEqual(['request']);
});
it('applies command rules without executing command text or changing unrelated Changes',async()=>{
 const f=await fixture();f.root.services.approvalRules.set({kind:'command',scope:'box:box:*',person:'alice',tier:'do'},'pat');const result=await f.ask('command',{...request,kind:'command',target:'box:box:echo fictitious'});expect(result.state).toBe('allowed');expect(f.root.services.approvals.get(result.id)).toMatchObject({kind:'command',operation:null});expect(f.db.select().from(s.changes).get()?.waitingOn).toBe('you');
});
it.each(['ask','remove'] as const)('resolves a changed rule (%s) for each new intent without revoking an existing allowance',async edit=>{
 const f=await fixture();f.grant('do');const original=await f.ask('original');if(edit==='ask')f.grant('ask');else f.root.services.approvalRules.set({kind:'merge',scope:'project:pond',person:'alice',tier:null},'pat');expect(await f.ask('original')).toEqual(original);expect((await f.ask('new')).state).toBe('pending');expect(f.db.select().from(s.approvals).all()).toHaveLength(2);expect(f.root.services.approvals.get(original.id).state).toBe('allowed');expect((await (await f.call('use',{id:original.id,kind:'merge',target:request.target},'use-after-edit')).json()).value.used).toBe(true);expect(f.root.services.approvals.get(original.id).state).toBe('used');expect(f.db.select().from(s.approvalRecord).all().map(row=>row.event)).toEqual(['request','allow','request','use']);
});
it('rolls back request, automatic allowance, audit, question, answer and waiting group if receipt persistence fails',async()=>{
 const f=await fixture();f.grant('do');const snapshot=()=>({cards:f.db.select().from(s.approvals).all(),audit:f.db.select().from(s.approvalRecord).all(),inbox:f.db.select().from(s.inbox).all(),changes:f.db.select().from(s.changes).all(),receipts:f.db.select().from(s.operationResults).all()});const before=snapshot();f.db.$client.exec("CREATE TRIGGER fail_standing_receipt BEFORE INSERT ON operation_results BEGIN SELECT RAISE(ABORT,'fixture failure'); END");expect((await f.call('request',request,'fail')).status).toBe(503);expect(snapshot()).toEqual(before);
});
it('publishes only the final automatic answer, audit and resolved question through an actual shared socket',async()=>{
 const {createHash}=await import('node:crypto'),{createServer}=await import('node:http'),{getRequestListener}=await import('@hono/node-server'),{once}=await import('node:events'),{default:WebSocket}=await import('ws');
 const f=await fixture();f.grant('do');const token='p'.repeat(64);f.db.insert(s.tokens).values({fingerprint:createHash('sha256').update(token).digest('hex'),label:'Standing proof owner',kind:'owner',member:'pat',createdAt:new Date(f.clock.now()).toISOString()}).run();
 const server=createServer(getRequestListener(f.root.http.fetch)),detach=f.root.attach(server);await new Promise<void>(ok=>server.listen(0,'127.0.0.1',ok));const address=server.address();if(!address||typeof address==='string')throw Error('No fixture listener');const url='http://127.0.0.1:'+address.port,socket=new WebSocket(url.replace('http:','ws:')+'/graphql','graphql-transport-ws',{headers:{authorization:'Bearer '+token}});
 try{
  await once(socket,'open');let next=once(socket,'message');socket.send(JSON.stringify({type:'connection_init'}));await next;
  const query='{ approvals { id state } approvalRecord { event } changes { waitingOn } inboxItems(source:"approval"){state} }';next=once(socket,'message');socket.send(JSON.stringify({type:'subscribe',id:'standing',payload:{query:'subscription { observe(query:'+JSON.stringify(query)+') { revision patches { path value removed } } }'}}));expect(JSON.parse(String((await next)[0])).payload.data.observe.patches[0].value).toEqual({approvals:[],approvalRecord:[],changes:[{waitingOn:'you'}],inboxItems:[]});
  next=once(socket,'message');const response=await fetch(url+'/api/approvals/request',{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+raw.body},body:JSON.stringify({input:request,id:'wire-standing'})});expect(response.status).toBe(200);const result=(await response.json()).value;expect(result.state).toBe('allowed');
  const patches=JSON.parse(String((await next)[0])).payload.data.observe.patches;expect(patches).toContainEqual({path:['approvals',0],value:{id:result.id,state:'allowed'},removed:false});expect(patches).toContainEqual({path:['approvalRecord',0],value:{event:'request'},removed:false});expect(patches).toContainEqual({path:['approvalRecord',1],value:{event:'allow'},removed:false});expect(patches).toContainEqual({path:['inboxItems',0],value:{state:'resolved'},removed:false});expect(patches).toContainEqual({path:['changes',0,'waitingOn'],value:'agent',removed:false});expect(JSON.stringify(patches)).not.toContain('pending');expect(JSON.stringify(patches)).not.toContain('"state":"waiting"');
 }finally{socket.terminate();detach();server.closeAllConnections();await new Promise<void>(ok=>server.close(()=>ok()));}
});
