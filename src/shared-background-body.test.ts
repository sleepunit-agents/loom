import {sealHandoff} from './core/conversations/handoff-words.js';
import {jobRoom} from './shared-place-mail.js';
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
  if(venue==='handoff'){f.db.insert(s.memberAgents).values({member:'alice',agent:'mark'}).run();f.db.insert(s.projectAgents).values({project:'pond',agent:'mark'}).run();}
  f.db.delete(s.threads).where(eq(s.threads.id,f.thread.id)).run();
  f.db.update(s.conversations).set({venue,member:null,place:venue==='wake'?'nightly':'parent-job'}).where(eq(s.conversations.id,conversation)).run();
  f.db.update(s.jobs).set({member:null}).where(eq(s.jobs.id,'job')).run();
  const old=f.db.select().from(s.tokens).where(eq(s.tokens.fingerprint,credentialHash(bodyCredentials.body))).get()!;
  f.db.delete(s.tokens).where(eq(s.tokens.fingerprint,old.fingerprint)).run();
  f.db.insert(s.tokens).values({...old,fingerprint:credentialHash(token),label:'Background body'}).run();
 });
 const brief=venue==='handoff'?await sealHandoff(f.key,'Compare three fictitious pumps',new Date(f.clock.now()).toISOString(),14):'Compare three fictitious pumps';
 const mail=f.root.services.comms!.threads.conversations.send({conversation,toKind:'agent',to:'art',source:venue==='wake'?'trigger':'handoff',fromKind:venue==='wake'?'schedule':'agent',fromId:venue==='wake'?null:'mark',words:brief});
 const job={id:'job',box:'box',agent:'art',conversation,thread:null,venue,model:'requested',account:'fixture-account',harness:'claude',brief:'',house:{repository:'fixture',file:'Housefile',branch:'next'},
  // The room loom reads for the job, as its dispatcher hands it: the word decides what the body asks for.
  run:{nestedContainers:false,gpu:false,ports:[],policy:jobRoom(f.db,{id:'job',agent:'art',conversation})}};
 const bytes=Buffer.from(JSON.stringify({job,build:'fixture-image',bootstrap:{origin:'https://loom.example',job:'job',token}}));
 const errors:string[]=[];
 expect(await bodyProgram({args:['config'],read:async()=>JSON.stringify({command:'/fake/claude',cwd:'/fixture'}),stdin:async()=>bytes,env:{},signal:new AbortController().signal,clock:f.clock,schedule:{every:()=>()=>{}},
  fetch:async(url,init)=>f.root.http.request(new Request(String(url),init)),
  native:async(assigned,words)=>{if(authored){const result=await f.call('digest',{summary:'Authored decisions',items:[{kind:'task',text:'Keep the inspection task'}],question:{to:'alice',answers:'yes-no',words:'Inspect the pump?'}},'authored-digest',token);expect(result.status).toBe(200);}expect(assigned).toEqual(job);if(venue==='handoff'){expect(words).toContain('Ask one yes-or-no question and give both outcomes in ifYes and ifNo.');expect(words).toMatch(/\n\nCompare three fictitious pumps$/);}else expect(words).toBe('Compare three fictitious pumps');expect(f.db.select().from(s.inbox).where(eq(s.inbox.id,mail.id)).get()?.state).toBe('taken');return {text:'Three pumps compared.',model:'actual-background-model',actions:[{model:'actual-tool-model'}]};},
  error:text=>errors.push(text)})).toBe(0);
 expect(errors).toEqual([]);
 // Settled only after the work was recorded.
 expect(f.db.select().from(s.inbox).where(eq(s.inbox.id,mail.id)).get()?.state).toBe('done');
 expect(f.db.select().from(s.turns).all()).toEqual(expect.arrayContaining([expect.objectContaining({conversation,kind:'reply',model:'actual-background-model',run:'job'}),expect.objectContaining({conversation,kind:'action',model:'actual-tool-model',run:'job'})]));
 // A brief with nobody's word on it is anybody else's: loom's line is first on its summary, as on its question. A lane's own work writes its own words alone.
 const stamp=venue==='handoff'?`[From loom: written while working for somebody loom cannot name in conversation ${conversation}, who is not one of art's owners.] `:'';
 expect(f.db.select().from(s.digests).all()).toEqual([expect.objectContaining({conversation,run:'job',summary:stamp+(authored?'Authored decisions':'Completed this stretch of work.'),revision:1})]);
 if(authored){expect(f.db.select().from(s.digestItems).all()).toEqual([expect.objectContaining({kind:'task',text:'Keep the inspection task'})]);
  // A brief with nobody's word on it is anybody else's: the question says so first, in loom's words. A lane's own work asks in its own words alone.
  const asked=venue==='handoff'?'Asked while working for somebody loom cannot name, who is not one of Art\'s owners.\n\nInspect the pump?':'Inspect the pump?';
  expect(f.db.select().from(s.inbox).all()).toEqual(expect.arrayContaining([expect.objectContaining({toKind:'person',to:'alice',words:asked,state:'waiting'})]));
 }
 expect(f.db.select().from(s.threads).all()).toEqual([]);expect(f.db.select().from(s.messages).all()).toEqual([]);
 // Such a brief's body writes nothing to the agent's one status row; a lane's own work reports as before.
 if(venue==='handoff')expect(f.db.select().from(s.agentStatus).get()).toBeUndefined();else expect(f.db.select().from(s.agentStatus).get()).toMatchObject({state:'idle',work:''});
 expect(bytes.every(byte=>byte===0)).toBe(true);
});
