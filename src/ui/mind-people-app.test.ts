import { afterEach,expect,it,vi } from 'vitest';
import { createElement as h } from '../../web/node_modules/react/index.js';
import { act,create } from '../../web/node_modules/react-test-renderer/index.js';
import type { CallState,Snapshot } from '../../web/src/data/store';
const f=vi.hoisted(()=>({feed:{records:[],status:'live'} as Snapshot,access:{records:[{id:'people',allowed:true,canAdd:true,agents:['art']}],status:'live'} as Snapshot,call:vi.fn()}));
vi.mock('../../web/src/data',()=>({useRecords:(type:string,scope?:string)=>type==='people.access'?f.access:type==='person'&&!scope?f.feed:{records:[],status:f.feed.status},call:f.call}));
vi.mock('../../web/src/kit',()=>({Split:(p:{list:unknown;reader:unknown;listTop:unknown;search:unknown})=>h('div',null,p.search,p.listTop,p.list,p.reader),List:(p:{children:unknown})=>h('div',null,p.children),Row:(p:{title:string;onClick:()=>void})=>h('button',{onClick:p.onClick},p.title),Empty:(p:{title:string})=>h('p',null,p.title),Loading:(p:{label:string})=>h('p',null,p.label),Error:(p:{text:string})=>h('p',null,p.text),Input:'input',Textarea:'textarea',Button:'button'}));
import People from '../../web/src/pieces/people/index';
import { contacts,contactLink } from '../../web/src/pieces/people/model';
(globalThis as typeof globalThis & {IS_REACT_ACT_ENVIRONMENT:boolean}).IS_REACT_ACT_ENVIRONMENT=true;
let tree:ReturnType<typeof create>|undefined;
const props={path:'/p/people-preview',go:()=>{}};
afterEach(async()=>{if(tree)await act(async()=>tree!.unmount());tree=undefined;f.call.mockReset();f.feed={records:[],status:'live'};f.access={records:[{id:'people',allowed:true,canAdd:true,agents:['art']}],status:'live'};});
const text=()=>JSON.stringify(tree!.toJSON());
it('separates loading, denial, offline and empty states without writes',async()=>{
  f.feed={records:[],status:'loading'};await act(async()=>{tree=create(h(People,{...props,path:'/p/people-preview/person/missing'}));});
  expect(text()).toContain('Opening contact');expect(text()).not.toContain('Connection lost');
  f.access={records:[{id:'people',allowed:false}],status:'live'};await act(async()=>tree!.update(h(People,props)));expect(text()).toContain('don’t have access');expect(text()).not.toContain('No people yet');
  f.access={records:[],status:'offline'};await act(async()=>tree!.update(h(People,props)));expect(text()).toContain('Connection lost');expect(f.call).not.toHaveBeenCalled();
});
it('retains a draft and request across disconnect and freezes unavailable saves for same-id retry',async()=>{
  let state:CallState={pending:true,status:'pending'},listener=()=>{};const retry=vi.fn();
  f.call.mockReturnValue({id:'retained',getSnapshot:()=>state,subscribe:(fn:()=>void)=>{listener=fn;return()=>{};},result:new Promise(()=>{}),retry});
  await act(async()=>{tree=create(h(People,props));});
  await act(async()=>tree!.root.findAllByType('button').find(b=>b.props.children==='Add a person')!.props.onClick());
  await act(async()=>tree!.root.findAllByType('input').find(i=>i.props.required)!.props.onChange({target:{value:'Robin'}}));
  const submit=()=>tree!.root.findByType('form').props.onSubmit({preventDefault(){}});
  await act(async()=>submit());expect(f.call).toHaveBeenCalledWith('mind.personAdd',{name:'Robin',summary:'',channel:'',handle:''});
  f.access={records:[],status:'offline'};await act(async()=>tree!.update(h(People,props)));expect(text()).toContain('Connection lost');
  f.access={records:[{id:'people',allowed:true,canAdd:true,agents:['art']}],status:'live'};await act(async()=>tree!.update(h(People,props)));expect(text()).toContain('Robin');
  state={pending:false,status:'done',result:{ok:false,code:'unavailable',message:'Source failed'}};await act(async()=>listener());
  await act(async()=>submit());expect(f.call).toHaveBeenCalledTimes(1);
  await act(async()=>tree!.root.findAllByType('button').find(b=>b.props.children==='Retry this save')!.props.onClick());expect(retry).toHaveBeenCalledOnce();
  state={pending:false,status:'done',result:{ok:true,value:{slug:'robin'}}};await act(async()=>listener());await act(async()=>submit());expect(f.call).toHaveBeenCalledTimes(1);
});
it('maps only safe contact destinations and filters authorized records',()=>{
  expect(contactLink('github','@friend')).toBe('https://github.com/friend');expect(contactLink('other','javascript:alert(1)')).toBeUndefined();
  expect(contacts([],'person','nobody','art')).toEqual([]);
});
