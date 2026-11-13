import { afterEach,expect,it,vi } from 'vitest';
import { createElement as h } from '../../../node_modules/react/index.js';
import { act,create } from '../../../node_modules/react-test-renderer/index.js';
import type { CallState,Snapshot } from '../../data/store';
const f=vi.hoisted(()=>({feed:{records:[],status:'live'} as Snapshot,access:{records:[{id:'people',allowed:true,canAdd:true,agents:['art']}],status:'live'} as Snapshot,conversations:{records:[],status:'live'} as Snapshot,call:vi.fn()}));
vi.mock('../../data',()=>({useRecords:(type:string,scope?:string)=>type==='people.access'?f.access:type==='people.conversations'?f.conversations:type==='person'&&!scope?f.feed:{records:[],status:f.feed.status},call:f.call}));
vi.mock('../../kit',()=>({Split:(p:{list:unknown;reader:unknown;listTop:unknown;search:unknown})=>h('div',null,p.search,p.listTop,p.list,p.reader),List:(p:{children:unknown})=>h('div',null,p.children),Row:(p:{title:string;onClick:()=>void})=>h('button',{onClick:p.onClick},p.title),Empty:(p:{title:string})=>h('p',null,p.title),Loading:(p:{label:string})=>h('p',null,p.label),Error:(p:{text:string})=>h('p',null,p.text),Input:'input',Textarea:'textarea',Button:'button'}));
import People, {peopleSession} from './index';
import { contacts,contactLink } from './model';
(globalThis as typeof globalThis & {IS_REACT_ACT_ENVIRONMENT:boolean}).IS_REACT_ACT_ENVIRONMENT=true;
let tree:ReturnType<typeof create>|undefined;
const props={path:'/p/people-preview',go:()=>{}};
afterEach(async()=>{if(tree)await act(async()=>tree!.unmount());tree=undefined;Object.assign(peopleSession,{draft:{name:'',summary:'',channel:'',handle:''},request:undefined,adding:false});f.call.mockReset();f.feed={records:[],status:'live'};f.access={records:[{id:'people',allowed:true,canAdd:true,agents:['art']}],status:'live'};});
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
  await act(async()=>tree!.unmount());await act(async()=>{tree=create(h(People,props));});expect(text()).toContain('Robin');expect(text()).toContain('Saving person');
  await act(async()=>tree!.update(h(People,{...props,path:'/p/people-preview/person/elsewhere'})));
  await act(async()=>tree!.update(h(People,props)));expect(text()).toContain('Robin');expect(f.call).toHaveBeenCalledTimes(1);
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
  const card={slug:'friend',name:'Friend',where:{},how:{},may:[]},base={id:'commons:friend',slug:'friend',name:'Friend',kind:'person' as const,card,updated:'',synthesizedAt:null,evidence:[],newer:0,fields:[],projects:[]};
  expect(contacts([base,{...base,id:'art:friend',agent:'art'}],'all','art','')).toHaveLength(1);
  expect(contacts([base,{...base,id:'art:friend',agent:'art'}],'all','nobody','')).toHaveLength(0);
});

it('renders owner roles, linked projects and supplied conversation links, with explicit unavailable fallback',async()=>{
  const p={id:'commons:friend',slug:'friend',name:'Friend',kind:'person',card:{slug:'friend',name:'Friend',where:{},how:{},may:[]},fields:[{key:'slack',value:'U12345',label:'Jonathan on Slack',state:'unverified'}],evidence:[],projects:[{agent:'art',slug:'box',name:'Box project',status:'active',href:'/p/projects-preview/project/art%3Abox'}],ownership:{owner:true,agents:['art']},updated:'2026-11-13T00:00:00Z',synthesizedAt:null,newer:0};
  f.feed={records:[p],status:'live'};f.conversations={records:[{id:p.id,available:false,rows:[]}],status:'live'};
  await act(async()=>{tree=create(h(People,{...props,path:'/p/people-preview/person/friend'}));});
  expect(text()).toContain('U12345');expect(text()).toContain('Jonathan on Slack');expect(text()).toContain('The household and every agent');expect(text()).toContain('Box project');expect(tree!.root.findAllByType('a').find(a=>a.props.children==='Box project')?.props.href).toBe('/p/projects-preview/project/art%3Abox');expect(text()).toContain('Conversation service is not available yet');
  f.feed={records:[{...p,projects:[{...p.projects[0],href:undefined}]}],status:'live'};
  await act(async()=>tree!.update(h(People,{...props,path:'/p/people-preview/person/friend'})));expect(text()).toContain('Projects app is not available yet');
  f.conversations={records:[{id:p.id,available:true,rows:[{id:'cv-test',title:'A private conversation',href:'/p/comms-preview/cv-test'}]}],status:'live'};
  await act(async()=>tree!.update(h(People,{...props,path:'/p/people-preview/person/friend'})));
  const sharingLink=tree!.root.findAllByType('a').find(a=>a.props.children==='Open Sharing')!;const prevented=vi.fn();await act(async()=>sharingLink.props.onClick({preventDefault:prevented}));expect(prevented).toHaveBeenCalledOnce();
  const link=tree!.root.findAllByType('a').find(a=>a.props.children==='A private conversation');expect(link?.props.href).toBe('/p/comms-preview/cv-test');
});
