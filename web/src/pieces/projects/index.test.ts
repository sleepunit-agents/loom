import {afterEach,expect,it,vi} from 'vitest';
import {createElement as h} from '../../../node_modules/react/index.js';
import {act,create} from '../../../node_modules/react-test-renderer/index.js';
import type {Snapshot} from '../../data/store';
import type {ProjectRecord} from './model';
const f=vi.hoisted(()=>({feed:{records:[],status:'live'} as Snapshot,access:{records:[{id:'projects',allowed:true,agents:['art']}],status:'live'} as Snapshot,detail:{records:[],status:'live'} as Snapshot,call:vi.fn()}));
vi.mock('../../data',()=>({useRecords:(type:string)=>type==='projects.access'?f.access:type==='project.hub'?f.detail:f.feed,call:f.call}));
vi.mock('../../kit',()=>({Split:(p:{list:unknown;reader:unknown;search:unknown})=>h('div',null,p.search,p.list,p.reader),List:(p:{children:unknown})=>h('ul',null,p.children),Empty:(p:{title:string})=>h('p',null,p.title),Loading:(p:{label:string})=>h('p',null,p.label),Error:(p:{text:string})=>h('p',null,p.text),Input:'input'}));
import Projects,{projectsSession} from './index';
import {projects,safeHref,whatOf} from './model';
(globalThis as typeof globalThis & {IS_REACT_ACT_ENVIRONMENT:boolean}).IS_REACT_ACT_ENVIRONMENT=true;
let tree:ReturnType<typeof create>|undefined;
const props={path:'/p/projects-preview',go:vi.fn()};
const project=(id='art:pond'):ProjectRecord=>({id,agent:id.split(':')[0],slug:'pond',name:'Pond',card:{slug:'pond',name:'Pond',status:'active',summary:'A field project. More prose.',where:{},links:{repos:['github:owner/repo']}},updated:'2026-11-12T00:00:00Z',activity:'2026-11-13T00:00:00Z',archived:false,sections:[],waiting:[],unknown:false,lately:[],people:['art'],spark:[0,1,0,0,0,0,1],fields:[]});
afterEach(async()=>{if(tree)await act(async()=>tree!.unmount());tree=undefined;Object.assign(projectsSession,{query:'',folder:'active',agent:''});f.feed={records:[],status:'live'};f.access={records:[{id:'projects',allowed:true,agents:['art']}],status:'live'};f.detail={records:[],status:'live'};props.go.mockClear();f.call.mockClear();});
const text=()=>JSON.stringify(tree!.toJSON());
it('distinguishes loading, denied, offline and no projects without calls',async()=>{
 f.access={records:[],status:'loading'};await act(async()=>{tree=create(h(Projects,props));});expect(text()).toContain('Opening projects');
 f.access={records:[{id:'projects',allowed:false}],status:'live'};await act(async()=>tree!.update(h(Projects,props)));expect(text()).toContain('don’t have access');expect(text()).not.toContain('No projects yet');
 f.access={records:[],status:'offline'};await act(async()=>tree!.update(h(Projects,props)));expect(text()).toContain('Connection lost');
 f.access={records:[{id:'projects',allowed:true,agents:[]}],status:'live'};await act(async()=>tree!.update(h(Projects,props)));expect(text()).toContain('No projects yet');expect(f.call).not.toHaveBeenCalled();
});
it('ranks waiting then unknown then activity; folds quiet cards, searches and normalizes safe links',()=>{
 const a=project('art:a'),b={...project('art:b'),unknown:true},c={...project('art:c'),waiting:[{title:'Need an answer'}]},quiet={...project('other:paused'),card:{...project().card,status:'paused'}};
 expect(projects([a,b,c,quiet],'active','','').map(p=>p.id)).toEqual(['art:c','art:b','art:a']);expect(projects([a,quiet],'quiet','','')[0].id).toBe('other:paused');expect(projects([a],'active','owner/repo','art')).toHaveLength(1);expect(projects([a],'active','','other')).toEqual([]);
 expect(whatOf(a.card.summary)).toBe('A field project.');expect(safeHref('javascript:alert(1)')).toBeUndefined();expect(safeHref('//elsewhere.test')).toBeUndefined();expect(safeHref('/p/tasks-preview/task/t-1')).toBe('/p/tasks-preview/task/t-1');
});
it('renders independent sections and internal links through shell navigation; retains filters after actual unmount',async()=>{
 const p={...project(),waiting:[{title:'Answer this',href:'/p/inbox-preview'}],sections:[{key:'tasks',label:'Tasks',available:true,groups:[{title:'Ready',items:[{title:'Do the work',href:'/p/tasks-preview/task/t-1'}]}]},{key:'notes',label:'Notes',available:true,error:"Notes couldn't answer"},{key:'conversations',label:'Conversations',available:false}]};f.feed={records:[p],status:'live'};f.detail={records:[p],status:'live'};
 await act(async()=>{tree=create(h(Projects,{...props,path:'/p/projects-preview/project/art%3Apond'}));});expect(text()).toContain('Do the work');expect(text()).toContain("Notes couldn't answer");expect(text()).toContain(' service is not available yet.');
 const link=tree!.root.findAllByType('a').find(a=>a.props.children==='Do the work')!,preventDefault=vi.fn();await act(async()=>link.props.onClick({preventDefault}));expect(preventDefault).toHaveBeenCalledOnce();expect(props.go).toHaveBeenCalledWith('/p/tasks-preview/task/t-1');
 await act(async()=>tree!.root.findByType('input').props.onChange({target:{value:'Pond'}}));await act(async()=>tree!.unmount());await act(async()=>{tree=create(h(Projects,props));});expect(tree!.root.findByType('input').props.value).toBe('Pond');expect(f.call).not.toHaveBeenCalled();
});
