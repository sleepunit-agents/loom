import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createElement as h, useSyncExternalStore } from '../../web/node_modules/react/index.js';
import { act, create } from '../../web/node_modules/react-test-renderer/index.js';
import type { Ask } from '../../web/src/pieces/attention/model';
import type { Call, CallState, Result, Snapshot } from '../../web/src/data';
const f = vi.hoisted(() => ({ snapshot: {records:[] as Ask[],status:'live'} as Snapshot<Ask>, listeners:new Set<()=>void>(), call:vi.fn() }));
vi.mock('../../web/src/data',()=>({useRecords:()=>useSyncExternalStore(fn=>{f.listeners.add(fn);return()=>{f.listeners.delete(fn);};},()=>f.snapshot),call:f.call}));
vi.mock('../../web/src/lib/cojeev-motion/use-reduced-motion',()=>({useReducedMotion:()=>true}));
import InboxApp, { AskReader } from '../../web/src/pieces/attention';
import { decisionLink, safeHref } from '../../web/src/pieces/attention/model';
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
const ask = (id='ask-1', fields:Partial<Ask>={}):Ask=>({id,agent:'art',ask:'Continue the work?',why:'A useful result',if_yes:'I continue.',if_no:'I stop.',answers:'yes-no',source:{kind:'piece',id:'test'},state:'open',createdAt:1,changedAt:1,...fields});
function request<T>() {
  let state:CallState<T>={pending:true,status:'pending'}, resolve:(r:Result<T>)=>void;
  const listeners=new Set<()=>void>();
  const call:Call<T>={id:'one-request',result:new Promise(r=>{resolve=r;}),getSnapshot:()=>state,subscribe:fn=>{listeners.add(fn);return()=>{listeners.delete(fn);};}};
  return {call, async finish(result:Result<T>) { await act(async()=>{state={pending:false,status:'done',result};resolve!(result);listeners.forEach(fn=>fn());}); }};
}
let tree:ReturnType<typeof create> | undefined;
const draw=async(element:any)=>{await act(async()=>{tree=create(element);});};
const text=()=>JSON.stringify(tree!.toJSON());
const words=(n:any):string=>typeof n==='string'?n:(n.children??[]).map(words).join('');
const buttons=(label:string)=>tree!.root.findAllByType('button').filter(b=>words(b)===label);
const click=async(label:string)=>act(async()=>{buttons(label)[0].props.onClick();});
async function publish(snapshot:Snapshot<Ask>) { await act(async()=>{f.snapshot=snapshot;f.listeners.forEach(fn=>fn());}); }
beforeEach(()=>{f.call.mockReset();f.listeners.clear();f.snapshot={records:[ask()],status:'live'};});
afterEach(async()=>{await act(async()=>tree?.unmount());tree=undefined;});
it('shows central needs, agent folders, answered history, full details and search, and clears the reader on scope loss',async()=>{
  const go=vi.fn();
  f.snapshot={records:[ask(),ask('other',{agent:'mark',ask:'Review the plan?'}),ask('done',{state:'answered',ask:'Finished question',answer:{kind:'done',by:{kind:'member',id:'jonathan'},at:2}})],status:'live'};
  f.call.mockReturnValue(request<Ask>().call);
  await draw(h(InboxApp,{go,path:'/p/inbox-preview/ask/ask-1'}));
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
  await draw(h(InboxApp,{path:'/p/inbox-preview/ask/ask-1',go:vi.fn()}));
  await shown.finish({ok:true,value:ask()}); await click('Yes');
  if(mode==='offline') await publish({records:[],status:'offline'});
  if(mode==='changed') await publish({records:[ask('ask-1',{why:'Changed'})],status:'live'});
  if(mode==='unmounted') {await act(async()=>tree!.unmount());tree=undefined;}
  await fresh.finish(mode==='denied'?{ok:false,code:'denied',message:'Denied'}:{ok:true,value:ask('ask-1',{state:mode==='gone'?'answered':'open'})});
  expect(f.call.mock.calls.filter(([op])=>op==='attention.answer')).toHaveLength(0);
});
it('records words only in words mode, keeps the draft on refusal, and disables done/dismiss while words are unsent',async()=>{
  const wordsAsk=ask('ask-1',{answers:'words'}),shown=request<Ask>(),fresh=request<Ask>(),write=request<Ask>();
  f.call.mockReturnValueOnce(shown.call).mockReturnValueOnce(fresh.call).mockReturnValueOnce(write.call);
  await draw(h(AskReader,{ask:wordsAsk,snapshot:{records:[wordsAsk],status:'live'},go:vi.fn()}));
  await shown.finish({ok:true,value:wordsAsk}); expect(buttons('Yes')).toHaveLength(0);
  await act(async()=>tree!.root.findByType('textarea').props.onChange({target:{value:'A considered answer'}}));
  expect(buttons('Mark done')[0].props.disabled).toBe(true);expect(buttons('Dismiss')[0].props.disabled).toBe(true);
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
