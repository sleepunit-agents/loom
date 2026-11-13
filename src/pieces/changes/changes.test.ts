import { afterEach, it, expect, vi } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
 const app=await startLoom({home,clock,sharing:fixtureSharing,authenticate:()=>({viewer:owner,valid:()=>true}),install:app=>installChanges(app.db,app.operations,app.live,fixtureSharing,{approvals,attribution:()=>({agents:{art:{logins:['art-bot'],branches:[]}},ownerLogins:[]})})});closes.push(app.close);
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
it('keeps a failed repository snapshot, replaces successful ones, holds staging and resumes durable refresh after restart',async()=>{
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
