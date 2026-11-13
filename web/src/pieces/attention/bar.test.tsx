import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createElement as h } from 'react';
// @ts-expect-error Existing renderer has no declarations.
import { act, create } from 'react-test-renderer';
import type { Snapshot } from '../../data';
const f=vi.hoisted(()=>({snapshots:{} as Record<string,Snapshot<any>>}));
vi.mock('../../data',()=>({useRecords:(type:string)=>f.snapshots[type]}));
vi.mock('../../ticker',()=>({Ticker:(props:unknown)=>h('ticker-test',props as object)}));
import Bar from './bar';
(globalThis as typeof globalThis & {IS_REACT_ACT_ENVIRONMENT:boolean}).IS_REACT_ACT_ENVIRONMENT=true;
let tree:ReturnType<typeof create>;
const live=(records:object[])=>({records,status:'live' as const});
beforeEach(()=>{f.snapshots={
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
 expect(tree.root.findByType('ticker-test').props.parts).toEqual([{text:'1 agent',href:'/'},{text:'Art E Fish · Checking a pull request',href:'/p/home-preview'}]);
 const needs=tree.root.findByProps({'aria-label':'1 needs you'});const preventDefault=vi.fn();
 await act(async()=>needs.props.onClick({preventDefault}));expect(go).toHaveBeenLastCalledWith('/p/inbox-preview');expect(preventDefault).toHaveBeenCalled();
 go.mockClear();needs.props.onClick({metaKey:true,preventDefault});expect(go).not.toHaveBeenCalled();
});
it.each(['offline','denied','loading'] as const)('drops stale work, identity and count on %s',async(status)=>{
 await act(async()=>{tree=create(h(Bar,{title:'Home',go:vi.fn(),actions:null}));});
 for(const type of Object.keys(f.snapshots))f.snapshots[type]={...f.snapshots[type],status};
 await act(async()=>tree.update(h(Bar,{title:'Home',go:vi.fn(),actions:null})));
 expect(tree.root.findByType('ticker-test').props.parts).toEqual([{text:'Your agents are unavailable'}]);
 expect(tree.root.findByType('ticker-test').props.live).toBe(false);
 expect(tree.root.findByProps({'aria-label':'Needs you: unavailable'}).children).toEqual(['?']);
});

it('shows server time and status on desktop and clears stale time',async()=>{
 await act(async()=>{tree=create(h(Bar,{title:'Home',go:vi.fn(),actions:null}));});
 expect(tree.root.findByProps({'aria-label':'12:41 PM, America/Chicago time'})).toBeTruthy();
 expect(tree.root.findByProps({'aria-label':'1 of 1 agents at work'})).toBeTruthy();
 f.snapshots['household.time']={...f.snapshots['household.time'],status:'offline'};
 await act(async()=>tree.update(h(Bar,{title:'Home',go:vi.fn(),actions:null})));
 expect(tree.root.findAllByProps({'aria-label':'12:41 PM, America/Chicago time'})).toHaveLength(0);
 expect(tree.root.findByProps({'aria-label':'Loom time unavailable'})).toBeTruthy();
});

it('clears working-agent count when just the roster becomes unavailable',async()=>{
 await act(async()=>{tree=create(h(Bar,{title:'Home',go:vi.fn(),actions:null}));});
 f.snapshots['attention.ownedAgent']={...f.snapshots['attention.ownedAgent'],status:'offline'};
 await act(async()=>tree.update(h(Bar,{title:'Home',go:vi.fn(),actions:null})));
 expect(tree.root.findAllByProps({'aria-label':'1 of 1 agents at work'})).toHaveLength(0);
 expect(tree.root.findByProps({'aria-label':'Agent status unavailable'})).toBeTruthy();
});
