import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createElement as h, useSyncExternalStore } from 'react';
// @ts-expect-error Existing renderer has no declarations.
import { act, create } from 'react-test-renderer';
import type { Snapshot } from '../../data';
const f=vi.hoisted(()=>({snapshots:{} as Record<string,Snapshot<any>>,listeners:new Set<()=>void>()}));
vi.mock('../../data',()=>({useRecords:(type:string)=>useSyncExternalStore(fn=>{f.listeners.add(fn);return()=>{f.listeners.delete(fn);};},()=>f.snapshots[type])}));
import Rail from './rail';
(globalThis as typeof globalThis & {IS_REACT_ACT_ENVIRONMENT:boolean}).IS_REACT_ACT_ENVIRONMENT=true;
let tree:ReturnType<typeof create>;
const live=(records:object[])=>({records,status:'live' as const});
const text=()=>JSON.stringify(tree.toJSON());
async function publish(type:string,status:Snapshot['status'],records=f.snapshots[type].records){await act(async()=>{f.snapshots[type]={status,records};f.listeners.forEach(fn=>fn());});}
beforeEach(()=>{f.listeners.clear();f.snapshots={
 'attention.ownedAgent':live([{id:'mark',name:'Mark'},{id:'art',name:'Art'}]),
 'household.agentDisplay':live([]),
 'person':live([]),'attention.ask':live([{id:'first',ask:'Proceed with backup?',agent:'art',state:'open',createdAt:1}]),
 'attention.agent':live([{id:'report',agent:'art',state:'working',work:'Checking the backup',changedAt:1}]),
 'thread':live([{id:'th:abc',agent:'art',title:'Unread conversation',unread:true,last:1,archived:null},{id:'th:recent',agent:'art',title:'Newest read thread',unread:false,last:2,archived:null}]),
};});
afterEach(async()=>{await act(async()=>tree?.unmount());});
it('keeps only the owned roster alphabetical, opens the first unread thread and reads full asks in Inbox',async()=>{
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
