/** Actual normal-startup listener; all people, credentials and words are fictitious. */
import {expect,it,vi} from 'vitest';
import {eq} from 'drizzle-orm';
import {z} from 'zod';
import {existsSync} from 'node:fs';
import {dirname} from 'node:path';
import {sharedUiProgram} from '../test/fixtures/shared-ui-program.js';
import {credentialHash as hash} from '../test/fixtures/conversation-body.js';
import {FakeClock} from './core/clock.js';
import * as s from './core/data/schema.js';
import {bodyConversationClient,bodyMailContext} from './runtime/conversation-client.js';
it('normal startup carries a private conversation through the one Inbox and actual body HTTP SDK',async()=>{
 const clock=new FakeClock(Date.parse('2026-11-15T12:00:00Z')),body='fictional-body-token-'.repeat(4);
 const p=await sharedUiProgram({clock,seed(db,now){
  db.insert(s.members).values([{id:'alice',role:'owner',joinedAt:now()},{id:'bob',role:'member',joinedAt:now()}]).run();
  db.insert(s.agents).values(['art','mark'].map(id=>({id,about:'',markBg:'',markFg:'',faceShape:'pebble' as const,faceEyes:'dot' as const}))).run();
  db.insert(s.memberAgents).values(['art','mark'].map(agent=>({member:'alice',agent}))).run();
 }});
 let sdk:ReturnType<typeof bodyConversationClient>|undefined;
 try{
  expect(await(await fetch(p.url+'/p/comms-preview')).text()).toContain('FICTIONAL SHARED PROGRAM');
  expect(await(await fetch(p.url+'/auth/session')).json()).toEqual({viewer:null});
  const signin=await fetch(p.composition.signinLink(),{method:'POST',redirect:'manual',headers:{origin:p.url}});expect(signin.status).toBe(303);
  const signedCookie=signin.headers.get('set-cookie')!.split(';',1)[0];
  expect(await(await fetch(p.url+'/auth/session',{headers:{cookie:signedCookie}})).json()).toMatchObject({viewer:{kind:'member',id:'alice'}});
  const now=()=>new Date(clock.now()).toISOString();
  let request=0;
  const call=async(name:string,input:unknown)=>{const response=await fetch(p.url+'/api/'+name,{method:'POST',headers:{cookie:signedCookie,origin:p.url,'content-type':'application/json'},body:JSON.stringify({input,id:'fixture-'+name+'-'+(++request)})});expect(response.status).toBe(200);return z.object({value:z.unknown()}).parse(await response.json()).value;};
  const opened=z.object({thread:z.string(),conversation:z.string()}).parse(await call('comms/open',{thread:'th:startup',agent:'art'}));
  const sent=z.object({item:z.string()}).parse(await call('comms/send',{thread:opened.thread,clientId:'person',words:'PRIVATE STARTUP MESSAGE'}));
  p.composition.writes.run(()=>{
   p.db.insert(s.boxes).values({id:'box',name:'Fictional box',owner:'alice',sameMachineAsLoom:false,hostsAny:false,reportOnly:false,alwaysOn:false,enrolledAt:now()}).run();
   p.db.insert(s.jobs).values({id:'job',agent:'art',box:'box',member:'alice',conversation:opened.conversation,title:'Fictional body',state:'running',brief:'',model:'fixture',startedByKind:'member',startedBy:'alice',houseRepository:'fixture',houseFile:'HOUSE.md',houseBranch:'next',queuedAt:now()}).run();
   p.db.update(s.conversations).set({job:'job'}).where(eq(s.conversations.id,opened.conversation)).run();
   p.db.insert(s.tokens).values({fingerprint:hash(body),label:'Fictional body',kind:'agent',agent:'art',job:'job',createdAt:now()}).run();
  });
  sdk=bodyConversationClient({url:p.url,token:body,job:'job',conversation:opened.conversation,signal:new AbortController().signal,clock});
  expect(await sdk.takeAndAccept(async item=>{expect(item.words).toBe('PRIVATE STARTUP MESSAGE');expect(p.db.select().from(s.inbox).where(eq(s.inbox.id,sent.item)).get()?.state).toBe('taken');})).toMatchObject({accepted:1});
  expect(p.db.select().from(s.inbox).where(eq(s.inbox.id,sent.item)).get()?.state).toBe('done');
  const question={words:'PRIVATE STARTUP QUESTION',why:'PRIVATE WHY',ifYes:'PRIVATE YES',ifNo:'PRIVATE NO',link:'https://example.invalid/fiction'};
  const digest=await sdk.digest({summary:'Fictional summary',question:{...question,to:'alice',answers:'yes-no'}});expect(digest.item).toBeTruthy();
  await call('inbox/answer',{item:digest.item,answer:'yes'});
  expect(await sdk.takeAndAccept(async item=>{expect(JSON.parse(bodyMailContext(item)!)).toEqual({question,answer:'yes',verdict:'yes'});})).toMatchObject({accepted:1});
  const turn=await sdk.turn({kind:'reply',model:'fixture',outcome:'answered'});
  await sdk.finding({turnSeq:turn.seq,measure:'Fictional quality',score:4,text:'Useful reply'});
  const query=await fetch(p.url+'/graphql',{method:'POST',headers:{cookie:signedCookie,origin:p.url,'content-type':'application/json'},body:JSON.stringify({query:'{findings{turnSeq score text}}'})});expect(await query.json()).toEqual({data:{findings:[{turnSeq:turn.seq,score:4,text:'Useful reply'}]}});
  const handed=await fetch(p.url+'/api/conversation/handoff',{method:'POST',headers:{authorization:'Bearer '+body,origin:p.url,'content-type':'application/json'},body:JSON.stringify({id:'startup-handoff',input:{agent:'mark',clientId:'first',label:'Fictional comparison',words:'PRIVATE STARTUP HANDOFF'}})});expect(handed.status).toBe(200);
  const child=z.object({value:z.object({conversation:z.string(),item:z.string()})}).parse(await handed.json()).value;
  expect(p.db.select().from(s.conversations).where(eq(s.conversations.id,child.conversation)).get()).toMatchObject({venue:'handoff',place:'job',agent:'mark',member:'alice',project:null});
  expect(p.db.select().from(s.inbox).where(eq(s.inbox.id,child.item)).get()).toMatchObject({source:'handoff',fromKind:'agent',fromId:'art',toKind:'agent',to:'mark',conversation:child.conversation});
  for(const table of [s.inbox,s.jobs,s.operationResults,s.messages,s.conversations,s.turns,s.findings])expect(JSON.stringify(p.db.select().from(table).all())).not.toContain('PRIVATE');
  const pending=z.object({item:z.string()}).parse(await call('comms/send',{thread:opened.thread,clientId:'revoked-pending',words:'PRIVATE PENDING INPUT'}));
  p.composition.writes.run(()=>p.db.delete(s.memberAgents).run());
  const acceptRevoked=vi.fn(async()=>{});
  await expect(sdk.takeAndAccept(acceptRevoked)).rejects.toThrow();expect(acceptRevoked).not.toHaveBeenCalled();
  expect(p.db.select().from(s.inbox).where(eq(s.inbox.id,pending.item)).get()?.state).toBe('waiting');
  expect(p.errors).toEqual([]);
 }finally{try{sdk?.close();}finally{await p.close();}}
});

it.each(['seed','startup','close'] as const)('cleans the fictional home and restores environment on %s',async phase=>{
 const names=['LOOM_WORKER_SOCKET','LOOM_PUBLIC_URL'] as const,previous=names.map(name=>process.env[name]);
 for(const name of names)process.env[name]='fictional-before-'+name;
 let home:string|undefined;
 const options={clock:new FakeClock(),webRoot:undefined as string|undefined,seed(db:Parameters<Parameters<typeof sharedUiProgram>[0]['seed']>[0],now:()=>string){
  home=dirname(db.$client.name);
  db.insert(s.members).values({id:'alice',role:'owner',joinedAt:now()}).run();
  db.insert(s.agents).values({id:'art',about:'',markBg:'',markFg:'',faceShape:'pebble',faceEyes:'dot'}).run();
  if(phase==='seed')throw Error('Fictional seed failure');
  if(phase==='startup')options.webRoot=home;
 }};
 try{
  if(phase==='close'){
   const p=await sharedUiProgram(options);await p.close();await p.close();
   await expect(fetch(p.url+'/auth/session')).rejects.toThrow();
  }else await expect(sharedUiProgram(options)).rejects.toThrow(phase==='seed'?'Fictional seed failure':'Public assets overlap private household files');
  expect(home).toBeTruthy();expect(existsSync(home!)).toBe(false);
  for(const name of names)expect(process.env[name]).toBe('fictional-before-'+name);
 }finally{names.forEach((name,i)=>{if(previous[i]===undefined)delete process.env[name];else process.env[name]=previous[i];});}
});
