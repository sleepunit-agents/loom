import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { startLoom } from '../../foundation.js';
import { fixture } from '../../fixture.js';
import { FakeClock, type Result, type Viewer } from '../../core/index.js';
import { signin, hash } from '../../core/signin/index.js';
import { runtimeStore } from '../runtime/store.js';
const closes: Array<()=>unknown> = [];
afterEach(async()=>{for(const close of closes.splice(0).reverse())await close();});
function value<T>(r:Result):T {expect(r.ok,JSON.stringify(r)).toBe(true);if(!r.ok)throw Error(r.code);return r.value as T;}
async function setup() {
 const home=mkdtempSync(join(tmpdir(),'secrets-house-'));closes.push(()=>rmSync(home,{recursive:true,force:true}));fixture(home);
 const clock=new FakeClock(1_800_000_000_000),app=await startLoom({home,next:true,staging:true,clock,stdout(){}});closes.push(app.close);
 const job=randomUUID(),otherJob=randomUUID();
 const auth=signin(app),store=runtimeStore(app.db),owner:Viewer={kind:'member',id:'jonathan'};let seq=0;
 const call=(op:string,input:unknown,viewer:Viewer=owner,id=`test-${++seq}`)=>app.operations.call('http',viewer,op,input,id);
 app.db.transaction(()=>{
  auth.tokens.replace({v:1,tokens:[]},{});
  store.put('box',{id:'box',name:'box',owner:'jonathan',local:false,mayHost:'*',lentTo:[],facts:[],labels:[],alwaysOn:false,reportOnly:false,createdAt:clock.now()},clock.now());
  for(const id of [job,otherJob])store.put('job',{id,agent:'art',runner:'box',box:'box',title:'fixture',state:'running',createdAt:clock.now()},clock.now());
 })();
 const token=app.db.transaction(()=>auth.issueBody('art',job))(),viewer=auth.token(hash(token))!.viewer;
 const otherToken=app.db.transaction(()=>auth.issueBody('art',otherJob))(),other=auth.token(hash(otherToken))!.viewer;
 value(call('secrets.describe',{name:'API',description:''}));
 return {app,auth,store,job,clock,call,viewer,other,token,request:(id?:string)=>call('secrets.houseRequest',{job,name:'API',why:'fixture',minutes:2},viewer,id)};
}
it('binds real signin body proof to exact job scope and uses managed owner Attention',async()=>{
 const f=await setup();const input={job:f.job,name:'API',why:'fixture',minutes:2};
 const post=async()=> (await fetch(`${f.app.url}/api/secrets/houseRequest`,{method:'POST',headers:{authorization:`Bearer ${f.token}`,'content-type':'application/json'},body:JSON.stringify({input,id:'http-request'})})).json();
 const first=await post(),r=value<{id:string}>(first);expect(await post()).toEqual(first);
 expect(f.request()).toEqual(first);
 const row=f.app.db.prepare('SELECT record FROM secrets_requests WHERE id=?').get(r.id) as {record:string};
 expect(JSON.parse(row.record)).toMatchObject({agent:'art',scope:{house:f.job},attentionManaged:true});
 expect(f.call('secrets.houseStatus',{id:r.id},f.viewer)).toEqual({ok:true,value:{state:'pending'}});
 expect(f.call('secrets.houseStatus',{id:r.id},f.other)).toMatchObject({ok:false,code:'not-found'});
 value(f.call('attention.answer',{id:r.id,answer:{kind:'yes'}}));
 expect(f.call('secrets.houseStatus',{id:r.id},f.viewer)).toEqual({ok:true,value:{state:'granted'}});
 f.clock.advance(120_000);
 expect(f.call('secrets.houseStatus',{id:r.id},f.viewer)).toEqual({ok:true,value:{state:'expired'}});
 expect(JSON.stringify(first)).not.toContain('fixture');
});
it('refuses forged scope, copied viewers, dead jobs, revoked tokens and policy-held execution including replay',async()=>{
 const f=await setup();const first=f.request('retry');const request=value<{id:string}>(first);
 const denied=()=>{expect(f.request('retry')).toMatchObject({ok:false,code:'denied'});expect(f.call('secrets.houseStatus',{id:request.id},f.viewer)).toMatchObject({ok:false,code:'denied'});};
 for(const viewer of [{...f.viewer},{kind:'member',id:'jonathan'},{kind:'runner',id:'box'},{kind:'service',id:'runtime'}] as Viewer[])
  expect(f.call('secrets.houseRequest',{job:f.job,name:'API',why:'fixture'},viewer)).toMatchObject({ok:false,code:'denied'});
 for(const extra of [{agent:'pond-bot'},{scope:{house:'other'}},{service:'bridge'}])
  expect(f.call('secrets.houseRequest',{job:f.job,name:'API',why:'fixture',...extra},f.viewer)).toMatchObject({ok:false,code:'invalid'});
 expect(f.call('secrets.houseRequest',{job:f.job,name:'API',why:'fixture'},f.other)).toMatchObject({ok:false,code:'denied'});
 value(f.request('x'.repeat(200)));
 const agentToken='synthetic-agent-only';f.auth.tokens.change(tokens=>tokens.push({role:'agent:art',sha256:hash(agentToken),label:'fixture',created:new Date(f.clock.now()).toISOString()}));
 const agentOnly=f.auth.token(hash(agentToken))!.viewer;
 expect(f.call('secrets.houseRequest',{job:f.job,name:'API',why:'fixture',minutes:2},agentOnly,'retry')).toMatchObject({ok:false,code:'denied'});
 expect(f.call('secrets.houseStatus',{id:request.id},agentOnly)).toMatchObject({ok:false,code:'denied'});
 const change=(set:object)=>f.app.db.transaction(()=>{const {changedAt:_,...job}=f.store.read('job',f.job)!;f.store.put('job',{...job,...set},f.clock.now());})();
 change({state:'done',endedAt:f.clock.now()});denied();
 change({state:'running',endedAt:undefined,service:'slack'});denied();
 change({service:undefined});
 change({imported:{history:'unknown'}});denied();
 change({imported:undefined});
 f.app.db.transaction(()=>{const {changedAt:_,...box}=f.store.read('box','box')!;f.store.put('box',{...box,revokedAt:f.clock.now()},f.clock.now());})();
 denied();
 f.app.db.transaction(()=>{const {changedAt:_,revokedAt:__,...box}=f.store.read('box','box')!;f.store.put('box',box,f.clock.now());})();
 value(f.request('retry'));
 f.auth.tokens.change(tokens=>{tokens.find(t=>t.sha256===hash(f.token))!.revoked=new Date(f.clock.now()).toISOString();});
 denied();
 f.auth.tokens.change(tokens=>{const row=tokens.find(t=>t.sha256===hash(f.token))!;delete row.revoked;});
 value(f.request('retry'));
 value(f.call('runtime.configureBodyPolicy',{agent:'art',revision:0,gates:{people:{},agents:{}},policy:{}}));
 denied();
});
it('retains exact service identity, atomic request failure and denied status',async()=>{
 const f=await setup();
 f.app.db.transaction(()=>{const {changedAt:_,...job}=f.store.read('job',f.job)!;f.store.put('job',{...job,service:'slack'},f.clock.now());})();
 const token='synthetic-service-token';f.auth.tokens.change(tokens=>tokens.push({role:`agent:art/slack@${f.job}`,sha256:hash(token),label:'fixture',created:new Date(f.clock.now()).toISOString()}));
 const viewer=f.auth.token(hash(token))!.viewer;
 const request=(id:string)=>f.call('secrets.houseRequest',{job:f.job,name:'API',why:'fixture'},viewer,id);
 f.app.db.exec("CREATE TRIGGER fail_house_request BEFORE INSERT ON secrets_requests BEGIN SELECT RAISE(ABORT,'synthetic'); END");
 expect(request('atomic')).toMatchObject({ok:false});
 expect(f.app.db.prepare('SELECT * FROM secrets_requests').all()).toEqual([]);
 expect(f.app.db.prepare("SELECT * FROM core_operations WHERE id IN ('atomic')").all()).toEqual([]);
 f.app.db.exec('DROP TRIGGER fail_house_request');
 const r=value<{id:string}>(request('atomic'));
 expect(f.app.db.prepare('SELECT record FROM secrets_requests WHERE id=?').get(r.id)).toEqual({record:expect.stringContaining('"service":"slack"')});
 value(f.call('attention.answer',{id:r.id,answer:{kind:'no'}}));
 expect(f.call('secrets.houseStatus',{id:r.id},viewer)).toEqual({ok:true,value:{state:'denied'}});
 // A current credential for the same agent/job without service is still a different authority.
 expect(f.call('secrets.houseStatus',{id:r.id},f.viewer)).toMatchObject({ok:false,code:'denied'});
 expect(f.call('secrets.houseRequest',{job:f.job,name:'API',why:'fixture'},f.viewer,'atomic')).toMatchObject({ok:false,code:'denied'});
});
it('requires surviving linked exact grants and isolates status from another valid service scope',async()=>{
 const f=await setup(),r=value<{id:string}>(f.request());
 value(f.call('attention.answer',{id:r.id,answer:{kind:'yes'}}));
 const status=()=>f.call('secrets.houseStatus',{id:r.id},f.viewer);
 const row=f.app.db.prepare('SELECT id,record FROM secrets_grants').get() as {id:string;record:string};
 const grant=JSON.parse(row.record);
 for(const patch of [{requestId:'different'},{scope:{house:randomUUID()}},{scope:{house:f.job,service:'slack'}},{movedTo:'elsewhere'}]){
  f.app.db.prepare('UPDATE secrets_grants SET record=? WHERE id=?').run(JSON.stringify({...grant,...patch}),row.id);
  expect(status()).toEqual({ok:true,value:{state:'expired'}});
  f.app.db.prepare('UPDATE secrets_grants SET record=? WHERE id=?').run(row.record,row.id);
  expect(status()).toEqual({ok:true,value:{state:'granted'}});
 }
 f.app.db.prepare('DELETE FROM secrets_grants WHERE id=?').run(row.id);
 expect(status()).toEqual({ok:true,value:{state:'expired'}});
 f.app.db.prepare('INSERT INTO secrets_grants VALUES (?,?,?,?,?)').run(row.id,grant.agent,grant.kind,grant.target,row.record);
 value(f.call('secrets.revoke',{agent:'art',kind:'secret',target:'API',scope:{house:f.job}}));
 expect(status()).toEqual({ok:true,value:{state:'revoked'}});
 const saved=f.app.db.prepare('SELECT record FROM secrets_requests WHERE id=?').get(r.id) as {record:string};
 const request=JSON.parse(saved.record);
 f.app.db.prepare('UPDATE secrets_requests SET record=? WHERE id=?').run(JSON.stringify({...request,state:'cancelled'}),r.id);
 expect(status()).toEqual({ok:true,value:{state:'cancelled'}});
 for(const patch of [{agent:'pond-bot'},{kind:'piece'},{scope:{house:randomUUID()}},{scope:{house:f.job,service:'slack'}}]) {
  f.app.db.prepare('UPDATE secrets_requests SET record=? WHERE id=?').run(JSON.stringify({...request,...patch}),r.id);
  expect(status()).toMatchObject({ok:false,code:'not-found'});
 }
});
it('rolls back managed Attention and both receipts when the outer acknowledgement fails',async()=>{
 const f=await setup(),changed=vi.spyOn(f.app.live,'changed');
 const before={requests:f.app.db.prepare('SELECT * FROM secrets_requests').all(),attention:f.app.db.prepare('SELECT * FROM attention_asks').all(),receipts:f.app.db.prepare('SELECT * FROM core_operations ORDER BY viewer,id').all()};
 f.app.db.exec("CREATE TRIGGER fail_outer_house_ack BEFORE INSERT ON core_operations WHEN NEW.name='secrets.houseRequest' BEGIN SELECT RAISE(ABORT,'synthetic'); END");
 expect(f.request('outer-failure')).toMatchObject({ok:false});
 expect(f.app.db.prepare('SELECT * FROM secrets_requests').all()).toEqual(before.requests);
 expect(f.app.db.prepare('SELECT * FROM attention_asks').all()).toEqual(before.attention);
 expect(f.app.db.prepare('SELECT * FROM core_operations ORDER BY viewer,id').all()).toEqual(before.receipts);
 expect(changed).not.toHaveBeenCalled();
 f.app.db.exec('DROP TRIGGER fail_outer_house_ack');
 value(f.request('outer-failure'));expect(changed).toHaveBeenCalled();changed.mockRestore();
});
