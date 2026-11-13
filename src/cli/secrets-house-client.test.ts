import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { randomUUID } from 'node:crypto';
import { startLoom } from '../foundation.js';
import { fixture } from '../fixture.js';
import { FakeClock, type Result, type Viewer } from '../core/index.js';
import { signin, hash } from '../core/signin/index.js';
import { runtimeStore } from '../pieces/runtime/store.js';
import { runSecretsClient } from './secrets-client.js';
const closes: Array<()=>unknown> = [];
afterEach(async()=>{for(const close of closes.splice(0).reverse())await close();});
function value<T>(r:Result):T {expect(r.ok,JSON.stringify(r)).toBe(true);if(!r.ok)throw Error(r.code);return r.value as T;}
async function setup() {
 const home=mkdtempSync(join(tmpdir(),'secrets-house-client-'));closes.push(()=>rmSync(home,{recursive:true,force:true}));fixture(home);
 const clock=new FakeClock(1_800_000_000_000),app=await startLoom({home,next:true,staging:true,clock,stdout(){}});closes.push(app.close);
 const job=randomUUID(),auth=signin(app),store=runtimeStore(app.db),owner:Viewer={kind:'member',id:'jonathan'};let seq=0;
 app.db.transaction(()=>{
  auth.tokens.replace({v:1,tokens:[]},{});
  store.put('box',{id:'box',name:'box',owner:'jonathan',local:false,mayHost:'*',lentTo:[],facts:[],labels:[],alwaysOn:false,reportOnly:false,createdAt:clock.now()},clock.now());
  store.put('job',{id:job,agent:'art',runner:'box',box:'box',title:'fixture',state:'running',createdAt:clock.now()},clock.now());
 })();
 const token=app.db.transaction(()=>auth.issueBody('art',job))();
 const tokenFile=join(home,'client-token');writeFileSync(tokenFile,token);
 const call=(op:string,input:unknown)=>app.operations.call('direct',owner,op,input,`owner-${++seq}`);
 value(call('secrets.describe',{name:'API',description:''}));
 const run=async(argv:string[],request:typeof fetch=fetch,env:NodeJS.ProcessEnv={})=>{
  let stdout='',stderr='';const bodies:string[]=[];
  const code=await runSecretsClient(argv,{stdout:t=>stdout+=t,stderr:t=>stderr+=t,stdin:Readable.from([]),stdinIsTTY:false,
   env:{LOOM_URL:app.url,LOOM_TOKEN_FILE:tokenFile,...env}}, {request:async(url,init)=>{bodies.push(String(init?.body));return request(url,init);},retry:async()=>{}});
  return {code,stdout,stderr,bodies};
 };
 const argv=['request','API','--job',job,'--why','fixture','--minutes','2'];
 return {app,clock,job,auth,store,token,tokenFile,call,run,argv};
}
it('requests with actual central body authentication and reports managed Attention decisions and expiry',async()=>{
 const f=await setup(),r=await f.run(f.argv);expect(r).toMatchObject({code:0,stderr:''});
 const request=JSON.parse(r.stdout);expect(request).toEqual({id:expect.stringMatching(/^q-/),state:'pending'});
 expect(JSON.parse(r.bodies[0]).input).toEqual({name:'API',job:f.job,why:'fixture',minutes:2});
 const status=()=>f.run(['status',request.id]);
 expect(await status()).toMatchObject({code:0,stdout:'{"state":"pending"}\n',stderr:''});
 value(f.call('attention.answer',{id:request.id,answer:{kind:'yes'}}));
 expect(await status()).toMatchObject({code:0,stdout:'{"state":"granted"}\n'});
 await f.clock.advance(120000);
 expect(await status()).toMatchObject({code:0,stdout:'{"state":"expired"}\n'});
 expect(await f.run(['status','q-ffffffff'])).toMatchObject({code:3,stdout:''});
});
it('retries the identical request and core id after a lost response without duplicating asks',async()=>{
 const f=await setup();let n=0;
 const r=await f.run(f.argv,async(url,init)=>{const result=await fetch(url,init);if(++n===1)throw Error('synthetic lost response');return result;});
 expect(r.code).toBe(0);expect(r.bodies).toHaveLength(2);expect(r.bodies[0]).toBe(r.bodies[1]);
 expect(f.app.db.prepare('SELECT count(*) n FROM secrets_requests').get()).toEqual({n:1});
 expect(f.app.db.prepare("SELECT count(*) n FROM core_operations WHERE name='secrets.houseRequest'").get()).toEqual({n:1});
});
it('rechecks central credential revocation on uncertain request retries',async()=>{
 const f=await setup();let n=0;
 const r=await f.run(f.argv,async(url,init)=>{
  const response=await fetch(url,init);
  if(++n===1){f.auth.tokens.change(ts=>{ts.find(t=>t.sha256===hash(f.token))!.revoked=new Date(f.clock.now()).toISOString();});throw Error('synthetic lost response');}
  return response;
 });
 expect(r).toMatchObject({code:4,stdout:''});expect(r.bodies).toHaveLength(2);expect(r.bodies[0]).toBe(r.bodies[1]);
 expect(f.app.db.prepare('SELECT count(*) n FROM secrets_requests').get()).toEqual({n:1});
});
it('maps policy denial to exit one and status denial to successful state metadata',async()=>{
 const f=await setup();value(f.call('secrets.policy',{default:'never',secrets:{}}));
 const r=await f.run(f.argv);expect(r).toMatchObject({code:1,stderr:''});
 const request=JSON.parse(r.stdout);expect(request.state).toBe('denied');
 expect(await f.run(['status',request.id])).toMatchObject({code:0,stdout:'{"state":"denied"}\n'});
});
it('cannot assert house authority through environment, job flags or an unbound token',async()=>{
 const f=await setup();
 expect(await f.run(['request','API','--job',randomUUID(),'--why','fixture'])).toMatchObject({code:4,stdout:''});
 const r=await f.run(f.argv),id=JSON.parse(r.stdout).id;
 f.auth.tokens.change(ts=>ts.push({role:'agent:art',sha256:hash('synthetic-unbound'),label:'fixture',created:new Date(f.clock.now()).toISOString()}));
 writeFileSync(f.tokenFile,'synthetic-unbound');
 const env={HOUSE_ID:f.job,HOUSE_AGENT:'art',LOOM_PIECE_NAME:'runtime',HOUSE_SERVICE:'slack'};
 expect(await f.run(f.argv,fetch,env)).toMatchObject({code:4,stdout:''});
 expect(await f.run(['status',id],fetch,env)).toMatchObject({code:4,stdout:''});
 writeFileSync(f.tokenFile,f.token);
 f.auth.tokens.change(ts=>{ts.find(t=>t.sha256===hash(f.token))!.revoked=new Date(f.clock.now()).toISOString();});
 expect(await f.run(['status',id])).toMatchObject({code:4,stdout:''});
});
it('rejects malformed metadata flags and retired plaintext commands before transport',async()=>{
 const f=await setup();
 for(const argv of [
  ['list','--constructor','value'],['list','--__proto__','value'],['list','--toString','value'],
  ['request','API','--why','fixture'],['request','API','--job',f.job],['request','API','--job','h-1','--why','fixture'],
  [...f.argv,'--job',f.job],[...f.argv,'--agent','art'],[...f.argv,'--scope','other'],[...f.argv,'extra'],
  ...['0','-1','1.5','NaN','Infinity','9007199254740993','--why'].map(n=>['request','API','--job',f.job,'--why','fixture','--minutes',n]),
  ['request','API','--job',f.job,'--why','   '],['status'],['status','bad'],['status','q-ffffffff','--job',f.job],['get','API'],
 ])expect(await f.run(argv)).toMatchObject({code:2,stdout:'',bodies:[]});
});
it('validates exact metadata acknowledgements and never prints arbitrary response fields or token text',async()=>{
 const f=await setup();
 for(const response of [
  {id:'q-01234567',state:'granted'},{id:'bad',state:'pending'},{id:'q-01234567',state:'pending',value:'PRIVATE'},
  {id:'q-01234567',state:'pending',scope:{house:f.job}},
 ])expect(await f.run(f.argv,async()=>new Response(JSON.stringify({ok:true,value:response})))).toMatchObject({code:1,stdout:''});
 for(const state of ['pending','allowed','denied','cancelled','revoked'])
  expect(await f.run(f.argv,async()=>new Response(JSON.stringify({ok:true,value:{id:'q-01234567',state}})))).toMatchObject({code:state==='denied'?1:0,stdout:JSON.stringify({id:'q-01234567',state})+'\n'});
 for(const state of ['cancelled','revoked','expired','granted','pending','denied'])
  expect(await f.run(['status','q-ffffffff'],async()=>new Response(JSON.stringify({ok:true,value:{state}})))).toMatchObject({code:0,stdout:JSON.stringify({state})+'\n'});
 expect(await f.run(f.argv,async()=>new Response(JSON.stringify({ok:true,value:{id:'q-01234567',state:'pending'},message:f.token})))).toMatchObject({code:1,stdout:''});
 for(const response of [{state:'allowed'},{state:'pending',value:'PRIVATE'}])
  expect(await f.run(['status','q-ffffffff'],async()=>new Response(JSON.stringify({ok:true,value:response})))).toMatchObject({code:1,stdout:''});
});
