import Database from 'better-sqlite3';
import * as roots from './shared-root.js';
import {Operations} from './core/operations/index.js';
import {it,expect,vi,afterEach} from 'vitest';
import {mkdtempSync,rmSync,readFileSync,mkdirSync,writeFileSync,statSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {exampleHome,runExampleHome} from './example-home.js';
import {FakeClock} from './core/clock.js';
import {startSharedHome} from './shared-startup.js';
afterEach(()=>{vi.restoreAllMocks();vi.unstubAllEnvs();});
it('builds fictitious data through services, then normal startup signs in and queries it',async()=>{
 vi.stubEnv('TZ','America/Chicago');
 const parent=mkdtempSync(join(tmpdir(),'loom-example-test-')),home=join(parent,'home');
 let app:Awaited<ReturnType<typeof startSharedHome>>|undefined;
 try{
  const made:ReturnType<typeof roots.sharedRoot>[]=[],issuedTokens:string[]=[],make=roots.sharedRoot;
  vi.spyOn(roots,'sharedRoot').mockImplementation(options=>{const root=make(options),issue=root.services.signin.issue;vi.spyOn(root.services.signin,'issue').mockImplementation(input=>{const issued=issue.call(root.services.signin,input);issuedTokens.push(issued.token);return issued;});vi.spyOn(root.http,'request');made.push(root);return root;});
  const output:string[]=[],errors:string[]=[];
  expect(await runExampleHome([],text=>output.push(text),text=>errors.push(text))).toBe(2);
  const exit=await runExampleHome([home],text=>output.push(text),text=>errors.push(text));expect(exit,errors.join('\n')).toBe(0);
  expect(errors.join(' ')).not.toContain('loom_');
  const manifest=JSON.parse(output[0]);
  expect(made.some(root=>vi.mocked(root.http.request).mock.calls.some(([path,init])=>path==='http://example/api/runtime/accountCreate'&&init?.method==='POST'&&JSON.parse(String(init.body)).id==='example-account'))).toBe(true);
  expect(statSync(join(home,'comms.key')).mode & 0o077).toBe(0);expect(statSync(join(home,'example-adapters.mjs')).mode & 0o077).toBe(0);
  expect(issuedTokens).toHaveLength(2);for(const file of ['app.db','program.json','example.json','example-adapters.mjs'])for(const token of issuedTokens)expect(readFileSync(join(home,file)).includes(Buffer.from(token))).toBe(false);
  const database=new Database(join(home,'app.db'),{readonly:true});
  try{expect(database.prepare("select member,revoked_at,expires_at,created_at from tokens where label='Example setup'").get()).toEqual({member:'alex',revoked_at:expect.any(String),expires_at:expect.any(String),created_at:expect.any(String)});
  const setup=database.prepare("select created_at,expires_at from tokens where label='Example setup'").get() as {created_at:string;expires_at:string};expect(Date.parse(setup.expires_at)-Date.parse(setup.created_at)).toBe(60_000);
  expect(database.prepare("select revoked_at from tokens where label='Example worker setup'").get()).toEqual({revoked_at:expect.any(String)});
  expect(database.prepare('select id,owner from model_accounts').all()).toEqual([{id:manifest.account.id,owner:'alex'}]);
  expect(database.prepare('select id,name,owner,same_machine_as_loom,hosts_any,report_only,always_on,last_seen_at from boxes').all()).toEqual([{id:manifest.runtime.box,name:'Example workshop',owner:'alex',same_machine_as_loom:1,hosts_any:0,report_only:0,always_on:0,last_seen_at:setup.created_at}]);
  // Runtime settlement must not consume the retention sample or put job facts
  // in the future of the clock used by the normal-startup walkthrough.
  const retained=database.prepare('select words,keep_until from messages where thread=? and seq=?').get(manifest.retention.thread,manifest.retention.seq) as {words:Buffer;keep_until:string};
  expect(Buffer.isBuffer(retained.words)).toBe(true);
  expect(Date.parse(retained.keep_until)).toBeGreaterThan(Date.parse(manifest.createdAt));
  const queued=database.prepare('select queued_at from jobs where id=?').get(manifest.runtime.job.id) as {queued_at:string};
  expect(Date.parse(queued.queued_at)).toBeLessThanOrEqual(Date.parse(manifest.createdAt));
  expect(Date.parse(manifest.createdAt)).toBeLessThanOrEqual(Date.now());
  expect(database.prepare('select box,agent,lent from box_agents order by agent').all()).toEqual([{box:manifest.runtime.box,agent:'fern',lent:0},{box:manifest.runtime.box,agent:'moss',lent:0}]);
  expect(database.prepare('select fact,from_owner from box_facts order by fact').all()).toEqual([{fact:'arch:example',from_owner:0},{fact:'cpu:example',from_owner:1}]);
  expect(database.prepare('select agent,model,position from agent_models order by agent,position').all()).toEqual([{agent:'fern',model:'example-model',position:0},{agent:'moss',model:'example-model',position:0}]);
  expect(database.prepare('select agent,box,position from agent_boxes order by agent,position').all()).toEqual([{agent:'fern',box:manifest.runtime.box,position:0},{agent:'moss',box:manifest.runtime.box,position:0}]);
  expect(database.prepare('select agent,house_repository,house_file,house_branch,nested_containers,gpu from agent_run_settings order by agent').all()).toEqual(['fern','moss'].map(agent=>({agent,house_repository:'https://example.invalid/house.git',house_file:'Housefile',house_branch:'next',nested_containers:0,gpu:0})));
  expect(database.prepare("select count(*) as n from inbox where source='trigger' and from_kind='schedule'").get()).toEqual({n:1});

  expect(database.prepare('select agent,model,member,conversation,state,box,brief from jobs where id=?').get(manifest.runtime.job.id)).toEqual({agent:'moss',model:'example-model',member:'alex',conversation:manifest.runtime.conversation,state:'queued',box:null,brief:''});

  expect(database.prepare("select operation,id from operation_results where id='example-account'").get()).toEqual({operation:'runtime.accountCreate',id:'example-account'});}finally{database.close();}
  expect(readFileSync(join(home,'program.json'),'utf8')).not.toContain('loom_');expect(JSON.stringify(manifest)).not.toContain('loom_');expect(readFileSync(join(home,'example.json'),'utf8')).not.toContain('loom_');
  expect(manifest.tasks).toHaveLength(4);expect(manifest.runtime.job).toMatchObject({title:'Inspect the example shed',state:'queued',box:null});expect(manifest.runtime.box).toEqual(expect.any(String));expect(manifest.gaps.map((g:{page:string})=>g.page)).toEqual(['machines']);
  const before=readFileSync(join(home,'app.db'));
  await expect(exampleHome(home)).rejects.toThrow();expect(readFileSync(join(home,'app.db'))).toEqual(before);
  mkdirSync(join(parent,'public'));writeFileSync(join(parent,'public','next.html'),'<main>Example entry</main>');
  const clock=new FakeClock(Date.now());
  let link='';app=await startSharedHome({home,clock,webRoot:join(parent,'public'),port:0,stdout:text=>{link=text.trim();}});
  const response=await fetch(link,{method:'POST',redirect:'manual',headers:{origin:app.url}});
  expect(response.status).toBe(303);const cookie=response.headers.get('set-cookie')!.split(';')[0];
  const post=async(path:string,input:unknown)=>{const response=await fetch(app!.url+path,{method:'POST',redirect:'error',headers:{cookie,origin:app!.url,'content-type':'application/json'},body:JSON.stringify(input)});expect(response.status).toBe(200);return response.json();};
  const read=async(query:string,variables:Record<string,unknown>={})=>{const result=await post('/graphql',{query,variables});expect(result.errors).toBeUndefined();return result.data;};
  const result={data:await read('{ deskTime { timezone } tasks { id title status } approvals { id state } changes { id project agent } triggers { id } currentJobs(agent:"moss"){id title state box} modelAccounts { __typename ... on RuntimeAccountDetail { id label usage hasRoom signedInOn{id name} } ... on RuntimeAccountSummary { label level } } }')};
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
  expect(result.data.modelAccounts).toEqual([expect.objectContaining({__typename:'RuntimeAccountDetail',id:manifest.account.id,label:'Example model subscription',usage:0.25,hasRoom:true,signedInOn:[{id:manifest.runtime.box,name:'Example workshop'}]})]);
  expect(result.data.currentJobs).toEqual(expect.arrayContaining([manifest.runtime.job]));
  const models=await fetch(app.url+'/api/runtime/agentModelsSet',{method:'POST',headers:{cookie,origin:app.url,'content-type':'application/json'},body:JSON.stringify({id:'restarted-example-models',input:{agent:'moss',models:['example-model']}})});expect(models.status).toBe(200);
  const ordinary=app.writes.run(()=>app!.services.signin.issue({kind:'owner',member:'robin',label:'Example ordinary member',expiresAt:new Date(Date.now()+60_000).toISOString()})).value;
  try{
   const response=await fetch(app.url+'/graphql',{method:'POST',headers:{authorization:'Bearer '+ordinary.token,'content-type':'application/json'},body:JSON.stringify({query:'{currentJobs(agent:"moss"){id} modelAccounts{__typename ...on RuntimeAccountDetail{id usage signedInOn{id}} ...on RuntimeAccountSummary{label level}}}'})});
   expect(response.status).toBe(200);expect((await response.json()).data).toEqual({currentJobs:[{id:manifest.runtime.publicJob.id}],modelAccounts:[{__typename:'RuntimeAccountSummary',label:'Example model subscription',level:'plenty'}]});
  }finally{app.writes.run(()=>app!.services.signin.revoke(ordinary.fingerprint));}
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

it.each(['runtime.boxSettingsSet','runtime.health','tempo.set']as const)('revokes temporary setup authority when %s is refused',async operation=>{
 const parent=mkdtempSync(join(tmpdir(),'loom-example-runtime-failed-')),home=join(parent,'home'),call=Operations.prototype.callAsync;
 vi.spyOn(Operations.prototype,'callAsync').mockImplementation(async function(this:Operations,...args:Parameters<Operations['callAsync']>){if(args[2]===operation)return{ok:false as const,code:'denied' as const,message:'Fictitious health refusal'};return call.apply(this,args);});
 try{
  await expect(exampleHome(home)).rejects.toThrow(operation==='runtime.health'?'Worker health failed':'Example Runtime setup failed at '+operation);
  const database=new Database(join(home,'app.db'),{readonly:true});try{expect(database.prepare("select label,revoked_at from tokens where label in ('Example setup','Example worker setup') order by label").all()).toEqual(operation==='runtime.boxSettingsSet'?[{label:'Example setup',revoked_at:expect.any(String)}]:[{label:'Example setup',revoked_at:expect.any(String)},{label:'Example worker setup',revoked_at:expect.any(String)}]);}finally{database.close();}
 }finally{rmSync(parent,{recursive:true,force:true});}
});
