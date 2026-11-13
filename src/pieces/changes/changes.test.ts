import { afterEach, it, expect, vi } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { WebSocket } from 'ws';
import { startLoom } from '../../foundation.js';
import { FakeClock, type Viewer } from '../../core/index.js';
import { fixtureSharing } from '../../fixture.js';
import { installChanges } from './index.js';
import { change } from './fixture.js';
import { replaceChanges, loadChanges } from './store.js';
import { normalize, githubReader } from './github.js';
import { startChangesJob } from './jobs.js';
import { changesRole, type Approvals } from './roles.js';
const dirs:string[]=[],closes:(()=>Promise<void>)[]=[];const owner:Viewer={kind:'member',id:'jonathan'},pollock:Viewer={kind:'member',id:'pollock'};
afterEach(async()=>{for(const c of closes.splice(0).reverse()) await c();for(const d of dirs.splice(0)) rmSync(d,{recursive:true,force:true});});
async function setup(approvals?:Approvals){
 const home=mkdtempSync(join(tmpdir(),'changes-'));dirs.push(home);const clock=new FakeClock();
 const app=await startLoom({home,clock,sharing:fixtureSharing,authenticate:req=>({viewer:req.headers.authorization==='Bearer pollock'?pollock:owner,valid:()=>true}),install:app=>installChanges(app.db,app.operations,app.live,fixtureSharing,{approvals,attribution:()=>({agents:{art:{logins:['art-bot'],branches:[]}},ownerLogins:[]})})});closes.push(app.close);
 let seq=0;return {...app,clock,call:(verb:string,input:unknown={},viewer=owner,id=`op-${++seq}`)=>app.operations.call('direct',viewer,`changes.${verb}`,input,id)};
}
it('ports the recorded GitHub adapter cases, including named reviewers and check failures',()=>{
 const recorded=JSON.parse(readFileSync(new URL('./github.fixture.json',import.meta.url),'utf8'));
 const rows=recorded.data.repository.open.nodes.map((n:unknown)=>normalize('github:acme/app',n));
 expect(rows[0]).toMatchObject({state:'open',checks:{state:'passing'},review:{state:'approved'},author:{login:'ada-bot'}});
 expect(rows.some((c:ReturnType<typeof change>)=>c.checks.state==='failing')).toBe(true);
 expect(rows.some((c:ReturnType<typeof change>)=>c.review.state==='required')).toBe(true);
});
it('uses one fixed read-only query with paginated open PRs and never leaks tokens or upstream errors',async()=>{
 const recorded=JSON.parse(readFileSync(new URL('./github.fixture.json',import.meta.url),'utf8')).data.repository.open.nodes[0];
 const token='ghp_TESTTOKEN_1234567890';const seen:RequestInit[]=[];
 const secrets={resolveGitHub:vi.fn(async()=> 'github-acme'),withValue:async<T>(_ref:string,use:(token:string)=>Promise<T>)=>use(token)};
 const request=vi.fn(async(url:unknown,init?:RequestInit)=>{expect(url).toBe('https://api.github.com/graphql');seen.push(init!);const {variables,query}=JSON.parse(String(init?.body));expect(query.startsWith('query(')).toBe(true);expect(query).not.toContain('mutation');const more=variables.states[0]==='OPEN'&&!variables.after;return Response.json({data:{repository:{pullRequests:{nodes:variables.states[0]==='OPEN'?[{...recorded,number:more?1:2,title:token}]:[],pageInfo:{hasNextPage:more,endCursor:'page-2'}}}}});}) as unknown as typeof fetch;
 const rows=await githubReader(secrets,request)('acme/app',Date.parse('2026-11-12T00:00:00Z'));
 expect(rows).toHaveLength(2);expect(seen).toHaveLength(3);expect(JSON.stringify(rows)).not.toContain(token);expect(secrets.resolveGitHub).toHaveBeenCalledWith('acme');
 await expect(githubReader(secrets,async()=>{throw new Error(token);})('acme/app',0)).rejects.toThrow('GitHub read unavailable');
});
it('filters each role and operation through central policy and reflects task citations without copying the task store',async()=>{
 const app=await setup();replaceChanges(app.db,[change({project:'pond'}),change({id:'github:other/app#3',repo:'github:other/app',project:'other'})]);
 const input={title:'Pond work',description:'acme/app#3',project:'pond',actor:'art',at:new Date(app.clock.now()).toISOString()};
 app.operations.call('direct',owner,'tasks.create',input,'task');
 expect(app.call('list',{},pollock)).toMatchObject({ok:true,value:[{id:'github:acme/app#3',tasks:[{title:'Pond work'}]}]});
 expect(changesRole(app.operations).forReferences(pollock,['acme/app#3','other/app#3'])).toMatchObject({ok:true,value:[{id:'github:acme/app#3'}]});
 expect(app.call('show',{id:'github:other/app#3'},pollock)).toMatchObject({code:'denied'});
 expect(app.call('refresh',{},pollock)).toMatchObject({code:'denied'});
 expect(app.call('answer',{id:change().id,head:change().head.id,action:'yes'},{kind:'agent',id:'art'})).toMatchObject({code:'denied'});
});
it('answers only a confirmed open exact-head owner ask, rechecks person, and retries the approval once',async()=>{
 let person:string|undefined;
 const answer=vi.fn(()=>({ok:true as const,value:{message:'Allowed'}}));
 const approvals:Approvals={rule:()=>({tier:'ask',...(person?{for:{slug:person,name:'Loren',state:'pending'}}:{})}),answer};
 const app=await setup(approvals),c=change({project:'pond'});replaceChanges(app.db,[c]);
 const input={id:c.id,head:c.head.id,action:'yes'};
 expect(app.call('answer',{...input,head:'b'.repeat(40)})).toMatchObject({code:'conflict'});expect(answer).not.toHaveBeenCalled();
 expect(app.call('answer',input,owner,'retry')).toMatchObject({ok:true});expect(app.call('answer',input,owner,'retry')).toMatchObject({ok:true});expect(answer).toHaveBeenCalledOnce();
 person='loren';expect(app.call('answer',input)).toMatchObject({code:'conflict'});
 expect(app.call('answer',{...input,person,action:'always'})).toMatchObject({code:'conflict'});
 expect(app.call('answer',{...input,person})).toMatchObject({ok:true});
 expect(answer.mock.calls.at(-1)).toEqual([owner,expect.objectContaining({person:'loren',target:`${c.id}@${c.head.id}`}),expect.any(String)]);
});
it('keeps a failed repository snapshot, replaces successful ones, holds staging and persists refresh requests',async()=>{
 const app=await setup();const projects={list:()=>[{slug:'pond',name:'Pond',repos:['acme/app','bad/app']}]};const settings=()=>({agents:{art:{logins:['art-bot'],branches:[]}},ownerLogins:[]});
 replaceChanges(app.db,[change({id:'github:bad/app#3',repo:'github:bad/app',project:'pond'}),change({id:'github:gone/app#3',repo:'github:gone/app'})]);
 const read=vi.fn(async(repo:string)=>{if(repo==='github:bad/app') throw new Error('SECRET upstream');return [change()];});
 const job=startChangesJob(app,{clock:app.clock,sharing:fixtureSharing,viewer:owner,projects,attribution:settings,read});
 await job.run();expect(read).toHaveBeenCalledTimes(2);expect(loadChanges(app.db)).toHaveLength(2);expect(JSON.stringify(loadChanges(app.db))).not.toContain('SECRET');expect(loadChanges(app.db).find(c=>c.repo==='github:bad/app')?.syncError).toBe('GitHub read unavailable');
 await job.run();expect(read).toHaveBeenCalledTimes(2);
 app.call('refresh');await job.run();expect(read).toHaveBeenCalledTimes(4);job.close();
 const staged=await setup();replaceChanges(staged.db,loadChanges(app.db));const held=startChangesJob(staged,{clock:staged.clock,sharing:fixtureSharing,viewer:owner,projects,attribution:settings,read,staging:true});staged.call('refresh');await held.run();expect(read).toHaveBeenCalledTimes(4);held.close();
 expect(app.db.prepare('SELECT running FROM changes_jobs').get()).toEqual({running:0});
});

it('resumes a pending refresh after closing and reopening the database, preserving the next due time', async()=>{
 const home=mkdtempSync(join(tmpdir(),'changes-restart-'));dirs.push(home);
 const clock=new FakeClock(),projects={list:()=>[{slug:'pond',name:'Pond',repos:['acme/app']}]};
 const attribution=()=>({agents:{},ownerLogins:[]});
 const open=()=>startLoom({home,clock,sharing:fixtureSharing,install:app=>installChanges(app.db,app.operations,app.live,fixtureSharing)});
 const first=await open();
 const read=vi.fn(async()=>[change({title:'Before restart'})]);
 const job=startChangesJob(first,{clock,sharing:fixtureSharing,viewer:owner,projects,attribution,read});
 await job.run();expect(read).toHaveBeenCalledOnce();
 expect(first.operations.call('direct',owner,'changes.refresh',{},'persisted-refresh')).toMatchObject({ok:true});
 job.close();await first.close();expect(first.db.open).toBe(false);
 const second=await open();closes.push(second.close);
 expect(loadChanges(second.db)).toMatchObject([{title:'Before restart'}]);
 const resumedRead=vi.fn(async()=>[change({title:'After restart'})]);
 const resumed=startChangesJob(second,{clock,sharing:fixtureSharing,viewer:owner,projects,attribution,read:resumedRead});
 try {
  await resumed.run();expect(resumedRead).toHaveBeenCalledOnce();
  expect(loadChanges(second.db)).toMatchObject([{title:'After restart'}]);
 } finally {resumed.close();}
 await second.close();closes.pop();expect(second.db.open).toBe(false);
 const third=await open();closes.push(third.close);
 const future=startChangesJob(third,{clock,sharing:fixtureSharing,viewer:owner,projects,attribution,read:resumedRead});
 try {await future.run();expect(resumedRead).toHaveBeenCalledOnce();}finally{future.close();}
});

async function changesSocket(app:{url:string}, member='jonathan') {
 const ws=new WebSocket(`${app.url.replace('http:','ws:')}/live`,{headers:{authorization:`Bearer ${member}`}});
 const queue:unknown[]=[],waiting:((value:any)=>void)[]=[];
 ws.on('message',raw=>{const value=JSON.parse(raw.toString());const receive=waiting.shift();if(receive)receive(value);else queue.push(value);});
 const next=():Promise<any>=>queue.length?Promise.resolve(queue.shift()):new Promise(resolve=>waiting.push(resolve));
 await once(ws,'open');closes.push(async()=>{if(ws.readyState===WebSocket.CLOSED)return;const done=once(ws,'close');ws.terminate();await done;});
 ws.send(JSON.stringify({kind:'subscribe',type:'change'}));
 return {next};
}
it('publishes task and approval projections to two windows and expires a closed change exactly at one week',async()=>{
 let allowed=false;
 const app=await setup({rule:()=>({tier:allowed?'do':'ask'}),answer:()=>({ok:true,value:{}})});
 const c=change({project:'pond'});replaceChanges(app.db,[c]);
 const a=await changesSocket(app),b=await changesSocket(app,'pollock');
 for(const socket of [a,b])expect(await socket.next()).toMatchObject({kind:'set',records:[{id:c.id,group:'you',tasks:[]}]});
 const created=app.operations.call('direct',owner,'tasks.create',{title:'Shared citation',description:'acme/app#3',project:'pond',actor:'art',at:new Date(app.clock.now()).toISOString()},'socket-task');
 expect(created).toMatchObject({ok:true});
 for(const socket of [a,b])expect(await socket.next()).toMatchObject({kind:'put',record:{id:c.id,tasks:[{title:'Shared citation'}]}});
 allowed=true;app.live.changed([{type:'approval-rule',id:'merge'}]);
 for(const socket of [a,b])expect(await socket.next()).toMatchObject({kind:'put',record:{id:c.id,group:'agent'}});
 allowed=false;app.live.changed([{type:'approval',id:'answer'}]);
 for(const socket of [a,b])expect(await socket.next()).toMatchObject({kind:'put',record:{id:c.id,group:'you'}});
 replaceChanges(app.db,[{...c,state:'merged',closed:new Date(app.clock.now()).toISOString()}]);app.live.changed([{type:'change',id:c.id}]);
 for(const socket of [a,b])expect(await socket.next()).toMatchObject({kind:'put',record:{state:'merged'}});
 app.clock.advance(7*86400_000-1);
 const boundary=await changesSocket(app);
 expect(await boundary.next()).toMatchObject({kind:'set',records:[{id:c.id}]});
 app.clock.advance(1);
 for(const socket of [a,b,boundary])expect(await socket.next()).toMatchObject({kind:'del',id:c.id});
 expect(app.call('list')).toMatchObject({ok:true,value:[]});
 expect(app.call('show',{id:c.id})).toMatchObject({ok:true,value:{state:'merged'}});
});
it('denies runner and ungranted service reads and prevents members and agents answering owner asks',async()=>{
 const answer=vi.fn(()=>({ok:true as const,value:{}}));const app=await setup({rule:()=>({tier:'ask'}),answer});
 const c=change({project:'pond'});replaceChanges(app.db,[c,change({id:'github:other/app#4',project:'other',agent:'mark'})]);
 for(const viewer of [{kind:'runner',id:'art'},{kind:'service',id:'keyholder'},{kind:'service',id:'changes'},{kind:'member',id:'unknown'}] as Viewer[]){
  expect(app.call('list',{},viewer)).toMatchObject({ok:viewer.kind!=='service',...(viewer.kind==='service'?{code:'denied'}:{value:[]})});
  expect(app.call('show',{id:c.id},viewer)).toMatchObject({code:'denied'});
 }
 expect(app.call('list',{}, {kind:'agent',id:'pond-bot'})).toMatchObject({ok:true,value:[{id:c.id}]});
 for(const viewer of [pollock,{kind:'agent',id:'art'},{kind:'agent',id:'pond-bot'},{kind:'runner',id:'art'},{kind:'service',id:'keyholder'}] as Viewer[]){
  expect(app.call('confirm',{id:c.id,head:c.head.id},viewer)).toMatchObject({code:'denied'});
  expect(app.call('answer',{id:c.id,head:c.head.id,action:'yes'},viewer)).toMatchObject({code:'denied'});
  expect(app.call('refresh',{},viewer)).toMatchObject({code:'denied'});
 }
 expect(answer).not.toHaveBeenCalled();
});

it('redacts escaped credentials after JSON decoding and reads past old closures updated recently',async()=>{
 const node=JSON.parse(readFileSync(new URL('./github.fixture.json',import.meta.url),'utf8')).data.repository.open.nodes[0];
 const token='private-secret';const calls:RequestInit[]=[];
 const secrets={resolveGitHub:async()=> 'github-acme',withValue:async<T>(_ref:string,use:(token:string)=>Promise<T>)=>use(token)};
 const request=(async(_url:unknown,init?:RequestInit)=>{
  calls.push(init!);expect(init?.redirect).toBe('error');const {variables}=JSON.parse(String(init?.body));
  const open=variables.states[0]==='OPEN';const more=!open&&!variables.after;
  const nodes=open?[]:[{...node,number:more?1:2,state:'CLOSED',closedAt:more?'2020-01-01T00:00:00Z':'2026-11-11T00:00:00Z',mergedAt:null,title:token,bodyText:'github_pat_ANOTHERSECRET'}];
  const text=JSON.stringify({data:{repository:{pullRequests:{nodes,pageInfo:{hasNextPage:more,endCursor:'next'}}}}}).replaceAll(token,Array.from(token,c=>'\\u'+c.charCodeAt(0).toString(16).padStart(4,'0')).join(''));
  return new Response(text);
 }) as typeof fetch;
 const rows=await githubReader(secrets,request)('acme/app',Date.parse('2026-11-12T00:00:00Z'));
 expect(calls).toHaveLength(3);expect(rows).toHaveLength(1);expect(rows[0]).toMatchObject({number:2,title:'[redacted]',body:'[redacted]'});expect(JSON.stringify(rows)).not.toContain(token);
});
it('rejects a GitHub redirect without reading its body',async()=>{
 const secrets={resolveGitHub:async()=> 'github-acme',withValue:async<T>(_ref:string,use:(token:string)=>Promise<T>)=>use('secret')};
 let calls=0;
 await expect(githubReader(secrets,(async(_url,init)=>{calls++;expect(init?.redirect).toBe('error');return new Response('secret upstream',{status:307,headers:{location:'https://api.github.com/other'}});}) as typeof fetch)('acme/app',0)).rejects.toThrow('GitHub read unavailable');expect(calls).toBe(1);
});
