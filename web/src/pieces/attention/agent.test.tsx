import { deskWaitingFixture } from '../../../../src/ui/desk-waiting.fixture';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {createElement as h, useMemo,useSyncExternalStore} from 'react';
// @ts-expect-error Existing renderer dependency has no declarations.
import {act,create} from 'react-test-renderer';
import type {Snapshot} from '../../data';
// `extra`: whole answers for the page's own per-agent requests, by a word of the document's name.
const f=vi.hoisted(()=>({snapshots:{} as Record<string,Snapshot<any>>,extra:{} as Record<string,{status:string;data?:any}>,listeners:new Set<()=>void>(),call:vi.fn()}));
function homeFixture() {
 const snapshot=f.snapshots.thread;
 return {status:snapshot.status,data:{homeComms:{member:'owner',agents:f.snapshots['attention.ownedAgent'].records.map((a:any)=>a.id),summaries:f.snapshots['attention.ownedAgent'].records.map((a:any)=>{
  const recent=snapshot.records.filter((t:any)=>t.agent===a.id&&t.archived===null).sort((a:any,b:any)=>b.last-a.last||a.id.localeCompare(b.id));
  const last=recent[0],first=recent.find((t:any)=>t.unread);
  return {agent:a.id,unread:recent.filter((t:any)=>t.unread).length,last:last?{thread:last.id,title:last.title??'',at:new Date(last.last).toISOString()}:null,first:first?{thread:first.id}:null};
 })}}};
}
vi.mock('./agent-status',()=>({useDeskAgentStatuses:()=>useSyncExternalStore(fn=>{f.listeners.add(fn);return()=>{f.listeners.delete(fn);};},()=>f.snapshots['attention.agent'])}));
vi.mock('../../data/graphql',()=>({useDataQuery:(document:string,variables?:Record<string,any>)=>{const extra=Object.keys(f.extra).find(key=>document.includes(key));useSyncExternalStore(fn=>{f.listeners.add(fn);return()=>{f.listeners.delete(fn);};},()=>extra?f.extra[extra]:document.includes('DeskWaiting')||document.includes('DeskAgentWaiting')?f.snapshots['attention.ask']:document.includes('DeskAgentDisplays')?f.snapshots['household.agentDisplay']:document.includes('DeskAgentProfiles')?f.snapshots['household.profile']:document.includes('MemoryActivity')?f.snapshots['activity.window']:document.includes('DeskAgentDirectory')?f.snapshots.person:document.includes('DeskHomeComms')?f.snapshots.thread:f.snapshots['attention.ownedAgent']);return useMemo(()=>extra?f.extra[extra]:document.includes('DeskWaiting')||document.includes('DeskAgentWaiting')?deskWaitingFixture(document,variables,f.snapshots['attention.ask'],'owner'):document.includes('DeskAgentDisplays')?{status:f.snapshots['household.agentDisplay'].status,data:{agents:f.snapshots['household.agentDisplay'].records.map((r:any)=>({id:r.id,markBg:r.mark.bg,markFg:r.mark.fg,faceShape:r.face.shape,faceEyes:r.face.eyes}))}}:document.includes('DeskAgentProfiles')?{status:f.snapshots['household.profile'].status,data:{agents:f.snapshots['household.profile'].records.map((p:any)=>({id:p.agent,about:p.description??'',aboutAskedAt:p.requestedAt??null}))}}:document.includes('MemoryActivity')?{status:f.snapshots['activity.window'].status,data:{memoryActivity:f.snapshots['activity.window'].records[0]??null}}:document.includes('DeskAgentDirectory')?{status:f.snapshots.person.status,data:{memoryPeopleAccess:{directory:true},memoryPeople:f.snapshots.person.records.map((p:any)=>({...p,agent:p.agent??null}))}}:document.includes('DeskHomeComms')?homeFixture():({status:f.snapshots['attention.ownedAgent'].status,data:{homeComms:{member:'owner',agents:(f.snapshots['attention.ownedAgent']?.records??[]).map((a:any)=>a.id)},agents:(f.snapshots['attention.ownedAgent']?.records??[]).map((a:any)=>({id:a.id,position:a.position??0}))}}),[f.snapshots['attention.ask'],f.snapshots['household.agentDisplay'],f.snapshots['household.profile'],f.snapshots['activity.window'],f.snapshots.person,f.snapshots.thread,f.snapshots['attention.ownedAgent'],document,variables?.agent,extra&&f.extra[extra]]);}}));
vi.mock('../../data',()=>({useRecords:(type:string)=>(expect(['attention.ask','household.agentDisplay','household.profile','activity.window','person','thread','attention.agent','attention.ownedAgent']).not.toContain(type),useSyncExternalStore(fn=>{f.listeners.add(fn);return()=>{f.listeners.delete(fn);};},()=>f.snapshots[type])),call:f.call,callOnce:f.call}));
vi.mock('../../lib/cojeev-motion/use-reduced-motion',()=>({useReducedMotion:()=>true}));
import AgentApp from './agent';
(globalThis as typeof globalThis & {IS_REACT_ACT_ENVIRONMENT:boolean}).IS_REACT_ACT_ENVIRONMENT=true;
let tree:ReturnType<typeof create>|undefined;
const live=(records:object[])=>({records,status:'live' as const});
const text=()=>JSON.stringify(tree!.toJSON());
const words=(node:any):string=>typeof node==='string'?node:(node.children??[]).map(words).join('');
const click=async(title:string)=>act(async()=>tree!.root.findAllByType('button').find((n:any)=>words(n).startsWith(title)).props.onClick());
const draw=async(path='/p/agents-preview/agent/art')=>{const go=vi.fn();await act(async()=>{tree=create(h(AgentApp,{path,go}));});return go;};
async function answer(key:string,value:{status:string;data?:any}){await act(async()=>{f.extra={...f.extra,[key]:value};f.listeners.forEach(fn=>fn());});}
async function publish(type:string,status:Snapshot<any>['status'],records:object[]){await act(async()=>{f.snapshots[type]={status,records};f.listeners.forEach(fn=>fn());});}
beforeEach(()=>{f.call.mockClear();f.listeners.clear();f.extra={DeskDoingAll:{status:'live',data:{agentDoing:{items:[],more:0}}},DeskCardTalk:{status:'live',data:{recent:[],answered:[]}},DeskAgentJobs:{status:'live',data:{jobHistory:[],boxes:[]}}};f.snapshots={
 'attention.ownedAgent':live([{id:'art',name:'Art'},{id:'mark',name:'Mark'}]),
 person:live([{id:'commons:art',slug:'art',kind:'agent',name:'Art E Fish'}]),
 'household.profile':live([{id:'art',agent:'art',description:'Keeps the household moving.',canEdit:true},{id:'foreign',agent:'foreign',description:'Private foreign profile',canEdit:true}]),
 'household.agentDisplay':live([]),'activity.window':live([]),
 'attention.agent':live([{id:'status',agent:'art',state:'working',work:'Checking the desk',changedAt:1}]),
 'attention.ask':live([{id:'question',agent:'art',state:'open',ask:'Ship the desk?',why:'Ready to test',createdAt:1}]),
 thread:live([{id:'th:latest',agent:'art',archived:null,unread:false,last:3},{id:'th:unread',agent:'art',archived:null,unread:true,last:1}]),
};});
afterEach(async()=>{await act(async()=>tree?.unmount());tree=undefined;});
it('opens one owned agent with real profile/status and routes each deeper action to its owning app',async()=>{
 const go=await draw();expect(text()).not.toContain('Edit profile in Setup');expect(text()).toContain('Art E Fish agent window');expect(text()).toContain('Keeps the household moving.');expect(text()).toContain('Checking the desk');expect(text()).not.toContain('Private foreign profile');
 for(const [title,path] of [['Ship the desk?','/p/inbox-preview/ask/question'],['Conversation','/p/comms-preview/thread/unread'],['Activity','/p/activity-preview/?who=art'],['People','/p/people-preview/person/art']]){await click(title);expect(go).toHaveBeenLastCalledWith(path);}
 expect(f.call).not.toHaveBeenCalled();
});
it.each(['foreign','%ZZ'])('does not expand an unowned or malformed addressed agent: %s',async(id)=>{
 await draw('/p/agents-preview/agent/'+id);expect(text()).toContain('Agent not available');expect(text()).not.toContain('Private foreign profile');expect(text()).not.toContain('Keeps the household moving.');expect(text()).not.toContain('Ship the desk?');
});
it('withdraws profile, work, questions and navigation capabilities as each source is lost',async()=>{
 await draw();await publish('household.profile','offline',f.snapshots['household.profile'].records);expect(text()).not.toContain('Keeps the household moving.');expect(text()).not.toContain('Edit profile in Setup');expect(tree!.root.findAllByProps({'aria-label':'About'})).toHaveLength(0);
 await publish('attention.agent','denied',f.snapshots['attention.agent'].records);expect(text()).not.toContain('Checking the desk');expect(tree!.root.findAllByProps({'aria-label':'Its own report'})).toHaveLength(0);
 await publish('attention.ask','offline',f.snapshots['attention.ask'].records);expect(text()).not.toContain('Ship the desk?');expect(text()).toContain('Can’t tell what is waiting on you right now.');
 await publish('attention.ownedAgent','offline',f.snapshots['attention.ownedAgent'].records);expect(text()).not.toContain('Art E Fish agent window');expect(text()).toContain('Your agents are unavailable');
});
it('does not infer profile edit permission and replaces an unread target when thread records disappear',async()=>{
 const go=await draw();await publish('household.profile','live',[{id:'art',agent:'art',canEdit:false}]);expect(text()).not.toContain('Edit profile in Setup');expect(tree!.root.findAllByProps({'aria-label':'About'})).toHaveLength(0);
 await publish('thread','offline',f.snapshots.thread.records);await click('Conversation');expect(go).toHaveBeenLastCalledWith('/p/comms-preview');
});

it('holds everything about one agent in full: what it is doing, its jobs, its last answer, its conversations and its steps',async()=>{
 const item=(id:string,fields:object)=>({id,title:null,with:null,place:null,direct:null,ref:null,machine:null,since:'2026-11-14T18:00:00Z',state:'running',href:null,...fields});
 f.extra.DeskDoingAll={status:'live',data:{agentDoing:{more:0,items:[...Array.from({length:10},(_,n)=>item(`j-${n}`,{kind:'job',title:`Job ${n}`})),item('t-7',{kind:'task',title:'Order the pump',ref:'t-7',href:'/p/tasks-preview/task/t-7'})]}}};
 f.extra.DeskAgentJobs={status:'live',data:{boxes:[{id:'box-one',name:'one'}],jobHistory:[
  {id:'j-now',agent:'art',title:'Compare pumps',state:'running',box:'box-one',queuedAt:'2026-11-14T18:00:00Z',claimedAt:'2026-11-14T18:01:00Z',endedAt:null},
  {id:'j-wait',agent:'art',title:'Order hose',state:'queued',box:null,queuedAt:'2026-11-14T18:05:00Z',claimedAt:null,endedAt:null},
  {id:'j-old',agent:'art',title:'Drain the pond',state:'done',box:'box-hidden',queuedAt:'2026-11-13T18:00:00Z',claimedAt:'2026-11-13T18:01:00Z',endedAt:'2026-11-13T19:00:00Z'},
  {id:'j-other',agent:'mark',title:'Not Art’s job',state:'running',box:null,queuedAt:'2026-11-14T18:00:00Z',claimedAt:null,endedAt:null}]}};
 const talk=(id:string,fields:object={})=>({id,agent:'art',label:`Talk ${id}`,venue:'loom',place:`th:${id}`,lastAt:`2026-11-14T0${id}:00:00Z`,...fields});
 f.extra.DeskCardTalk={status:'live',data:{recent:[1,2,3,4,5].map(n=>talk(String(n))),answered:[talk('2',{lastAnswer:{at:'2026-11-14T02:00:00Z',words:'Line one\nLine two\nLine three\nLine four\nLine five'}})]}};
 const entry=(id:string,agent='art')=>({id,agent,at:'2026-11-13T18:00:00Z',day:'2026-11-13',hour:12,title:`Step ${id}`,line:'What landed',venue:'terminal',where:'Terminal',what:'work'});
 f.snapshots['activity.window']=live([{id:'recent',to:'2026-11-13',days:['2026-11-13'],entries:[entry('a'),entry('b'),entry('c'),entry('d'),entry('private','other')],conversations:'available',episodes:'available',truncated:false,expires:1}]);
 const go=await draw(),section=(label:string)=>tree!.root.findByProps({'aria-label':label});
 // The page asks for the whole list, not Home's first eight.
 expect(section('What Art E Fish is doing').findAllByProps({className:'desk-doing-phrase'}).map(words)).toHaveLength(11);expect(words(section('Doing now'))).not.toContain(' more');
 await act(async()=>section('What Art E Fish is doing').findByType('a').props.onClick({button:0,preventDefault(){}}));expect(go).toHaveBeenLastCalledWith('/p/tasks-preview/task/t-7');
 expect(words(tree!.root.findByProps({'aria-label':'Art E Fish agent window'}).findAllByProps({className:'loom-reader__meta '})[0])).toBe('Working · 1 needs you');
 // Jobs: one name, the ones running now first with their machine and times, then the earlier ones.
 expect(section('Art E Fish jobs now').findAllByProps({className:'loom-kit-title'}).map(words)).toEqual(['Compare pumps','Order hose']);
 expect(words(section('Art E Fish jobs now'))).toMatch(/Running · on one · queued Nov 14, \d+:\d\d [AP]M · started Nov 14, \d+:\d\d [AP]M/);expect(words(section('Art E Fish jobs now'))).toMatch(/Queued · queued Nov 14, \d+:\d\d [AP]M/);
 expect(words(section('Art E Fish earlier jobs'))).toMatch(/Drain the pond.*Done · queued Nov 13, .* · started Nov 13, .* · ended Nov 13, \d+:\d\d [AP]M/);expect(text()).not.toContain('box-hidden');expect(text()).not.toContain('Not Art’s job');
 expect(text()).not.toMatch(/Runtime jobs|Current jobs/);
 // The last answer whole, and where it was said.
 expect(words(section('Last answer'))).toContain('Line one\nLine two\nLine three\nLine four\nLine five');
 await click('Open the conversation');expect(go).toHaveBeenLastCalledWith('/p/comms-preview/thread/2');
 // More conversations than Home's three, newest first, the unread one marked, and the way to all of them.
 const rows=section('Art E Fish conversations').findAllByType('button');
 expect(rows.map((n:any)=>words(n.findByProps({className:'loom-kit-title'})))).toEqual(['Talk 5','Talk 4','Talk 3','Talk 2','Talk 1']);
 await act(async()=>rows[0].props.onClick());expect(go).toHaveBeenLastCalledWith('/p/comms-preview/thread/5');
 await click('All conversations in Comms');expect(go).toHaveBeenLastCalledWith('/p/comms-preview');
 // Steps live here now.
 const steps=section('Art E Fish recent steps').findAllByType('button');expect(steps.map((n:any)=>words(n.findByProps({className:'loom-kit-title'})))).toEqual(['Step a','Step b','Step c','Step d']);
 await act(async()=>steps[0].props.onClick());expect(go).toHaveBeenLastCalledWith('/p/activity-preview/?who=art&e=a&day=2026-11-13');expect(text()).not.toContain('Step private');
 for(const label of ['Doing now','About','Its own report','Needs you','Jobs','Last answer','Conversations · 1 unread','Last steps','Explore'])expect(section(label).type).toBe('section');
 expect(f.call).not.toHaveBeenCalled();
});
it('says plainly what it cannot read, and shows no last answer and no stale words then',async()=>{
 f.extra.DeskCardTalk={status:'live',data:{recent:[],answered:[{id:'1',agent:'art',venue:'loom',place:'th:1',lastAnswer:{at:'2026-11-14T02:00:00Z',words:'Private retained words'}}]}};
 f.extra.DeskAgentJobs={status:'live',data:{boxes:[],jobHistory:[{id:'j',agent:'art',title:'Private job title',state:'running',box:null,queuedAt:'2026-11-14T18:00:00Z',claimedAt:null,endedAt:null}]}};
 f.extra.DeskDoingAll={status:'live',data:{agentDoing:{more:0,items:[{id:'j',kind:'job',title:'Private job title',with:null,place:null,direct:null,ref:null,machine:null,since:'2026-11-14T18:00:00Z',state:'running',href:null}]}}};
 await draw();expect(text()).toContain('Private retained words');expect(text()).toContain('Private job title');
 for(const status of ['loading','offline','denied'])for(const key of ['DeskCardTalk','DeskAgentJobs','DeskDoingAll'])await answer(key,{...f.extra[key],status});
 expect(text()).not.toContain('Private retained words');expect(text()).not.toContain('Private job title');
 expect(tree!.root.findAllByProps({'aria-label':'Last answer'})).toHaveLength(0);
 expect(text()).toContain('Can’t read jobs right now.');expect(text()).toContain('Can’t read conversations right now.');expect(text()).toContain('Can’t tell what it is doing right now.');
 await answer('DeskCardTalk',{status:'live',data:{recent:[],answered:[]}});expect(tree!.root.findAllByProps({'aria-label':'Last answer'})).toHaveLength(0);expect(text()).not.toMatch(/No retained agent answer|Answer unavailable/);
});
