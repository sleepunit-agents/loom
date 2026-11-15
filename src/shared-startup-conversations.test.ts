/** Actual normal-startup listener; all people, credentials and words are fictitious. */
import {expect,it} from 'vitest';
import {eq} from 'drizzle-orm';
import {sharedUiProgram} from '../test/fixtures/shared-ui-program.js';
import {credentialHash as hash} from '../test/fixtures/conversation-body.js';
import {FakeClock} from './core/clock.js';
import * as s from './core/data/schema.js';
import {bodyConversationClient,bodyMailContext} from './runtime/conversation-client.js';
it('normal startup carries a private conversation through the one Inbox and actual body HTTP SDK',async()=>{
 const clock=new FakeClock(Date.parse('2026-11-15T12:00:00Z')),body='fictional-body-token-'.repeat(4);
 const p=await sharedUiProgram({clock,seed(db,now){
  db.insert(s.members).values([{id:'alice',role:'owner',joinedAt:now()},{id:'bob',role:'member',joinedAt:now()}]).run();
  db.insert(s.agents).values({id:'art',about:'',markBg:'',markFg:'',faceShape:'pebble',faceEyes:'dot'}).run();
  db.insert(s.memberAgents).values({member:'alice',agent:'art'}).run();
 }});
 let sdk:ReturnType<typeof bodyConversationClient>|undefined;
 try{
  expect(await(await fetch(p.url+'/p/comms-preview')).text()).toContain('FICTIONAL SHARED PROGRAM');
  expect(await(await fetch(p.url+'/auth/session')).json()).toEqual({viewer:null});
  const signin=await fetch(p.printed[0].trim(),{method:'POST',redirect:'manual',headers:{origin:p.url}});expect(signin.status).toBe(303);
  const signedCookie=signin.headers.get('set-cookie')!.split(';',1)[0];
  expect(await(await fetch(p.url+'/auth/session',{headers:{cookie:signedCookie}})).json()).toMatchObject({viewer:{kind:'member',id:'alice'}});
  const now=()=>new Date(clock.now()).toISOString();
  const call=async(name:string,input:unknown)=>{const response=await fetch(p.url+'/api/'+name,{method:'POST',headers:{cookie:signedCookie,origin:p.url,'content-type':'application/json'},body:JSON.stringify({input,id:'fixture-'+name})});expect(response.status).toBe(200);return(await response.json()).value;};
  const opened=await call('comms/open',{thread:'th:startup',agent:'art'});
  const sent=await call('comms/send',{thread:opened.thread,clientId:'person',words:'PRIVATE STARTUP MESSAGE'});
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
  for(const table of [s.inbox,s.jobs,s.operationResults])expect(JSON.stringify(p.db.select().from(table).all())).not.toContain('PRIVATE');
  p.composition.writes.run(()=>p.db.delete(s.memberAgents).run());
  await expect(sdk.takeAndAccept(async()=>{throw Error('revoked body must not deliver');})).rejects.toThrow();
  expect(p.errors).toEqual([]);
 }finally{sdk?.close();await p.close();}
});
