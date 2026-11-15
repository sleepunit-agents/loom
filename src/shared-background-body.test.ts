/** Real Root/body protocol, no provider or child process. */
import {afterEach,expect,it} from 'vitest';
import {eq} from 'drizzle-orm';
import {bodyFixture,bodyCredentials,credentialHash} from '../test/fixtures/conversation-body.js';
import {bodyProgram} from './runtime/body-program.js';
import * as s from './core/data/schema.js';
const clean:(()=>void|Promise<void>)[]=[];
afterEach(async()=>{for(const close of clean.splice(0).reverse())await close();});
it.each([['wake',false],['handoff',false],['wake',true],['handoff',true]] as const)('completes actual %s Inbox mail without Comms (authored digest %s)',async(venue,authored)=>{
 const f=await bodyFixture(clean),conversation=f.thread.conversation,token='body_'+'d'.repeat(64);
 f.root.writes.run(()=>{
  f.db.delete(s.threads).where(eq(s.threads.id,f.thread.id)).run();
  f.db.update(s.conversations).set({venue,member:null,place:venue==='wake'?'nightly':'parent-job'}).where(eq(s.conversations.id,conversation)).run();
  f.db.update(s.jobs).set({member:null}).where(eq(s.jobs.id,'job')).run();
  const old=f.db.select().from(s.tokens).where(eq(s.tokens.fingerprint,credentialHash(bodyCredentials.body))).get()!;
  f.db.delete(s.tokens).where(eq(s.tokens.fingerprint,old.fingerprint)).run();
  f.db.insert(s.tokens).values({...old,fingerprint:credentialHash(token),label:'Background body'}).run();
 });
 const mail=f.root.services.comms!.threads.conversations.send({conversation,toKind:'agent',to:'art',source:venue==='wake'?'trigger':'handoff',fromKind:venue==='wake'?'schedule':'agent',fromId:venue==='wake'?null:'mark',words:'Compare three fictitious pumps'});
 const job={id:'job',box:'box',agent:'art',conversation,thread:null,venue,model:'requested',account:'fixture-account',harness:'claude',brief:'',house:{repository:'fixture',file:'Housefile',branch:'next'}};
 const bytes=Buffer.from(JSON.stringify({job,build:'fixture-image',bootstrap:{origin:'https://loom.example',job:'job',token}}));
 const errors:string[]=[];
 expect(await bodyProgram({args:['config'],read:async()=>JSON.stringify({command:'/fake/claude',cwd:'/fixture'}),stdin:async()=>bytes,env:{},signal:new AbortController().signal,clock:f.clock,schedule:{every:()=>()=>{}},
  fetch:async(url,init)=>f.root.http.request(new Request(String(url),init)),
  native:async(assigned,words)=>{if(authored){const result=await f.call('digest',{summary:'Authored decisions',items:[{kind:'task',text:'Keep the inspection task'}],question:{to:'alice',answers:'yes-no',words:'Inspect the pump?'}},'authored-digest',token);expect(result.status).toBe(200);}expect(assigned).toEqual(job);expect(words).toBe('Compare three fictitious pumps');expect(f.db.select().from(s.inbox).where(eq(s.inbox.id,mail.id)).get()?.state).toBe('done');return {text:'Three pumps compared.',model:'actual-background-model',actions:[{model:'actual-tool-model'}]};},
  error:text=>errors.push(text)})).toBe(0);
 expect(errors).toEqual([]);
 expect(f.db.select().from(s.turns).all()).toEqual(expect.arrayContaining([expect.objectContaining({conversation,kind:'reply',model:'actual-background-model',run:'job'}),expect.objectContaining({conversation,kind:'action',model:'actual-tool-model',run:'job'})]));
 expect(f.db.select().from(s.digests).all()).toEqual([expect.objectContaining({conversation,run:'job',summary:authored?'Authored decisions':'Completed this stretch of work.',revision:1})]);
 if(authored){expect(f.db.select().from(s.digestItems).all()).toEqual([expect.objectContaining({kind:'task',text:'Keep the inspection task'})]);
  expect(f.db.select().from(s.inbox).all()).toEqual(expect.arrayContaining([expect.objectContaining({toKind:'person',to:'alice',words:'Inspect the pump?',state:'waiting'})]));
 }
 expect(f.db.select().from(s.threads).all()).toEqual([]);expect(f.db.select().from(s.messages).all()).toEqual([]);
 expect(f.db.select().from(s.agentStatus).get()).toMatchObject({state:'idle',work:''});
 expect(bytes.every(byte=>byte===0)).toBe(true);
});
