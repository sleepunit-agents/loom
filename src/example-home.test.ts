import {prepareAcceptanceHome} from '../scripts/rebuild-acceptance-adapter.mjs';
import {holderValueAbsent} from '../scripts/rebuild-secret-holder.mjs';
import {FakeClock} from './core/clock.js';
import Database from 'better-sqlite3';
import * as roots from './shared-root.js';
import {Operations} from './core/operations/index.js';
import {it,expect,vi,afterEach} from 'vitest';
import {mkdtempSync,rmSync,readFileSync,mkdirSync,writeFileSync,statSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {exampleHome,runExampleHome} from './example-home.js';
import {startSharedHome} from './shared-startup.js';
afterEach(()=>{vi.restoreAllMocks();vi.unstubAllEnvs();});
it('builds fictitious data through services, then normal startup signs in and queries it',async()=>{
 vi.stubEnv('TZ','America/Chicago');
 const parent=mkdtempSync(join(tmpdir(),'loom-example-test-')),home=join(parent,'home');
 let app:Awaited<ReturnType<typeof startSharedHome>>|undefined;
 try{
  const made:ReturnType<typeof roots.sharedRoot>[]=[],make=roots.sharedRoot;
  vi.spyOn(roots,'sharedRoot').mockImplementation(options=>{const root=make(options);vi.spyOn(root.http,'request');made.push(root);return root;});
  const output:string[]=[],errors:string[]=[];
  expect(await runExampleHome([],text=>output.push(text),text=>errors.push(text))).toBe(2);
  expect(await runExampleHome([home],text=>output.push(text),text=>errors.push(text))).toBe(0);
  expect(errors.join(' ')).not.toContain('loom_');
  const manifest=JSON.parse(output[0]);
  expect(made.some(root=>vi.mocked(root.http.request).mock.calls.some(([path,init])=>path==='http://example/api/runtime/accountCreate'&&init?.method==='POST'&&JSON.parse(String(init.body)).id==='example-account'))).toBe(true);
  expect(statSync(join(home,'comms.key')).mode & 0o077).toBe(0);
  const database=new Database(join(home,'app.db'),{readonly:true});
  try{expect(database.prepare("select member,revoked_at,expires_at,created_at from tokens where label='Example setup'").get()).toEqual({member:'alex',revoked_at:expect.any(String),expires_at:expect.any(String),created_at:expect.any(String)});
  const setup=database.prepare("select created_at,expires_at from tokens where label='Example setup'").get() as {created_at:string;expires_at:string};expect(Date.parse(setup.expires_at)-Date.parse(setup.created_at)).toBe(60_000);
  expect(database.prepare('select id,owner from model_accounts').all()).toEqual([{id:manifest.account.id,owner:'alex'}]);
  expect(database.prepare("select operation,id from operation_results where id='example-account'").get()).toEqual({operation:'runtime.accountCreate',id:'example-account'});}finally{database.close();}
  expect(readFileSync(join(home,'program.json'),'utf8')).not.toContain('loom_');expect(JSON.stringify(manifest)).not.toContain('loom_');expect(readFileSync(join(home,'example.json'),'utf8')).not.toContain('loom_');
  expect(manifest.tasks).toHaveLength(4);expect(manifest.gaps.map((g:{page:string})=>g.page)).toEqual(['machines']);
  const before=readFileSync(join(home,'app.db'));
  await expect(exampleHome(home)).rejects.toThrow();expect(readFileSync(join(home,'app.db'))).toEqual(before);
  mkdirSync(join(parent,'public'));writeFileSync(join(parent,'public','next.html'),'<main>Example entry</main>');
  const clock=new FakeClock(Date.now());
  let link='';app=await startSharedHome({home,clock,webRoot:join(parent,'public'),port:0,stdout:text=>{link=text.trim();}});
  const response=await fetch(link,{method:'POST',redirect:'manual',headers:{origin:app.url}});
  expect(response.status).toBe(303);const cookie=response.headers.get('set-cookie')!.split(';')[0];
  const post=async(path:string,input:unknown)=>{const response=await fetch(app!.url+path,{method:'POST',redirect:'error',headers:{cookie,origin:app!.url,'content-type':'application/json'},body:JSON.stringify(input)});expect(response.status).toBe(200);return response.json();};
  const read=async(query:string,variables:Record<string,unknown>={})=>{const result=await post('/graphql',{query,variables});expect(result.errors).toBeUndefined();return result.data;};
  const result={data:await read('{ deskTime { timezone } tasks { id title status } approvals { id state } changes { id project agent } triggers { id } modelAccounts { ... on RuntimeAccountDetail { id label } } }')};
  expect(result.data.deskTime).toEqual({timezone:'America/Chicago'});
  expect(result.data.tasks).toHaveLength(4);expect(result.data.tasks.map((t:{status:string})=>t.status)).toContain('in_progress');
  expect(result.data.approvals).toEqual([expect.objectContaining({state:'pending'})]);
  expect(result.data.changes).toEqual([{id:manifest.change,project:'garden',agent:'fern'}]);
  const token=app.writes.run(()=>app!.services.signin.issue({kind:'owner',member:'robin',label:'Fictitious sharing proof'})).value;
  try{
   const read=async()=>{const response=await app!.http.request(app!.url+'/graphql',{method:'POST',headers:{authorization:'Bearer '+token.token,'content-type':'application/json'},body:JSON.stringify({query:'{ tasks { id } changes { id project agent } approvals { id } }'})});return response.json();};
   expect(await read()).toEqual({data:{tasks:manifest.tasks.map((id:string)=>({id})),changes:[{id:manifest.change,project:'garden',agent:'fern'}],approvals:[]}});
   app.writes.run(()=>app!.services.projects.save({id:'garden',name:'Example garden',members:['alex'],agents:['fern','moss'],repositories:['github:example-house/garden']}));
   expect(await read()).toEqual({data:{tasks:[],changes:[],approvals:[]}});
  }finally{app.writes.run(()=>app!.services.signin.revoke(token.fingerprint));}
  expect(result.data.modelAccounts).toEqual([expect.objectContaining({label:'Example model subscription'})]);
  const command=async(name:string,input:unknown,id:string)=>{expect(await post('/api/'+name.replace('.','/'),{id,input})).toMatchObject({ok:true});};
  const trigger=()=>read('query Watch($id:String!){triggers(where:{id:{eq:$id}}){state lastFiredAt} triggerLog(where:{trigger:{eq:$id}}){event}}',{id:manifest.trigger});
  await command('tempo.pause',{agent:manifest.agents[0]},'pause-example');
  await command('approvals.answer',{id:manifest.approval,answer:'allow'},'answer-example');
  expect((await trigger()).triggers).toEqual([{state:'held',lastFiredAt:null}]);
  await command('tempo.resume',{agent:manifest.agents[0]},'resume-example');
  const fired=await trigger();expect(fired.triggers[0].state).toBe('fired');expect(fired.triggerLog.filter((row:{event:string})=>row.event==='fired')).toHaveLength(1);
  const timeTrigger=(id:string)=>({id,ownerKind:'member',owner:manifest.members[0],sourceKind:'time',times:new Date(clock.now()+60_000).toISOString(),lifespan:'once',targetKind:'inbox',toKind:'person',to:manifest.members[0],instructions:'Example manual notice',note:id});
  await command('tempo.set',timeTrigger('manual-notice'),'set-notice');clock.advance(2000);await command('tempo.runNow',{id:'manual-notice'},'run-notice');
  const selection='{inboxItems(source:"trigger"){id sourceId refs body{words}} settledInboxNotice{id count}}';
  const delivered=await read(selection);expect(delivered.inboxItems).toEqual([expect.objectContaining({sourceId:expect.stringMatching(/^manual-notice:/),refs:['manual-notice'],body:{words:'Example manual notice'}})]);
  clock.advance(4999);expect((await read(selection)).settledInboxNotice).toBeNull();clock.advance(1);expect((await read(selection)).settledInboxNotice.count).toBe(2);
  await command('tempo.set',timeTrigger('cancel-notice'),'set-cancel');await command('tempo.stop',{id:'cancel-notice'},'cancel-notice');clock.advance(60_001);
  expect((await read(selection)).inboxItems).toHaveLength(1);
 }finally{await app?.close();rmSync(parent,{recursive:true,force:true});}
});

it('revokes the temporary setup credential when the outside operation fails',async()=>{
 const parent=mkdtempSync(join(tmpdir(),'loom-example-failed-')),home=join(parent,'home');
 vi.spyOn(Operations.prototype,'callAsync').mockResolvedValue({ok:false,code:'denied',message:'Fixture refusal'});
 try{
  await expect(exampleHome(home)).rejects.toThrow('Example account could not be created through its API');
  const database=new Database(join(home,'app.db'),{readonly:true});
  try{expect(database.prepare("select revoked_at,expires_at from tokens where label='Example setup'").get()).toEqual({revoked_at:expect.any(String),expires_at:expect.any(String)});expect(database.prepare('select count(*) as n from model_accounts').get()).toEqual({n:0});}finally{database.close();}
 }finally{rmSync(parent,{recursive:true,force:true});}
});

it('executes guarded prepared operations and exact allowance deadlines in normal startup',async()=>{
 const parent=mkdtempSync(join(tmpdir(),'loom-example-approvals-')),home=join(parent,'home');
 let app:Awaited<ReturnType<typeof startSharedHome>>|undefined;
 try{
  const manifest=await exampleHome(home);prepareAcceptanceHome(home);mkdirSync(join(parent,'public'));writeFileSync(join(parent,'public','next.html'),'<main>Example entry</main>');
  const clock=new FakeClock(Date.now());let link='';app=await startSharedHome({home,clock,webRoot:join(parent,'public'),port:0,stdout:text=>{link=text.trim();}});
  expect(holderValueAbsent(home,'no-such-fictitious-secret')).toBe(true);
  const response=await fetch(link,{method:'POST',redirect:'manual',headers:{origin:app.url}});expect(response.status).toBe(303);const cookie=response.headers.get('set-cookie')!.split(';')[0];
  const watched=app.writes.run(()=>app!.services.approvals.request({kind:'command',target:'example:watched',agent:'fern',askedFrom:'example-proof',actingFor:'alex',what:'Watched example',why:'Prove answer delivery.',ask:'Proceed?',ifYes:'Continue.',ifNo:'Wait.',minutes:1})).value;
  const trigger=app.writes.run(()=>app!.services.tempo.triggers.set({ownerKind:'agent',owner:'fern',sourceKind:'answer',watches:`approval:${watched.id}`,lifespan:'once',targetKind:'inbox',toKind:'agent',to:'fern',instructions:'Continue fictitious work.',note:'Watched example'})).value;
  const allowed=await fetch(app.url+'/api/approvals/answer',{method:'POST',headers:{cookie,origin:app.url,'content-type':'application/json'},body:JSON.stringify({id:'watched-example',input:{id:watched.id,answer:'allow'}})});expect(allowed.status).toBe(200);clock.advance(0);
  const deliveries=()=>app!.services.comms!.db.$client.prepare("SELECT count(*) AS n FROM inbox JOIN inbox_refs ON inbox_refs.item=inbox.id WHERE inbox.source='trigger' AND inbox_refs.ref=?").get(trigger.id);
  expect(deliveries()).toEqual({n:1});clock.advance(1);app.writes.run(()=>app!.services.approvals.deny(watched.id,'alex'));clock.advance(60_001);expect(deliveries()).toEqual({n:1});
  for(const minutes of [1,3]){
   const value={kind:'command' as const,target:'example:expiry-'+minutes,agent:'fern',askedFrom:'example-proof',actingFor:'alex',what:'Duration proof',why:'Configured duration.',ask:'Proceed?',ifYes:'Continue.',ifNo:'Wait.',minutes};
   const first=app.writes.run(()=>app!.services.approvals.request(value)).value,second=app.writes.run(()=>app!.services.approvals.request(value)).value;app.writes.run(()=>{app!.services.approvals.allow(first.id,'alex');app!.services.approvals.allow(second.id,'alex');});
   clock.advance(minutes*60_000-1);expect(app.services.approvals.get(second.id).state).toBe('allowed');expect(app.writes.run(()=>app!.services.approvals.use(first.id,'fern','command',value.target)).value.ok).toBe(true);clock.advance(1);
   expect(app.services.approvals.get(second.id).state).toBe('expired');expect(app.writes.run(()=>app!.services.approvals.use(second.id,'fern','command',value.target)).value.ok).toBe(false);
  }
  const draft=app.writes.run(()=>app!.services.tasks.create({title:'Fictitious dangerous draft',goal:'Discard only on approval.',why:'Prove installed prepared actions.',owner:{kind:'household'}},{kind:'member',id:'alex'})).value;
  const card=app.writes.run(()=>app!.services.approvals.request({kind:'dangerous',target:`example:discard-draft:${draft.id}`,operation:'example.discardDraft',changeSummary:`Draft ${draft.id}: open → cancelled`,agent:'fern',askedFrom:manifest.conversation,actingFor:'alex',conversation:manifest.conversation,member:'alex',what:'Discard fictitious draft',why:'Prove the exact before/after.',ask:'Discard it?',ifYes:'Cancel draft.',ifNo:'Keep draft.'})).value;
  expect(app.services.tasks.get(draft.id).status).toBe('open');
  const answer=()=>fetch(app!.url+'/api/approvals/answer',{method:'POST',headers:{cookie,origin:app!.url,'content-type':'application/json'},body:JSON.stringify({id:'discard-example-draft',input:{id:card.id,answer:'allow'}})});
  expect((await answer()).status).toBe(200);expect((await answer()).status).toBe(200);
  expect(app.services.tasks.get(draft.id)).toMatchObject({status:'closed',closeReason:'cancelled'});
  expect(app.services.approvals.record(card.id).map(row=>row.event)).toEqual(['request','allow','use']);
  for(const stale of ['summary','state']){
   const next=app.writes.run(()=>app!.services.tasks.create({title:'Fictitious guarded draft',goal:'Reject stale approvals.',why:'Verify before/after guards.',owner:{kind:'household'}},{kind:'member',id:'alex'})).value;
   const request=app.writes.run(()=>app!.services.approvals.request({kind:'dangerous',target:`example:discard-draft:${next.id}`,operation:'example.discardDraft',changeSummary:stale==='summary'?'Wrong before/after':`Draft ${next.id}: open → cancelled`,agent:'fern',askedFrom:manifest.conversation,actingFor:'alex',what:'Discard guarded draft',why:'Exercise stale refusal.',ask:'Discard guarded draft?',ifYes:'Cancel.',ifNo:'Keep.'})).value;
   if(stale==='state')app.writes.run(()=>app!.services.tasks.close(next.id,'Already finished.'));
   const before=app.services.tasks.get(next.id),audit=app.services.approvals.record(request.id);
   const refused=await fetch(app.url+'/api/approvals/answer',{method:'POST',headers:{cookie,origin:app.url,'content-type':'application/json'},body:JSON.stringify({id:'stale-'+stale,input:{id:request.id,answer:'allow'}})});
   expect(refused.status).toBe(503);expect(app.services.tasks.get(next.id)).toEqual(before);expect(app.services.approvals.get(request.id).state).toBe('pending');expect(app.services.approvals.record(request.id)).toEqual(audit);
  }
 }finally{await app?.close();if(app)expect(()=>holderValueAbsent(home,'no-such-fictitious-secret')).toThrow('not active');rmSync(parent,{recursive:true,force:true});}
});
