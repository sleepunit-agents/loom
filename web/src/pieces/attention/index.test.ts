import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createElement as h, useSyncExternalStore } from 'react';
// @ts-expect-error The existing react-test-renderer dependency ships without declarations.
import { act, create } from 'react-test-renderer';
import type { ReactElement } from 'react';
// Renderer props include arbitrary DOM attributes and callbacks; tests invoke them dynamically.
type Node = { children: Array<Node|string>; props: Record<string, any> };
import type { Ask } from './model';
import type { Call, CallState, Result, Snapshot } from '../../data';
const f = vi.hoisted(() => ({ snapshot: {records:[] as Ask[],status:'live'} as Snapshot<Ask>, listeners:new Set<()=>void>(), call:vi.fn(), privateCall:vi.fn(), markRead:vi.fn(), identity:{records:[{id:'jonathan',member:'jonathan'}],status:'live'} as Snapshot<any>, outcomes:{records:[],status:'live'} as Snapshot<any>, marks:{records:[],status:'live'} as Snapshot<any> }));
vi.mock('../../data',()=>({useRecords:(type:string)=>useSyncExternalStore(fn=>{f.listeners.add(fn);return()=>{f.listeners.delete(fn);};},()=>type==='household.preferences'?f.identity:type==='attention.readMark'?f.marks:type==='attention.outcome'?f.outcomes:f.snapshot),callOnce:(op:string,input:unknown)=>f.privateCall(op,input),call:(op:string,input:unknown)=>['attention.markRead','attention.readOutcome'].includes(op)?f.markRead(op,input):f.call(op,input)}));
vi.mock('../../lib/cojeev-motion/use-reduced-motion',()=>({useReducedMotion:()=>true}));
import { AskReader } from './index';
import { inFolder, matches, listedAsks, decisionLink, safeHref } from './model';
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
beforeEach(()=>{f.markRead.mockReset().mockReturnValue({result:Promise.resolve({ok:true})});f.identity={records:[{id:'jonathan',member:'jonathan'}],status:'live'};f.marks={records:[],status:'live'};f.outcomes={records:[],status:'live'};f.call.mockReset();f.privateCall.mockReset();f.listeners.clear();f.snapshot={records:[ask()],status:'live'};});
afterEach(async()=>{await act(async()=>tree?.unmount());tree=undefined;});
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

it('counts a same-audience approval wait once and retains different/private audiences and direct records',()=>{
  const approval=ask('source',{source:{kind:'approval',id:'a-12345678'},sourceManaged:true,project:'pond'});
  const wait=ask('wait',{source:{kind:'conversation',id:'cv-one'},project:'pond',waits_on:{approval:'a-12345678'}});
  expect(listedAsks([approval,wait])).toEqual([wait]);
  for(const changed of [{agent:'mark'},{project:'other'},{member:'jonathan'},{state:'resolved' as const},{sourceManaged:true},{source:{kind:'piece' as const,id:'fixture'}},{source:undefined as unknown as Ask['source']}])expect(listedAsks([approval,{...wait,...changed}])).toHaveLength(2);
  expect(listedAsks([{...approval,state:'resolved'},wait])).toHaveLength(2);
  expect([approval,wait]).toHaveLength(2);
});

it('chooses one stable conversation representative across multiple waits for the same decision',()=>{
  const source=ask('source',{sourceManaged:true,source:{kind:'approval',id:'a-12345678'}});
  const old=ask('a',{source:{kind:'conversation',id:'cv-a'},waits_on:{approval:'a-12345678'},createdAt:1});
  const tied={...old,id:'b'},newer={...old,id:'c',createdAt:2};
  expect(listedAsks([newer,tied,source,old])).toEqual([old]);
  expect(listedAsks([old,source,tied,newer])).toEqual([old]);
  expect(listedAsks([source,{...old,state:'resolved'},tied,newer])).toEqual([{...old,state:'resolved'},tied]);
  expect(listedAsks([source,old,{...tied,member:'jonathan'}])).toHaveLength(2);
});

it('acknowledges Clock notices through a fresh central check and navigates canonically',async()=>{
  const record=ask('clock:w-1:failed',{sourceManaged:true,source:{kind:'piece',id:'clock'},href:'/p/clock-preview',answers:undefined});
  const shown=request<Ask>(),fresh=request<Ask>(),write=request<Ask>(),go=vi.fn();
  f.call.mockReturnValueOnce(shown.call).mockReturnValueOnce(fresh.call).mockReturnValueOnce(write.call);
  await draw(h(AskReader,{ask:record,snapshot:{records:[record],status:'live'},go}));
  await shown.finish({ok:true,value:record});
  expect(buttons('Yes')).toHaveLength(0);expect(buttons('Dismiss')).toHaveLength(0);expect(tree!.root.findAllByType('textarea')).toHaveLength(0);
  expect(text()).toContain('does not retry or cancel');
  await click('Open Clock');expect(go).toHaveBeenCalledWith('/p/clock-preview');
  await click('Acknowledge');expect(f.call).toHaveBeenLastCalledWith('attention.get',{id:record.id});
  await fresh.finish({ok:true,value:record});
  expect(f.call).toHaveBeenLastCalledWith('attention.answer',{id:record.id,answer:{kind:'done'}});
  await write.finish({ok:true,value:{...record,state:'answered'}});expect(text()).toContain('Alert acknowledged');
});
const privateAsk=()=>ask('private',{member:'jonathan',source:{kind:'conversation',id:'cv-private'},answers:'yes-no'});
it('sends private words only through Comms after fresh checks, keeps refused words and clears an acknowledged draft',async()=>{
  const record=privateAsk(),shown=request<Ask>(),fresh=request<Ask>(),write=request<unknown>();
  const snapshot:Snapshot<Ask>={records:[record],status:'live'};
  f.call.mockReturnValueOnce(shown.call).mockReturnValueOnce(fresh.call);f.privateCall.mockReturnValueOnce(write.call);
  await draw(h(AskReader,{ask:record,snapshot,go:vi.fn()}));await shown.finish({ok:true,value:record});
  for(const label of ['Yes','No','Mark done','Dismiss'])expect(buttons(label)).toHaveLength(0);
  const edit=async(value:string)=>act(async()=>tree!.root.findByType('textarea').props.onChange({target:{value}}));
  expect(tree!.root.findByType('textarea').props.maxLength).toBe(4000);
  await edit('x'.repeat(4001));expect(buttons('Send private reply')[0].props.disabled).toBe(true);await click('Send private reply');expect(f.call).toHaveBeenCalledTimes(1);
  await edit('Private answer');await click('Send private reply');await click('Send private reply');
  expect(f.privateCall).not.toHaveBeenCalled();await fresh.finish({ok:true,value:record});
  expect(f.privateCall).toHaveBeenCalledExactlyOnceWith('comms.replyToAsk',{ref:'private',text:'Private answer'});
  expect(f.call.mock.calls.every(([op])=>op==='attention.get')).toBe(true);
  await write.finish({ok:false,code:'unavailable',message:'Connection closed'});
  const checked=request<Ask>(),next=request<Ask>(),saved=request<unknown>();
  f.call.mockReturnValueOnce(checked.call).mockReturnValueOnce(next.call);f.privateCall.mockReturnValueOnce(saved.call);
  await click('Check again');await checked.finish({ok:true,value:record});
  expect(tree!.root.findByType('textarea').props.value).toBe('Private answer');
  await click('Send private reply');await next.finish({ok:true,value:record});await saved.finish({ok:true,value:{thread:'th:one',seq:2}});
  expect(text()).toContain('Private reply saved in Comms');
  const last=request<Ask>();f.call.mockReturnValueOnce(last.call);await click('Check again');await last.finish({ok:true,value:record});
  expect(tree!.root.findByType('textarea').props.value).toBe('');
});
it('keeps managed private asks with their owning actions',async()=>{
  const record=privateAsk();
  for(const extra of [{sourceManaged:true as const},{waits_on:{task:'t-1'}}]){
    await draw(h(AskReader,{ask:{...record,...extra},snapshot:{records:[record],status:'live'},go:vi.fn()}));
    expect(buttons('Send private reply')).toHaveLength(0);
  }
});

it('routes sealed questions to their owning encrypted reader and opens reference-only reply history',async()=>{
  const sealed={...privateAsk(),privateQuestion:{thread:'th:abc',seq:2}},go=vi.fn();
  await draw(h(AskReader,{ask:sealed,snapshot:{records:[sealed],status:'live'},go}));
  expect(buttons('Send private reply')).toHaveLength(0);expect(f.call).not.toHaveBeenCalled();
  await click('Open private conversation');expect(go).toHaveBeenLastCalledWith('/p/comms-preview/thread/abc');
  const answered={...privateAsk(),state:'answered' as const,answer:{kind:'replied',reply:{thread:'th:abc',seq:3},by:{kind:'member',id:'jonathan'},at:3}};
  await act(async()=>tree!.update(h(AskReader,{ask:answered,snapshot:{records:[answered],status:'live'},go})));
  await click('Open private reply');expect(go).toHaveBeenLastCalledWith('/p/comms-preview/thread/abc');
  expect(text()).not.toContain('Private answer');
});

it('keeps Approvals reported-step FYIs in FYI with an owning navigation action and no answer controls',async()=>{
  const notice=ask('approval-notice:event',{ask:'Merge reported in Approvals',sourceManaged:true,source:{kind:'piece',id:'approvals-notices'},state:'resolved',answers:undefined,if_yes:undefined,if_no:undefined});
  expect(inFolder(notice,'fyi')).toBe(true);expect(inFolder(notice,'needs')).toBe(false);
  expect(decisionLink(notice)).toEqual({path:'/p/approvals-preview/notices',label:'Open Approvals'});
  const go=vi.fn();await draw(h(AskReader,{ask:notice,go,snapshot:{records:[notice],status:'live'}}));
  expect(text()).toContain('Open Approvals');expect(buttons('Yes')).toHaveLength(0);expect(buttons('No')).toHaveLength(0);
  await click('Open Approvals');expect(go).toHaveBeenCalledWith('/p/approvals-preview/notices');
});
it.each(['piece','conversation'] as const)('does not infer delivery or reading from %s source text; a refused public answer retains its draft for a checked retry',async(kind)=>{
  const record=ask('ask-1',{source:{kind,id:'runtime-clock'}}),snapshot:Snapshot<Ask>={records:[record],status:'live'};
  const shown=request<Ask>(),fresh=request<Ask>(),write=request<Ask>();
  f.call.mockReturnValueOnce(shown.call).mockReturnValueOnce(fresh.call).mockReturnValueOnce(write.call);
  await draw(h(AskReader,{ask:record,snapshot,go:vi.fn()}));await shown.finish({ok:true,value:record});
  expect(text()).toContain('When the conversation supports delivery');expect(text()).toContain('Saved does not mean read');
  expect(text()).toContain('Mark done and Dismiss send no message');
  expect(text()).not.toContain('not connected in this preview');
  await act(async()=>tree!.root.findByType('textarea').props.onChange({target:{value:'  Keep these exact words.  '}}));
  await click('Record answer');await fresh.finish({ok:true,value:record});
  await write.finish({ok:false,code:'denied',message:'Original public answer destination ended'});
  expect(text()).toContain('Original public answer destination ended');expect(text()).not.toContain('Answer recorded');
  const retry=request<Ask>(),retryFresh=request<Ask>(),accepted=request<Ask>();
  f.call.mockReturnValueOnce(retry.call).mockReturnValueOnce(retryFresh.call).mockReturnValueOnce(accepted.call);
  await click('Check again');await retry.finish({ok:true,value:record});
  expect(tree!.root.findByType('textarea').props.value).toBe('  Keep these exact words.  ');
  await click('Record answer');await retryFresh.finish({ok:true,value:record});
  expect(f.call).toHaveBeenLastCalledWith('attention.answer',{id:record.id,answer:{kind:'words',text:'  Keep these exact words.  '}});
  await accepted.finish({ok:true,value:{...record,state:'answered'}});
  expect(text()).toContain('Answer recorded');expect(text()).not.toContain('Answer delivered');
});
