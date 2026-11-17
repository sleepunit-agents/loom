import {afterEach,expect,it} from 'vitest';
import {and,eq,inArray} from 'drizzle-orm';
import {bodyFixture,bodyCredentials as raw,credentialHash as hash} from '../test/fixtures/conversation-body.js';
import {bodyConversationClient} from './runtime/conversation-client.js';
import * as s from './core/data/schema.js';
const clean:(()=>void|Promise<void>)[]=[];afterEach(async()=>{for(const close of clean.splice(0).reverse())await close();});
const finding={turnSeq:1,measure:'DISTINCTIVE_REVIEW_MEASURE',score:4,text:'Useful fictitious reply'};
function sdk(f:Awaited<ReturnType<typeof bodyFixture>>){const client=bodyConversationClient({url:'https://loom.invalid',token:raw.body,job:'job',conversation:f.thread.conversation,signal:new AbortController().signal,clock:f.clock,fetch:async(url,init)=>f.root.http.request(new Request(url,init))});clean.push(()=>client.close());return client;}
async function fixture(){const f=await bodyFixture(clean);expect((await f.call('turn',{kind:'reply',model:'actual',outcome:'answered'},'reply')).status).toBe(200);return f;}
it('reports a score on the actual agent turn through the body SDK, deriving conversation/day and upserting only its natural key',async()=>{
 const f=await fixture(),client=sdk(f);
 expect(await client.finding(finding,'score-1')).toEqual({saved:true,day:'2026-11-14'});expect(await client.finding({...finding,score:5,text:'Revised fictitious review'},'score-2')).toEqual({saved:true,day:'2026-11-14'});
 expect(f.db.select().from(s.findings).all()).toEqual([{...finding,score:5,text:'Revised fictitious review',conversation:f.thread.conversation,day:'2026-11-14'}]);expect(f.db.select().from(s.turns).all()).toHaveLength(1);
 const read=await f.root.http.request('/graphql',{method:'POST',headers:{cookie:'loom_ui='+raw.memberCookie,'content-type':'application/json'},body:JSON.stringify({query:'{findings{conversation day turnSeq measure score text}}'})});expect(await read.json()).toEqual({data:{findings:[{...finding,score:5,text:'Revised fictitious review',conversation:f.thread.conversation,day:'2026-11-14'}]}});
 const receipts=JSON.stringify(f.db.select().from(s.operationResults).all());for(const text of [finding.text,'Revised fictitious review',finding.measure])expect(receipts).not.toContain(text);
});
it('uses the actual review day and preserves an uncertain operation receipt across midnight',async()=>{
 const f=await bodyFixture(clean,{initialTime:Date.parse('2026-11-14T23:59:30Z')});await f.call('turn',{kind:'note'},'note');
 expect(await(await f.call('finding',finding,'same-review')).json()).toEqual({ok:true,value:{saved:true,day:'2026-11-14'}});f.clock.advance(60000);
 expect(await(await f.call('finding',finding,'same-review')).json()).toEqual({ok:true,value:{saved:true,day:'2026-11-14'}});expect(await(await f.call('finding',finding,'new-review')).json()).toEqual({ok:true,value:{saved:true,day:'2026-11-15'}});expect(f.db.select().from(s.findings).all()).toHaveLength(2);
});
it('rejects missing, person and other-agent turns, caller-selected scope and invalid one-line scores',async()=>{
 const f=await fixture(),other=f.root.services.comms!.threads.open({member:'alice',agent:'art',title:'Other'});for(let n=0;n<2;n++)f.root.services.conversations.turn({conversation:other.conversation,kind:'reply',fromKind:'agent',fromId:'art'});expect((await f.call('finding',{...finding,turnSeq:2},'other-conversation')).status).toBe(404);
 for(const [index,input]of [{...finding,turnSeq:999},{...finding,conversation:'foreign'},{...finding,day:'1900-01-01'},{...finding,agent:'mark'},{...finding,score:4.5},{...finding,score:0},{...finding,score:6},{...finding,measure:''},{...finding,text:'Two\nlines'},...['\r','\v','\f','\u0085','\u2028','\u2029'].map(line=>({...finding,measure:'Two'+line+'lines'})),{...finding,measure:'x'.repeat(201)},{...finding,text:'x'.repeat(201)},...['\0','\x1b','\u0080','\u200b','\ud800'].map(char=>({...finding,text:'Two'+char+'parts'}))].entries())expect((await f.call('finding',input,'invalid-'+index)).status).toBeGreaterThanOrEqual(400);
 f.db.update(s.turns).set({fromKind:'person',fromId:'alice'}).run();expect((await f.call('finding',finding,'person')).status).toBe(404);f.db.update(s.turns).set({fromKind:'agent',fromId:'mark'}).run();expect((await f.call('finding',finding,'other-agent')).status).toBe(404);expect(f.db.select().from(s.findings).all()).toEqual([]);
});
it('requires the current enrolled body and current private assignment, including receipt replay',async()=>{
 const f=await fixture();for(const [index,token]of [raw.agent,raw.runner,raw.member].entries())expect((await f.call('finding',finding,'wrong-'+index,token)).status).toBe(403);
 expect((await f.call('finding',finding,'accepted')).status).toBe(200);f.root.writes.run(()=>f.db.delete(s.memberAgents).where(eq(s.memberAgents.agent,'art')).run());expect((await f.call('finding',finding,'accepted')).status).toBe(403);expect((await f.call('finding',{...finding,score:2},'revoked')).status).toBe(403);expect(f.db.select().from(s.findings).get()?.score).toBe(4);
});
it.each([false,true])('rolls insert/upsert back when its metadata receipt fails: existing=%s',async existing=>{
 const f=await fixture();if(existing)expect((await f.call('finding',finding,'existing')).status).toBe(200);f.db.$client.exec("CREATE TRIGGER reject_finding_receipt BEFORE INSERT ON operation_results WHEN NEW.operation='conversation.finding' BEGIN SELECT RAISE(ABORT,'Fixture receipt failure'); END");expect((await f.call('finding',{...finding,score:5},'rollback')).status).toBeGreaterThanOrEqual(400);expect(f.db.select().from(s.findings).all()).toEqual(existing?[{...finding,conversation:f.thread.conversation,day:'2026-11-14'}]:[]);
});
it('accepts the complete 200-printable-character boundary',async()=>{
 const f=await fixture();expect((await f.call('finding',{...finding,text:'x'.repeat(200)},'boundary')).status).toBe(200);expect(f.db.select().from(s.findings).get()?.text).toHaveLength(200);
});
it('lets the newly enrolled current body review its own conversation agent turn from an earlier run',async()=>{
 const f=await fixture(),original=f.db.select().from(s.jobs).get()!;f.root.services.runtime.stop('job','alice','reset');
 f.root.writes.run(()=>{f.db.insert(s.jobs).values({...original,id:'reviewer-job',state:'starting'}).run();});
 const token='body_'+'d'.repeat(64),runtime=(name:string,input:unknown)=>f.root.http.request('/api/runtime/'+name,{method:'POST',headers:{authorization:'Bearer '+raw.runner,'content-type':'application/json'},body:JSON.stringify({input,id:'reviewer-'+name})});
 expect((await runtime('enrollBody',{job:'reviewer-job',fingerprint:hash(token)})).status).toBe(200);expect((await f.call('finding',finding,'not-running',token)).status).toBe(403);
 expect((await runtime('started',{job:'reviewer-job',build:'fixture-reviewer'})).status).toBe(200);expect((await f.call('finding',finding,'earlier-run',token)).status).toBe(200);expect(f.db.select().from(s.turns).get()?.run).toBe('job');expect(f.db.select({id:s.jobs.id}).from(s.jobs).where(and(eq(s.jobs.conversation,f.thread.conversation),inArray(s.jobs.state,['queued','starting','running','waiting']))).all()).toEqual([{id:'reviewer-job'}]);expect(f.db.select().from(s.findings).get()).toMatchObject({conversation:f.thread.conversation,turnSeq:1,score:4});expect((await f.call('finding',finding,'old-body')).status).toBe(401);
});
it.each(['measure','text'] as const)('counts Unicode characters in the complete 200-character %s boundary through the SDK',async field=>{
 const f=await fixture(),client=sdk(f);
 expect(await client.finding({...finding,[field]:'🙂'.repeat(200)},'unicode-200')).toEqual({saved:true,day:'2026-11-14'});expect(f.db.select().from(s.findings).get()?.[field]).toBe('🙂'.repeat(200));await expect(client.finding({...finding,[field]:'🙂'.repeat(201)},'unicode-201')).rejects.toThrow();expect(f.db.select().from(s.findings).all()).toHaveLength(1);
});
