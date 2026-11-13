import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createElement as h, useSyncExternalStore } from 'react';
// @ts-expect-error Existing renderer dependency has no bundled declarations.
import { act, create } from 'react-test-renderer';
import type { Ask } from './model';
import type { OwnedAgent, AgentStatus } from './home-model';
import type { Call, CallState, Result, Snapshot } from '../../data';
// Renderer nodes carry arbitrary DOM callbacks; snapshots mix three record types for the hook fake.
type Node={children:Array<Node|string>;props:Record<string,any>};
const f=vi.hoisted(()=>({snapshots:{} as Record<string,Snapshot<any>>,listeners:new Set<()=>void>(),call:vi.fn()}));
vi.mock('../../data',()=>({useRecords:(type:string)=>useSyncExternalStore(fn=>{f.listeners.add(fn);return()=>{f.listeners.delete(fn);};},()=>f.snapshots[type]),call:f.call}));
vi.mock('../../lib/cojeev-motion/use-reduced-motion',()=>({useReducedMotion:()=>true}));
import Home from './home';
import { orderedAgents, reportLink } from './home-model';
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
beforeEach(()=>{f.call.mockReset();f.listeners.clear();f.snapshots={'attention.ownedAgent':live<OwnedAgent>([{id:'mark',name:'Mark'},{id:'art',name:'Art'}]),'attention.ask':live<Ask>([]),'attention.agent':live<AgentStatus>([])};});
afterEach(async()=>{await act(async()=>tree?.unmount());tree=undefined;});
it('keeps idle owned cards alphabetical by display name and id, without deriving agents from asks or work',async()=>{
  f.snapshots['attention.ask']=live([ask('foreign',{agent:'other'})]);
  await draw();expect(tree!.root.findAllByType('section').filter((n:Node)=>n.props['aria-label']?.endsWith(' card')).map((n:Node)=>n.props['aria-label'])).toEqual(['Art card','Mark card']);
  expect(text()).toContain('Nothing right now');expect(text()).not.toContain('other card');
  expect(orderedAgents([{id:'z',name:'ALPHA'},{id:'a',name:'alpha'},{id:'b',name:'Beta'}]).map(a=>a.id)).toEqual(['a','z','b']);
});
it('counts every central open ask, shows exactly the first three, and opens their exact Inbox reader',async()=>{
  f.snapshots['attention.ask']=live([ask('four',{createdAt:4}),ask('done',{state:'answered'}),ask('resolved',{state:'resolved'}),ask('three',{createdAt:3}),ask('one',{createdAt:1}),ask('two',{createdAt:2})]);
  const go=await draw();expect(text()).toContain('Needs you · ');expect(text()).toContain('Inbox · +');
  const rows=tree!.root.findByProps({'aria-label':'First three asks'}).findAllByType('button');
  expect(rows.map((n:Node)=>words(n))).toEqual(['Question oneThe whole reasonart','Question twoThe whole reasonart','Question threeThe whole reasonart']);
  await act(async()=>rows[1].props.onClick());expect(go).toHaveBeenLastCalledWith('/p/inbox-preview/ask/two');
  await click('Inbox · +1 more');expect(go).toHaveBeenLastCalledWith('/p/inbox-preview');
  expect(text()).not.toContain('Question done');expect(text()).not.toContain('Question resolved');
});
it('shows the full first ask and latest status; checks at display and again before writing through Attention',async()=>{
  const first=ask('first');f.snapshots['attention.ask']=live([first]);
  f.snapshots['attention.agent']=live<AgentStatus>([{id:'old',agent:'art',state:'idle',work:'Old work',changedAt:1,jobs:[],watched:[]},{id:'new',agent:'art',state:'working',work:'Current work',changedAt:Date.parse('2026-11-13T08:00:00Z'),jobs:[],watched:[]}]);
  const shown=request<Ask>(),fresh=request<Ask>(),write=request<Ask>();f.call.mockReturnValueOnce(shown.call).mockReturnValueOnce(fresh.call).mockReturnValueOnce(write.call);
  await draw();for(const word of ['The whole reason','I continue.','I stop.','t-2205','Current work'])expect(text()).toContain(word);expect(text()).not.toContain('Old work');expect(text()).toContain('11/13/2026, 2:00:00 AM');expect(text()).toContain(' CT');expect(buttons('Yes')).toHaveLength(0);
  await click('Check again');await shown.finish({ok:true,value:first});await click('Yes');expect(f.call).toHaveBeenLastCalledWith('attention.get',{id:'first'});
  await fresh.finish({ok:true,value:first});expect(f.call).toHaveBeenLastCalledWith('attention.answer',{id:'first',answer:{kind:'yes'},requireOwnership:true});
  const answered={...first,state:'answered' as const,answer:{kind:'yes',by:{kind:'member',id:'jonathan'},at:Date.parse('2026-11-13T08:00:00Z')}};await write.finish({ok:true,value:answered});await publish('attention.ask',live([answered]));expect(buttons('Check again')).toHaveLength(0);expect(text()).toContain('All clear.');expect(text()).toContain('Art card');expect(text()).toContain('Art last answer');expect(text()).toContain('jonathan');expect(text()).toContain('11/13/2026, 2:00:00 AM');
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
  const report:AgentStatus={id:'work',agent:'art',state:'working',work:'Current secret work',changedAt:1,jobs:[],watched:[]};
  f.snapshots['attention.agent']=live([report]);await draw();
  await publish('attention.agent',{records:[report],status:'offline'});
  expect(text()).not.toContain('Current secret work');expect(text()).toContain('Question first');expect(text()).toContain('Art card');
  await publish('attention.ask',{records:[first],status:'denied'});
  expect(text()).not.toContain('Question first');expect(text()).not.toContain('All clear.');expect(text()).toContain('Art card');expect(buttons('Check again')).toHaveLength(0);
});

it('shows only the latest visible report’s complete jobs and watches and routes new apps without a write',async()=>{
  const report:AgentStatus={id:'current',agent:'art',state:'working',work:'Reviewing changes',changedAt:2,
    jobs:[{id:'job',label:'Review this task',href:'/p/tasks-preview/task/t-2205'},{id:'plain',label:'Waiting for input'},{id:'empty',label:''}],
    watched:[{id:'pr',label:'Watch the pull request',href:'https://github.com/sleepunit-agents/loom/pull/927'},{id:'unsafe',label:'Unsafe source',href:'javascript:alert(1)'},{id:'old',label:'Old source',href:'/runtime'}]};
  f.snapshots['attention.agent']=live([{...report,id:'old',changedAt:1,jobs:[{id:'gone',label:'Superseded job'}]},report,{...report,id:'foreign',agent:'other',jobs:[{id:'hidden',label:'Other agent work'}]}]);
  const go=await draw();
  for(const label of ['Review this task','Waiting for input','empty','Watch the pull request','Unsafe source','Old source'])expect(text()).toContain(label);
  for(const label of ['Superseded job','Other agent work','javascript:','/runtime'])expect(text()).not.toContain(label);
  const external=tree!.root.findAllByType('a').find((n:Node)=>words(n)==='Watch the pull request');
  expect(external.props).toMatchObject({href:'https://github.com/sleepunit-agents/loom/pull/927',target:'_blank',rel:'noopener noreferrer'});
  await click('Review this task');expect(go).toHaveBeenCalledWith('/p/tasks-preview/task/t-2205');expect(f.call).not.toHaveBeenCalled();
  await publish('attention.agent',live([{...report,changedAt:3,jobs:[],watched:[]}]));
  expect(text()).not.toContain('Waiting for input');expect(text()).not.toContain('Watch the pull request');
  expect(text()).toContain('No jobs reported.');expect(text()).toContain('No watched items reported.');
  await publish('attention.agent',live([]));expect(text()).not.toContain('No jobs reported.');expect(text()).toContain('No status reported');
});

it.each(['loading','offline','denied'] as const)('removes jobs and watches on %s even when stale records remain in the snapshot',async(status)=>{
  const report:AgentStatus={id:'work',agent:'art',state:'working',work:'Current work',changedAt:1,jobs:[{id:'job',label:'Private job',href:'/p/tasks-preview/task/t-1'}],watched:[{id:'watch',label:'Private watch'}]};
  f.snapshots['attention.agent']=live([report]);await draw();expect(text()).toContain('Private job');
  await publish('attention.agent',{records:[report],status});
  expect(text()).not.toContain('Private job');expect(text()).not.toContain('Private watch');expect(text()).not.toContain('No jobs reported.');
  expect(text()).toContain('Art card');expect(text()).toContain(status==='loading'?'Opening agent status':'Couldn’t load agent status');
});

it('keeps report destinations on new apps or explicit HTTP(S) sources',()=>{
  expect(reportLink('/p/tasks-preview/task/t-1?tab=comments#latest')).toEqual({app:true,href:'/p/tasks-preview/task/t-1?tab=comments#latest'});
  expect(reportLink('https://example.com/work')).toEqual({app:false,href:'https://example.com/work'});
  for(const href of [undefined,'','javascript:alert(1)','data:text/html,hi','//evil.test/p/x','/runtime','/p/../../signin','/p/%2e%2e/signin','/p/\\evil.test','https://example.com/\nwork'])expect(reportLink(href)).toBeUndefined();
});
