import { afterEach, expect, it, vi } from 'vitest';
import { createElement as h } from '../../web/node_modules/react/index.js';
import { act, create } from '../../web/node_modules/react-test-renderer/index.js';
import type { CallState, Snapshot } from '../../web/src/data/store';
const f=vi.hoisted(()=>({feed:{records:[],status:'live'} as Snapshot,detail:{records:[],status:'live'} as Snapshot,access:{records:[{id:'knowledge',allowed:true,canVerify:true,canRecheck:true}],status:'live'} as Snapshot,call:vi.fn()}));
vi.mock('../../web/src/memory/commands',()=>({memoryCall:f.call}));
vi.mock('../../web/src/memory/query',()=>({useMemoryQuery:(s:any)=>s?.query.includes('HouseholdTimezone')?{status:'live',value:'America/Chicago'}:s?.query.includes('MemoryKnowledgeAccess')?{status:f.access.status,value:f.access.records[0]}:s?.query.includes('query MemoryKnowledge {')?{status:f.feed.status,value:{pages:f.feed.records}}:{status:f.detail.status,value:f.detail.records[0]??null}}));
vi.mock('../../web/src/kit',()=>({
  Search:'input',Reader:'article',Title:'h1',Meta:'p',Section:'section',Facts:'dl',Fact:'dd',
  Markdown:(p:{text:string})=>h('div',null,p.text),
  Split:(p:{list:unknown;reader:unknown;listAction:unknown})=>h('div',null,p.listAction,p.list,p.reader),List:(p:{children:unknown})=>h('div',null,p.children),Row:(p:{title:string;meta?:string;onClick:()=>void})=>h('button',{onClick:p.onClick},p.title,p.meta),
  Empty:(p:{title:string})=>h('p',null,p.title),Loading:(p:{label:string})=>h('p',null,p.label),Error:(p:{text:string})=>h('p',null,p.text),Input:'input',Textarea:'textarea',Button:'button',
}));
import Knowledge from '../../web/src/pieces/knowledge/index';
// React's renderer uses this documented global to flush updates in act().
(globalThis as typeof globalThis & {IS_REACT_ACT_ENVIRONMENT:boolean}).IS_REACT_ACT_ENVIRONMENT=true;
const page={id:'fact',slug:'fact',title:'Fact',domain:'systems',body:'Words',updated:'2026-11-12T00:00:00Z',fresh:'fresh',sources:[],citedBy:[]};
const props={path:'/p/knowledge-preview/page/fact',go:()=>{}};
let tree:ReturnType<typeof create>|undefined;
afterEach(async()=>{if(tree)await act(async()=>tree!.unmount());tree=undefined;f.call.mockReset();f.feed={records:[],status:'live'};f.detail={records:[],status:'live'};f.access={records:[{id:'knowledge',allowed:true,canVerify:true,canRecheck:true}],status:'live'};});
const text=()=>JSON.stringify(tree!.toJSON());
it('shows initial reader loading and denies the surface separately from an empty store',async()=>{
  f.feed={records:[],status:'loading'};f.detail={records:[],status:'loading'};
  await act(async()=>{tree=create(h(Knowledge,props));});
  expect(text()).toContain('Opening page');expect(text()).not.toContain('Connection lost');expect(f.call).not.toHaveBeenCalled();
  f.access={records:[{id:'knowledge',allowed:false}],status:'live'};await act(async()=>tree!.update(h(Knowledge,props)));
  expect(text()).toContain('don’t have access');expect(text()).not.toContain('No knowledge yet');
});
it('keeps a pending request and its eventual failure across disconnect and reader navigation',async()=>{
  f.feed={records:[page],status:'live'};f.detail=f.feed;
  let state:CallState={pending:true,status:'pending'};let listener=()=>{};
  const request={id:'same',getSnapshot:()=>state,subscribe:(fn:()=>void)=>{listener=fn;return()=>{};},result:new Promise(()=>{}),retry:vi.fn()};f.call.mockReturnValue(request);
  await act(async()=>{tree=create(h(Knowledge,props));});
  const verify=()=>tree!.root.findAllByType('button').find(button=>button.props.children==='Still true')!;
  await act(async()=>verify().props.onClick());expect(f.call).toHaveBeenCalledTimes(1);expect(verify().props.disabled).toBe(true);
  state={pending:true,status:'offline'};f.feed={records:[],status:'offline'};f.detail=f.feed;f.access={records:[],status:'offline'};
  await act(async()=>{listener();tree!.update(h(Knowledge,props));});expect(text()).toContain('Connection lost');
  f.feed={records:[page],status:'live'};f.detail=f.feed;f.access={records:[{id:'knowledge',allowed:true,canVerify:true,canRecheck:true}],status:'live'};
  await act(async()=>tree!.update(h(Knowledge,props)));expect(verify().props.disabled).toBe(true);expect(text()).toContain('Waiting for connection');
  await act(async()=>tree!.update(h(Knowledge,{...props,path:'/p/knowledge-preview'})));
  await act(async()=>tree!.update(h(Knowledge,props)));expect(verify().props.disabled).toBe(true);expect(f.call).toHaveBeenCalledTimes(1);
  state={pending:false,status:'done',result:{ok:false,code:'denied',message:'Access changed'}};
  await act(async()=>listener());expect(text()).toContain('denied: Access changed');expect(verify().props.disabled).toBe(false);
});

it('freezes an uncertain check and offers an explicit retry of the same request',async()=>{
 f.feed={records:[page],status:'live'};f.detail=f.feed;
 let state:CallState={pending:true,status:'pending'},listener=()=>{};const retry=vi.fn();
 f.call.mockReturnValue({id:'retained-check',getSnapshot:()=>state,subscribe:(fn:()=>void)=>{listener=fn;return()=>{};},result:new Promise(()=>{}),retry});
 await act(async()=>{tree=create(h(Knowledge,props));});
 const verify=()=>tree!.root.findAllByType('button').find(b=>b.props.children==='Still true')!;
 await act(async()=>verify().props.onClick());
 state={pending:false,status:'done',result:{ok:false,code:'unavailable',message:'Uncertain'}};await act(async()=>listener());
 expect(verify().props.disabled).toBe(true);await act(async()=>verify().props.onClick());expect(f.call).toHaveBeenCalledTimes(1);
 await act(async()=>tree!.root.findAllByType('button').find(b=>b.props.children==='Retry this check')!.props.onClick());expect(retry).toHaveBeenCalledTimes(1);
});

it('keeps an uncertain Add request frozen until an explicit same-request retry',async()=>{
 f.access={records:[{id:'knowledge',allowed:true,canAdd:true,canVerify:true,canRecheck:true}],status:'live'};
 let state:CallState={pending:true,status:'pending'},listener=()=>{};const retry=vi.fn();
 f.call.mockReturnValue({id:'retained-add',getSnapshot:()=>state,subscribe:(fn:()=>void)=>{listener=fn;return()=>{};},result:new Promise(()=>{}),retry});
 await act(async()=>{tree=create(h(Knowledge,props));});
 await act(async()=>tree!.root.findAllByType('button').find(b=>b.props.children==='Add a fact')!.props.onClick());
 const submit=()=>tree!.root.findByType('form').props.onSubmit({preventDefault(){}});
 await act(async()=>submit());expect(f.call).toHaveBeenCalledTimes(1);
 state={pending:false,status:'done',result:{ok:false,code:'unavailable',message:'Uncertain'}};await act(async()=>listener());
 expect(tree!.root.findByType('fieldset').props.disabled).toBe(true);await act(async()=>submit());expect(f.call).toHaveBeenCalledTimes(1);
 await act(async()=>tree!.root.findAllByType('button').find(b=>b.props.children==='Retry this save')!.props.onClick());expect(retry).toHaveBeenCalledTimes(1);
 state={pending:false,status:'done',result:{ok:true,value:{slug:'fact'}}};await act(async()=>listener());await act(async()=>submit());expect(f.call).toHaveBeenCalledTimes(1);
});

it('uses the household day in both the list and the open page at midnight UTC',async()=>{
  const entry={...page,verified_at:page.updated,checked:{outcome:'stale',at:page.updated}};
  f.feed={records:[entry],status:'live'};
  f.detail={records:[entry],status:'live'};
  await act(async()=>{tree=create(h(Knowledge,props));});
  expect(text().match(/verified Nov 11/g)).toHaveLength(2);
  expect(text()).toContain('Asked to be checked again Nov 11');
});
