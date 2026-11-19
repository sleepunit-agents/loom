import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {createElement as h,Fragment,lazy,type ReactNode} from 'react';
// @ts-expect-error Renderer has no bundled declarations.
import {act,create} from 'react-test-renderer';
import type {RegisteredApp} from './index';
vi.mock('../app-icon',()=>({AppIcon:()=>null}));
vi.mock('@radix-ui/react-dialog',()=>({
 Root:({open,children}:{open:boolean;children:ReactNode})=>open?h(Fragment,null,children):null,
 Portal:({children}:{children:ReactNode})=>h(Fragment,null,children),
 Overlay:()=>null,Content:({children,...props}:{children:ReactNode})=>h('section',{'data-test-content':true,...props},children),
 Title:({children}:{children:ReactNode})=>h('h2',null,children),Close:({children,...props}:{children:ReactNode})=>h('button',props,children),
}));
import Launcher from './launcher';
const fit={min:[320,280] as [number,number],ideal:520,max:null,big:false,why:'Fixture app'};
const Screen=lazy(async()=>({default:()=>null}));
const apps:RegisteredApp[]=['Tasks','Inbox'].map(title=>({id:title.toLowerCase(),title,path:'/'+title.toLowerCase(),icon:'circle',fit,Screen}));
let tree:ReturnType<typeof create>,input:{focus():void},dom:{activeElement:object|null};
const launch=vi.fn(),change=vi.fn();
beforeEach(()=>{
 vi.clearAllMocks();dom={activeElement:null};input={focus:()=>{dom.activeElement=input;}};
 vi.stubGlobal('document',dom);vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true);
});
afterEach(async()=>{await act(async()=>tree?.unmount());vi.unstubAllGlobals();});
const view=(open:boolean)=>h(Launcher,{apps,open,onOpenChange:change,launch});
async function draw(open=true){await act(async()=>{tree=create(view(open),{createNodeMock:(node:{type:unknown;props:Record<string,unknown>})=>node.type==='input'?input:node.props.id==='next-launcher-apps'?{querySelectorAll:()=>[]}:null});});}
async function type(name:string){input.focus();await act(async()=>tree.root.findByType('input').props.onChange({target:{value:name}}));}
async function enter(){await act(async()=>tree.root.findByProps({'data-test-content':true}).props.onKeyDown({key:'Enter',target:input,preventDefault:vi.fn()}));}
it('delayed opening autofocus preserves a typed query and the app Enter opens',async()=>{
 await draw();await type('Inbox');
 await act(async()=>tree.root.findByProps({'data-test-content':true}).props.onOpenAutoFocus({preventDefault:vi.fn()}));
 await enter();expect(launch).toHaveBeenCalledExactlyOnceWith('inbox');expect(change).toHaveBeenCalledWith(false);
});
it('a logical reopen resets the previous search before autofocus arrives',async()=>{
 await draw();await type('Inbox');await act(async()=>tree.update(view(false)));await act(async()=>tree.update(view(true)));
 expect(tree.root.findByType('input').props.value).toBe('');await enter();expect(launch).toHaveBeenCalledExactlyOnceWith('tasks');
});
it('lists the Appearance app in its own Look & feel group, and finds it by what it holds',async()=>{
 const withAppearance:RegisteredApp[]=[...apps,{id:'appearance',title:'Appearance',path:'/p/appearance',icon:'palette',fit,Screen}];
 await act(async()=>{tree=create(h(Launcher,{apps:withAppearance,open:true,onOpenChange:change,launch}),{createNodeMock:(node:{type:unknown})=>node.type==='input'?input:{querySelectorAll:()=>[]}});});
 const groups=()=>tree.root.findAll((n:{type:unknown;props:{className?:string}})=>n.type==='section'&&n.props.className==='loom-lsec').map((s:{props:{'aria-label':string};findAllByProps(props:object):{props:{children:string}}[]})=>[s.props['aria-label'],s.findAllByProps({className:'loom-lapp__nm'}).map(n=>n.props.children)]);
 expect(groups()).toEqual([['Work',['Tasks','Inbox']],['Look & feel',['Appearance']]]);
 await type('desk background');expect(groups()).toEqual([['Look & feel',['Appearance']]]);
 await enter();expect(launch).toHaveBeenCalledExactlyOnceWith('appearance');
});
