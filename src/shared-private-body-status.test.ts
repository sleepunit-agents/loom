import {afterEach,expect,it} from 'vitest';
import {eq} from 'drizzle-orm';
import {bodyFixture} from '../test/fixtures/conversation-body.js';
import * as s from './core/data/schema.js';
const clean:(()=>void|Promise<void>)[]=[];afterEach(async()=>{for(const close of clean.splice(0).reverse())await close();});
async function fixture(){
 const f=await bodyFixture(clean);let other!:string;
 f.root.writes.run(()=>{f.db.insert(s.memberAgents).values({member:'bob',agent:'art'}).run();other=f.root.services.signin.issue({kind:'owner',member:'bob',label:'Co-owner fixture'}).token;});
 const status=async()=>{const response=await f.root.http.request('/graphql',{method:'POST',headers:{authorization:'Bearer '+other,'content-type':'application/json'},body:JSON.stringify({query:'{agentStatus{agent state work}}'})});expect(response.status).toBe(200);return(await response.json()).data.agentStatus;};
 return{...f,status};
}
it.each([{state:'working',work:'Working privately'},{state:'waiting',work:'Waiting privately'},{state:'idle',work:''},{state:'offline',work:''}]as const)('keeps member-private $state progress words out of global status, including for another agent co-owner',async expected=>{
 const f=await fixture(),secret='PRIVATE_STATUS_CANARY';expect((await f.call('status',{state:expected.state,work:secret},'private-status')).status).toBe(200);
 expect(f.db.select().from(s.agentStatus).get()).toMatchObject({agent:'art',state:expected.state,work:expected.work});expect(await f.status()).toEqual([{agent:'art',state:expected.state,work:expected.work}]);expect(f.db.$client.serialize().includes(Buffer.from(secret))).toBe(false);
});
it('preserves public conversation progress without changing the caller identity or schema',async()=>{
 const f=await fixture();f.root.writes.run(()=>{f.db.update(s.conversations).set({member:null,venue:'discord'}).run();f.db.update(s.jobs).set({member:null}).run();});
 expect((await f.call('status',{state:'working',work:'Reading public channel messages'},'public-status')).status).toBe(200);expect(await f.status()).toEqual([{agent:'art',state:'working',work:'Reading public channel messages'}]);
});
it('keeps private normalization atomic with the receipt and does not reapply it on replay',async()=>{
 const f=await fixture(),input={state:'working',work:'PRIVATE_ROLLBACK_CANARY'};f.db.insert(s.agentStatus).values({agent:'art',state:'idle',work:'Prior public status',changedAt:new Date(f.clock.now()).toISOString()}).run();
 f.db.$client.exec("CREATE TEMP TRIGGER fail_private_status BEFORE INSERT ON operation_results WHEN NEW.id='rollback' BEGIN SELECT RAISE(ABORT,'fixture'); END");
 expect((await f.call('status',input,'rollback')).status).toBe(503);expect((await f.status())[0].work).toBe('Prior public status');expect((await f.call('status',input,'committed')).status).toBe(200);expect((await f.status())[0].work).toBe('Working privately');
 f.db.update(s.agentStatus).set({state:'waiting',work:'Later public status'}).where(eq(s.agentStatus.agent,'art')).run();expect((await f.call('status',input,'committed')).status).toBe(200);expect((await f.status())[0].work).toBe('Later public status');expect(f.db.$client.serialize().includes(Buffer.from('PRIVATE_ROLLBACK_CANARY'))).toBe(false);
});
