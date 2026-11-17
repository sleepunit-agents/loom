/** A bridge conversation over two bodies: what the second is told when it continues the first one's session,
 * and when it cannot. Real intake, real doors, the real body program; the harness and the place its
 * session files live are stood in for. */
import Database from 'better-sqlite3';
import {createHash} from 'node:crypto';
import {afterEach,expect,it,vi} from 'vitest';
import {FakeClock} from './core/clock.js';
import {createDataSchema} from './core/data/database.js';
import * as s from './core/data/schema.js';
import {sharedRoot} from './shared-root.js';
import {bodyProgram} from './runtime/body-program.js';
import {HarnessResumeUnavailable,type HarnessRun,type HarnessSession} from './runtime/body-harness.js';
import type {BodySessions} from './runtime/body-session.js';
import type {WorkerAssignment} from './runtime/worker.js';
import type {bridgeSlackSocket} from './pieces/bridges/slack-socket.js';
import {wordsKey} from './pieces/comms/crypto.js';

const clean:(()=>unknown|Promise<unknown>)[]=[];
afterEach(async()=>{for(const close of clean.splice(0).reverse())await close();});
async function fixture(){
 const sql=new Database(':memory:');clean.push(()=>sql.close());const db=createDataSchema(sql),clock=new FakeClock(),now=()=>new Date(clock.now()).toISOString();
 db.insert(s.members).values({id:'owner',role:'owner',joinedAt:now()}).run();db.insert(s.agents).values({id:'art',about:'',markBg:'',markFg:'',faceShape:'pebble',faceEyes:'dot'}).run();
 db.insert(s.boxes).values({id:'box',name:'Box',owner:'owner',sameMachineAsLoom:false,hostsAny:false,reportOnly:false,alwaysOn:false,enrolledAt:now()}).run();
 db.insert(s.secrets).values(['TOKEN','APP'].map(name=>({name,description:'Synthetic',changedAt:now(),changedBy:'owner'}))).run();
 db.insert(s.bridgeConnections).values({id:'connection',platform:'slack',workspace:'TWORK',botUser:'UBOT',agent:'art',tokenSecret:'TOKEN',appSecret:'APP',enabled:true,state:'disconnected',stateAt:now()}).run();
 db.insert(s.bridgeChannels).values({platform:'slack',workspace:'TWORK',channel:'CROOM',answers:'art',botsMayTalk:false}).run();
 db.insert(s.bridgePeople).values({platform:'slack',workspace:'TWORK',user:'UUSER',member:'owner'}).run();
 let slack!:Parameters<typeof bridgeSlackSocket>[0],posted=0;
 const request=vi.fn<typeof fetch>(async url=>{
  const path=String(url);
  if(path.endsWith('auth.test'))return Response.json({ok:true,user_id:'UBOT',team_id:'TWORK',bot_id:'BBOT'});
  if(path.endsWith('bots.info'))return Response.json({ok:true,bot:{id:'BBOT',user_id:'UBOT',app_id:'AAPP',deleted:false}});
  if(path.endsWith('conversations.info'))return Response.json({ok:true,channel:{id:'CROOM',context_team_id:'TWORK',is_channel:true}});
  if(path.endsWith('chat.postMessage'))return Response.json({ok:true,channel:'CROOM',ts:`17944320${String(10+posted++)}.000009`});
  throw Error('Unexpected fictitious provider path');
 });
 const root=sharedRoot({db,clock,originAllowed:()=>true,reportError:()=>{},commsKey:wordsKey('AGE-SECRET-KEY-10SC5M7Q03WKNXKZHXZKY6JWHDV8MP7DS8USNSE64C674RN6TDGDSEKQNMR'),tempo:{admit:()=>true},
  bridges:{request,source:{generation:async()=>'12345678-1234-4234-8234-123456789abc',read:async()=>Buffer.from('SYNTHETIC_TOKEN')},effectsAllowed:()=>true,slack:options=>{slack=options;options.state?.('connected');return{close:async()=>{}};}}});
 clean.push(()=>root.close());
 const daemon=root.services.bridges.daemon!;await daemon.ready();await daemon.idle();
 let events=0;
 /** A message in the one Slack thread, so every message is the same conversation. */
 const hear=async(text:string)=>{
  const n=++events;
  await slack.receive({},Buffer.from(JSON.stringify({type:'events_api',envelope_id:'ack'+n,payload:{type:'event_callback',event_id:'event'+n,team_id:'TWORK',event:{type:'message',channel:'CROOM',user:'UUSER',text,ts:`179443200${n}.000001`,...(n>1?{thread_ts:'1794432001.000001'}:{})}}})));
  clock.advance(0);await daemon.idle();
  return db.select().from(s.bridgeIncoming).all().at(-1)!;
 };
 /** One body's whole run for the conversation's waiting mail. */
 const run=async(id:string,conversation:string,native:HarnessRun,sessions:BodySessions,more:{reach?:'loom'|'all';saveAttachments?:Parameters<typeof bodyProgram>[0]['saveAttachments']}={})=>{
  const token='body_'+createHash('sha256').update(id).digest('hex');
  const job:WorkerAssignment={id,agent:'art',box:'box',conversation,venue:'slack',thread:null,model:'claude-opus-5-5',account:'account',harness:'claude',brief:'',house:{repository:'r',file:'f',branch:'next'}};
  root.writes.run(()=>{
   db.insert(s.jobs).values({id,agent:'art',box:'box',conversation,title:'',brief:'',model:job.model,harness:'claude',state:'running',startedByKind:'agent',startedBy:'art',houseRepository:'r',houseFile:'f',houseBranch:'next',queuedAt:now()}).run();
   db.insert(s.tokens).values({fingerprint:createHash('sha256').update(token).digest('hex'),label:'Synthetic body '+id,kind:'agent',agent:'art',job:id,createdAt:now()}).run();
  });
  const errors=vi.fn();
  const exit=await bodyProgram({args:['config'],read:async()=>JSON.stringify({command:'/fake/claude',cwd:'/house',...(more.reach?{reach:more.reach}:{})}),stdin:async()=>Buffer.from(JSON.stringify({job,build:'image',bootstrap:{origin:'https://loom.example',job:id,token}})),
   env:{LOOM_BODY_SCRATCH:'/scratch-of-this-body'},signal:new AbortController().signal,clock,...(more.saveAttachments?{saveAttachments:more.saveAttachments}:{}),fetch:async(url,options)=>root.http.request(String(url),options),schedule:{every:()=>()=>{}},error:errors,startup:async()=>{},loadMemory:async()=>'IDENTITY',loadBrief:async()=>null,native,sessions});
  await daemon.idle();
  root.writes.run(()=>{db.update(s.jobs).set({state:'done'}).run();});
  return exit;
 };
 return {db,clock,root,hear,run};
}
/** Stands in for where a harness keeps its sessions: what loom handed over, and what the run left. */
function keeper(kept?:string){
 const calls:string[]=[];
 const sessions:BodySessions={take:async()=>{calls.push('take');return kept;},save:async session=>{calls.push('save:'+session);},discard:()=>{calls.push('discard');}};
 return {sessions,calls};
}

it('starts a first body fresh, keeping a session, and tells the next one only the new message when it continues that session',async()=>{
 const f=await fixture(),first=await f.hear('What is the plan?');
 const one=keeper(),seen:{words:string;session?:HarnessSession}[]=[];
 const native:HarnessRun=async(_job,words,_signal,session)=>{seen.push({words,session});return{text:'Three steps.',model:'claude-opus-5-5',actions:[],session:'session-one-1'};};
 expect(await f.run('one',first.conversation!,native,one.sessions)).toBe(0);
 // Fresh: asked to keep a session and to continue none, and told who it is with its mail.
 expect(seen[0].session).toEqual({});expect(seen[0].words).toBe('IDENTITY\n\nWhat is the plan?');
 expect(one.calls).toEqual(['take','save:session-one-1']);
 const second=await f.hear('Do the second one');expect(second.conversation).toBe(first.conversation);
 const two=keeper('session-one-1');
 expect(await f.run('two',second.conversation!,native,two.sessions)).toBe(0);
 // Continued: the session already holds what came before, so neither the history nor the identity is said again.
 expect(seen[1]).toEqual({words:'Do the second one',session:{resume:'session-one-1'}});
 expect(two.calls).toEqual(['take','save:session-one-1']);
 expect(f.db.select().from(s.bridgeSends).all().map(send=>[send.text,send.state])).toEqual([['Three steps.','sent'],['Three steps.','sent']]);
});

it('runs the same work afresh, with the kept history, when the harness cannot continue the session it was handed',async()=>{
 const f=await fixture(),first=await f.hear('What is the plan?');
 const native:HarnessRun=async()=>({text:'Three steps.',model:'claude-opus-5-5',actions:[],session:'session-one-1'});
 await f.run('one',first.conversation!,native,keeper().sessions);
 const second=await f.hear('Do the second one');
 const two=keeper('session-gone-9'),seen:{words:string;session?:HarnessSession}[]=[];
 const failing:HarnessRun=async(_job,words,_signal,session)=>{seen.push({words,session});if(session?.resume)throw new HarnessResumeUnavailable();return{text:'Done.',model:'claude-opus-5-5',actions:[],session:'session-new-2'};};
 expect(await f.run('two',second.conversation!,failing,two.sessions)).toBe(0);
 expect(seen.map(call=>call.session)).toEqual([{resume:'session-gone-9'},{}]);
 expect(seen[0].words).toBe('Do the second one');
 // Afresh it is told who it is and what was said before, then the new message.
 expect(seen[1].words.startsWith('IDENTITY\n\n')).toBe(true);
 expect(JSON.parse(seen[1].words.slice('IDENTITY\n\n'.length))).toMatchObject({input:'Do the second one',history:[{kind:'message',words:'What is the plan?'},{kind:'reply',words:'Three steps.'}]});
 // The session the new run left is the one handed back, and the answer is posted once.
 expect(two.calls).toEqual(['take','save:session-new-2']);
 expect(f.db.select().from(s.bridgeSends).all().map(send=>send.text)).toEqual(['Three steps.','Done.']);
});

it('does not run the work twice for any other failure, and hands loom nothing for a run that did not answer',async()=>{
 const f=await fixture(),first=await f.hear('What is the plan?');
 const one=keeper('session-one-1');let runs=0;
 const broken:HarnessRun=async()=>{runs++;throw Error('Native execution unavailable');};
 expect(await f.run('one',first.conversation!,broken,one.sessions)).not.toBe(0);
 expect(runs).toBe(1);
 // What loom keeps is left as it is; only this machine's copy goes.
 expect(one.calls).toEqual(['take','discard']);
 expect(f.db.select().from(s.bridgeSends).all()).toEqual([]);
});

it('writes what was sent with a message only for a body that has file tools to open it with',async()=>{
 const f=await fixture(),first=await f.hear('Look at this');
 const asked:{incoming:readonly string[];scratch:string|undefined}[]=[],seen:string[]=[];
 const saveAttachments:NonNullable<Parameters<typeof bodyProgram>[0]['saveAttachments']>=async(_client,incoming,scratch)=>{asked.push({incoming:[...incoming],scratch});return 'Files sent with these messages are saved here for you to open:\n- /scratch-of-this-body/attachments-x/1-cat.png (cat.png, 3 bytes)';};
 const native:HarnessRun=async(_job,words)=>{seen.push(words);return{text:'I see.',model:'claude-opus-5-5',actions:[]};};
 // A body held to loom's own tools has nothing to open a file with: none is fetched for it or written, and it is told of none.
 expect(await f.run('one',first.conversation!,native,keeper().sessions,{saveAttachments})).toBe(0);
 expect(asked).toEqual([]);expect(seen[0]).toBe('IDENTITY\n\nLook at this');
 expect(await f.run('two',(await f.hear('And this')).conversation!,native,keeper().sessions,{reach:'loom',saveAttachments})).toBe(0);
 expect(asked).toEqual([]);
 // A body with the harness's own tools is: for the messages it took, into its own scratch directory.
 const third=await f.hear('And this one');
 expect(await f.run('three',third.conversation!,native,keeper().sessions,{reach:'all',saveAttachments})).toBe(0);
 expect(asked).toHaveLength(1);expect(asked[0].scratch).toBe('/scratch-of-this-body');
 // The one message this job took, by the id loom keeps its files under.
 expect(asked[0].incoming).toEqual([f.db.select().from(s.bridgeIncoming).all().find(row=>row.text==='And this one')!.id]);
 expect(seen[2].endsWith('saved here for you to open:\n- /scratch-of-this-body/attachments-x/1-cat.png (cat.png, 3 bytes)')).toBe(true);
});
