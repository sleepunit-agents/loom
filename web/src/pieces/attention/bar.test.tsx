import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createElement as h, useMemo } from 'react';
// @ts-expect-error Existing renderer has no declarations.
import { act, create } from 'react-test-renderer';
import type { Snapshot } from '../../data';
const f=vi.hoisted(()=>({snapshots:{} as Record<string,Snapshot<any>>, changes:{status:'live',data:{changes:[]}} as any, bridges:{status:'live',data:{bridgeConnections:[]}} as any, boxes:{status:'live',data:{boxes:[]}} as any, tempo:{status:'live',data:{triggers:[],triggerLog:[],agentPauses:[]}} as any}));
vi.mock('../../data/graphql',()=>({useDataQuery:(document:string)=>useMemo(()=>document.includes('DeskChanges')?f.changes:document.includes('DeskBridges')?f.bridges:document.includes('DeskBoxes')?f.boxes:document.includes('DeskTempo')?f.tempo:({status:'live',data:{agents:(f.snapshots['attention.ownedAgent']?.records??[]).map((a:any)=>({id:a.id,position:a.position??0}))}}),[f.snapshots['attention.ownedAgent'],f.tempo,f.boxes,f.bridges,f.changes])}));
vi.mock('../../data',()=>({useRecords:(type:string)=>{expect(['runtime.box','bridges.venue','change']).not.toContain(type);return f.snapshots[type];}}));
vi.mock('../../ticker',()=>({Ticker:(props:unknown)=>h('ticker-test',props as object)}));
import Bar from './bar';
(globalThis as typeof globalThis & {IS_REACT_ACT_ENVIRONMENT:boolean}).IS_REACT_ACT_ENVIRONMENT=true;
let tree:ReturnType<typeof create>;
const live=(records:object[])=>({records,status:'live' as const});
beforeEach(()=>{f.changes={status:'live',data:{changes:[{id:'pr',checks:'failing'}]}};f.bridges={status:'live',data:{bridgeConnections:[{id:'v',enabled:true},{id:'off',enabled:false}]}};f.boxes={status:'live',data:{boxes:[{id:'local',revokedAt:null},{id:'gone',revokedAt:'2026-11-14T00:00:00Z'}]}};f.tempo={status:'live',data:{triggers:[{id:'standing',enabled:true,state:'standing'},{id:'done',enabled:true,state:'fired'},{id:'off',enabled:false,state:'due'}],triggerLog:[{seq:2,event:'fired'}],agentPauses:[{agent:'art'}]}};f.snapshots={
 task:live([{id:'t-1',status:'in_progress',ready:false},{id:'t-2',status:'open',ready:true}]),
 wake:live([{id:'w-1',state:'parked'},{id:'w-2',state:'fired'}]),
 'household.time':live([{id:'owner',at:Date.parse('2026-11-13T18:41:00Z'),timezone:'America/Chicago'}]),
 'attention.ownedAgent':live([{id:'art',name:'Art'}]),
 person:live([{id:'commons:art',slug:'art',kind:'agent',name:'Art E Fish'}]),
 'attention.agent':live([{id:'report',agent:'art',state:'working',work:'Checking a pull request',changedAt:1}]),
 'attention.ask':live([{id:'a',agent:'art',state:'open',createdAt:1},{id:'b',state:'answered',createdAt:2}]),
};});
afterEach(async()=>{await act(async()=>tree?.unmount());});
it('uses owned-agent facts and open asks, and opens Inbox through the router',async()=>{
 const go=vi.fn();await act(async()=>{tree=create(h(Bar,{title:'Tasks',go,actions:h('button',null,'Appearance')}));});
 expect(tree.root.findByType('h1').children).toEqual(['Tasks']);
 expect(tree.root.findByType('ticker-test').props.parts.slice(0,2)).toEqual([{text:'1 agent',href:'/'},{text:'Art E Fish · Checking a pull request',href:'/p/agents-preview/agent/art'}]);
 const needs=tree.root.findByProps({'aria-label':'1 needs you'});const preventDefault=vi.fn();
 await act(async()=>needs.props.onClick({preventDefault}));expect(go).toHaveBeenLastCalledWith('/p/inbox-preview');expect(preventDefault).toHaveBeenCalled();
 go.mockClear();needs.props.onClick({metaKey:true,preventDefault});expect(go).not.toHaveBeenCalled();
});
it.each(['offline','denied','loading'] as const)('drops stale work, identity and count on %s',async(status)=>{
 await act(async()=>{tree=create(h(Bar,{title:'Home',go:vi.fn(),actions:null}));});
 f.changes={...f.changes,status};
 f.tempo={...f.tempo,status};
 f.bridges={...f.bridges,status};
 f.boxes={...f.boxes,status};
 for(const type of Object.keys(f.snapshots))f.snapshots[type]={...f.snapshots[type],status};
 await act(async()=>tree.update(h(Bar,{title:'Home',go:vi.fn(),actions:null})));
 expect(tree.root.findByType('ticker-test').props.parts.map((p:{text:string})=>p.text)).toEqual(['Your agents are unavailable','Tasks unavailable','Tempo unavailable','Bridges unavailable','Changes unavailable','Boxes unavailable']);
 expect(tree.root.findByProps({'aria-label':'Boxes unavailable'}).children).toBeTruthy();
 expect(tree.root.findByType('ticker-test').props.live).toBe(false);
 expect(tree.root.findByProps({'aria-label':'Needs you: unavailable'}).children).toEqual(['?']);
});

it('shows server time and status on desktop and clears stale time',async()=>{
 await act(async()=>{tree=create(h(Bar,{title:'Home',go:vi.fn(),actions:null}));});
 expect(tree.root.findByProps({title:'12:41 PM, America/Chicago time'})).toBeTruthy();
 expect(tree.root.findByProps({'aria-label':'1 of 1 agents at work'})).toBeTruthy();
 f.snapshots['household.time']={...f.snapshots['household.time'],status:'offline'};
 await act(async()=>tree.update(h(Bar,{title:'Home',go:vi.fn(),actions:null})));
 expect(tree.root.findAllByProps({title:'12:41 PM, America/Chicago time'})).toHaveLength(0);
 expect(tree.root.findByProps({title:'Loom time unavailable'})).toBeTruthy();
});

it('clears working-agent count when just the roster becomes unavailable',async()=>{
 await act(async()=>{tree=create(h(Bar,{title:'Home',go:vi.fn(),actions:null}));});
 f.snapshots['attention.ownedAgent']={...f.snapshots['attention.ownedAgent'],status:'offline'};
 await act(async()=>tree.update(h(Bar,{title:'Home',go:vi.fn(),actions:null})));
 expect(tree.root.findAllByProps({'aria-label':'1 of 1 agents at work'})).toHaveLength(0);
 expect(tree.root.findByProps({'aria-label':'Agent status unavailable'})).toBeTruthy();
});

it('uses real piece counts, puts CI trouble first, and never calls enrollment health',async()=>{
 await act(async()=>{tree=create(h(Bar,{title:'Home',go:vi.fn(),actions:null}));});
 expect(tree.root.findByType('ticker-test').props.parts.slice(2)).toEqual([
  {text:'Changes · 1 open · 1 CI red',href:'/p/changes-preview',tone:'bad'},
  {text:'Tasks · 1 in progress · 1 ready',href:'/p/tasks-preview'},
  {text:'Tempo · 1 active trigger · 1 paused agent · Last event: fired',href:'/p/tempo-preview',tone:undefined},
  {text:'Bridges · 1 enabled connection',href:'/p/bridges-preview'},
  {text:'1 enrolled box · health unavailable'},
 ]);
 expect(tree.root.findByProps({'aria-label':'1 enrolled box; health unavailable'})).toBeTruthy();
 // Each source drops its own stale values independently, including a retained red PR.
 f.changes={...f.changes,status:'denied'};
 f.boxes={...f.boxes,status:'offline'};
 await act(async()=>tree.update(h(Bar,{title:'Home',go:vi.fn(),actions:null})));
 const parts=tree.root.findByType('ticker-test').props.parts;
 expect(parts.some((p:{text:string})=>p.text.includes('CI red')||p.text.includes('enrolled'))).toBe(false);
 expect(parts.find((p:{text:string})=>p.text==='Changes unavailable').tone).toBeUndefined();
 expect(parts.some((p:{text:string})=>p.text==='Tasks · 1 in progress · 1 ready')).toBe(true);
});

it('updates Tempo independently, clears retained failures and keeps an empty live result explicit',async()=>{
 await act(async()=>{tree=create(h(Bar,{title:'Home',go:vi.fn(),actions:null}));});
 f.tempo={status:'live',data:{triggers:[{id:'failed',enabled:false,state:'failed'},{id:'held',enabled:true,state:'held'}],triggerLog:[{seq:3,event:'held'}],agentPauses:[]}};
 await act(async()=>tree.update(h(Bar,{title:'Home',go:vi.fn(),actions:null})));
 const tempo=()=>tree.root.findByType('ticker-test').props.parts.find((p:any)=>p.href==='/p/tempo-preview');
 expect(tempo()).toEqual({text:'Tempo · 1 active trigger · 0 paused agents · 1 failed · Last event: held',href:'/p/tempo-preview',tone:'bad'});
 for(const status of ['offline','denied','loading']){
  f.tempo={...f.tempo,status};
  await act(async()=>tree.update(h(Bar,{title:'Home',go:vi.fn(),actions:null})));
  expect(tempo()).toEqual({text:'Tempo unavailable',href:'/p/tempo-preview',tone:undefined});
 }
 f.tempo={status:'live',data:{triggers:[],triggerLog:[],agentPauses:[]}};
 await act(async()=>tree.update(h(Bar,{title:'Home',go:vi.fn(),actions:null})));
 expect(tempo().text).toBe('Tempo · 0 active triggers · 0 paused agents');
});

it('updates box enrollment, distinguishes live zero and clears retained counts in every unavailable state',async()=>{
 await act(async()=>{tree=create(h(Bar,{title:'Home',go:vi.fn(),actions:null}));});
 const boxes=()=>tree.root.findByType('ticker-test').props.parts.at(-1).text;
 f.boxes={status:'live',data:{boxes:[{id:'a',revokedAt:null},{id:'b',revokedAt:null}]}};
 await act(async()=>tree.update(h(Bar,{title:'Home',go:vi.fn(),actions:null})));
 expect(boxes()).toBe('2 enrolled boxes · health unavailable');
 for(const status of ['loading','offline','denied']){
  f.boxes={...f.boxes,status};
  await act(async()=>tree.update(h(Bar,{title:'Home',go:vi.fn(),actions:null})));
  expect(boxes()).toBe('Boxes unavailable');
  expect(tree.root.findByProps({'aria-label':'Boxes unavailable'})).toBeTruthy();
 }
 f.boxes={status:'live',data:{boxes:[]}};
 await act(async()=>tree.update(h(Bar,{title:'Home',go:vi.fn(),actions:null})));
 expect(boxes()).toBe('0 enrolled boxes · health unavailable');
 expect(tree.root.findByProps({'aria-label':'0 enrolled boxes; health unavailable'})).toBeTruthy();
});

it('updates generated bridge counts and clears retained configuration when unavailable',async()=>{
 await act(async()=>{tree=create(h(Bar,{title:'Home',go:vi.fn(),actions:null}));});
 const bridges=()=>tree.root.findByType('ticker-test').props.parts.find((p:any)=>p.href==='/p/bridges-preview');
 f.bridges={status:'live',data:{bridgeConnections:[{id:'a',enabled:true},{id:'b',enabled:true},{id:'off',enabled:false}]}};
 await act(async()=>tree.update(h(Bar,{title:'Home',go:vi.fn(),actions:null})));
 expect(bridges().text).toBe('Bridges · 2 enabled connections');
 for(const status of ['loading','offline','denied']){
  f.bridges={...f.bridges,status};
  await act(async()=>tree.update(h(Bar,{title:'Home',go:vi.fn(),actions:null})));
  expect(bridges().text).toBe('Bridges unavailable');
 }
 f.bridges={status:'live',data:{bridgeConnections:[]}};
 await act(async()=>tree.update(h(Bar,{title:'Home',go:vi.fn(),actions:null})));
 expect(bridges().text).toBe('Bridges · 0 enabled connections');
});

it('updates generated Changes counts, clears retained failures and distinguishes live zero',async()=>{
 await act(async()=>{tree=create(h(Bar,{title:'Home',go:vi.fn(),actions:null}));});
 const changes=()=>tree.root.findByType('ticker-test').props.parts.find((p:any)=>p.href==='/p/changes-preview');
 f.changes={status:'live',data:{changes:[{id:'a',checks:'passing'},{id:'b',checks:'running'}]}};
 await act(async()=>tree.update(h(Bar,{title:'Home',go:vi.fn(),actions:null})));
 expect(changes()).toEqual({text:'Changes · 2 open',href:'/p/changes-preview',tone:undefined});
 for(const status of ['loading','offline','denied']){
  f.changes={status,data:{changes:[{id:'red',checks:'failing'}]}};
  await act(async()=>tree.update(h(Bar,{title:'Home',go:vi.fn(),actions:null})));
  expect(changes()).toEqual({text:'Changes unavailable',href:'/p/changes-preview',tone:undefined});
 }
 f.changes={status:'live',data:{changes:[]}};
 await act(async()=>tree.update(h(Bar,{title:'Home',go:vi.fn(),actions:null})));
 expect(changes().text).toBe('Changes · 0 open');
});
