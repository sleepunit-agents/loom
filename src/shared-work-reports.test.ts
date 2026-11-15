import {afterEach,expect,it} from 'vitest';
import {randomUUID} from 'node:crypto';
import {eq} from 'drizzle-orm';
import {bodyFixture,bodyCredentials as raw,credentialHash as hash} from '../test/fixtures/conversation-body.js';
import * as s from './core/data/schema.js';
const clean:(()=>void|Promise<void>)[]=[];afterEach(async()=>{for(const stop of clean.splice(0).reverse())await stop();});
async function fixture(){
 const f=await bodyFixture(clean),at=new Date(f.clock.now()).toISOString();
 f.db.insert(s.members).values({id:'pat',role:'owner',joinedAt:at}).run();f.db.insert(s.memberAgents).values({member:'bob',agent:'art'}).run();
 const bob='z'.repeat(64);f.db.insert(s.tokens).values({fingerprint:hash(bob),label:'Bob',kind:'owner',member:'bob',createdAt:at}).run();
 const call=(name:string,input:unknown,id=randomUUID(),token=raw.body)=>f.root.http.request('/api/approvals/'+name,{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+token},body:JSON.stringify({input,id})});
 const query=async(token:string)=>(await (await f.root.http.request('/graphql',{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+token},body:JSON.stringify({query:'{ approvals { id what member } approvalRecord { event note } approvalNotices { what target } }'})})).json()).data;
 const request={kind:'command',target:'fixture:private',what:'Private fixture',why:'For Alice',ask:'Run fixture?',ifYes:'Run',ifNo:'Wait'};
 f.root.services.approvalRules.set({kind:'command',scope:'fixture:*',person:'alice',tier:'tell'},'pat');
 const response=await call('request',request);expect(response.status).toBe(200);const id=(await response.json()).value.id;
 return {...f,call,query,bob,id,request};
}
it('reports a private tell-rule step through its labelled permanent record and never through agent-wide notices',async()=>{
 const f=await fixture();expect((await f.call('report',{id:f.id,what:'PRIVATE RESULT'})).status).not.toBe(200);
 expect((await f.call('use',{id:f.id,kind:'command',target:f.request.target})).status).toBe(200);
 for(const token of [raw.member,raw.agent,raw.runner,f.bob])expect((await f.call('report',{id:f.id,what:'PRIVATE RESULT'},randomUUID(),token)).status).toBe(403);
 const report={id:f.id,what:'PRIVATE RESULT'};expect((await f.call('report',report,'report')).status).toBe(200);expect((await f.call('report',report,'report')).status).toBe(200);expect((await f.call('report',report,'new-retry')).status).toBe(200);
 expect(f.db.select().from(s.approvalRecord).all().filter(row=>row.note==='Reported step: PRIVATE RESULT')).toHaveLength(1);
 expect(f.db.select().from(s.approvalNotices).all()).toEqual([]);
 expect(JSON.stringify(await f.query(raw.member))).toContain('PRIVATE RESULT');expect(JSON.stringify(await f.query(f.bob))).not.toContain('PRIVATE RESULT');
 expect((await f.call('report',{id:f.id,what:'CHANGED RESULT'})).status).not.toBe(200);
 f.db.update(s.approvals).set({conversation:null}).where(eq(s.approvals.id,f.id)).run();expect((await f.call('report',report,'report')).status).toBe(403);
});
it('rolls back reporting if its receipt fails and requires a tell rule rather than a manual or do allowance',async()=>{
 const f=await fixture();await f.call('use',{id:f.id,kind:'command',target:f.request.target});
 const before=f.db.select().from(s.approvalRecord).all();
 f.db.$client.exec("CREATE TRIGGER fail_report_receipt BEFORE INSERT ON operation_results BEGIN SELECT RAISE(ABORT,'fixture failure'); END");
 expect((await f.call('report',{id:f.id,what:'PRIVATE RESULT'})).status).toBe(503);expect(f.db.select().from(s.approvalRecord).all()).toEqual(before);
 f.db.$client.exec('DROP TRIGGER fail_report_receipt');
 f.root.services.approvalRules.set({kind:'command',scope:'fixture:*',person:'alice',tier:'do'},'pat');
 const id=(await (await f.call('request',f.request)).json()).value.id;await f.call('use',{id,kind:'command',target:f.request.target});
 expect((await f.call('report',{id,what:'Do result'})).status).not.toBe(200);
});
it('stores a non-private reported step once in the notices table as well as its permanent record',async()=>{
 const f=await fixture();await f.call('use',{id:f.id,kind:'command',target:f.request.target});
 f.db.update(s.approvals).set({member:null}).where(eq(s.approvals.id,f.id)).run();
 f.root.services.approvals.reportUsed(f.id,'art','Public result');f.root.services.approvals.reportUsed(f.id,'art','Public result');
 expect(f.db.select().from(s.approvalNotices).all()).toEqual([expect.objectContaining({what:'Public result',target:f.request.target})]);
});
