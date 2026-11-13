import {afterEach,expect,it,vi} from 'vitest';
import {createElement as h} from '../../../node_modules/react/index.js';
import {act,create} from '../../../node_modules/react-test-renderer/index.js';
import type {Snapshot} from '../../data/store';
const f=vi.hoisted(()=>({access:{records:[{id:'activity',allowed:true,agents:['art','other'],owner:'Jonathan',today:'2026-11-13',timezone:'America/Chicago',windows:['2026-11-13','2026-11-10']}],status:'live'} as Snapshot,window:{records:[],status:'live'} as Snapshot,detail:{records:[],status:'live'} as Snapshot,call:vi.fn(),scopes:[] as string[]}));
vi.mock('../../data',()=>({useRecords:(type:string,scope:string)=>{f.scopes.push(`${type}:${scope}`);return type==='activity.access'?f.access:type==='activity.entry'?f.detail:scope?f.window:{records:[],status:'live'};},call:f.call}));
vi.mock('../../kit',()=>({Split:(p:{list:unknown;reader:unknown;listTop:unknown;narrow:unknown;onBack:()=>void})=>h('div',null,h('button',{onClick:p.onBack},'Back'),p.narrow,p.listTop,p.list,p.reader),List:(p:{children:unknown})=>h('div',null,p.children),Row:(p:{title:string;meta:string;onClick:()=>void})=>h('button',{'data-split-row':true,onClick:p.onClick},p.title,p.meta),Empty:(p:{title:string})=>h('p',null,p.title),Loading:(p:{label:string})=>h('p',null,p.label),Error:(p:{text:string})=>h('p',null,p.text),Button:'button',Markdown:(p:{text:string})=>h('p',null,p.text)}));
vi.mock('../../face',()=>({default:()=>h('svg')}));
vi.mock('../../access',()=>({reducedMotion:()=>true}));
import Activity,{activitySession} from './index';
import {address,filtersOf,passes,safeHref,type ActivityEntry} from './model';
(globalThis as typeof globalThis & {IS_REACT_ACT_ENVIRONMENT:boolean}).IS_REACT_ACT_ENVIRONMENT=true;
let tree:ReturnType<typeof create>|undefined;
const props={path:'/p/activity-preview',go:vi.fn()};
const entry=(id='d~art~dg-one'):ActivityEntry=>({id,agent:'art',at:'2026-11-13T17:00:00Z',day:'2026-11-13',hour:11,title:'Household work',line:'Shipped Activity',venue:'terminal',where:'Terminal',what:'work',owner:true});
const feed=()=>({records:[{id:'2026-11-13',days:['2026-11-13','2026-11-12','2026-11-11'],to:'2026-11-13',entries:[entry(),{...entry('e~other~m-two'),agent:'other',title:'Another conversation',what:'conversation',owner:undefined}],conversations:'unavailable',episodes:'available',truncated:false}],status:'live'} as Snapshot);
const text=()=>JSON.stringify(tree!.toJSON());
afterEach(async()=>{if(tree)await act(async()=>tree!.unmount());tree=undefined;activitySession.windows=1;f.access={...f.access,status:'live',records:[{id:'activity',allowed:true,agents:['art','other'],owner:'Jonathan',today:'2026-11-13',timezone:'America/Chicago',windows:['2026-11-13','2026-11-10']}]};f.window={records:[],status:'live'};f.detail={records:[],status:'live'};f.call.mockClear();f.scopes=[];props.go.mockClear();});
it('matches any within each filter group and all across groups, with stable address and safe links',()=>{
 const e=entry();expect(passes(e,{who:['other','owner'],where:['terminal'],what:['work']})).toBe(true);expect(passes(e,{who:['art'],where:['slack'],what:[]})).toBe(false);
 const filters={who:['art','owner'],where:['terminal'],what:['work']};expect(filtersOf(new URL(address(filters,e.id,e.day),'http://loom').searchParams)).toEqual(filters);
 expect(safeHref('javascript:alert(1)')).toBeUndefined();expect(safeHref('//evil.test')).toBeUndefined();expect(safeHref('/\\evil.test')).toBeUndefined();expect(safeHref('/p/tasks-preview/task/t-12')).toBe('/p/tasks-preview/task/t-12');
});
it('distinguishes loading, offline, denial, unavailable sources and empty feed without making calls',async()=>{
 f.access={records:[],status:'loading'};await act(async()=>{tree=create(h(Activity,props));});expect(text()).toContain('Opening activity');
 f.access={records:[],status:'offline'};await act(async()=>tree!.update(h(Activity,props)));expect(text()).toContain('Connection lost');expect(text()).not.toContain('Quiet');
 f.access={records:[{id:'activity',allowed:false}],status:'live'};await act(async()=>tree!.update(h(Activity,props)));expect(text()).toContain('don’t have access');
 f.access={records:[{id:'activity',allowed:true,agents:['art'],today:'2026-11-13',windows:['2026-11-13']}],status:'live'};f.window=feed();await act(async()=>tree!.update(h(Activity,props)));expect(text()).toContain('are not available yet');expect(text()).toContain('Household work');expect(f.call).not.toHaveBeenCalled();
 f.window={records:[],status:'live'};await act(async()=>tree!.update(h(Activity,props)));expect(text()).toContain('Quiet');
});
it('uses address filters and handler navigation, preserves Earlier subscriptions after unmount, and Back clears the entry',async()=>{
 f.window=feed();await act(async()=>{tree=create(h(Activity,{...props,path:'/p/activity-preview/?who=art&what=work&e=d~art~dg-one'}));});expect(text()).toContain('Household work');expect(text()).not.toContain('Another conversation');
 await act(async()=>tree!.root.findAllByType('button').find(b=>b.props.children==='Earlier')!.props.onClick());expect(f.scopes).toContain('activity.window:2026-11-10');expect(activitySession.windows).toBe(2);
 await act(async()=>tree!.root.findAllByType('button').find(b=>b.props.children==='Back')!.props.onClick());expect(new URL(props.go.mock.lastCall![0],'http://loom').searchParams.has('e')).toBe(false);expect(new URL(props.go.mock.lastCall![0],'http://loom').searchParams.get('who')).toBe('art');
 await act(async()=>tree!.unmount());await act(async()=>{tree=create(h(Activity,props));});expect(f.scopes).toContain('activity.window:2026-11-10');expect(f.call).not.toHaveBeenCalled();
});
it('renders the full reader and original internal destinations; hides reader data when offline',async()=>{
 f.window=feed();f.detail={records:[{...entry(),asked:['Build it'],decided:['Use live records'],story:'The complete story',tasks:[{label:'t-12',href:'/p/tasks-preview/task/t-12'}],prs:[{label:'loom#941',href:'https://github.com/sleepunit-agents/loom/pull/941'}],links:[],needs:'Ship?',steps:[{label:'Read files',state:'done',tool:'Read'}],more:[{id:'d~art~dg-two',at:entry().at,title:'Earlier run'}]}],status:'live'};
 await act(async()=>{tree=create(h(Activity,{...props,path:'/p/activity-preview/?e=d~art~dg-one'}));});expect(text()).toContain('The complete story');expect(text()).toContain('Use live records');expect(text()).toContain('Read files');expect(text()).toContain('Ship?');
 const link=tree!.root.findAllByType('a').find(a=>a.props.children==='t-12')!,preventDefault=vi.fn();await act(async()=>link.props.onClick({preventDefault}));expect(preventDefault).toHaveBeenCalledOnce();expect(props.go).toHaveBeenCalledWith('/p/tasks-preview/task/t-12');
 f.detail={records:[],status:'offline'};await act(async()=>tree!.update(h(Activity,{...props,path:'/p/activity-preview/?e=d~art~dg-one'})));expect(text()).not.toContain('The complete story');expect(text()).toContain('Connection lost');
});
