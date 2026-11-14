import { afterEach, beforeEach, expect, it, vi } from 'vitest';
vi.mock('./member-retention',()=>({useMemberRetention:vi.fn()}));
import { createElement as h, useSyncExternalStore } from 'react';
// @ts-expect-error The existing react-test-renderer dependency ships without declarations.
import { act, create } from 'react-test-renderer';
import type { ReactElement } from 'react';
// Renderer props include arbitrary DOM attributes and callbacks; tests invoke them dynamically.
type Node = { children: Array<Node|string>; props: Record<string, any> };
import type { Ask } from './model';
import type { Call, CallState, Result, Snapshot } from '../../data';
const f = vi.hoisted(() => ({ snapshot: {records:[] as Ask[],status:'live'} as Snapshot<Ask>, listeners:new Set<()=>void>(), call:vi.fn(), markRead:vi.fn(), identity:{records:[{id:'jonathan',member:'jonathan'}],status:'live'} as Snapshot<any>, marks:{records:[],status:'live'} as Snapshot<any> }));
vi.mock('../../data',()=>({useRecords:(type:string)=>useSyncExternalStore(fn=>{f.listeners.add(fn);return()=>{f.listeners.delete(fn);};},()=>type==='household.preferences'?f.identity:type==='attention.readMark'?f.marks:f.snapshot),call:(op:string,input:unknown)=>op==='attention.markRead'?f.markRead(op,input):f.call(op,input)}));
vi.mock('../../lib/cojeev-motion/use-reduced-motion',()=>({useReducedMotion:()=>true}));
import InboxApp, { AskReader } from './index';
import { listedAsks, decisionLink, safeHref } from './model';
(globalThis as typeof globalThis & {IS_REACT_ACT_ENVIRONMENT:boolean}).IS_REACT_ACT_ENVIRONMENT = true;
const ask = (id='ask-1', fields:Partial<Ask>={}):Ask=>({id,agent:'art',ask:'Continue the work?',why:'A useful result',if_yes:'I continue.',if_no:'I stop.',answers:'yes-no',source:{kind:'piece',id:'test'},state:'open',createdAt:1,changedAt:1,...fields});
function request<T>() {
  let state:CallState<T>={pending:true,status:'pending'}, resolve:(r:Result<T>)=>void;
  const listeners=new Set<()=>void>();
  const call:Call<T>={id:'one-request',result:new Promise(r=>{resolve=r;}),getSnapshot:()=>state,subscribe:fn=>{listeners.add(fn);return()=>{listeners.delete(fn);};}};
  return {call, async finish(result:Result<T>) { await act(async()=>{state={pending:false,status:'done',result};resolve!(result);listeners.forEach(fn=>fn());}); }};
}
let tree:ReturnType<typeof create> | undefined;
const draw=async(element:ReactElement)=>{await act(async()=>{tree=create(element);});if(buttons('Check again').length) await click('Check again');};
const text=()=>JSON.stringify(tree!.toJSON());
const words=(n:Node|string):string=>typeof n==='string'?n:(n.children??[]).map(words).join('');
const buttons=(label:string)=>tree!.root.findAllByType('button').filter((b:Node)=>words(b)===label);
const click=async(label:string)=>act(async()=>{buttons(label)[0].props.onClick({preventDefault(){}});});
async function publish(snapshot:Snapshot<Ask>) { await act(async()=>{f.snapshot=snapshot;f.listeners.forEach(fn=>fn());}); }
beforeEach(()=>{f.markRead.mockReset().mockReturnValue({result:Promise.resolve({ok:true})});f.identity={records:[{id:'jonathan',member:'jonathan'}],status:'live'};f.marks={records:[],status:'live'};f.call.mockReset();f.listeners.clear();f.snapshot={records:[ask()],status:'live'};});
afterEach(async()=>{await act(async()=>tree?.unmount());tree=undefined;});
it('shows central needs, agent folders, answered history, full details and search, and clears the reader on scope loss',async()=>{
  const go=vi.fn();
  f.snapshot={records:[ask(),ask('other',{agent:'mark',ask:'Review the plan?'}),ask('done',{state:'answered',ask:'Finished question',answer:{kind:'done',by:{kind:'member',id:'jonathan'},at:2}})],status:'live'};
  f.call.mockReturnValue(request<Ask>().call);
  await draw(h<{path?:string;go?:(path:string)=>void}>(InboxApp,{go,path:'/p/inbox-preview/ask/ask-1'}));
  for(const word of ['Needs you','Answered','By agent','mark','I continue.','I stop.']) expect(text()).toContain(word);
  expect(text()).not.toContain('Finished question');
  await click('Answered1');
  expect(text()).toContain('Finished question');
  await act(async()=>tree!.root.findByProps({type:'search'}).props.onChange({target:{value:'nothing'}}));
  expect(text()).toContain('Nothing matches');
  for(const status of ['offline','denied','live'] as const) {
    await publish({records:[],status});
    expect(text()).not.toContain('I continue.');
    if(status!=='live') expect(tree!.root.findAllByProps({role:'alert'}).length).toBeGreaterThan(0);
  }
});
it('requires a daemon confirmation before showing buttons and a fresh check before recording, with one pending write',async()=>{
  const shown=request<Ask>(),fresh=request<Ask>(),write=request<Ask>();
  f.call.mockReturnValueOnce(shown.call).mockReturnValueOnce(fresh.call).mockReturnValueOnce(write.call);
  await draw(h(AskReader,{ask:ask(),snapshot:f.snapshot,go:vi.fn()}));
  expect(buttons('Yes')).toHaveLength(0);
  await shown.finish({ok:true,value:ask()}); expect(buttons('Yes')).toHaveLength(1);
  await click('Yes'); await click('No');
  expect(f.call).toHaveBeenCalledTimes(2); expect(f.call).toHaveBeenLastCalledWith('attention.get',{id:'ask-1'});
  await fresh.finish({ok:true,value:ask()});
  expect(f.call).toHaveBeenCalledTimes(3); expect(f.call).toHaveBeenLastCalledWith('attention.answer',{id:'ask-1',answer:{kind:'yes'}});
  expect(buttons('Yes')).toHaveLength(0); expect(text()).toContain('Recording answer');
  await write.finish({ok:false,code:'denied',message:'Access changed'}); expect(text()).toContain('Access changed');
});
it.each(['gone','denied','offline','changed','unmounted'] as const)('sends nothing when the immediate check is %s',async(mode)=>{
  const shown=request<Ask>(),fresh=request<Ask>(); f.call.mockReturnValueOnce(shown.call).mockReturnValueOnce(fresh.call);
  await draw(h<{path?:string;go?:(path:string)=>void}>(InboxApp,{path:'/p/inbox-preview/ask/ask-1',go:vi.fn()}));
  await shown.finish({ok:true,value:ask()}); await click('Yes');
  if(mode==='offline') await publish({records:[],status:'offline'});
  if(mode==='changed') await publish({records:[ask('ask-1',{why:'Changed'})],status:'live'});
  if(mode==='unmounted') {await act(async()=>tree!.unmount());tree=undefined;}
  await fresh.finish(mode==='denied'?{ok:false,code:'denied',message:'Denied'}:{ok:true,value:ask('ask-1',{state:mode==='gone'?'answered':'open'})});
  expect(f.call.mock.calls.filter(([op])=>op==='attention.answer')).toHaveLength(0);
});
it.each(['words','yes-no',undefined] as const)('records words in mode %s, keeps the draft on refusal, and guards alternate answers while words are unsent',async(answers)=>{
  const wordsAsk=ask('ask-1',{answers}),shown=request<Ask>(),fresh=request<Ask>(),write=request<Ask>();
  f.call.mockReturnValueOnce(shown.call).mockReturnValueOnce(fresh.call).mockReturnValueOnce(write.call);
  await draw(h(AskReader,{ask:wordsAsk,snapshot:{records:[wordsAsk],status:'live'},go:vi.fn()}));
  await shown.finish({ok:true,value:wordsAsk}); expect(buttons('Yes')).toHaveLength(answers==='words'?0:1);
  await act(async()=>tree!.root.findByType('textarea').props.onChange({target:{value:'A considered answer'}}));
  expect(buttons('Mark done')[0].props.disabled).toBe(true);expect(buttons('Dismiss')[0].props.disabled).toBe(true);
  for(const label of ['Yes','No']) if(buttons(label).length) expect(buttons(label)[0].props.disabled).toBe(true);
  await click('Record answer');await fresh.finish({ok:true,value:wordsAsk});
  expect(f.call).toHaveBeenLastCalledWith('attention.answer',{id:'ask-1',answer:{kind:'words',text:'A considered answer'}});
  await write.finish({ok:false,code:'conflict',message:'Already answered'});
  const retry=request<Ask>();f.call.mockReturnValueOnce(retry.call); await click('Check again');await retry.finish({ok:true,value:wordsAsk});
  expect(tree!.root.findByType('textarea').props.value).toBe('A considered answer');
});
it.each([{waits_on:{approval:'a-12345678'}},{source:{kind:'approval' as const,id:'a-12345678'}},{waits_on:{task:'t-1'}},{source:{kind:'task' as const,id:'t-1'}},{member:'jonathan'}])('keeps source-owned decisions and private replies out of central answer controls (%j)',async(fields)=>{
  const record=ask('ask-1',fields),go=vi.fn();
  await draw(h(AskReader,{ask:record,snapshot:{records:[record],status:'live'},go}));
  expect(f.call).not.toHaveBeenCalled();expect(buttons('Yes')).toHaveLength(0);expect(buttons('Mark done')).toHaveLength(0);expect(tree!.root.findAllByType('textarea')).toHaveLength(0);
  const link=decisionLink(record);if(link){await click(link.label);expect(go).toHaveBeenCalledWith(link.path);}
});
it('allows only HTTP(S) authored references',()=>{expect(safeHref('javascript:alert(1)')).toBeUndefined();expect(safeHref('//host')).toBeUndefined();expect(safeHref('https://example.com/')).toBe('https://example.com/');});
it.each(['no','done','dismiss'] as const)('records %s after its own fresh check',async(kind)=>{
  const shown=request<Ask>(),fresh=request<Ask>(),write=request<Ask>();f.call.mockReturnValueOnce(shown.call).mockReturnValueOnce(fresh.call).mockReturnValueOnce(write.call);
  await draw(h(AskReader,{ask:ask(),snapshot:f.snapshot,go:vi.fn()}));await shown.finish({ok:true,value:ask()});
  await click(kind==='no'?'No':kind==='done'?'Mark done':'Dismiss');await fresh.finish({ok:true,value:ask()});
  expect(f.call).toHaveBeenLastCalledWith('attention.answer',{id:'ask-1',answer:{kind}});await write.finish({ok:true,value:ask('ask-1',{state:'answered'})});
});
it('sorts agent folders, filters them and includes resolved asks in history with references and full answer',async()=>{
  const resolved=ask('resolved',{agent:'zeta',state:'resolved',resolution:'Closed elsewhere',ask:'Resolved question',href:'https://example.com/record',refs:['t-2205'],answer:{kind:'words',text:'A recorded answer',by:{kind:'member',id:'jonathan'},at:Date.parse('2026-11-13T06:00:00Z')}});
  f.snapshot={records:[ask('z',{agent:'zeta',ask:'Zeta question'}),resolved,ask('a',{agent:'alpha',ask:'Alpha question'})],status:'live'};
  await draw(h<{path?:string;go?:(path:string)=>void}>(InboxApp,{go:vi.fn(),path:'/p/inbox-preview/ask/resolved'}));
  const folders=tree!.root.findAllByType('button').map(words);expect(folders.indexOf('alpha1')).toBeLessThan(folders.indexOf('zeta1'));
  await click('alpha1');expect(tree!.root.findAllByProps({'data-split-row':''}).map(words).join(' ')).toContain('Alpha question');expect(tree!.root.findAllByProps({'data-split-row':''}).map(words).join(' ')).not.toContain('Zeta question');
  await click('Answered1');expect(tree!.root.findAllByProps({'data-split-row':''}).map(words).join(' ')).toContain('Resolved question');
  for(const word of ['Closed elsewhere','t-2205','A recorded answer','jonathan','11/13/2026','12:00:00 AM','CT'])expect(text()).toContain(word);
  expect(tree!.root.findByType('a').props.href).toBe('https://example.com/record');
});
it('keeps one pending write above reader navigation and never claims delivery',async()=>{
  const first=ask(),second=ask('ask-2',{ask:'Another question'}),shown=request<Ask>(),fresh=request<Ask>(),write=request<Ask>(),other=request<Ask>();
  f.snapshot={records:[first,second],status:'live'};
  f.call.mockReturnValueOnce(shown.call).mockReturnValueOnce(fresh.call).mockReturnValueOnce(write.call).mockReturnValueOnce(other.call);
  await draw(h(InboxApp));
  const firstRow=tree!.root.findAllByProps({'data-split-row':''}).find((n:Node)=>words(n).includes('Continue the work?'))!;
  await act(async()=>firstRow.props.onClick());await shown.finish({ok:true,value:first});
  expect(text()).toContain('Delivery to the agent is not connected');
  await click('Yes');await fresh.finish({ok:true,value:first});
  const row=tree!.root.findAllByProps({'data-split-row':''}).find((n:Node)=>words(n).includes('Another question'))!;
  await act(async()=>row.props.onClick());
  expect(buttons('Yes')).toHaveLength(0);expect(buttons('Check again')[0].props.disabled).toBe(true);
  expect(f.call).toHaveBeenCalledTimes(3);
  await write.finish({ok:true,value:{...first,state:'answered'}});
  await click('Check again');await other.finish({ok:true,value:second});
  expect(tree!.root.findByType('fieldset').props.disabled).toBe(false);
  expect(f.call.mock.calls.filter(([op])=>op==='attention.answer')).toHaveLength(1);
});

it('serializes display checks and does not revive them when history remounts a reader',async()=>{
  const shown=request<Ask>();f.call.mockReturnValueOnce(shown.call);
  f.snapshot={records:[ask(),ask('ask-2')],status:'live'};
  await draw(h(InboxApp));
  await act(async()=>tree!.root.findAllByProps({'data-split-row':''})[0].props.onClick());
  expect(buttons('Check again')[0].props.disabled).toBe(true);await click('Check again');expect(f.call).toHaveBeenCalledTimes(1);
  await act(async()=>tree!.update(h<{path?:string}>(InboxApp,{path:'/p/inbox-preview'})));
  await act(async()=>tree!.update(h<{path?:string}>(InboxApp,{path:'/p/inbox-preview/ask/ask-1'})));
  await shown.finish({ok:true,value:ask()});
  expect(buttons('Yes')).toHaveLength(0);expect(buttons('Check again')[0].props.disabled).toBe(false);
});
it('invalidates a completed display confirmation on live changes, and reopening the selected row consumes its new read',async()=>{
  const shown=request<Ask>(),reopened=request<Ask>();f.call.mockReturnValueOnce(shown.call).mockReturnValueOnce(reopened.call);
  await draw(h(InboxApp));
  await act(async()=>tree!.root.findAllByProps({'data-split-row':''})[0].props.onClick());await shown.finish({ok:true,value:ask()});expect(buttons('Yes')).toHaveLength(1);
  await publish({records:[ask('ask-1',{why:'New live set'})],status:'live'});expect(buttons('Yes')).toHaveLength(0);
  await act(async()=>tree!.root.findAllByProps({'data-split-row':''})[0].props.onClick());await reopened.finish({ok:true,value:ask()});expect(buttons('Yes')).toHaveLength(1);
  await publish({records:[],status:'offline'});expect(buttons('Yes')).toHaveLength(0);
});
it.each(['denied','closed'] as const)('offers no answer after a %s display read',async(mode)=>{
  const shown=request<Ask>();f.call.mockReturnValueOnce(shown.call);
  await draw(h(AskReader,{ask:ask(),snapshot:f.snapshot,go:vi.fn()}));
  await shown.finish(mode==='denied'?{ok:false,code:'denied',message:'No longer visible'}:{ok:true,value:ask('ask-1',{state:'resolved'})});
  expect(buttons('Yes')).toHaveLength(0);expect(text()).toContain(mode==='denied'?'No longer visible':'This ask is no longer open.');
  expect(f.call).toHaveBeenCalledTimes(1);
});

it.each(['yes-no','words'] as const)('keeps a source-managed %s ask in its declared mode',async(answers)=>{
  const record=ask('managed',{sourceManaged:true,answers}),shown=request<Ask>();
  f.call.mockReturnValueOnce(shown.call);
  await draw(h(AskReader,{ask:record,snapshot:{records:[record],status:'live'},go:vi.fn()}));
  await shown.finish({ok:true,value:record});
  expect(buttons('Yes')).toHaveLength(answers==='words'?0:1);
  expect(tree!.root.findAllByType('textarea')).toHaveLength(answers==='words'?1:0);
});

it('automatically checks visible waits on Inbox arrival, each minute and reconnect, and stops on unmount',async()=>{
  vi.useFakeTimers();
  try {
    f.snapshot={records:[ask('wait',{waits_on:{task:'t-1'}})],status:'live'};
    f.call.mockImplementation(()=>({result:Promise.resolve({ok:false,code:'denied',message:'Held'})}));
    await act(async()=>{tree=create(h(InboxApp));});
    expect(f.call).toHaveBeenCalledExactlyOnceWith('attention.checkWait',{id:'wait'});
    await act(async()=>{await vi.advanceTimersByTimeAsync(60_000);});expect(f.call).toHaveBeenCalledTimes(2);
    await publish({records:[],status:'offline'});
    await act(async()=>{await vi.advanceTimersByTimeAsync(60_000);});expect(f.call).toHaveBeenCalledTimes(2);
    await publish({records:[ask('wait',{waits_on:{task:'t-1'}})],status:'live'});expect(f.call).toHaveBeenCalledTimes(3);
    await act(async()=>tree!.unmount());tree=undefined;
    await act(async()=>{await vi.advanceTimersByTimeAsync(120_000);});expect(f.call).toHaveBeenCalledTimes(3);
  } finally {vi.useRealTimers();}
});

it('shows member read facts live without removing open asks, and marks a direct reader only as its authenticated member',async()=>{
  f.call.mockReturnValue(request<Ask>().call);
  await draw(h<{path?:string;go?:(path:string)=>void}>(InboxApp,{path:'/p/inbox-preview/ask/ask-1',go:vi.fn()}));
  expect(f.markRead).toHaveBeenCalledExactlyOnceWith('attention.markRead',{id:'ask-1'});
  const rows=()=>tree!.root.findAllByProps({'data-split-row':''});
  expect(rows()[0].props['data-unread']).toBe(true);expect(buttons('Needs you1')).toHaveLength(1);
  await act(async()=>{f.marks={records:[{id:'read',ask:'ask-1',member:'jonathan',readAt:2}],status:'live'};f.listeners.forEach(fn=>fn());});
  expect(rows()[0].props['data-unread']).toBeUndefined();expect(words(rows()[0])).toContain('Read');expect(buttons('Needs you1')).toHaveLength(1);
  await act(async()=>{f.marks={records:[],status:'offline'};f.listeners.forEach(fn=>fn());});
  expect(words(rows()[0])).toContain('Read state unavailable');
  await act(async()=>{f.identity={records:[],status:'denied'};f.listeners.forEach(fn=>fn());});
  expect(text()).not.toContain('I continue.');expect(tree!.root.findAllByType('textarea')).toHaveLength(0);
});

it('keeps the persistent Inbox draft through failed answers and remounts, then clears only an acknowledged send',async()=>{
  const data=new Map<string,string>();vi.stubGlobal('localStorage',{getItem:(k:string)=>data.get(k)??null,setItem:(k:string,v:string)=>data.set(k,v),removeItem:(k:string)=>data.delete(k)});
  try {
    const shown=request<Ask>(),fresh=request<Ask>(),write=request<Ask>();
    f.call.mockReturnValueOnce(shown.call).mockReturnValueOnce(fresh.call).mockReturnValueOnce(write.call);
    const element=h<{path?:string;go?:(path:string)=>void}>(InboxApp,{path:'/p/inbox-preview/ask/ask-1',go:vi.fn()});
    await draw(element);await shown.finish({ok:true,value:ask()});
    await act(async()=>tree!.root.findByType('textarea').props.onChange({target:{value:'A saved answer'}}));
    await click('Record answer');await fresh.finish({ok:true,value:ask()});await write.finish({ok:false,code:'denied',message:'Held'});
    expect([...data.values()]).toContain('A saved answer');
    await act(async()=>tree!.unmount());tree=undefined;
    const reopened=request<Ask>(),nextFresh=request<Ask>(),success=request<Ask>();
    f.call.mockReturnValueOnce(reopened.call).mockReturnValueOnce(nextFresh.call).mockReturnValueOnce(success.call);
    await draw(element);await reopened.finish({ok:true,value:ask()});
    expect(tree!.root.findByType('textarea').props.value).toBe('A saved answer');
    await click('Record answer');await nextFresh.finish({ok:true,value:ask()});await success.finish({ok:true,value:ask('ask-1',{state:'answered'})});
    expect([...data.values()]).not.toContain('A saved answer');
  } finally {vi.unstubAllGlobals();}
});

it('counts a same-audience approval wait once and retains different/private audiences and direct records',()=>{
  const approval=ask('source',{source:{kind:'approval',id:'a-12345678'},sourceManaged:true,project:'pond'});
  const wait=ask('wait',{source:{kind:'conversation',id:'cv-one'},project:'pond',waits_on:{approval:'a-12345678'}});
  expect(listedAsks([approval,wait])).toEqual([wait]);
  for(const changed of [{agent:'mark'},{project:'other'},{member:'jonathan'},{state:'resolved' as const},{sourceManaged:true},{source:{kind:'piece' as const,id:'fixture'}}])expect(listedAsks([approval,{...wait,...changed}])).toHaveLength(2);
  expect(listedAsks([{...approval,state:'resolved'},wait])).toHaveLength(2);
  expect([approval,wait]).toHaveLength(2);
});

it('renders one Needs-you decision for a matching approval wait while direct source navigation stays available',async()=>{
  const source=ask('source',{source:{kind:'approval',id:'a-12345678'},sourceManaged:true});
  const wait=ask('wait',{source:{kind:'conversation',id:'cv-one'},waits_on:{approval:'a-12345678'}});
  f.snapshot={status:'live',records:[source,wait]};
  await draw(h(InboxApp,{path:'/p/inbox-preview/ask/source'}));
  expect(tree!.root.findAll(n=>n.props['data-split-row']!==undefined)).toHaveLength(1);expect(buttons('Needs you1')).toHaveLength(1);expect(buttons('Open approval')).toHaveLength(1);
});
