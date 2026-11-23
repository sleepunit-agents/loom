import {afterEach,expect,it} from 'vitest';
import BetterSqlite3 from 'better-sqlite3';
import {mkdtempSync,rmSync,existsSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {FakeClock,type Sharing,type Viewer} from '../../core/index.js';
import {createActivityReader} from './activity.js';
import {dayBefore,startOf,oneLine,whatOf,venueKey,refsIn,type ActivityOpen} from './activity-model.js';
import type {ActivityConversations,ActivityRun,ActivityConversation} from './activity-role.js';
const homes:string[]=[],closes:Array<()=>void|Promise<void>>=[];
const dir=()=>{const h=mkdtempSync(join(tmpdir(),'activity-'));homes.push(h);return h;};
afterEach(async()=>{for(const fn of closes.splice(0).reverse())await fn();for(const h of homes.splice(0))rmSync(h,{recursive:true,force:true});});
const now=Date.parse('2026-11-13T18:00:00Z'),owner:Viewer={kind:'member',id:'owner'},partial:Viewer={kind:'member',id:'partial'};
const sharing:Sharing={members:{owner:{owner:true,agents:[]},partial:{owner:false,agents:['art']},outsider:{owner:false,agents:[]}},projects:{pond:{members:['outsider'],agents:[]}}};
function source(path=join(dir(),'memories.db')){const db=new BetterSqlite3(path);db.exec('CREATE TABLE memories(ref TEXT PRIMARY KEY,title TEXT,content TEXT,created TEXT,project TEXT,metadata TEXT,expires_at TEXT,category TEXT,archived INTEGER)');closes.push(()=>db.close());return {path,db,add(ref:string,input:Record<string,unknown>={}){const row={ref,title:ref,content:'A complete story mentioning t-12 and sleepunit-agents/loom#941.',created:'2026-11-13T17:00:00Z',project:null,metadata:'{"where":"terminal"}',expires_at:null,category:'episode',archived:0,...input};db.prepare('INSERT OR REPLACE INTO memories VALUES(@ref,@title,@content,@created,@project,@metadata,@expires_at,@category,@archived)').run(row);}};}
const conv=(id='cv-111111111111',input:Partial<ActivityConversation>={}):ActivityConversation=>({id,agent:'art',venue:'terminal',place:'terminal',label:'Build the household',people:['owner'],...input});
const run=(key:string,input:Partial<ActivityRun>={}):ActivityRun=>({kind:'digest',key,at:'2026-11-13T17:10:00Z',conversation:conv(),summary:'Shipped Activity. The full story follows.',asked:['Show what happened'],decided:['Use the new role'],tasks:['t-2207'],links:[],more:[],...input});
function role(rows:ActivityRun[]):ActivityConversations{return {list:(_v,q)=>({available:true,rows:rows.filter(r=>r.conversation.agent===q.agent&&Date.parse(r.at)>=q.from&&Date.parse(r.at)<q.until)}),read:(_v,a,k,key)=>rows.find(r=>r.conversation.agent===a&&r.kind===k&&r.key===key),conversation:(_v,a,id)=>rows.find(r=>r.conversation.agent===a&&r.conversation.id===id)?.conversation};}
async function fixture(a:string,b?:string,conversations?:ActivityConversations){
 const clock=new FakeClock(now),reader=createActivityReader(clock,{agents:[{agent:'art',memories:a},...(b?[{agent:'other',memories:b}]:[])],sharing:()=>sharing,conversations,owner:'owner',timezone:'America/Chicago'});
 closes.push(reader.close);return {clock,reader};
}
function list(app:Awaited<ReturnType<typeof fixture>>,v=owner,to='recent'){const row=app.reader.window(to,v);if(!row)throw Error('Activity window absent');return row;}
function read(app:Awaited<ReturnType<typeof fixture>>,id:string,v=owner){return app.reader.read(id,v);}
it('keeps calendar windows bounded across DST and classifies pure text without old IO',()=>{
 expect(dayBefore('2026-03-01')).toBe('2026-02-28');expect(startOf('2026-11-01','America/Chicago')).toBe(Date.parse('2026-11-01T05:00:00Z'));expect(startOf('2026-11-02','America/Chicago')-startOf('2026-11-01','America/Chicago')).toBe(25*3600000);
 expect(startOf('2026-03-09','America/Chicago')-startOf('2026-03-08','America/Chicago')).toBe(23*3600000);expect(startOf('2026-11-13','Asia/Kolkata')).toBe(Date.parse('2026-11-12T18:30:00Z'));
 expect(oneLine('Shipped the household activity screen. More words.')).toBe('Shipped the household activity screen.');expect(oneLine('x'.repeat(250))).toHaveLength(200);expect(venueKey('loom')).toBe('comms');expect(venueKey('schedule')).toBe('wakes');expect(whatOf({title:'Disk nearly full'})).toBe('system');expect(whatOf({title:'Release',line:'Merged loom#941'})).toBe('work');expect(refsIn('t-12 t-12 https://github.com/sleepunit-agents/loom/pull/941 loom#941','sleepunit-agents')).toMatchObject({tasks:['t-12'],prs:[{label:'loom#941'}]});
});
it('does not arm Activity or inspect Conversations when no agent source is configured',()=>{
 let scans=0;const reader=createActivityReader(new FakeClock(now),{agents:[],sharing:()=>sharing,timezone:'UTC',conversations:{...conv,nextDeadline(){scans++;return now+1000;}}});
 try{expect(reader.allowed(owner)).toBe(false);expect(reader.window('recent',owner)).toBeUndefined();expect(reader.nextDeadline()).toBeUndefined();expect(scans).toBe(0);}finally{reader.close();}
});
it('reads active episodes only and keeps absent files absent, with explicit missing conversation owner',async()=>{
 const a=source();a.add('m-visible');a.add('m-expired',{expires_at:new Date(now).toISOString()});a.add('m-archived',{archived:1});a.add('m-fact',{category:'project'});a.add('m-old',{created:'2026-10-01T00:00:00Z'});
 const missing=join(dir(),'missing.db'),app=await fixture(a.path,missing);const w=list(app);expect(w.days).toEqual(['2026-11-13','2026-11-12','2026-11-11']);expect(w.earlier).toBe('2026-11-10');expect(w.entries.map(e=>e.id)).toEqual(['e~art~m-visible']);expect(w).toMatchObject({conversations:'unavailable',episodes:'unavailable'});expect(existsSync(missing)).toBe(false);
 expect(read(app,'e~art~m-visible')).toMatchObject({story:expect.stringContaining('complete story'),tasks:[{label:'t-12',href:'/p/tasks-preview/task/t-12'}],prs:[{label:'loom#941'}]});
 expect(list(app,owner,'2026-10-14').days).toEqual(['2026-10-14']);expect(app.reader.window('2026-02-30',owner)).toBeUndefined();expect(app.reader.window('2026-10-13',owner)).toBeUndefined();
});
it('opens the complete episode and resolves references beyond the first twenty thousand characters',async()=>{
 const a=source(),content=`${'A long fictional episode. '.repeat(1000)}Finished t-998 and sleepunit-agents/loom#998. Final detail.`;
 a.add('long',{content});
 const app=await fixture(a.path);
 expect(read(app,'e~art~long')).toMatchObject({story:content,tasks:[{label:'t-998'}],prs:[{label:'loom#998'}]});
 expect(JSON.stringify(list(app))).not.toContain(content);
});
it('checks conversation references at the end of a long episode before listing or opening it',async()=>{
 const a=source();
 a.add('long-private',{content:`${'Fictional detail. '.repeat(1500)}Its conversation is cv-222222222222`});
 const app=await fixture(a.path,undefined,role([run('private',{conversation:conv('cv-222222222222',{member:'owner',venue:'loom'})})]));
 expect(list(app,partial).entries).toEqual([]);
 expect(read(app,'e~art~long-private',partial)).toBeUndefined();
});
it('uses private agent policy and keeps another member’s private conversations from a household owner',async()=>{
 const a=source(),b=source();a.add('m-art');b.add('m-other');
 const rows=[run('dg-visible'),run('dg-private',{conversation:conv('cv-222222222222',{venue:'loom',member:'partial',label:'Partial private thread'})}),run('dg-unscoped-comms',{conversation:conv('cv-333333333333',{venue:'loom',label:'No member'})})];
 a.add('m-comms',{metadata:JSON.stringify({where:'loom:thread',conversation:'cv-222222222222'})});a.add('m-mislabeled',{metadata:JSON.stringify({where:'terminal',conversation:'cv-222222222222'})});a.add('m-unknown',{metadata:JSON.stringify({where:'terminal',conversation:'cv-444444444444'})});
 const app=await fixture(a.path,b.path,role(rows));expect(list(app).entries.map(e=>e.id)).toEqual(['d~art~dg-unscoped-comms','d~art~dg-visible','e~other~m-other']);
 expect(list(app,partial).entries.map(e=>e.id)).toEqual(expect.arrayContaining(['d~art~dg-private','d~art~dg-visible']));expect(list(app,partial).entries.some(e=>e.agent==='other')).toBe(false);
 expect(read(app,'d~art~dg-private')).toBeUndefined();expect(read(app,'d~art~dg-private',partial)).toBeDefined();expect(read(app,'e~art~m-mislabeled')).toBeUndefined();expect(read(app,'e~other~m-other',partial)).toBeUndefined();
 expect(app.reader.window('recent',{kind:'member',id:'outsider'})).toBeUndefined();expect(list(app,{kind:'agent',id:'art'}).entries.some(e=>e.agent==='other')).toBe(false);
});
it('shows shared project conversations without opening the agent’s episode files',async()=>{
 const a=source();a.add('private-memory');
 const r=role([run('shared',{conversation:conv(undefined,{project:'pond'})})]);
 r.agents=()=>['art'];
 const app=await fixture(a.path,undefined,r),viewer:Viewer={kind:'member',id:'outsider'};
 expect(list(app,viewer).entries.map(e=>e.id)).toEqual(['d~art~shared']);
 expect(read(app,'d~art~shared',viewer)).toBeDefined();
 expect(read(app,'e~art~private-memory',viewer)).toBeUndefined();
});
it('checks shared-service UUID conversation ids in episode metadata and text',async()=>{
 const a=source(),id='cv-12345678-1234-1234-1234-123456789abc';
 a.add('metadata',{metadata:JSON.stringify({where:'terminal',conversation:id})});
 a.add('body',{content:`Its conversation is ${id}`});
 const app=await fixture(a.path,undefined,role([run('private',{conversation:conv(id,{member:'owner',venue:'loom'})})]));
 expect(list(app,partial).entries).toEqual([]);
 expect(read(app,'e~art~metadata',partial)).toBeUndefined();
 expect(read(app,'e~art~body',partial)).toBeUndefined();
});
it('extracts task and PR references from shared digest item text',async()=>{
 const a=source(),app=await fixture(a.path,undefined,role([run('refs',{summary:'Checked the hose',asked:['Review t-43'],tasks:['Task t-42 with sleepunit-agents/loom#42'],references:['Pond: t-44 sleepunit-agents/loom#44']})]));
 expect(read(app,'d~art~refs')).toMatchObject({tasks:[{label:'t-43',href:'/p/tasks-preview/task/t-43'},{label:'t-42',href:'/p/tasks-preview/task/t-42'},{label:'t-44',href:'/p/tasks-preview/task/t-44'}],prs:[{label:'loom#42'},{label:'loom#44'}]});
});
it('deduplicates moved conversations and covered episodes; readers preserve stories, refs, own needs and card-only steps',async()=>{
 const a=source();a.add('covered',{metadata:JSON.stringify({where:'terminal',conversation:'cv-111111111111'}),created:'2026-11-13T14:00:00Z'});a.add('near-duplicate',{created:'2026-11-13T17:15:00Z'});a.add('independent',{created:'2026-11-13T15:00:00Z',title:'Weekly check: all clear'});
 const rows=[run('dg-one',{needs:'Ship it?',needsHref:'/p/inbox-preview',needsForMember:'owner',more:[{id:'d~art~dg-two',at:'2026-11-12T12:00:00Z',title:'Yesterday'}]}),run('cv-111111111111',{kind:'conversation'}),run('dg-two',{at:'2026-11-12T12:00:00Z'}),run('private-run',{conversation:conv('cv-222222222222',{venue:'loom',member:'owner'}),steps:[{label:'Tool',state:'done',tool:'Read'},{label:'Internal words',state:'done',tool:'text'}]})];
 const app=await fixture(a.path,undefined,role(rows));expect(list(app).entries.map(e=>e.id)).toEqual(['d~art~dg-one','d~art~private-run','e~art~independent','d~art~dg-two']);
 expect(read(app,'d~art~dg-one')).toMatchObject({asked:['Show what happened'],decided:['Use the new role'],needs:'Ship it?',links:[{label:'What it needs you for',href:'/p/inbox-preview'}],more:[{id:'d~art~dg-two'}]});expect(read(app,'d~art~dg-one',partial)).toMatchObject({links:[]});expect((read(app,'d~art~dg-one',partial) as ActivityOpen).needs).toBeUndefined();expect(read(app,'d~art~private-run')).toMatchObject({steps:[{label:'Tool',state:'done',tool:'Read'}]});
 expect(read(app,'e~art~independent')).toMatchObject({title:'Weekly check',line:'all clear',story:expect.any(String)});
});
it('keeps a session note when a nearby digest belongs to a different conversation',async()=>{
 const a=source(),other=conv('cv-222222222222');
 a.add('gauge',{metadata:JSON.stringify({where:'terminal',conversation:other.id})});
 const records=role([run('unrelated')]);
 records.conversation=(_viewer,_agent,id)=>id===other.id?other:undefined;
 const app=await fixture(a.path,undefined,records);
 expect(list(app).entries.map(entry=>entry.id)).toEqual(['d~art~unrelated','e~art~gauge']);
});
it('scrubs spawn preambles using only the new role, and extracts fallback episode parts',async()=>{
 const a=source();a.add('prompt',{title:'You are art, in a conversation on wake: Daily review.',content:'Ask: You are art, in a conversation on wake: Daily review. Its conversation is cv-111111111111\nLast said: Checked the house\nShipped: t-12; loom#941\n(fallback episode, auto-extracted)',metadata:'{"where":"terminal","conversation":"cv-111111111111"}'});
 const r=role([run('dg-one',{conversation:conv(undefined,{label:'Daily review',venue:'wake'}),at:'2026-11-10T12:00:00Z'})]);const app=await fixture(a.path,undefined,r);expect(list(app).entries[0]).toMatchObject({title:'Daily review',venue:'wakes'});expect(read(app,'e~art~prompt')).toMatchObject({asked:[],story:'Checked the house',decided:['t-12','loom#941']});expect(JSON.stringify(list(app))).not.toContain('You are art');
});
it('isolates failed and malformed role answers while retaining episodes, with a stable 600 cap',async()=>{
 const a=source();for(let i=0;i<602;i++)a.add(`m-${i}`,{created:new Date(now-i*1000).toISOString()});const r=role([]);r.list=()=>{throw Error('/private/path');};const app=await fixture(a.path,undefined,r);expect(list(app)).toMatchObject({conversations:'error',truncated:true,entries:expect.any(Array)});expect(list(app).entries).toHaveLength(600);expect(list(app).entries[0].id).toBe('e~art~m-0');expect(JSON.stringify(list(app))).not.toContain('/private/path');r.list=()=>({available:true,rows:[{no:'schema'}]}) as never;expect(list(app)).toMatchObject({conversations:'error',entries:expect.any(Array)});
});
it('rereads outside writes and clears expired and archived entries',async()=>{
 const a=source();a.add('m-one',{expires_at:new Date(now+1000).toISOString()});const app=await fixture(a.path);
 expect(list(app).entries).toHaveLength(1);a.add('m-two',{title:'Outside update'});expect(list(app).entries.map(e=>e.title)).toContain('Outside update');
 app.clock.advance(1000);expect(list(app).entries.map(e=>e.id)).toEqual(['e~art~m-two']);
 a.db.prepare('UPDATE memories SET archived=1 WHERE ref=?').run('m-two');expect(read(app,'e~art~m-two')).toBeUndefined();
});

it('passes the original viewer to every role method',async()=>{
 const a=source();a.add('m-later',{created:'2026-11-13T14:00:00Z'});a.add('m-named',{created:'2026-11-13T14:00:00Z',metadata:'{"conversation":"cv-111111111111","where":"terminal"}'});
 const calls:Array<{method:string;viewer:Viewer}>=[],base=role([run('dg-one')]);
 const original:ActivityConversations={list(v,q){calls.push({method:'list',viewer:v});return base.list(v,q);},read(v,a,k,id){calls.push({method:'read',viewer:v});return base.read(v,a,k,id);},conversation(v,a,id){calls.push({method:'conversation',viewer:v});return base.conversation(v,a,id);}};
 const app=await fixture(a.path,undefined,original);
 calls.splice(0);list(app,partial);read(app,'d~art~dg-one',partial);read(app,'e~art~m-named',partial);expect(new Set(calls.map(c=>c.method))).toEqual(new Set(['list','read','conversation']));for(const c of calls)expect(c.viewer).toBe(partial);
});
it('reports reader failures and absent owners separately from missing, retaining healthy episodes beside corrupt databases',async()=>{
 const a=source();a.add('healthy');const bad=join(dir(),'corrupt.db');writeFileSync(bad,'not a sqlite database');
 const r=role([run('dg-one')]),app=await fixture(a.path,bad,r);expect(list(app)).toMatchObject({episodes:'error'});expect(list(app).entries.some(e=>e.id==='e~art~healthy')).toBe(false); // nearby digest owns the run
 r.read=()=>{throw Error('/private/secret');};expect(read(app,'d~art~dg-one')).toMatchObject({state:'error',message:'The conversation service couldn’t open this entry.'});
 expect(read(app,'e~other~anything')).toMatchObject({state:'error'});r.list=()=>({available:true,rows:[]});expect(list(app).entries.map(e=>e.id)).toEqual(['e~art~healthy']);
 const absent=await fixture(a.path);expect(read(absent,'d~art~dg-one')).toMatchObject({state:'unavailable'});expect(read(absent,'e~art~missing')).toBeUndefined();
});
it('expires an open digest at the NEW owner’s exact deadline',async()=>{
 const a=source(),rows=[run('dg-expiring',{expires:now+1000})],app=await fixture(a.path,undefined,role(rows));
 expect(read(app,'d~art~dg-expiring')).toBeDefined();app.clock.advance(1000);expect(read(app,'d~art~dg-expiring')).toBeUndefined();
});
it('rolls recent windows, access dates and thirty-day readers at local midnight',async()=>{
 const a=source();a.add('m-drop',{created:'2026-11-11T08:00:00Z'});a.add('m-month',{created:'2026-10-14T08:00:00Z'});const app=await fixture(a.path);
 expect(read(app,'e~art~m-month')).toBeDefined();app.clock.advance(startOf('2026-11-14','America/Chicago')-now);
 expect(list(app)).toMatchObject({days:['2026-11-14','2026-11-13','2026-11-12'],entries:[]});expect(app.reader.access(owner).today).toBe('2026-11-14');expect(read(app,'e~art~m-month')).toBeUndefined();
});
it('suppresses normalized conversation ids from prompt content even without metadata outside the nearby-run heuristic',async()=>{
 const a=source();a.add('prompt',{title:'You are art, in a conversation on terminal: House work.',content:'Ask: You are art, in a conversation on terminal: House work. Its conversation is cv-111111111111',metadata:'{}',created:'2026-11-13T12:00:00Z'});
 const app=await fixture(a.path,undefined,role([run('dg-one')]));expect(list(app).entries.map(e=>e.id)).toEqual(['d~art~dg-one']);
});

it('preserves contextual venue labels and a canonical NEW memory reader destination',async()=>{
 const a=source();a.add('m-slack',{created:'2026-11-13T12:00:00Z',metadata:'{"where":"slack:dm:patrick-kells"}'});const app=await fixture(a.path,undefined,role([run('dg-discord',{conversation:conv(undefined,{venue:'discord',label:'#household'})})]));
 expect(list(app).entries.find(e=>e.id==='d~art~dg-discord')?.where).toBe('Discord #household');expect(read(app,'e~art~m-slack')).toMatchObject({where:'Slack DM · Patrick Kells',links:[{label:'The memory',href:'/p/activity-preview/memory/art%3Am-slack'}]});
});
it('keeps the startup source inventory fixed when an absent path later appears',async()=>{
 const a=source(),missing=join(dir(),'later.db'),app=await fixture(a.path,missing);a.add('m-known');const later=source(missing);later.add('m-later');expect(list(app)).toMatchObject({episodes:'unavailable'});expect(list(app).entries.map(e=>e.id)).toEqual(['e~art~m-known']);expect(read(app,'e~other~m-later')).toMatchObject({state:'unavailable'});
});
it('rereads current conversation summaries in windows and complete readers',async()=>{
 const a=source(),rows=[run('dg-live')],app=await fixture(a.path,undefined,role(rows));rows[0].summary='Updated by conversation owner.';
 expect(list(app).entries[0].line).toBe('Updated by conversation owner.');expect(read(app,'d~art~dg-live')).toMatchObject({story:'Updated by conversation owner.'});
});

it('withdraws an open named episode at its conversation expiry and reports lookup failures as source errors',async()=>{
 const a=source();a.add('named',{metadata:'{"conversation":"cv-111111111111","where":"slack:#house"}'});const r=role([run('dg-one',{conversation:conv(undefined,{expires:now+1000})})]),app=await fixture(a.path,undefined,r);
 expect(read(app,'e~art~named')).toMatchObject({expires:now+1000});app.clock.advance(1000);expect(read(app,'e~art~named')).toBeUndefined();
 r.conversation=()=>{throw Error('private path');};expect(read(app,'e~art~named')).toMatchObject({state:'error'});
});

it('keeps an earlier conversation error when another agent’s role is unavailable',async()=>{
 const a=source(),b=source(),r=role([]);r.list=(_v,q)=>{if(q.agent==='art')throw Error('unreadable');return {available:false,rows:[]};};const app=await fixture(a.path,b.path,r);expect(list(app).conversations).toBe('error');
});
it('includes an independent moved conversation and opens its no-digest reader',async()=>{
 const a=source(),r=run('cv-111111111111',{kind:'conversation',summary:undefined,turns:3,replies:1,asked:[],decided:[],tasks:[]}),app=await fixture(a.path,undefined,role([r]));
 expect(list(app).entries).toMatchObject([{id:'c~art~cv-111111111111',title:'Build the household',line:'3 turns, 1 reply, no summary yet'}]);expect(read(app,'c~art~cv-111111111111')).toMatchObject({id:'c~art~cv-111111111111',asked:[],decided:[],tasks:[],more:[]});
});

it('uses the current member for the legacy owner filter, with household owner fallback for agent viewers',async()=>{
 const a=source();a.add('m-partial',{created:'2026-11-13T12:00:00Z',metadata:'{"where":"slack:dm:partial"}'});
 const rows=[run('dg-household',{conversation:conv(undefined,{people:['owner']})}),run('dg-partial',{conversation:conv('cv-222222222222',{people:['partial'],venue:'discord'})})],app=await fixture(a.path,undefined,role(rows));
 expect(list(app,partial).entries.find(e=>e.id==='d~art~dg-partial')?.owner).toBe(true);expect(list(app,partial).entries.find(e=>e.id==='d~art~dg-household')?.owner).toBeUndefined();expect(list(app,partial).entries.find(e=>e.id==='e~art~m-partial')?.owner).toBe(true);
 expect(list(app,{kind:'agent',id:'art'}).entries.find(e=>e.id==='d~art~dg-household')?.owner).toBe(true);
 expect(app.reader.access(partial).owner).toBe('Partial');
});

it('derives the earliest episode deadline without visibility or list caps and closes it with the reader',async()=>{
 const a=source();a.add('expires',{expires_at:new Date(now+2000).toISOString()});
 a.add('future',{created:new Date(now+61000).toISOString()});
 a.add('archived',{archived:1,expires_at:new Date(now+1).toISOString()});
 a.add('invalid',{expires_at:'invalid'});
 const app=await fixture(a.path),reader=app.reader;
 expect(reader.nextDeadline()).toBe(now+1000);
 app.clock.advance(1000);expect(reader.nextDeadline()).toBe(now+1001);
 app.clock.advance(1);expect(reader.nextDeadline()).toBe(now+2000);
 app.clock.advance(999);expect(reader.nextDeadline()).toBe(startOf('2026-11-14','America/Chicago'));
 reader.close();expect(reader.nextDeadline()).toBeUndefined();
});
it('opens the entries of an agent whose id starts with a digit or is long, as the household allows',()=>{
 const sharing:Sharing={members:{owner:{owner:true,agents:[]}},projects:{}};
 for(const agent of ['2fast','a'.repeat(100)]){
  const a=source();a.add('m-one',{title:`You are ${agent}, in a conversation on wake: Daily review.`,metadata:'{"where":"terminal"}'});
  const reader=createActivityReader(new FakeClock(now),{agents:[{agent,memories:a.path}],sharing:()=>sharing,timezone:'America/Chicago'});closes.push(reader.close);
  const entry=reader.window('recent',owner)!.entries[0];
  expect(entry.id).toBe(`e~${agent}~m-one`);
  // The runtime's opening line to the body is recognised for this agent too, so it is not shown as the title.
  expect(entry.title).not.toContain('You are');
  expect(reader.read(entry.id,owner)).toMatchObject({id:entry.id});
 }
});

it('pages visible episodes past old date windows without dropping ties or spending slots on hidden rows',async()=>{
 const store=source(),app=await fixture(store.path);
 for(const ref of ['a','b','c'])store.add(ref,{created:'2025-01-01T00:00:00Z'});
 store.add('cc',{metadata:JSON.stringify({where:'loom',conversation:'cv-111111111111'})});
 store.add('d',{archived:1});store.add('e',{expires_at:'2025-01-01'});
 const first=app.reader.episodePage('art',owner,2);
 expect(first?.entries.map(row=>row.title)).toEqual(['c','b']);
 expect(first?.nextBefore).toBe('b');
 const last=app.reader.episodePage('art',owner,2,first?.nextBefore);
 expect(last?.entries.map(row=>row.title)).toEqual(['a']);
 expect(last?.entries[0].story).toContain('complete story');
 expect(last?.nextBefore).toBeNull();
 expect(app.reader.episodePage('art',{kind:'member',id:'outsider'},2)).toBeUndefined();
});

it('fills a page past a hidden link without looking up the rest of the archive',async()=>{
 const store=source(),calls:string[][]=[];
 const ids=Array.from({length:100},(_,i)=>'cv-'+String(i).padStart(12,'0'));
 const visible=new Set(ids.slice(0,99));
 const port:ActivityConversations={...role([]),
  conversation(){throw Error('unexpected single lookup');},
  conversations(_v,agent,wanted){
   calls.push(wanted);
   if(wanted.includes(ids[0]!))throw Error('unrelated old source failure');
   return wanted.filter(id=>visible.has(id)).map(id=>conv(id,{agent}));
  },
 };
 for(let i=0;i<ids.length;i++)store.add('m-'+String(i).padStart(2,'0'),{content:'Its conversation is '+ids[i],metadata:'{"where":"terminal"}'});
 const app=await fixture(store.path,undefined,port);
 const page=app.reader.episodePage('art',owner,2)!;
 expect(page.entries.map(e=>e.title)).toEqual(['m-98','m-97']);
 expect(page.nextBefore).toBe('m-97');
 expect(calls.map(batch=>batch.length)).toEqual([3,3]);
 expect(new Set(calls.flat())).toEqual(new Set(ids.slice(94)));
 calls.length=0;
 visible.delete(ids[96]!);
 expect(app.reader.episodePage('art',owner,2,page.nextBefore)?.entries.map(e=>e.title)).toEqual(['m-95','m-94']);
 expect(calls.map(batch=>batch.length)).toEqual([3,3]);
});

it('does not fail a readable page when an unused candidate causes its batch to fail',async()=>{
 const store=source(),ids=Array.from({length:6},(_,i)=>'cv-'+String(i).padStart(12,'0'));
 const single:string[]=[];
 const port:ActivityConversations={...role([]),
  conversation(_v,agent,id){single.push(id);if(id===ids[0])throw Error('unavailable');return conv(id,{agent});},
  conversations(_v,agent,wanted){
   if(wanted.includes(ids[0]!))throw Error('unavailable');
   return wanted.filter(id=>id!==ids[5]).map(id=>conv(id,{agent}));
  },
 };
 for(let i=0;i<ids.length;i++)store.add('m-'+i,{metadata:JSON.stringify({conversation:ids[i]})});
 const app=await fixture(store.path,undefined,port);
 expect(app.reader.episodePage('art',owner,2)?.nextBefore).toBe('m-3');
 expect(single).toEqual([ids[2]]);
});
