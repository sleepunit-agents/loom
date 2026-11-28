/** Frozen reviews (conversation.review) through the real Root, dispatcher, worker door and body program. Every repository,
 * commit, person and word here is fictional. */
import {afterEach,expect,it,vi} from 'vitest';
import {and,eq} from 'drizzle-orm';
import {bodyFixture,bodyCredentials,credentialHash} from '../test/fixtures/conversation-body.js';
import * as s from './core/data/schema.js';
import {bodyProgram} from './runtime/body-program.js';
import type {HarnessRun} from './runtime/body-harness.js';
import {frozenReview,reviewPlace,REVIEW_PLACE_UNREADABLE} from './core/conversations/review-place.js';
import {handoffEnvelope} from './core/conversations/handoff-words.js';
import {change as fixtureChange} from './pieces/changes/change.fixture.js';
import {changeReviewStore,NO_VERDICT,TREE_CHANGED} from './apps/change-reviews.js';
import {currentKitJob} from './shared-kit-access.js';
import {sharedCredentials} from './shared-credentials.js';
import {FROZEN_REVIEW_CALLS} from './core/conversations/review-confinement.js';

const clean:(()=>void|Promise<void>)[]=[];
afterEach(async()=>{for(const close of clean.splice(0).reverse())await close();});
const head='a'.repeat(40),base='b'.repeat(40),change='github:acme/app#3';
const AUTHOR_THREAD='AUTHOR THREAD REASONING: the fix is safe because the pump never stalls.';
const AUTHOR_DESCRIPTION='AUTHOR PR DESCRIPTION: I chose a doubled rate after a long session.';
const CONTRACT='CONTRACT: ticket t-17 says the pump rate doubles and nothing else changes.';
const role={agent:'art',id:'review',description:'Review the supplied change for correctness and repository standards.',models:['reviewer']};

async function fixture(harness:'claude'|'codex'='codex',readBase:(repository:string,head:string,branch?:string)=>Promise<string>=async()=>base){
 const asked:(string|undefined)[][]=[];
 const f=await bodyFixture(clean,{workRoles:[role],modelRoles:()=>[{model:'first',provider:'openai',harness:'claude',series:'first'},{model:'reviewer',provider:'openai',harness,series:'reviewer'}],
  changes:{read:async()=>[fixtureChange({body:AUTHOR_DESCRIPTION})],reviewBindings:{acme:'github-acme'},reviewBase:async(...args)=>{asked.push(args);return readBase(...args);}}});
 const {db,root}=f,now=()=>new Date(f.clock.now()).toISOString();
 db.insert(s.agentModels).values([{agent:'art',model:'first',position:0},{agent:'art',model:'reviewer',position:1}]).run();
 db.insert(s.agentRunSettings).values({agent:'art',houseRepository:'repo',houseFile:'Housefile',houseBranch:'next',nestedContainers:false,gpu:false}).run();
 db.insert(s.agentBoxes).values({agent:'art',box:'box',position:0}).run();
 db.update(s.boxes).set({hostsAny:true,lastSeenAt:now()}).run();
 db.insert(s.modelAccounts).values({id:'paid',owner:'alice',provider:'openai',label:'Subscription',hasRoom:true}).run();
 db.insert(s.modelAccountWindows).values({account:'paid',window:'week',usage:0.1,usageReadAt:now(),resetsAt:new Date(f.clock.now()+86400000).toISOString(),durationMs:604800000}).run();
 db.insert(s.modelAccountBoxes).values({account:'paid',box:'box'}).run();
 for(const one of ['claude','codex'])db.insert(s.modelAccountLogins).values({account:'paid',box:'box',harness:one,place:'containers',state:'signed-in',checkedAt:now(),since:now(),learnedFrom:'check'}).run();
 // The pull request belongs to the thread's project, so the owner's body may read it; loom's poll reads it the same.
 db.insert(s.projectRepositories).values({project:'pond',repository:'acme/app'}).run();
 root.services.changes.put(fixtureChange({body:AUTHOR_DESCRIPTION}));
 const next=async(id:string,frozen:boolean)=>(await (await root.http.request('/api/runtime/next',{method:'POST',headers:{authorization:'Bearer '+bodyCredentials.runner,'content-type':'application/json'},
  body:JSON.stringify({id,input:{execution:'container',reviewResults:true,...(frozen&&{frozenReviews:true}),slots:3}})})).json()).value;
 const runtime=(name:string,input:unknown,id:string)=>root.http.request('/api/runtime/'+name,{method:'POST',headers:{authorization:'Bearer '+bodyCredentials.runner,'content-type':'application/json'},body:JSON.stringify({id,input})});
 await f.send(AUTHOR_THREAD,'start-review');
 await next('advertise',true);
 return {...f,now,next,runtime,asked};
}
const request={clientId:'review-one',label:'Review acme/app#3',target:{change:'acme/app#3'},contract:CONTRACT};
async function launch(f:Awaited<ReturnType<typeof fixture>>,input:unknown=request,id='launch'){
 const response=await f.call('review',input,id);
 expect(response.status,JSON.stringify(await response.clone().json())).toBe(200);
 return (await response.json()).value as {conversation:string;item:string;commit:string;base:string};
}
/** The origin's own job is done, so the child's job is the one the worker is offered. */
function settleOrigin(f:Awaited<ReturnType<typeof fixture>>){
 f.db.update(s.inbox).set({state:'done',job:'job'}).where(eq(s.inbox.conversation,f.thread.conversation)).run();
 f.db.update(s.jobs).set({state:'done',endedAt:f.now()}).where(eq(s.jobs.id,'job')).run();
 f.clock.advance(60_000);
}
/** Run the worker's offer through loom's own body program, with the harness's reply. What the harness was told is returned. */
async function runBody(f:Awaited<ReturnType<typeof fixture>>,assignment:{id:string;conversation:string},reply:string){
 const token='body_'+'c'.repeat(64);
 f.db.update(s.jobs).set({state:'running'}).where(eq(s.jobs.id,assignment.id)).run();
 f.db.insert(s.tokens).values({fingerprint:credentialHash(token),label:'Fictional reviewer',kind:'agent',agent:'art',job:assignment.id,createdAt:f.now()}).run();
 let told='';
 const native:HarnessRun=async(_job,context)=>{told=context;return {text:reply,model:'reviewer',actions:[]};};
 const startup=vi.fn(async()=>{}),loadMemory=vi.fn(async()=>'IDENTITY AND MEMORY OF THE AUTHOR');
 const bytes=Buffer.from(JSON.stringify({job:assignment,build:'fixture',bootstrap:{origin:'https://loom.invalid',job:assignment.id,token}}));
 const errors:string[]=[];
 const code=await bodyProgram({args:['fixture'],read:async()=>JSON.stringify({command:'/fictional/harness',cwd:'/fictional',reach:'all'}),stdin:async()=>bytes,env:{},signal:new AbortController().signal,clock:f.clock,
  fetch:async(url,init)=>f.root.http.request(new Request(url,init)),schedule:{every:()=>()=>{}},startup,loadMemory,native,error:message=>errors.push(message)});
 expect(code,errors.join(' ')).toBe(0);
 // Handed no secret at start and no memory: the reviewer starts from the brief loom wrote and nothing else.
 expect(startup).not.toHaveBeenCalled();expect(loadMemory).not.toHaveBeenCalled();
 return told;
}
const relayed=async(f:Awaited<ReturnType<typeof fixture>>,child:string)=>{
 const row=f.db.select().from(s.messages).where(eq(s.messages.clientId,'review:'+child)).get()!;
 expect(row.thread).toBe(f.thread.id);
 return f.key.open(row.words!);
};

it.each([
 ['claude','clear'],['codex','clear'],['codex','blocking'],['claude','no-verdict'],['codex','no-verdict'],['claude','tree-changed'],['codex','no-tree'],
] as const)('pins a pull request, runs a frozen review on a %s worker and files its verdict on the round (%s)',async(harness,mode)=>{
 const f=await fixture(harness);
 const created=await launch(f);
 expect(created).toMatchObject({commit:head,base});
 // The merge base of the pull request's head with its base branch, asked of the forge once.
 expect(f.asked).toEqual([['acme/app',head,'main']]);
 // The same request again is the same review; the same id with another target is not.
 expect((await launch(f,request,'again')).conversation).toBe(created.conversation);
 const child=f.root.services.conversations.conversation(created.conversation);
 expect(frozenReview(child)).toEqual({repository:'acme/app',head,base,change,tier:'medium'});
 expect(child).toMatchObject({venue:'handoff',agent:'art',member:'alice',project:'pond'});
 settleOrigin(f);
 // A worker that cannot give the copy is never offered the review.
 expect(await f.next('no-copy',false)).toBeNull();
 const assignment=await f.next('copy',true);
 expect(assignment).toMatchObject({conversation:created.conversation,review:true,harness,model:'reviewer',frozenReview:{repository:'acme/app',head,base}});
 // Its round was filed with its job, on the pinned commit, before any body ran.
 const store=changeReviewStore(f.db,f.now);
 expect(store.history(change)).toMatchObject([{job:assignment.id,headCommit:head,tier:'medium',round:1,verdict:null,conversation:created.conversation}]);
 // A review uses no kit, whatever kits its agent has.
 f.db.update(s.jobs).set({state:'running'}).where(eq(s.jobs.id,assignment.id)).run();
 expect(currentKitJob(f.db,{body:()=>({agent:'art',job:assignment.id,box:'box'})} as unknown as Pick<ReturnType<typeof sharedCredentials>,'body'>,{kind:'agent',id:'art'})).toBeUndefined();
 const reply=mode==='blocking'?'- MAJOR src/pump.ts:1 the rate is tripled, not doubled.\nVERDICT: BLOCKING':mode==='no-verdict'?'Looks fine to me.':'No findings.\nVERDICT: CLEAR';
 const told=await runBody(f,assignment,reply);
 // The brief: the role, what is reviewed and where its copy is, the rule for the answer and the requester's contract.
 for(const said of [role.description,CONTRACT,head,base,'/review/tree','/review/change.diff','VERDICT: CLEAR'])expect(told).toContain(said);
 // And nothing of the author's: not its thread, not the pull request's description, not its memory.
 for(const unsaid of [AUTHOR_THREAD,AUTHOR_DESCRIPTION,'IDENTITY AND MEMORY OF THE AUTHOR'])expect(told).not.toContain(unsaid);
 const words=await relayed(f,created.conversation);
 const filed=store.history(change)[0];
 if(mode==='no-verdict'){
  expect(words.startsWith(`Frozen review of acme/app@${head.slice(0,12)} FAILED`)).toBe(true);
  expect(filed).toMatchObject({verdict:'NONE'});expect(filed.findings).toContain(NO_VERDICT);
 }else{
  const verdict=mode==='blocking'?'BLOCKING':'CLEAR';
  expect(words.startsWith(`Frozen review of acme/app@${head.slice(0,12)}: VERDICT ${verdict}.`)).toBe(true);
  expect(filed).toMatchObject({verdict,findings:reply});
 }
 expect(words).toContain(reply);
 // The worker's finish: the copy's fingerprints before and after the body. Any change, or none reported, is no verdict.
 const fingerprint='d'.repeat(64);
 const tree=mode==='tree-changed'?{head,before:fingerprint,after:'e'.repeat(64)}:mode==='no-tree'?undefined:{head,before:fingerprint,after:fingerprint};
 const finished=await f.runtime('finish',{job:assignment.id,exitCode:0,logTail:'',exitBy:'body',...(tree?{reviewTree:tree}:{})},'finish');
 expect(finished.status,await finished.clone().text()).toBe(200);
 const after=store.history(change)[0];
 if(mode==='tree-changed')expect(after).toMatchObject({verdict:'NONE',findings:TREE_CHANGED});
 else if(mode==='no-tree')expect(after).toMatchObject({verdict:'NONE'});
 else expect(after).toMatchObject({verdict:filed.verdict});
 // One job: a review is never tried again.
 expect(f.db.select().from(s.jobs).where(eq(s.jobs.conversation,created.conversation)).all()).toHaveLength(1);
});

it('reviews a commit against its parent, filing the round on the pull request it heads, and gives the description only when asked',async()=>{
 const f=await fixture();
 const created=await launch(f,{clientId:'commit',label:'Review a commit',target:{repository:'Acme/App',commit:head},contract:CONTRACT},'commit');
 // No branch: the commit's first parent.
 expect(f.asked).toEqual([['acme/app',head,undefined]]);
 expect(frozenReview(f.root.services.conversations.conversation(created.conversation))).toEqual({repository:'acme/app',head,base,change,tier:'medium'});
 const described=await launch(f,{...request,clientId:'described',includeDescription:true,tier:'high'},'described');
 const brief=(cv:string)=>f.db.select().from(s.inbox).where(and(eq(s.inbox.conversation,cv),eq(s.inbox.source,'handoff'))).get()!;
 // The brief is sealed; nothing of it is stored in the clear.
 for(const cv of [created.conversation,described.conversation])expect(JSON.stringify(brief(cv))).not.toContain(CONTRACT);
 const opened=async(cv:string)=>(await f.key.open(Buffer.from(handoffEnvelope(brief(cv).words)!.cipher,'base64'))).toString();
 // Asked for, the pull request's description is given, and said to be the requester's choice. Not asked for, it is not.
 const plain=await opened(created.conversation),withDescription=await opened(described.conversation);
 expect(plain).toContain(CONTRACT);expect(plain).not.toContain(AUTHOR_DESCRIPTION);expect(plain).toContain("the commit's parent");
 expect(withDescription).toContain('Pull request description, included at the requester\'s request:\n'+AUTHOR_DESCRIPTION);
 expect(withDescription).toContain('the merge base of the pull request with main');
 for(const words of [plain,withDescription])expect(words).not.toContain(AUTHOR_THREAD);
 expect(frozenReview(f.root.services.conversations.conversation(described.conversation))?.tier).toBe('high');
 // A commit no pull request loom follows is headed by: reviewed all the same, with no round to file on.
 const other='c'.repeat(40);
 const loose=await launch(f,{clientId:'loose',label:'Review a loose commit',target:{repository:'acme/app',commit:other},contract:CONTRACT},'loose');
 expect(frozenReview(f.root.services.conversations.conversation(loose.conversation))).toMatchObject({head:other,change:null});
});

it('refuses a review it cannot pin, and anyone but the private owner body',async()=>{
 const f=await fixture('codex',async()=>{throw Error('GitHub down');});
 expect((await f.call('review',request,'down')).status).toBe(503);
 expect((await f.call('review',{...request,target:{change:'acme/app#99'}},'unknown')).status).toBe(400);
 expect((await f.call('review',{...request,target:{repository:'acme/app',commit:'abc'}},'short')).status).toBe(400);
 expect((await f.call('review',{...request,role:'missing'},'role')).status).toBe(400);
 for(const token of [bodyCredentials.agent,bodyCredentials.member])expect((await f.call('review',request,'ordinary',token)).status).toBe(403);
 expect(f.db.select().from(s.conversations).where(eq(s.conversations.venue,'handoff')).all()).toEqual([]);
});

it('reviews a commit only in a repository the asker may read, refusing any other as one that does not exist, before GitHub is asked',async()=>{
 const f=await fixture();
 const commit=(repository:string,clientId:string)=>f.call('review',{clientId,label:'Review a commit',target:{repository,commit:head},contract:CONTRACT},clientId);
 const refusal=async(response:Response)=>({status:response.status,body:await response.json()});
 // In a repository a pull request it may read is in (acme/app, the project's): allowed.
 expect((await commit('acme/app','readable')).status).toBe(200);
 // The agent's own house, on GitHub: allowed. And one whose owner the forge bindings name: allowed (Jonathan's ruling).
 f.db.update(s.agentRunSettings).set({houseRepository:'https://github.com/acme/house.git'}).run();
 expect((await commit('acme/house','house')).status).toBe(200);
 expect((await commit('acme/payroll','bound-owner')).status).toBe(200);
 expect(f.asked.map(([repository])=>repository)).toEqual(['acme/app','acme/house','acme/payroll']);
 // Any other repository: the same refusal, word for word, as a repository GitHub says does not exist, and GitHub is
 // never asked about it, so the refusal tells nothing of whether it exists.
 const hidden=await refusal(await commit('other/secret','hidden'));
 expect(f.asked).toHaveLength(3);
 const g=await fixture('codex',async()=>{throw Error('Not Found');});
 const missing=await refusal(await g.call('review',{clientId:'missing',label:'Review a commit',target:{repository:'acme/gone',commit:head},contract:CONTRACT},'missing'));
 expect(g.asked).toHaveLength(1);
 expect(hidden).toEqual(missing);expect(hidden.status).toBe(503);
 expect(f.db.select().from(s.conversations).where(eq(s.conversations.place,'')).all()).toEqual([]);
});

it('runs no review of a repository whose owner no forge binding names, not even one the asker may read, and asks GitHub nothing',async()=>{
 const f=await fixture();
 f.db.insert(s.projectRepositories).values({project:'pond',repository:'other/app'}).run();
 f.root.services.changes.put(fixtureChange({id:'github:other/app#4',repo:'github:other/app',number:4,url:'https://github.com/other/app/pull/4'}));
 const response=await f.call('review',{...request,clientId:'unbound',target:{change:'other/app#4'}},'unbound');
 expect(response.status).toBe(503);
 expect((await response.json()).message).toContain('no forge credential');
 expect(f.asked).toEqual([]);
});

it('never runs a frozen review whose pinned target does not parse, and never as an ordinary job',async()=>{
 const f=await fixture();
 const created=await launch(f);
 settleOrigin(f);
 const child=f.root.services.conversations.conversation(created.conversation);
 const parts=JSON.parse(child.place) as string[];
 // A sixth part loom did not write: a repository name longer than GitHub allows.
 const target=JSON.parse(parts[5]) as Record<string,unknown>;
 f.db.update(s.conversations).set({place:JSON.stringify([...parts.slice(0,5),JSON.stringify({...target,repository:'acme/'+'a'.repeat(101)})])}).where(eq(s.conversations.id,child.id)).run();
 expect(frozenReview(f.root.services.conversations.conversation(child.id))).toBeUndefined();
 // Offered neither to a worker without the copy (as an ordinary handoff would be) nor to one with it.
 expect(await f.next('ordinary',false)).toBeNull();
 const job=f.db.select().from(s.jobs).where(eq(s.jobs.conversation,child.id)).get()!;
 expect(job).toMatchObject({state:'failed',box:null,endedNote:REVIEW_PLACE_UNREADABLE});
 expect(await f.next('copy',true)).toBeNull();
 // And loom never makes such a place: the strict shape is checked before one is written.
 expect(()=>reviewPlace('parent','id',{id:'review',revision:'r'},{repository:'acme/'+'a'.repeat(101),head,base,change:null,tier:'medium'})).toThrow('Invalid frozen review target');
});

it('holds a frozen review\'s body token to its own reply and its job\'s bookkeeping: every other operation in the registry is refused it',async()=>{
 const f=await fixture();
 const created=await launch(f);
 const viewer=(raw:string)=>f.root.credentials.authenticate(new Request('https://loom.invalid/api/conversation/message',{headers:{authorization:'Bearer '+raw}}))!.viewer;
 // Every operation any caller could reach at the outside door, read from the registry itself.
 const offered=f.root.operations.offered('http').map(one=>one.name).sort();
 expect(offered.length).toBeGreaterThan(100);
 // The refusal is the review's, not the agent's: the origin's own body, while it runs, is held by no such rule.
 expect(offered.filter(name=>!f.root.credentials.allows(viewer(bodyCredentials.body),name))).toEqual([]);
 const control=await f.root.http.request('/graphql',{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+bodyCredentials.body},body:JSON.stringify({query:'{__typename}'})});
 expect(control.status).toBe(200);
 settleOrigin(f);
 const assignment=await f.next('copy',true);
 const token='body_'+'f'.repeat(64);
 f.db.update(s.jobs).set({state:'running'}).where(eq(s.jobs.id,assignment.id)).run();
 f.db.insert(s.tokens).values({fingerprint:credentialHash(token),label:'Fictional reviewer',kind:'agent',agent:'art',job:assignment.id,createdAt:f.now()}).run();
 const reviewer=viewer(token);
 // The ones the ruling names are among them, so the sweep below covers them.
 for(const name of ['conversation.handoff','conversation.review','conversation.digest','conversation.activityPost','memory.remember','tasks.create','secrets.request'])
  if(f.root.operations.has(name))expect(offered).toContain(name);
 const allowed=offered.filter(name=>f.root.credentials.allows(reviewer,name));
 expect(allowed).toEqual([...FROZEN_REVIEW_CALLS].filter(name=>offered.includes(name)).sort());
 expect(allowed).not.toContain('conversation.handoff');expect(allowed).not.toContain('conversation.review');
 // And it holds at the door: each refused operation, called with the reviewer's token, is denied before it runs.
 for(const name of offered.filter(name=>!FROZEN_REVIEW_CALLS.has(name))){
  const [piece,operation]=name.split('.');
  const response=await f.root.http.request(`/api/${piece}/${operation}`,{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+token},body:JSON.stringify({input:{},id:'sweep-'+name})});
  expect(response.status,name).toBe(403);
 }
 // A handoff of each kind, with real input: refused, and nothing is written.
 for(const input of [{clientId:'role',label:'Escape',role:'review',words:'Push this.'},{clientId:'self',label:'Escape',to:{conversation:f.thread.conversation},words:'Push this.'},{clientId:'peer',label:'Escape',agent:'mark',words:'Push this.'}])
  expect((await f.call('handoff',input,'escape-'+input.clientId,token)).status).toBe(403);
 expect((await f.call('review',{...request,clientId:'again'},'escape-review',token)).status).toBe(403);
 expect(f.db.select().from(s.conversations).where(eq(s.conversations.venue,'handoff')).all().map(row=>row.id)).toEqual([created.conversation]);
 // Nor may it read through GraphQL.
 const read=await f.root.http.request('/graphql',{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+token},body:JSON.stringify({query:'{__typename}'})});
 expect(read.status).not.toBe(200);
});
