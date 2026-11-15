import {sealHandoff} from './core/conversations/handoff-words.js';
/** Real Root completion effects; native execution and every credential are fictitious. */
import {afterEach,expect,it} from 'vitest';
import {eq} from 'drizzle-orm';
import {z} from 'zod';
import {bodyFixture,bodyCredentials,credentialHash} from '../test/fixtures/conversation-body.js';
import {bodyProgram} from './runtime/body-program.js';
import * as s from './core/data/schema.js';
const clean:(()=>void|Promise<void>)[]=[];
afterEach(async()=>{for(const close of clean.splice(0).reverse())await close();});
it.each(['comms','authored','private-handoff'] as const)('records completion without copying reply words: %s',async mode=>{
 const f=await bodyFixture(clean),token='body_'+'e'.repeat(64),background=mode==='private-handoff';
 f.root.writes.run(()=>{
  const old=f.db.select().from(s.tokens).where(eq(s.tokens.fingerprint,credentialHash(bodyCredentials.body))).get()!;
  f.db.delete(s.tokens).where(eq(s.tokens.fingerprint,old.fingerprint)).run();f.db.insert(s.tokens).values({...old,fingerprint:credentialHash(token)}).run();
  if(background){f.db.delete(s.threads).where(eq(s.threads.id,f.thread.id)).run();f.db.update(s.conversations).set({venue:'handoff',place:'fictional-parent-job'}).where(eq(s.conversations.id,f.thread.conversation)).run();}
 });
 const brief=background?await sealHandoff(f.key,'Fictional private handoff',new Date(f.clock.now()).toISOString(),14):null;
 if(background)f.root.writes.run(()=>f.root.services.conversations.send({conversation:f.thread.conversation,toKind:'agent',to:'art',source:'handoff',fromKind:'agent',fromId:'mark',words:brief}));
 else expect((await f.send('Fictional member input','person')).status).toBe(200);
 const job={id:'job',box:'box',agent:'art',conversation:f.thread.conversation,thread:background?null:f.thread.id,venue:background?'handoff':'loom',model:'fixture',account:'fixture',harness:'claude',brief:'',house:{repository:'fixture',file:'Housefile',branch:'next'}};
 const bytes=Buffer.from(JSON.stringify({job,build:'fixture',bootstrap:{origin:'https://loom.invalid',job:'job',token}}));
 let authored:string|undefined,question:string|undefined;
 const errors:string[]=[];
 expect(await bodyProgram({args:['config'],read:async()=>JSON.stringify({command:'/fictional/claude',cwd:'/fictional'}),stdin:async()=>bytes,env:{},signal:new AbortController().signal,clock:f.clock,schedule:{every:()=>()=>{}},startup:async()=>{},fetch:async(url,init)=>f.root.http.request(new Request(String(url),init)),native:async()=>{
  if(mode==='authored'){
   const response=await f.call('digest',{summary:'Reviewed the fictional plan',items:[{kind:'decision',text:'Keep the smaller plan'}],question:{to:'alice',answers:'yes-no',words:'PRIVATE MODEL QUESTION'}},'model-digest',token);expect(response.status).toBe(200);const value=z.object({value:z.object({digest:z.string(),item:z.string().nullable()})}).parse(await response.json()).value;authored=value.digest;question=value.item??undefined;
  }
  return{text:'PRIVATE RESPONSE WORDS',model:'observed',actions:[]};
 },error:text=>errors.push(text)})).toBe(0);
 expect(errors).toEqual([]);
 const rows=f.db.select().from(s.digests).all();expect(rows).toHaveLength(1);expect(rows[0]).toMatchObject({conversation:f.thread.conversation,run:'job',revision:1,summary:mode==='authored'?'Reviewed the fictional plan':'Completed this stretch of work.'});
 expect(JSON.stringify(rows)).not.toContain('PRIVATE');
 if(authored){expect(rows[0].id).toBe(authored);expect(rows[0].inboxItem).toBe(question);expect(f.db.select().from(s.inbox).where(eq(s.inbox.id,question!)).get()?.state).toBe('waiting');expect(f.db.select().from(s.digestItems).all()).toMatchObject([{kind:'decision',text:'Keep the smaller plan'}]);}
 expect(bytes.every(byte=>byte===0)).toBe(true);
});
