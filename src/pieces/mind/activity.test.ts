import {afterEach,expect,it} from 'vitest';
import BetterSqlite3 from 'better-sqlite3';
import {mkdtempSync,rmSync,existsSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {once} from 'node:events';
import {WebSocket} from 'ws';
import {startLoom} from '../../foundation.js';
import {FakeClock,type Sharing,type Viewer} from '../../core/index.js';
import {installTouched} from '../../core/touched/index.js';
import {installMindActivity} from './activity.js';
import {dayBefore,startOf,oneLine,whatOf,venueKey,refsIn,type ActivityWindow,type ActivityOpen} from './activity-model.js';
import type {ActivityConversations,ActivityRun,ActivityConversation} from './activity-role.js';
const homes:string[]=[],closes:Array<()=>void|Promise<void>>=[];
const dir=()=>{const h=mkdtempSync(join(tmpdir(),'activity-'));homes.push(h);return h;};
afterEach(async()=>{for(const fn of closes.splice(0).reverse())await fn();for(const h of homes.splice(0))rmSync(h,{recursive:true,force:true});});
const now=Date.parse('2026-11-13T18:00:00Z'),owner:Viewer={kind:'member',id:'owner'},partial:Viewer={kind:'member',id:'partial'};
const sharing:Sharing={members:{owner:{owner:true,agents:[]},partial:{owner:false,agents:['art']},outsider:{owner:false,agents:[]}},projects:{pond:{members:['outsider'],agents:[]}},services:{'conversation-reader':{types:['conversation'],operations:[]},'memory-reader':{types:['memory'],operations:[]}}};
function source(path=join(dir(),'memories.db')){const db=new BetterSqlite3(path);db.exec('CREATE TABLE memories(ref TEXT PRIMARY KEY,title TEXT,content TEXT,created TEXT,project TEXT,metadata TEXT,expires_at TEXT,category TEXT,archived INTEGER)');closes.push(()=>db.close());return {path,db,add(ref:string,input:Record<string,unknown>={}){const row={ref,title:ref,content:'A complete story mentioning t-12 and sleepunit-agents/loom#941.',created:'2026-11-13T17:00:00Z',project:null,metadata:'{"where":"terminal"}',expires_at:null,category:'episode',archived:0,...input};db.prepare('INSERT OR REPLACE INTO memories VALUES(@ref,@title,@content,@created,@project,@metadata,@expires_at,@category,@archived)').run(row);}};}
const conv=(id='cv-111111111111',input:Partial<ActivityConversation>={}):ActivityConversation=>({id,agent:'art',venue:'terminal',place:'terminal',label:'Build the household',people:['owner'],...input});
const run=(key:string,input:Partial<ActivityRun>={}):ActivityRun=>({kind:'digest',key,at:'2026-11-13T17:10:00Z',conversation:conv(),summary:'Shipped Activity. The full story follows.',asked:['Show what happened'],decided:['Use the new role'],tasks:['t-2207'],links:[],more:[],...input});
function role(rows:ActivityRun[]):ActivityConversations{return {list:(_v,q)=>({available:true,rows:rows.filter(r=>r.conversation.agent===q.agent&&Date.parse(r.at)>=q.from&&Date.parse(r.at)<q.until)}),read:(_v,a,k,key)=>rows.find(r=>r.conversation.agent===a&&r.kind===k&&r.key===key),conversation:(_v,a,id)=>rows.find(r=>r.conversation.agent===a&&r.conversation.id===id)?.conversation};}
async function fixture(a:string,b?:string,conversations?:ActivityConversations){const clock=new FakeClock(now);const app=await startLoom({home:dir(),clock,authenticate:req=>({viewer:req.url?.includes('partial')?partial:owner,valid:()=>true}),install(app){const reader=installMindActivity(app.operations,app.live,{agents:[{agent:'art',memories:a},...(b?[{agent:'other',memories:b}]:[])],sharing:()=>sharing,conversations,owner:'owner'});app.onClose(()=>reader.close());installTouched(app.operations,(v,c)=>v.kind==='agent'&&v.id==='art'?c:undefined);}});closes.push(()=>app.close());return app;}
function list(app:Awaited<ReturnType<typeof fixture>>,v=owner,to='recent'){const r=app.operations.call('direct',v,'mind.activityList',{to});if(!r.ok)throw Error(r.message);return r.value as ActivityWindow;}
function read(app:Awaited<ReturnType<typeof fixture>>,id:string,v=owner){return app.operations.call('direct',v,'mind.activityRead',{id});}
it('keeps calendar windows bounded across DST and classifies pure text without old IO',()=>{
 expect(dayBefore('2026-03-01')).toBe('2026-02-28');expect(startOf('2026-11-01','America/Chicago')).toBe(Date.parse('2026-11-01T05:00:00Z'));expect(startOf('2026-11-02','America/Chicago')-startOf('2026-11-01','America/Chicago')).toBe(25*3600000);
 expect(startOf('2026-03-09','America/Chicago')-startOf('2026-03-08','America/Chicago')).toBe(23*3600000);expect(startOf('2026-11-13','Asia/Kolkata')).toBe(Date.parse('2026-11-12T18:30:00Z'));
 expect(oneLine('Shipped the household activity screen. More words.')).toBe('Shipped the household activity screen.');expect(oneLine('x'.repeat(250))).toHaveLength(200);expect(venueKey('loom')).toBe('comms');expect(venueKey('schedule')).toBe('wakes');expect(whatOf({title:'Disk nearly full'})).toBe('system');expect(whatOf({title:'Release',line:'Merged loom#941'})).toBe('work');expect(refsIn('t-12 t-12 https://github.com/sleepunit-agents/loom/pull/941 loom#941','sleepunit-agents')).toMatchObject({tasks:['t-12'],prs:[{label:'loom#941'}]});
});
it('reads active episodes only and keeps absent files absent, with explicit missing conversation owner',async()=>{
 const a=source();a.add('m-visible');a.add('m-expired',{expires_at:new Date(now).toISOString()});a.add('m-archived',{archived:1});a.add('m-fact',{category:'project'});a.add('m-old',{created:'2026-10-01T00:00:00Z'});
 const missing=join(dir(),'missing.db'),app=await fixture(a.path,missing);const w=list(app);expect(w.days).toEqual(['2026-11-13','2026-11-12','2026-11-11']);expect(w.earlier).toBe('2026-11-10');expect(w.entries.map(e=>e.id)).toEqual(['e~art~m-visible']);expect(w).toMatchObject({conversations:'unavailable',episodes:'unavailable'});expect(existsSync(missing)).toBe(false);
 expect(read(app,'e~art~m-visible')).toMatchObject({value:{story:expect.stringContaining('complete story'),tasks:[{label:'t-12',href:'/p/tasks-preview/task/t-12'}],prs:[{label:'loom#941'}]}});
 expect(list(app,owner,'2026-10-14').days).toEqual(['2026-10-14']);expect(app.operations.call('direct',owner,'mind.activityList',{to:'2026-02-30'})).toMatchObject({code:'not-found'});expect(app.operations.call('direct',owner,'mind.activityList',{to:'2026-10-13'})).toMatchObject({code:'not-found'});
});
it('uses private agent policy without project scope and blocks another member’s Comms even to owner',async()=>{
 const a=source(),b=source();a.add('m-art');b.add('m-other');
 const rows=[run('dg-visible'),run('dg-private',{conversation:conv('cv-222222222222',{venue:'loom',member:'partial',label:'Partial private thread'})}),run('dg-malformed-comms',{conversation:conv('cv-333333333333',{venue:'loom',label:'No member'})})];
 a.add('m-comms',{metadata:JSON.stringify({where:'loom:thread',conversation:'cv-222222222222'})});a.add('m-mislabeled',{metadata:JSON.stringify({where:'terminal',conversation:'cv-222222222222'})});a.add('m-unknown',{metadata:JSON.stringify({where:'terminal',conversation:'cv-444444444444'})});
 const app=await fixture(a.path,b.path,role(rows));expect(list(app).entries.map(e=>e.id)).toEqual(['d~art~dg-visible','e~other~m-other']);
 expect(list(app,partial).entries.map(e=>e.id)).toEqual(expect.arrayContaining(['d~art~dg-private','d~art~dg-visible']));expect(list(app,partial).entries.some(e=>e.agent==='other')).toBe(false);
 expect(read(app,'d~art~dg-private')).toMatchObject({code:'not-found'});expect(read(app,'e~art~m-mislabeled')).toMatchObject({code:'not-found'});expect(read(app,'e~other~m-other',partial)).toMatchObject({code:'not-found'});
 expect(app.operations.call('direct',{kind:'member',id:'outsider'},'mind.activityList',{})).toMatchObject({code:'denied'});expect(list(app,{kind:'agent',id:'art'}).entries.some(e=>e.agent==='other')).toBe(false);
});
it('deduplicates moved conversations and covered episodes; readers preserve stories, refs, own needs and card-only steps',async()=>{
 const a=source();a.add('covered',{metadata:JSON.stringify({where:'terminal',conversation:'cv-111111111111'}),created:'2026-11-13T14:00:00Z'});a.add('near-duplicate',{created:'2026-11-13T17:15:00Z'});a.add('independent',{created:'2026-11-13T15:00:00Z',title:'Weekly check: all clear'});
 const rows=[run('dg-one',{needs:'Ship it?',needsHref:'/p/inbox-preview',needsForMember:'owner',more:[{id:'d~art~dg-two',at:'2026-11-12T12:00:00Z',title:'Yesterday'}]}),run('cv-111111111111',{kind:'conversation'}),run('dg-two',{at:'2026-11-12T12:00:00Z'}),run('private-run',{conversation:conv('cv-222222222222',{venue:'loom',member:'owner'}),steps:[{label:'Tool',state:'done',tool:'Read'},{label:'Internal words',state:'done',tool:'text'}]})];
 const app=await fixture(a.path,undefined,role(rows));expect(list(app).entries.map(e=>e.id)).toEqual(['d~art~dg-one','d~art~private-run','e~art~independent','d~art~dg-two']);
 expect(read(app,'d~art~dg-one')).toMatchObject({value:{asked:['Show what happened'],decided:['Use the new role'],needs:'Ship it?',links:[{label:'What it needs you for',href:'/p/inbox-preview'}],more:[{id:'d~art~dg-two'}]}});expect(read(app,'d~art~dg-one',partial)).toMatchObject({value:{links:[]}});expect((read(app,'d~art~dg-one',partial) as {value:ActivityOpen}).value.needs).toBeUndefined();expect(read(app,'d~art~private-run')).toMatchObject({value:{steps:[{label:'Tool',state:'done',tool:'Read'}]}});
 expect(read(app,'e~art~independent')).toMatchObject({value:{title:'Weekly check',line:'all clear',story:expect.any(String)}});
});
it('scrubs spawn preambles using only the new role, and extracts fallback episode parts',async()=>{
 const a=source();a.add('prompt',{title:'You are art, in a conversation on wake: Daily review.',content:'Ask: You are art, in a conversation on wake: Daily review. Its conversation is cv-111111111111\nLast said: Checked the house\nShipped: t-12; loom#941\n(fallback episode, auto-extracted)',metadata:'{"where":"terminal","conversation":"cv-111111111111"}'});
 const r=role([run('dg-one',{conversation:conv(undefined,{label:'Daily review',venue:'wake'}),at:'2026-11-10T12:00:00Z'})]);const app=await fixture(a.path,undefined,r);expect(list(app).entries[0]).toMatchObject({title:'Daily review',venue:'wakes'});expect(read(app,'e~art~prompt')).toMatchObject({value:{asked:[],story:'Checked the house',decided:['t-12','loom#941']}});expect(JSON.stringify(list(app))).not.toContain('You are art');
});
it('isolates failed and malformed role answers while retaining episodes, with a stable 600 cap',async()=>{
 const a=source();for(let i=0;i<602;i++)a.add(`m-${i}`,{created:new Date(now-i*1000).toISOString()});const r=role([]);r.list=()=>{throw Error('/private/path');};const app=await fixture(a.path,undefined,r);expect(list(app)).toMatchObject({conversations:'error',truncated:true,entries:expect.any(Array)});expect(list(app).entries).toHaveLength(600);expect(list(app).entries[0].id).toBe('e~art~m-0');expect(JSON.stringify(list(app))).not.toContain('/private/path');r.list=()=>({available:true,rows:[{no:'schema'}]}) as never;expect(list(app)).toMatchObject({conversations:'error',entries:expect.any(Array)});
});
it('updates two windows after outside writes and expiry without polling, and clears archived readers',async()=>{
 const a=source();a.add('m-one',{expires_at:new Date(now+1000).toISOString()});const app=await fixture(a.path);
 const sockets=await Promise.all(['','?partial'].map(async suffix=>{const ws=new WebSocket(app.url.replace('http:','ws:')+'/live'+suffix);closes.push(()=>ws.close());await once(ws,'open');const initial=once(ws,'message');ws.send(JSON.stringify({kind:'subscribe',type:'activity.window',scope:'recent'}));expect(JSON.parse((await initial)[0].toString()).records[0].entries).toHaveLength(1);return ws;}));
 const next=sockets.map(w=>once(w,'message'));a.add('m-two',{title:'Outside update'});app.operations.call('direct',{kind:'agent',id:'art'},'core.touched',{type:'memory',id:'art:m-two'});for(const p of next)expect(JSON.parse((await p)[0].toString()).record.entries.map((e:{title:string})=>e.title)).toContain('Outside update');
 const expired=sockets.map(w=>once(w,'message'));(app.operations.clock as FakeClock).advance(1000);for(const p of expired)expect(JSON.parse((await p)[0].toString()).record.entries.map((e:{id:string})=>e.id)).toEqual(['e~art~m-two']);
 a.db.prepare('UPDATE memories SET archived=1 WHERE ref=?').run('m-two');expect(read(app,'e~art~m-two')).toMatchObject({code:'not-found'});
});

it('authorizes conversation-only and memory-only services independently and passes the original viewer to every role method',async()=>{
 const a=source();a.add('m-later',{created:'2026-11-13T14:00:00Z'});a.add('m-named',{created:'2026-11-13T14:00:00Z',metadata:'{"conversation":"cv-111111111111","where":"terminal"}'});
 const calls:Array<{method:string;viewer:Viewer}>=[],base=role([run('dg-one')]);
 const original:ActivityConversations={list(v,q){calls.push({method:'list',viewer:v});return base.list(v,q);},read(v,a,k,id){calls.push({method:'read',viewer:v});return base.read(v,a,k,id);},conversation(v,a,id){calls.push({method:'conversation',viewer:v});return base.conversation(v,a,id);}};
 const app=await fixture(a.path,undefined,original),v:Viewer={kind:'service',id:'conversation-reader'},memory:Viewer={kind:'service',id:'memory-reader'};
 expect(list(app,v).entries.map(e=>e.id)).toEqual(['d~art~dg-one']);expect(read(app,'d~art~dg-one',v)).toMatchObject({ok:true});expect(read(app,'e~art~m-later',v)).toMatchObject({code:'not-found'});
 expect(list(app,memory).entries.map(e=>e.id)).toEqual(['e~art~m-later']);expect(read(app,'d~art~dg-one',memory)).toMatchObject({code:'not-found'});
 calls.splice(0);list(app,partial);read(app,'d~art~dg-one',partial);read(app,'e~art~m-named',partial);expect(new Set(calls.map(c=>c.method))).toEqual(new Set(['list','read','conversation']));for(const c of calls)expect(c.viewer).toBe(partial);
});
it('reports reader failures and absent owners separately from missing, retaining healthy episodes beside corrupt databases',async()=>{
 const a=source();a.add('healthy');const bad=join(dir(),'corrupt.db');writeFileSync(bad,'not a sqlite database');
 const r=role([run('dg-one')]),app=await fixture(a.path,bad,r);expect(list(app)).toMatchObject({episodes:'error'});expect(list(app).entries.some(e=>e.id==='e~art~healthy')).toBe(false); // nearby digest owns the run
 r.read=()=>{throw Error('/private/secret');};expect(read(app,'d~art~dg-one')).toMatchObject({value:{state:'error',message:'The conversation service couldn’t open this entry.'}});
 expect(read(app,'e~other~anything')).toMatchObject({value:{state:'error'}});r.list=()=>({available:true,rows:[]});expect(list(app).entries.map(e=>e.id)).toEqual(['e~art~healthy']);
 const absent=await fixture(a.path);expect(read(absent,'d~art~dg-one')).toMatchObject({value:{state:'unavailable'}});expect(read(absent,'e~art~missing')).toMatchObject({code:'not-found'});
});
it('expires an open digest at the NEW owner’s exact deadline',async()=>{
 const a=source(),rows=[run('dg-expiring',{expires:now+1000})],app=await fixture(a.path,undefined,role(rows));
 const ws=new WebSocket(app.url.replace('http:','ws:')+'/live');closes.push(()=>ws.close());await once(ws,'open');const initial=once(ws,'message');ws.send(JSON.stringify({kind:'subscribe',type:'activity.entry',scope:'d~art~dg-expiring'}));expect(JSON.parse((await initial)[0].toString()).records).toHaveLength(1);
 const expired=once(ws,'message');(app.operations.clock as FakeClock).advance(1000);expect(JSON.parse((await expired)[0].toString())).toMatchObject({kind:'del',id:'d~art~dg-expiring'});
});
it('rolls recent windows, access dates and thirty-day readers at local midnight',async()=>{
 const a=source();a.add('m-drop',{created:'2026-11-11T08:00:00Z'});a.add('m-month',{created:'2026-10-14T08:00:00Z'});const app=await fixture(a.path);
 const sockets=await Promise.all([['activity.window','recent'],['activity.access',undefined],['activity.entry','e~art~m-month']].map(async([type,scope])=>{const ws=new WebSocket(app.url.replace('http:','ws:')+'/live');closes.push(()=>ws.close());await once(ws,'open');const initial=once(ws,'message');ws.send(JSON.stringify({kind:'subscribe',type,scope}));expect(JSON.parse((await initial)[0].toString()).records).toHaveLength(1);return ws;}));
 const next=sockets.map(ws=>once(ws,'message'));(app.operations.clock as FakeClock).advance(startOf('2026-11-14','America/Chicago')-now);
 expect(JSON.parse((await next[0])[0].toString()).record).toMatchObject({days:['2026-11-14','2026-11-13','2026-11-12'],entries:[]});expect(JSON.parse((await next[1])[0].toString()).record.today).toBe('2026-11-14');expect(JSON.parse((await next[2])[0].toString())).toMatchObject({kind:'del',id:'e~art~m-month'});
});
it('suppresses normalized conversation ids from prompt content even without metadata outside the nearby-run heuristic',async()=>{
 const a=source();a.add('prompt',{title:'You are art, in a conversation on terminal: House work.',content:'Ask: You are art, in a conversation on terminal: House work. Its conversation is cv-111111111111',metadata:'{}',created:'2026-11-13T12:00:00Z'});
 const app=await fixture(a.path,undefined,role([run('dg-one')]));expect(list(app).entries.map(e=>e.id)).toEqual(['d~art~dg-one']);
});

it('preserves contextual venue labels and a canonical NEW memory reader destination',async()=>{
 const a=source();a.add('m-slack',{created:'2026-11-13T12:00:00Z',metadata:'{"where":"slack:dm:patrick-kells"}'});const app=await fixture(a.path,undefined,role([run('dg-discord',{conversation:conv(undefined,{venue:'discord',label:'#household'})})]));
 expect(list(app).entries.find(e=>e.id==='d~art~dg-discord')?.where).toBe('Discord #household');expect(read(app,'e~art~m-slack')).toMatchObject({value:{where:'Slack DM · Patrick Kells',links:[{label:'The memory',href:'/p/activity-preview/memory/art%3Am-slack'}]}});
});
it('keeps the startup source inventory fixed when an absent path later appears',async()=>{
 const a=source(),missing=join(dir(),'later.db'),app=await fixture(a.path,missing);a.add('m-known');const later=source(missing);later.add('m-later');app.operations.call('direct',{kind:'agent',id:'art'},'core.touched',{type:'memory',id:'art:m-known'});expect(list(app)).toMatchObject({episodes:'unavailable'});expect(list(app).entries.map(e=>e.id)).toEqual(['e~art~m-known']);expect(read(app,'e~other~m-later')).toMatchObject({value:{state:'unavailable'}});
});
it.each(['conversation','digest','comms.thread'])('refreshes windows and open readers on NEW %s role events',async type=>{
 const a=source(),rows=[run('dg-live')],app=await fixture(a.path,undefined,role(rows));
 const sockets=await Promise.all([['activity.window','recent'],['activity.entry','d~art~dg-live']].map(async([type,scope])=>{const ws=new WebSocket(app.url.replace('http:','ws:')+'/live');closes.push(()=>ws.close());await once(ws,'open');const initial=once(ws,'message');ws.send(JSON.stringify({kind:'subscribe',type,scope}));await initial;return ws;}));
 const next=sockets.map(ws=>once(ws,'message'));rows[0].summary='Updated by NEW owner.';app.live.changed([{type,id:'dg-live'}]);expect(JSON.parse((await next[0])[0].toString()).record.entries[0].line).toBe('Updated by NEW owner.');expect(JSON.parse((await next[1])[0].toString()).record.story).toBe('Updated by NEW owner.');
});

it('withdraws an open named episode at its conversation expiry and reports lookup failures as source errors',async()=>{
 const a=source();a.add('named',{metadata:'{"conversation":"cv-111111111111","where":"slack:#house"}'});const r=role([run('dg-one',{conversation:conv(undefined,{expires:now+1000})})]),app=await fixture(a.path,undefined,r);
 const ws=new WebSocket(app.url.replace('http:','ws:')+'/live');closes.push(()=>ws.close());await once(ws,'open');const initial=once(ws,'message');ws.send(JSON.stringify({kind:'subscribe',type:'activity.entry',scope:'e~art~named'}));expect(JSON.parse((await initial)[0].toString()).records[0].expires).toBe(now+1000);
 const expired=once(ws,'message');(app.operations.clock as FakeClock).advance(1000);expect(JSON.parse((await expired)[0].toString())).toMatchObject({kind:'del',id:'e~art~named'});
 r.conversation=()=>{throw Error('private path');};expect(read(app,'e~art~named')).toMatchObject({value:{state:'error'}});
});

it('keeps an earlier conversation error when another agent’s role is unavailable',async()=>{
 const a=source(),b=source(),r=role([]);r.list=(_v,q)=>{if(q.agent==='art')throw Error('unreadable');return {available:false,rows:[]};};const app=await fixture(a.path,b.path,r);expect(list(app).conversations).toBe('error');
});
it('includes an independent moved conversation and opens its no-digest reader',async()=>{
 const a=source(),r=run('cv-111111111111',{kind:'conversation',summary:undefined,turns:3,replies:1,asked:[],decided:[],tasks:[]}),app=await fixture(a.path,undefined,role([r]));
 expect(list(app).entries).toMatchObject([{id:'c~art~cv-111111111111',title:'Build the household',line:'3 turns, 1 reply, no summary yet'}]);expect(read(app,'c~art~cv-111111111111')).toMatchObject({value:{id:'c~art~cv-111111111111',asked:[],decided:[],tasks:[],more:[]}});
});
