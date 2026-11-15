import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createElement as h, useMemo, useSyncExternalStore } from 'react';
// @ts-expect-error Existing renderer has no declarations.
import { act, create } from 'react-test-renderer';
import type { Snapshot } from '../../data';
const f=vi.hoisted(()=>({snapshots:{} as Record<string,Snapshot<any>>,listeners:new Set<()=>void>(),queryStatus:"live" as "live"|"offline"|"denied"}));
function homeFixture() {
 const snapshot=f.snapshots.thread;
 return {status:snapshot.status,data:{homeComms:{member:'owner',agents:f.snapshots['attention.ownedAgent'].records.map((a:any)=>a.id),summaries:f.snapshots['attention.ownedAgent'].records.map((a:any)=>{
  const recent=snapshot.records.filter((t:any)=>t.agent===a.id&&t.archived===null).sort((a:any,b:any)=>b.last-a.last||a.id.localeCompare(b.id));
  const last=recent[0],first=recent.find((t:any)=>t.unread);
  return {agent:a.id,unread:recent.filter((t:any)=>t.unread).length,last:last?{thread:last.id,title:last.title??'',at:new Date(last.last).toISOString()}:null,first:first?{thread:first.id}:null};
 })}}};
}
vi.mock('./agent-status',()=>({useDeskAgentStatuses:()=>useSyncExternalStore(fn=>{f.listeners.add(fn);return()=>{f.listeners.delete(fn);};},()=>f.snapshots['attention.agent'])}));
vi.mock('../../data/graphql',()=>({useDataQuery:(document:string,variables?:{agent:string})=>{useSyncExternalStore(fn=>{f.listeners.add(fn);return()=>{f.listeners.delete(fn);};},()=>document.includes('DeskAgentDirectory')?f.snapshots.person:document.includes('DeskRoster')?f.snapshots['attention.ownedAgent']:document.includes('DeskHomeComms')?f.snapshots.thread:f.snapshots['generated.jobs']);return useMemo(()=>document.includes('DeskAgentDirectory')?{status:f.snapshots.person.status,data:{memoryPeopleAccess:{directory:true},memoryPeople:f.snapshots.person.records.map((p:any)=>({...p,agent:p.agent??null}))}}:document.includes('DeskHomeComms')?homeFixture():document.includes('DeskCurrentJobs')?{status:f.snapshots['generated.jobs'].status,data:{currentJobs:f.snapshots['generated.jobs'].records.filter((row:any)=>row.agent===variables?.agent)}}:({status:f.snapshots['attention.ownedAgent'].status!=='live'?f.snapshots['attention.ownedAgent'].status:f.queryStatus,data:{homeComms:{member:'owner',agents:(f.snapshots['attention.ownedAgent']?.records??[]).map((a:any)=>a.id)},agents:(f.snapshots['attention.ownedAgent']?.records??[]).map((a:any)=>({id:a.id,position:a.position??0}))}}),[f.snapshots.person,f.snapshots.thread,f.snapshots['attention.ownedAgent'],f.snapshots['generated.jobs'],f.snapshots['conversation.summary'],document,variables?.agent,f.queryStatus]);}}));
vi.mock('../../data',()=>({useRecords:(type:string)=>(expect(['person','thread','attention.agent','attention.ownedAgent']).not.toContain(type),useSyncExternalStore(fn=>{f.listeners.add(fn);return()=>{f.listeners.delete(fn);};},()=>f.snapshots[type]))}));
import Rail from './rail';
import { RailContext } from '../../desk-rail';
import DeskSignals from './desk-signals';
(globalThis as typeof globalThis & {IS_REACT_ACT_ENVIRONMENT:boolean}).IS_REACT_ACT_ENVIRONMENT=true;
let tree:ReturnType<typeof create>;
const live=(records:object[])=>({records,status:'live' as const});
const text=()=>JSON.stringify(tree.toJSON());
async function publish(type:string,status:Snapshot['status'],records=f.snapshots[type].records){await act(async()=>{f.snapshots[type]={status,records};f.listeners.forEach(fn=>fn());});}
let events:EventTarget;
beforeEach(()=>{f.queryStatus='live';events=new EventTarget();vi.stubGlobal('addEventListener',events.addEventListener.bind(events));vi.stubGlobal('removeEventListener',events.removeEventListener.bind(events));f.listeners.clear();f.snapshots={
 'attention.ownedAgent':live([{id:'mark',name:'Mark'},{id:'art',name:'Art'}]),
 'household.agentDisplay':live([]),'generated.jobs':live([]),
 'person':live([]),'attention.ask':live([{id:'first',ask:'Proceed with backup?',agent:'art',state:'open',createdAt:1}]),
 'attention.agent':live([{id:'report',agent:'art',state:'working',work:'Checking the backup',changedAt:1}]),
 'thread':live([{id:'th:abc',agent:'art',title:'Unread conversation',unread:true,last:1,archived:null},{id:'th:recent',agent:'art',title:'Newest read thread',unread:false,last:2,archived:null}]),
};});
afterEach(async()=>{await act(async()=>tree?.unmount());vi.unstubAllGlobals();});
it('keeps only the owned roster in saved order, opens the first unread thread and reads full asks in Inbox',async()=>{
 const go=vi.fn();await act(async()=>{tree=create(h(Rail,{go}));});
 expect(tree.root.findAllByType('section').map((n:any)=>n.props['data-agent'])).toEqual(['art','mark']);
 expect(text()).toContain('Checking the backup');expect(text()).toContain('1 unread thread');
 await act(async()=>tree.root.findByProps({'aria-label':'Open Art conversation'}).props.onClick());expect(go).toHaveBeenLastCalledWith('/p/comms-preview/thread/abc');
 await act(async()=>tree.root.findByProps({className:'desk-rail-ask'}).props.onClick());expect(go).toHaveBeenLastCalledWith('/p/inbox-preview/ask/first');
 await publish('attention.ownedAgent','live',[{id:'mark',name:'Mark'}]);expect(text()).not.toContain('Art conversation');expect(text()).not.toContain('Checking the backup');
});
it.each(['offline','denied','loading'] as const)('drops stale names, asks, work and private thread metadata on %s',async(status)=>{
 f.snapshots.person=live([{id:'commons:art',slug:'art',kind:'agent',name:'Directory name'}]);
 await act(async()=>{tree=create(h(Rail,{go:vi.fn()}));});expect(text()).toContain('Directory name');
 for(const type of ['person','attention.ask','attention.agent','thread'])await publish(type,status);
 for(const word of ['Directory name','Proceed with backup?','Checking the backup','Unread conversation','1 unread thread','All clear.'])expect(text()).not.toContain(word);
 expect(text()).toContain('Art rail card');expect(text()).toContain('Conversations unavailable');
 await publish('attention.ownedAgent',status);expect(text()).not.toContain('Art rail card');
});

it('folds measured overflow, keeps current working state before asks/unread, and unfolds when room returns',async()=>{
 const element={clientWidth:296,clientHeight:120,scrollHeight:700};let resize:()=>void=()=>{};
 vi.stubGlobal('document',{fonts:undefined});
 vi.stubGlobal('ResizeObserver',class{constructor(fn:()=>void){resize=fn;}observe(){}disconnect(){}});
 try {
  const go=vi.fn();
  await act(async()=>{tree=create(h(Rail,{go}),{createNodeMock:(node:any)=>node.props.className==='desk-agent-rail'?element:null});});
  expect(tree.root.findByProps({className:'desk-agent-rail'}).props['data-fold']).toBe(true);
  expect(tree.root.findByProps({className:'desk-rail-card'}).props['data-agent']).toBe('art');
  expect(tree.root.findByProps({className:'desk-rail-compact'}).props['data-agent']).toBe('mark');
  // Current working state takes priority over Art's ask.
  await publish('attention.agent','live',[{id:'mark',agent:'mark',state:'working',work:'In flight',changedAt:2}]);
  expect(tree.root.findByProps({className:'desk-rail-card'}).props['data-agent']).toBe('mark');
  await act(async()=>tree.root.findByProps({'aria-label':'Open Art conversation'}).props.onClick());
  expect(go).toHaveBeenLastCalledWith('/p/comms-preview/thread/abc');
  // Conversation loss clears unread independently; status loss clears working priority.
  await publish('thread','offline');
  await publish('attention.agent','offline');
  expect(tree.root.findByProps({className:'desk-rail-card'}).props['data-agent']).toBe('art');
  expect(text()).not.toContain('1 unread thread');expect(text()).toContain('Conversations unavailable');
  element.clientHeight=900;await act(async()=>resize());
  expect(tree.root.findByProps({className:'desk-agent-rail'}).props['data-fold']).toBeUndefined();
  expect(tree.root.findAllByProps({className:'desk-rail-card'})).toHaveLength(2);
  element.clientHeight=120;await act(async()=>resize());
  expect(tree.root.findAllByProps({className:'desk-rail-compact'})).toHaveLength(1);
  // A content shrink also retries full cards, without waiting for a viewport resize.
  element.scrollHeight=80;await publish('attention.ownedAgent','live',[{id:'art',name:'Art'}]);
  expect(tree.root.findByProps({className:'desk-agent-rail'}).props['data-fold']).toBeUndefined();
 } finally {await act(async()=>tree.unmount());vi.unstubAllGlobals();}
});

it('reports only live attention and opens agents in saved order by shortcut while typing',async()=>{
 const go=vi.fn(),onAttention=vi.fn();await act(async()=>{tree=create(h(DeskSignals,{go,onAttention}));});
 expect(onAttention).toHaveBeenLastCalledWith(true);
 const press=(code:string)=>{const event=new Event('keydown',{cancelable:true});Object.assign(event,{code,ctrlKey:true,shiftKey:true});return event;};
 const first=press('Digit1');await act(async()=>{events.dispatchEvent(first);});
 expect(first.defaultPrevented).toBe(true);expect(go).toHaveBeenLastCalledWith('/p/comms-preview/thread/abc');
 await publish('thread','offline');await publish('attention.ask','denied');
 expect(onAttention).toHaveBeenLastCalledWith(false);
 await act(async()=>{events.dispatchEvent(press('Digit1'));});expect(go).toHaveBeenLastCalledWith('/p/comms-preview');
 await publish('attention.ownedAgent','offline');go.mockClear();
 await act(async()=>{events.dispatchEvent(press('Digit1'));});expect(go).not.toHaveBeenCalled();
});

it('puts the selected owned Comms companion above Needs you and returns it to saved order',async()=>{
 const go=vi.fn(),onAir=vi.fn();const view=(selected?:string)=>h(RailContext.Provider,{value:{onAir,shown:true,screen:null,selected}},h(Rail,{go}));
 await act(async()=>{tree=create(view('mark'));});
 expect(tree.root.findAllByType('section').map((n:any)=>n.props['data-agent'])).toEqual(['mark','art']);
 expect(tree.root.findByProps({className:'desk-rail-kicker desk-rail-with'}).children.join('')).toBe('With Mark in Comms');
 await act(async()=>tree.update(view()));
 expect(tree.root.findAllByType('section').map((n:any)=>n.props['data-agent'])).toEqual(['art','mark']);
 expect(tree.root.findAllByProps({className:'desk-rail-kicker desk-rail-with'})).toHaveLength(0);
 await act(async()=>tree.update(view('unowned')));expect(text()).not.toContain('in Comms');
 await act(async()=>tree.update(view('mark')));await publish('attention.ownedAgent','denied');
 expect(text()).not.toContain('in Comms');expect(text()).not.toContain('Mark rail card');
});

it('lists each agent current jobs and drops stale jobs when disconnected',async()=>{
 f.snapshots['generated.jobs']=live([
  {id:'j:running',agent:'art',title:'Compare pumps',state:'running',box:'workbench',queuedAt:'2026-11-14T01:00:00Z'},
  {id:'j:queued',agent:'art',title:'Order hose',state:'queued',box:'workbench',queuedAt:'2026-11-14T02:00:00Z'},
  {id:'j:other',agent:'other',title:'Other agent job',state:'running',box:'workbench',queuedAt:'2026-11-14T03:00:00Z'},
 ]);
 const go=vi.fn();await act(async()=>{tree=create(h(Rail,{go}));});
 const jobs=()=>tree.root.findByProps({'aria-label':'Art current jobs'});
 expect(jobs().findAllByType('li').map((n:any)=>n.findByType('strong').children[0])).toEqual(['Compare pumps','Order hose']);
 expect(text()).not.toContain('Other agent job');
 await publish('generated.jobs','offline');expect(text()).not.toContain('Compare pumps');expect(text()).toContain('Jobs unavailable');
 await publish('generated.jobs','live',[]);expect(text()).toContain('No current jobs.');
});
it('uses saved positions for rail cards and keyboard shortcuts after a live reorder',async()=>{
 const go=vi.fn();
 f.snapshots['attention.ownedAgent']=live([{id:'art',name:'Art',position:4},{id:'mark',name:'Mark',position:1}]);
 await act(async()=>{tree=create(h('div',null,h(Rail,{go}),h(DeskSignals,{go,onAttention:vi.fn()})));});
 const order=()=>tree.root.findAllByType('section').map((n:any)=>n.props['data-agent']).filter(Boolean);
 expect(order()).toEqual(['mark','art']);
 const shortcut=()=>{const event=new Event('keydown',{cancelable:true});Object.assign(event,{ctrlKey:true,shiftKey:true,altKey:false,metaKey:false,code:'Digit1'});events.dispatchEvent(event);};
 await act(async()=>shortcut());expect(go).toHaveBeenLastCalledWith('/p/comms-preview');
 await publish('attention.ownedAgent','live',[{id:'art',name:'Art',position:0},{id:'mark',name:'Mark',position:1}]);
 expect(order()).toEqual(['art','mark']);
 await act(async()=>shortcut());expect(go).toHaveBeenLastCalledWith('/p/comms-preview/thread/abc');
});

it.each(['offline','denied'] as const)('clears rail details and shortcuts when generated directory is %s, then accepts fresh order',async status=>{
 const go=vi.fn();await act(async()=>{tree=create(h('div',null,h(Rail,{go}),h(DeskSignals,{go,onAttention:vi.fn()})));});
 expect(text()).toContain('Art rail card');
 f.queryStatus=status;
 await publish('attention.ownedAgent','live');
 expect(text()).not.toContain('Art rail card');expect(text()).not.toContain('Checking the backup');
 const event=new Event('keydown',{cancelable:true});Object.assign(event,{ctrlKey:true,shiftKey:true,altKey:false,metaKey:false,code:'Digit1'});
 go.mockClear();await act(async()=>events.dispatchEvent(event));expect(go).not.toHaveBeenCalled();
 f.queryStatus='live';await publish('attention.ownedAgent','live',[{id:'mark',name:'Mark',position:0}]);
 expect(text()).toContain('Mark rail card');expect(text()).not.toContain('Art rail card');
});

it('shows the first waiting item and how many more, updates on answers, and clears disconnected counts',async()=>{
 const first=f.snapshots['attention.ask'].records[0];
 f.snapshots['attention.ask']=live([first,
  {...first,id:'second',ask:'Order the pump?',createdAt:2},
  {...first,id:'third',agent:'mark',ask:'Book the electrician?',createdAt:3},
  {...first,id:'answered',ask:'Already answered',state:'answered',createdAt:0},
 ]);
 await act(async()=>{tree=create(h(Rail,{go:vi.fn()}));});
 const needs=()=>tree.root.findByProps({className:'desk-rail-needs'});
 const ask=()=>tree.root.findAllByProps({className:'desk-rail-ask'})[0];
 expect(JSON.stringify(needs().children.map((n:any)=>typeof n==='string'?n:n.children))).toContain('2 more');
 expect(JSON.stringify(ask().children.map((n:any)=>typeof n==='string'?n:n.children))).toContain('1 more');
 expect(text()).not.toContain('Already answered');
 await publish('attention.ask','live',[{...first,state:'answered'}]);
 expect(text()).not.toContain(' more');expect(text()).toContain('All clear.');
 await publish('attention.ask','offline');
 expect(text()).not.toContain('All clear.');expect(text()).not.toContain(' more');expect(text()).toContain('Asks unavailable');
});

it('keeps the waiting count on a folded agent card and removes it when asks disconnect',async()=>{
 vi.stubGlobal('document',{fonts:undefined});
 vi.stubGlobal('ResizeObserver',class{observe(){}disconnect(){}});
 const first=f.snapshots['attention.ask'].records[0];
 f.snapshots['attention.ask']=live([first,{...first,id:'mark-one',agent:'mark'},{...first,id:'mark-two',agent:'mark'}]);
 const element={clientWidth:296,clientHeight:120,scrollHeight:700};
 await act(async()=>{tree=create(h(Rail,{go:vi.fn()}),{createNodeMock:(node:any)=>node.props.className==='desk-agent-rail'?element:null});});
 const compact=tree.root.findByProps({className:'desk-rail-compact'});
 expect(compact.props['data-agent']).toBe('mark');
 expect(compact.findByProps({'aria-label':'2 waiting questions'}).children.join('')).toBe('ASK · 2');
 await publish('attention.ask','offline');
 expect(tree.root.findAllByProps({'aria-label':'2 waiting questions'})).toHaveLength(0);
 expect(text()).not.toContain('ASK');
});
