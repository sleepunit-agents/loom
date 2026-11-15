import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createElement as h, useMemo, useSyncExternalStore } from 'react';
// @ts-expect-error Existing renderer dependency has no bundled declarations.
import { act, create } from 'react-test-renderer';
import type { Ask } from './model';
import type { OwnedAgent, AgentStatus } from './home-model';
import type { CurrentJob } from './current-jobs';
import type { Call, CallState, Result, Snapshot } from '../../data';
// Renderer nodes carry arbitrary DOM callbacks; snapshots mix three record types for the hook fake.
type Node={children:Array<Node|string>;props:Record<string,any>};
const f=vi.hoisted(()=>({snapshots:{} as Record<string,Snapshot<any>>,listeners:new Set<()=>void>(),call:vi.fn(),once:vi.fn()}));
vi.mock('./agent-status',()=>({useDeskAgentStatuses:()=>useSyncExternalStore(fn=>{f.listeners.add(fn);return()=>{f.listeners.delete(fn);};},()=>f.snapshots['attention.agent'])}));
vi.mock('../../data/graphql',()=>({useDataQuery:(document:string,variables?:{agent:string})=>{useSyncExternalStore(fn=>{f.listeners.add(fn);return()=>{f.listeners.delete(fn);};},()=>document.includes('DeskRoster')?f.snapshots['attention.ownedAgent']:document.includes('DeskHomeComms')?f.snapshots['generated.homeComms']:f.snapshots['generated.jobs']);return useMemo(()=>document.includes('DeskHomeComms')?{status:f.snapshots['generated.homeComms'].status,data:{homeComms:f.snapshots['generated.homeComms'].records[0]??null}}:document.includes('DeskCurrentJobs')?{status:f.snapshots['generated.jobs'].status,data:{currentJobs:f.snapshots['generated.jobs'].records.filter((row:any)=>row.agent===variables?.agent)}}:({status:document.includes('DeskRoster')?f.snapshots['attention.ownedAgent'].status:'live',data:{homeComms:{member:'owner',agents:(f.snapshots['attention.ownedAgent']?.records??[]).map((a:any)=>a.id)},recentConversations:(f.snapshots['conversation.summary']?.records??[]).filter((row:any)=>row.agent===variables?.agent),agents:(f.snapshots['attention.ownedAgent']?.records??[]).map((a:any)=>({id:a.id,position:a.position??0}))}}),[f.snapshots['generated.homeComms'],f.snapshots['attention.ownedAgent'],f.snapshots['generated.jobs'],f.snapshots['conversation.summary'],document,variables?.agent]);}}));
vi.mock('../../data',()=>({useRecords:(type:string)=>(expect(['wake','clock','attention.agent','thread','attention.ownedAgent']).not.toContain(type),useSyncExternalStore(fn=>{f.listeners.add(fn);return()=>{f.listeners.delete(fn);};},()=>f.snapshots[type])),call:f.call,callOnce:f.once}));
vi.mock('../../lib/cojeev-motion/use-reduced-motion',()=>({useReducedMotion:()=>true}));
import Home from './home';
vi.mock('./member-retention',()=>({useMemberRetention:vi.fn()}));
import { orderedAgents } from './home-model';
(globalThis as typeof globalThis & {IS_REACT_ACT_ENVIRONMENT:boolean}).IS_REACT_ACT_ENVIRONMENT=true;
const ask=(id:string,fields:Partial<Ask>={}):Ask=>({id,agent:'art',ask:`Question ${id}`,why:'The whole reason',if_yes:'I continue.',if_no:'I stop.',refs:['t-2205'],source:{kind:'piece',id:'test'},state:'open',createdAt:1,changedAt:1,...fields});
const live=<T,>(records:T[])=>({records,status:'live' as const});
let tree:ReturnType<typeof create>|undefined;
const words=(node:Node|string):string=>typeof node==='string'?node:(node.children??[]).map(words).join('');
const text=()=>JSON.stringify(tree!.toJSON());
const buttons=(label:string)=>tree!.root.findAllByType('button').filter((n:Node)=>words(n)===label);
const click=async(label:string)=>act(async()=>buttons(label)[0].props.onClick());
const draw=async(go=vi.fn())=>{await act(async()=>{tree=create(h<{go?:(path:string)=>void}>(Home,{go}));});return go;};
async function publish(type:string,snapshot:Snapshot<any>){await act(async()=>{f.snapshots[type]=snapshot;f.listeners.forEach(fn=>fn());});}
function request<T>() {
  let state:CallState<T>={pending:true,status:'pending'},resolve!:(r:Result<T>)=>void;
  const listeners=new Set<()=>void>();
  const call:Call<T>={id:'request',result:new Promise(r=>{resolve=r;}),getSnapshot:()=>state,subscribe:fn=>{listeners.add(fn);return()=>{listeners.delete(fn);};}};
  return {call,finish:async(result:Result<T>)=>act(async()=>{state={pending:false,status:'done',result};resolve(result);listeners.forEach(fn=>fn());})};
}
beforeEach(()=>{f.call.mockReset();f.once.mockReset();f.once.mockReturnValue({result:new Promise(()=>{})});f.listeners.clear();f.snapshots={'activity.window':live([]),'attention.ownedAgent':live<OwnedAgent>([{id:'mark',name:'Mark'},{id:'art',name:'Art'}]),'generated.homeComms':live([{member:'owner',agents:[],summaries:[]}]),'household.agentDisplay':live([]),'person':live([]),'generated.jobs':live([]),'attention.ask':live<Ask>([]),'attention.agent':live<AgentStatus>([])};});
afterEach(async()=>{await act(async()=>tree?.unmount());tree=undefined;});
it('keeps idle owned cards in saved position order with stable id ties, without deriving agents from asks or work',async()=>{
  f.snapshots['attention.ask']=live([ask('foreign',{agent:'other'})]);
  await draw();expect(tree!.root.findAllByType('section').filter((n:Node)=>n.props['aria-label']?.endsWith(' card')).map((n:Node)=>n.props['aria-label'])).toEqual(['Art card','Mark card']);
  expect(text()).toContain('Nothing right now');expect(text()).not.toContain('other card');
  expect(orderedAgents([{id:'z',name:'ALPHA',position:1},{id:'a',name:'alpha',position:0},{id:'b',name:'Beta',position:2}]).map(a=>a.id)).toEqual(['a','z','b']);
});
it('counts every central open ask, shows the first waiting item and remaining count, and opens their exact Inbox reader',async()=>{
  f.snapshots['attention.ask']=live([ask('four',{createdAt:4}),ask('done',{state:'answered'}),ask('resolved',{state:'resolved'}),ask('three',{createdAt:3}),ask('one',{createdAt:1}),ask('two',{createdAt:2})]);
  const go=await draw();expect(text()).toContain('Needs you · ');expect(text()).toContain('Inbox · +');
  const rows=tree!.root.findByProps({'aria-label':'First waiting item'}).findAllByType('button');
  expect(rows.map((n:Node)=>words(n))).toEqual(['Question oneThe whole reasonart']);
  await act(async()=>rows[0].props.onClick());expect(go).toHaveBeenLastCalledWith('/p/inbox-preview/ask/one');
  await click('Inbox · +3 more');expect(go).toHaveBeenLastCalledWith('/p/inbox-preview');
  expect(text()).not.toContain('Question done');expect(text()).not.toContain('Question resolved');
});
it('shows the full first ask and latest status; checks at display and again before writing through Attention',async()=>{
  const first=ask('first');f.snapshots['attention.ask']=live([first]);
  f.snapshots['attention.agent']=live<AgentStatus>([{id:'old',agent:'art',state:'idle',work:'Old work',changedAt:1},{id:'new',agent:'art',state:'working',work:'Current work',changedAt:Date.parse('2026-11-13T08:00:00Z')}]);
  const shown=request<Ask>(),fresh=request<Ask>(),write=request<Ask>();f.call.mockReturnValueOnce(shown.call).mockReturnValueOnce(fresh.call).mockReturnValueOnce(write.call);
  await draw();for(const word of ['The whole reason','I continue.','I stop.','t-2205','Current work'])expect(text()).toContain(word);expect(text()).not.toContain('Old work');expect(text()).toContain('11/13/2026, 2:00:00 AM');expect(text()).toContain(' CT');expect(buttons('Yes')).toHaveLength(0);
  await click('Check again');await shown.finish({ok:true,value:first});await click('Yes');expect(f.call).toHaveBeenLastCalledWith('attention.get',{id:'first'});
  await fresh.finish({ok:true,value:first});expect(f.call).toHaveBeenLastCalledWith('attention.answer',{id:'first',answer:{kind:'yes'},requireOwnership:true});
  const answered={...first,state:'answered' as const,answer:{kind:'yes',by:{kind:'member',id:'jonathan'},at:Date.parse('2026-11-13T08:00:00Z')}};await write.finish({ok:true,value:answered});await publish('attention.ask',live([answered]));expect(buttons('Check again')).toHaveLength(0);expect(text()).toContain('All clear.');expect(text()).toContain('Art card');expect(text()).not.toContain('jonathan');expect(text()).toContain('11/13/2026, 2:00:00 AM');
});
it('keeps one answer guard across cards and invalidates a prewrite check when its first ask is replaced',async()=>{
  const first=ask('first'),second=ask('second',{agent:'mark'});f.snapshots['attention.ask']=live([first,second]);
  const shown=request<Ask>(),fresh=request<Ask>();f.call.mockReturnValueOnce(shown.call).mockReturnValueOnce(fresh.call);
  await draw();await click('Check again');await shown.finish({ok:true,value:first});await click('Yes');
  expect(buttons('Check again').every((n:Node)=>n.props.disabled)).toBe(true);
  await publish('attention.ask',live([second]));await fresh.finish({ok:true,value:first});expect(f.call.mock.calls.filter(([op])=>op==='attention.answer')).toHaveLength(0);
  const next=request<Ask>();f.call.mockReturnValueOnce(next.call);await click('Check again');expect(f.call).toHaveBeenLastCalledWith('attention.get',{id:'second'});
});
it.each(['loading','offline','denied'] as const)('shows %s errors without stale asks, statuses or ownership',async(status)=>{
  f.snapshots['attention.ask']=live([ask('secret')]);await draw();
  for(const type of ['attention.ask','attention.agent','attention.ownedAgent'])await publish(type,{records:f.snapshots[type].records,status});
  expect(text()).not.toContain('Question secret');expect(text()).not.toContain('All clear.');expect(text()).not.toContain('Art card');expect(text()).toContain(status==='loading'?'Opening':'Couldn’t load');expect(f.call).not.toHaveBeenCalled();
});
it('handles no owned agents and regaining scope without invented agents',async()=>{
  f.snapshots['attention.ownedAgent']=live([]);await draw();expect(text()).toContain('No agents of your own');
  await publish('attention.ownedAgent',live([{id:'mark',name:'Mark'}]));expect(text()).toContain('Mark card');expect(text()).not.toContain('Art card');
});
it('keeps source-owned decisions and member-private asks out of central answer controls',async()=>{
  f.snapshots['attention.ask']=live([ask('approval',{source:{kind:'approval',id:'a-12345678'}}),ask('private',{agent:'mark',member:'jonathan'})]);
  const go=await draw();expect(buttons('Check again')).toHaveLength(0);expect(buttons('Yes')).toHaveLength(0);expect(text()).toContain('Private replies stay there.');await click('Open approval');expect(go).toHaveBeenCalledWith('/p/approvals-preview/approval/a-12345678');expect(f.call).not.toHaveBeenCalled();
});

it('abandons a fresh check on ownership loss even while the same project ask remains visible',async()=>{
  const first=ask('shared',{project:'pond'});f.snapshots['attention.ask']=live([first]);
  const shown=request<Ask>(),fresh=request<Ask>();f.call.mockReturnValueOnce(shown.call).mockReturnValueOnce(fresh.call);
  await draw();await click('Check again');await shown.finish({ok:true,value:first});await click('Yes');
  await publish('attention.ownedAgent',live([{id:'mark',name:'Mark'}]));await fresh.finish({ok:true,value:first});
  expect(f.call.mock.calls.filter(([op])=>op==='attention.answer')).toHaveLength(0);expect(text()).not.toContain('Art card');
  expect(text()).toContain('Question shared');
});
it('clears failed asks and statuses independently while retaining idle owned cards',async()=>{
  const first=ask('first');f.snapshots['attention.ask']=live([first]);
  const report:AgentStatus={id:'work',agent:'art',state:'working',work:'Current secret work',changedAt:1};
  f.snapshots['attention.agent']=live([report]);await draw();
  await publish('attention.agent',{records:[report],status:'offline'});
  expect(text()).not.toContain('Current secret work');expect(text()).toContain('Question first');expect(text()).toContain('Art card');
  await publish('attention.ask',{records:[first],status:'denied'});
  expect(text()).not.toContain('Question first');expect(text()).not.toContain('All clear.');expect(text()).toContain('Art card');expect(buttons('Check again')).toHaveLength(0);
});

const person=(slug:string,name:string,extra:Record<string,unknown>={})=>({id:`commons:${slug}`,slug,name,kind:'agent',...extra});
it('uses live directory agent names and People links without adding relationship or project-only cards',async()=>{
  f.snapshots['person']=live([person('art','Zulu Fish'),person('mark','ALPHA Mark'),person('pond-bot','Not owned'),person('art','Relationship name',{id:'mark:art',agent:'mark'}),person('outsider','Outside')]);
  const go=await draw();
  const cards=()=>tree!.root.findAllByType('section').filter((n:Node)=>n.props['aria-label']?.endsWith(' card')).map((n:Node)=>n.props['aria-label']);
  expect(cards()).toEqual(['Zulu Fish card','ALPHA Mark card']);
  expect(text()).not.toContain('Relationship name');expect(text()).not.toContain('Not owned');
  await act(async()=>tree!.root.findByProps({'aria-label':'Zulu Fish in People'}).props.onClick());expect(go).toHaveBeenCalledWith('/p/people-preview/person/art');expect(f.call).not.toHaveBeenCalled();
  await publish('person',live([person('art','Beta Fish')]));
  expect(cards()).toEqual(['Beta Fish card','Mark card']);
  expect(tree!.root.findAllByProps({'aria-label':'ALPHA Mark in People'})).toHaveLength(0);
});
it.each(['loading','offline','denied'] as const)('drops stale directory names and links on %s while retaining owned ids and ask controls',async(status)=>{
  const records=[person('art','Private display name')];f.snapshots['person']=live(records);f.snapshots['attention.ask']=live([ask('first')]);
  await draw();expect(text()).toContain('Private display name');
  await publish('person',{status,records});
  expect(text()).not.toContain('Private display name');expect(text()).toContain('Art card');expect(buttons('Check again')).toHaveLength(1);
});
it('ignores person-kind and mismatched directory identities and blank names',async()=>{
  f.snapshots['person']=live([person('art','Wrong kind',{kind:'person'}),person('mark','Wrong id',{id:'commons:art'}),person('mark','   ')]);
  await draw();expect(text()).toContain('Art card');expect(text()).toContain('Mark card');expect(text()).not.toContain('Wrong');
});

it('checks the real member wait operation from Home without synthesizing a local resolution or answer',async()=>{
  const pending=request<Ask>();f.call.mockReturnValue(pending.call);
  const record=ask('wait',{waits_on:{task:'t-1'}});f.snapshots['attention.ask']=live([record]);
  await draw();expect(f.call).toHaveBeenCalledExactlyOnceWith('attention.checkWait',{id:'wait'});
  await pending.finish({ok:true,value:{...record,state:'resolved',resolution:'t-1 is closed'}});
  expect(text()).toContain('Question wait');
  await publish('attention.ask',live([{...record,state:'resolved'}]));
  expect(text()).not.toContain('Question wait');expect(text()).toContain('All clear.');
  expect(f.call.mock.calls.some(([name])=>name==='attention.answer')).toBe(false);
});

const runtimeJob=(id:string,fields:Partial<CurrentJob>={}):CurrentJob=>({id,agent:'art',title:`Runtime ${id}`,state:'queued',box:'worker',queuedAt:new Date(1).toISOString(),...fields});
it('shows generated current jobs independently of reports and preserves server order and concurrent titles',async()=>{
  f.snapshots['generated.jobs']=live([
    {id:'first',agent:'art',title:'Same work',state:'running',box:'worker',queuedAt:'2026-11-14T01:00:00Z'},
    {id:'second',agent:'art',title:'Same work',state:'waiting',box:'worker',queuedAt:'2026-11-14T02:00:00Z'},
    {id:'queued',agent:'art',title:'Runtime queued',state:'queued',box:null,queuedAt:'2026-11-14T03:00:00Z'},
    {id:'starting',agent:'art',title:'Runtime starting',state:'starting',box:'worker',queuedAt:'2026-11-14T04:00:00Z'},
  ]);
  await draw();
  const panel=tree!.root.findByProps({'aria-label':'Art runtime jobs'});
  expect(words(panel)).toContain('Runtime jobs · 4');expect(panel.findAllByType('li')).toHaveLength(4);
  expect(panel.findAllByType('h4').map(words)).toEqual(['Same work','Same work','Runtime queued','Runtime starting']);
  expect(words(panel)).toContain('running · Box worker');expect(words(panel)).toContain(' CT');
  expect(words(panel)).not.toContain('Runtime foreign');expect(words(panel)).not.toContain('Runtime failed');
  expect(f.call).not.toHaveBeenCalled();
  await publish('generated.jobs',live([{...runtimeJob('new',{title:'New authoritative work'}),queuedAt:new Date(1).toISOString()}]));
  expect(text()).not.toContain('Same work');expect(text()).toContain('New authoritative work');
  await publish('generated.jobs',live([]));expect(text()).not.toContain('New authoritative work');expect(text()).toContain('No current runtime jobs.');
});
it.each(['loading','offline','denied'] as const)('clears Runtime words and avoids a false empty inventory while %s',async(status)=>{
  f.snapshots['generated.jobs']=live([{...runtimeJob('private',{title:'Visible private Runtime title'}),queuedAt:new Date(1).toISOString()}]);await draw();
  await publish('generated.jobs',{records:f.snapshots['generated.jobs'].records,status});
  const panel=tree!.root.findByProps({'aria-label':'Art runtime jobs'});
  expect(words(panel)).not.toContain('Visible private Runtime title');expect(words(panel)).not.toContain('No current runtime jobs.');expect(words(panel)).not.toContain('Runtime jobs · 0');
  expect(words(panel)).toContain(status==='loading'?'Opening runtime jobs':'Couldn’t load runtime jobs');
  expect(text()).toContain('Art card');
  await publish('generated.jobs',live([{...runtimeJob('returned'),queuedAt:new Date(1).toISOString()}]));expect(words(tree!.root.findByProps({'aria-label':'Art runtime jobs'}))).toContain('Runtime returned');
  await publish('attention.ownedAgent',live([{id:'mark',name:'Mark'}]));expect(text()).not.toContain('Runtime returned');expect(text()).not.toContain('Art card');
});
it('shows generated mailbox counts and opens exact last/unread destinations without legacy commands',async()=>{
 f.snapshots['generated.homeComms']=live([{member:'owner',agents:[],summaries:[{agent:'art',unread:102,last:{thread:'th:last',title:'Recent desk work',at:'2026-11-14T00:00:00Z'},first:{thread:'th:first'}}]}]);
 const go=await draw();expect(text()).toContain('Recent desk work');expect(buttons('102 unread threads')).toHaveLength(1);expect(f.once).not.toHaveBeenCalled();
 await click('102 unread threads');expect(go).toHaveBeenCalledWith('/p/comms-preview/thread/first');
 for(const status of ['loading','offline','denied'] as const){
  await publish('generated.homeComms',{...f.snapshots['generated.homeComms'],status});
  expect(text()).not.toContain('Recent desk work');expect(buttons('102 unread threads')).toHaveLength(0);
 }
 await publish('generated.homeComms',live([{member:'owner',agents:[],summaries:[]}]));expect(text()).toContain('No conversations yet.');
});
it('withdraws compose eligibility on current ownership, identity and query loss',async()=>{
 f.snapshots['generated.homeComms']=live([{member:'owner',agents:['art'],summaries:[]}]);await draw();
 const composer=()=>tree!.root.findByProps({'aria-label':'Message Art'}).findAllByType('form');
 expect(composer()).toHaveLength(1);expect(tree!.root.findByProps({'aria-label':'Message Mark'}).findAllByType('form')).toHaveLength(0);
 await publish('generated.homeComms',live([{member:'owner',agents:[],summaries:[]}]));expect(composer()).toHaveLength(0);
 await publish('generated.homeComms',live([{member:'other',agents:['art'],summaries:[]}]));expect(composer()).toHaveLength(1);
 await publish('generated.homeComms',{...f.snapshots['generated.homeComms'],status:'offline'});expect(composer()).toHaveLength(0);
 await publish('generated.homeComms',live([]));expect(composer()).toHaveLength(0);expect(text()).toContain('Conversations unavailable.');
});

it('folds only phone rosters over four, prioritizes current working state then asks then unread, and unmounts other readers',async()=>{
 let matches=true;const changes=new Set<()=>void>();
 vi.stubGlobal('window',{matchMedia:()=>({get matches(){return matches;},addEventListener:(_s:string,f:()=>void)=>changes.add(f),removeEventListener:(_s:string,f:()=>void)=>changes.delete(f)}),addEventListener:vi.fn(),removeEventListener:vi.fn()});
 try {
 const agents=['art','birch','cedar','elm','fern'].map(id=>({id,name:id}));
 f.snapshots['attention.ownedAgent']=live(agents);
 f.snapshots.person=live(agents.map(a=>({id:`commons:${a.id}`,slug:a.id,name:a.name,kind:'agent'})));
 f.snapshots['attention.ask']=live([ask('question',{agent:'birch'})]);
 const summary={member:'owner',agents:[],summaries:[{agent:'cedar',unread:2,last:{thread:'th:new/one',title:'Unread',at:'2026-11-14T00:00:00Z'},first:{thread:'th:new/one'}},{agent:'elm',unread:0,last:{thread:'th:latest',title:'Latest',at:'2026-11-14T00:00:00Z'},first:null}]};
 f.snapshots['generated.homeComms']=live([summary]);
 f.snapshots['attention.agent']=live([{id:'fern',agent:'fern',state:'working',work:'Working',changedAt:1}]);const go=await draw();
 const cards=()=>tree!.root.findAllByType('section').filter((n:Node)=>n.props.className?.startsWith('desk-home-card')).map((n:Node)=>n.props['data-agent']);
 const rows=()=>tree!.root.findAllByType('section').filter((n:Node)=>n.props.className==='desk-home-compact');
 expect(cards()).toEqual(['fern']);expect(rows()).toHaveLength(4);
 expect(tree!.root.findAllByProps({'aria-label':'birch desk details'})).toHaveLength(0);
 await act(async()=>tree!.root.findByProps({'aria-label':'Open cedar conversation'}).props.onClick());expect(go).toHaveBeenLastCalledWith('/p/comms-preview/thread/new%2Fone');
 await act(async()=>tree!.root.findByProps({'aria-label':'Open elm conversation'}).props.onClick());expect(go).toHaveBeenLastCalledWith('/p/comms-preview/thread/latest');
 await publish('attention.agent',live([]));expect(cards()).toEqual(['birch']);
 await publish('attention.ask',{records:f.snapshots['attention.ask'].records,status:'denied'});expect(cards()).toEqual(['cedar']);expect(text()).not.toContain('Question question');
 await publish('generated.homeComms',{records:[summary],status:'offline'});expect(cards()).toEqual(['art']);expect(text()).not.toContain('2 unread');
 await act(async()=>{matches=false;changes.forEach(f=>f());});expect(cards()).toHaveLength(5);expect(rows()).toHaveLength(0);
 await act(async()=>{matches=true;changes.forEach(f=>f());});expect(cards()).toEqual(['art']);
 await publish('attention.ownedAgent',live(agents.slice(0,4)));expect(cards()).toHaveLength(4);expect(rows()).toHaveLength(0);
 } finally {await act(async()=>tree?.unmount());tree=undefined;vi.unstubAllGlobals();}
});

it('shows and counts a represented source approval once through the actual Home path',async()=>{
  const approval=ask('approval',{sourceManaged:true,source:{kind:'approval',id:'a-12345678'}});
  const wait=ask('wait',{source:{kind:'conversation',id:'cv-one'},waits_on:{approval:'a-12345678'}});
  f.snapshots['attention.ask']=live([approval,wait,{...wait,id:'another-wait',createdAt:2,ask:'Another copy of this approval'}]);await draw();
  expect(text()).toContain('Question wait');expect(text()).not.toContain('Question approval');expect(text()).not.toContain('Another copy of this approval');
  expect(tree!.root.findAllByType('h2').map(words)).toContain('Needs you · 1');
});

it('shows each owned agent’s latest three Activity entries with exact reader navigation and clears lost sources',async()=>{
 const entry=(id:string,agent='art',at='2026-11-13T18:00:00Z')=>({id,agent,at,day:'2026-11-13',hour:12,title:`Step ${id}`,line:'What landed',venue:'terminal',where:'Terminal',what:'work'});
 const window={id:'recent',to:'2026-11-13',days:['2026-11-13'],entries:[entry('old','art','2026-11-13T15:00:00Z'),entry('private','other'),entry('z'),entry('b'),entry('a'),entry('mark','mark')],conversations:'available',episodes:'available',truncated:false,expires:1};
 f.snapshots['activity.window']=live([window]);const go=await draw();
 const steps=tree!.root.findByProps({'aria-label':'Art recent steps'});
 const rows=steps.findAllByType('button');expect(rows.map((r:Node)=>words(r))).toEqual(['Step aWhat landed11/13/2026, 12:00:00 PM CT · Terminal','Step bWhat landed11/13/2026, 12:00:00 PM CT · Terminal','Step zWhat landed11/13/2026, 12:00:00 PM CT · Terminal']);
 expect(text()).not.toContain('Step old');expect(text()).not.toContain('Step private');expect(text()).toContain('Step mark');
 await act(async()=>rows[0].props.onClick());expect(go).toHaveBeenLastCalledWith('/p/activity-preview/?who=art&e=a&day=2026-11-13');
 await publish('activity.window',live([{...window,entries:[],conversations:'unavailable',truncated:true}]));
 expect(text()).not.toContain('Step a');expect(text()).toContain('Some activity is unavailable.');expect(text()).toContain('Showing the available recent activity.');expect(text()).not.toContain('No recent steps.');
 await publish('activity.window',live([{...window,entries:[]}]));expect(text()).toContain('No recent steps.');
 for(const status of ['offline','denied','loading'] as const){await publish('activity.window',{status,records:[window]});expect(text()).not.toContain('Step a');expect(text()).toContain(status==='loading'?'Opening activity':'Activity unavailable.');}
});

it('opens an owned agent’s dedicated window from its Home face',async()=>{
 const go=await draw(),link=tree!.root.findByProps({'aria-label':'Open Art agent window'});expect(link.props.href).toBe('/p/agents-preview/agent/art');const preventDefault=vi.fn();await act(async()=>link.props.onClick({button:0,preventDefault}));expect(preventDefault).toHaveBeenCalled();expect(go).toHaveBeenLastCalledWith('/p/agents-preview/agent/art');go.mockClear();await act(async()=>link.props.onClick({button:0,ctrlKey:true,preventDefault}));expect(go).not.toHaveBeenCalled();
});

it('renders the generated agent reply on Home instead of a human approval receipt, and removes it with its owned card',async()=>{
 f.snapshots['attention.ask']=live([ask('human',{state:'answered',answer:{kind:'yes',by:{kind:'member',id:'human-approver'},at:1}})]);
 f.snapshots['conversation.summary']=live([{id:'cv-art',agent:'art',lastAnswer:{at:'2026-11-14T11:00:00Z',words:'Actual agent reply'}}]);
 await draw();expect(text()).toContain('Actual agent reply');expect(text()).not.toContain('human-approver');
 await publish('attention.ownedAgent',live([{id:'mark',name:'Mark'}]));expect(text()).not.toContain('Actual agent reply');
});
