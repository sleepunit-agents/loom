import Database from 'better-sqlite3';
import { afterEach, expect, it, vi } from 'vitest';
import { GraphQLScalarType, GraphQLString } from 'graphql/index.js';
import { eq } from 'drizzle-orm';
import { FakeClock } from '../clock.js';
import { createDataSchema } from '../data/database.js';
import { workVisibility } from '../data/work-visibility.js';
import { agents, household, members, messages } from '../data/schema.js';
import { nextData } from '../../next-data.js';
import { CommsMessages } from './messages.js';
import { CommsQueries, commsQueryFields } from './comms-query.js';
import { InboxQueries, inboxQueryFields } from './inbox-query.js';
import { ConversationSummaries, conversationSummaryFields } from './summaries.js';
const clean: (()=>void|Promise<void>)[]=[];
afterEach(async()=>{for(const close of clean.splice(0).reverse())await close();vi.restoreAllMocks();});
const start=Date.parse('2026-11-14T18:00:00Z');
function fixture(fields: Parameters<typeof nextData>[4]={}, person='alice') {
 const client=new Database(':memory:');clean.push(()=>client.close());
 const clock=new FakeClock(start);let time=start;vi.spyOn(clock,'now').mockImplementation(()=>time);
 const now=()=>new Date(time).toISOString(),db=createDataSchema(client,now);
 db.insert(members).values([{id:'alice',role:'member',joinedAt:now()},{id:'owner',role:'owner',joinedAt:now()}]).run();
 db.insert(agents).values({id:'art',about:'',markBg:'#000',markFg:'#fff',faceShape:'pebble',faceEyes:'dot'}).run();
 const key={seal:async(s:string)=>Buffer.from(s),hash:(s:string)=>s,open:async(b:Uint8Array)=>Buffer.from(b).toString()};
 const service=new CommsMessages(db,key,now),thread=service.threads.open({member:'alice',agent:'art',title:'PRIVATE LABEL'});
 const policy=(viewer: Parameters<typeof workVisibility>[0], f: Parameters<NonNullable<ReturnType<typeof workVisibility>['approvals']>>[0])=>workVisibility(viewer).approvals!(f);
 const queries=new CommsQueries(db,key,policy,now),inbox=new InboxQueries(db,key,policy,now),summaries=new ConversationSummaries(db,key,now);
 const data=nextData(db,clock,()=>true,undefined,{...commsQueryFields(queries),...inboxQueryFields(inbox),...conversationSummaryFields(summaries),...fields},()=>true,()=>({viewer:{kind:'member',id:person},valid:()=>true}));
 clean.push(()=>data.close());
 const query=(source:string)=>data.http.request('/graphql',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({query:source})});
 return {db,clock,data,service,thread,query,setTime:(t:number)=>{time=t;}};
}
it('connects actual nextData HTTP publication to committed policy changes',async()=>{
 let entered!:()=>void,release!:()=>void;
 const started=new Promise<void>(r=>{entered=r;});
 const f=fixture({held:{type:GraphQLString,resolve:()=>{entered();return new Promise<string>(r=>{release=()=>r('public');});}}},'owner');
 const pending=f.query(`{commsThread(id:"${f.thread.id}"){title} held}`);await started;
 f.data.writes.run(()=>f.db.update(members).set({role:'member'}).where(eq(members.id,'owner')).run());release();
 const response=await pending;expect(response.status).toBe(503);expect(await response.text()).not.toContain('PRIVATE LABEL');
 const retry=await f.query(`{commsThread(id:"${f.thread.id}"){title}}`);expect(await retry.json()).toEqual({data:{commsThread:null}});
});
it.each(['comms','inbox','answer','summary','search'].flatMap(kind=>['stored','household'].flatMap(bound=>[false,true].map(clone=>({kind,bound,clone})))) )('guards actual $kind at $bound expiry (clone=$clone)',async({kind,bound,clone})=>{
 let step=()=>{};
 const scalar=new GraphQLScalarType({name:'PublicationClockStep',serialize:()=>({toJSON(){step();return 'public';}})});
 const f=fixture({step:{type:scalar,resolve:()=>true}});
 const question=await f.service.ask(f.thread.id,'art','ask',{words:'PRIVATE WORDS',answers:'words'});
 if(kind==='answer') await f.service.answer(question.inboxItem!,'alice','words','PRIVATE WORDS');
 if(kind==='summary') await f.service.send({thread:f.thread.id,kind:'reply',sender:'art',words:'PRIVATE WORDS'});
 f.data.writes.run(()=>{
  if(bound==='household'){f.db.insert(household).values({commsDays:1}).run();f.db.update(messages).set({at:'2026-11-13T18:00:01Z',keepUntil:'2026-11-28T18:00:00Z'}).run();}
  else f.db.update(messages).set({keepUntil:'2026-11-14T18:00:01Z'}).run();
 });
 const source=kind==='comms'?`{commsMessages(thread:"${f.thread.id}"){words}}`:kind==='summary'?'{recentConversations(agent:"art"){lastAnswer{words}}}':kind==='search'?'{inboxItems(search:"PRIVATE WORDS"){id}}':`{inboxItem(id:"${question.inboxItem}"){${kind==='answer'?'answerText':'body{words}'}}}`;
 if(clone){const response=await f.query(source);expect(response.status).toBe(200);const copy=response.clone();await Promise.resolve();f.setTime(start+1000);await expect(copy.text()).rejects.toThrow('Data access ended');await expect(response.text()).rejects.toThrow('Data access ended');}
 else {step=()=>f.setTime(start+1000);const response=await f.query(source.slice(0,-1)+' step}');expect(response.status).toBe(503);expect(await response.text()).not.toContain('PRIVATE WORDS');}
 expect(f.db.select().from(messages).get()?.words).not.toBeNull();
});
