import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {createElement as h,Fragment,lazy,type ReactNode} from 'react';
// @ts-expect-error Renderer has no bundled declarations.
import {act,create} from 'react-test-renderer';
vi.mock('../app-icon',()=>({AppIcon:({label}:{label:string})=>h('app-icon',{label})}));
vi.mock('@radix-ui/react-dialog',()=>({
 Root:({open,children}:{open:boolean;children:ReactNode})=>open?h(Fragment,null,children):null,
 Portal:({children}:{children:ReactNode})=>h(Fragment,null,children),
 Overlay:()=>null,Content:({children}:{children:ReactNode})=>h('section',{'data-launcher':true},children),
 Title:({children}:{children:ReactNode})=>h('h2',null,children),Close:({children}:{children:ReactNode})=>h('button',null,children),
}));
vi.mock('../kit',()=>({Loading:()=>null,Error:()=>null,Empty:()=>null,Button:({children,variant:_v,size:_s,...props}:{children?:ReactNode;variant?:string;size?:string})=>h('button',props,children)}));
vi.mock('../tiling/menu',()=>({ContextMenu:()=>null}));
vi.mock('./member-preferences',()=>({useMemberPreferences:()=>({status:'loading',records:[]})}));
vi.mock('../haptic',()=>({buzz:()=>{},HapticLabel:()=>null,useHaptics:()=>false}));
// The dock as the shell describes it: each key's shown name, its accessible name and its icon.
vi.mock('../components/ui/dock',()=>({Dock:({items}:{items:{value:string;label:string;name?:string;icon:ReactNode;onSelect():void}[]})=>h('nav',null,items.map(item=>h('button',{key:item.value,'data-dock':item.value,'data-shown':item.label,'aria-label':item.name??item.label,onClick:item.onSelect},item.icon)))}));
import Shell,{type RegisteredApp} from './index';

type Node={type:unknown;props:Record<string,any>;children:unknown[];find(match:(n:Node)=>boolean):Node;findAll(match:(n:Node)=>boolean):Node[];findByProps(props:object):Node;findAllByProps(props:object):Node[];findAllByType(type:unknown):Node[]};
type Listener=(e:unknown)=>void;
const fit={min:[320,280] as [number,number],ideal:520,max:null,big:false,why:'Fixture app'};
// Each fixture app shows where it is and can go somewhere, as a real app's screen does.
const Screen=lazy(async()=>({default:(props:{path?:string;go?:(path:string)=>void})=>h('app-screen',props)}));
const apps:RegisteredApp[]=['Tasks','Inbox'].map(title=>({id:title.toLowerCase(),title,path:'/'+title.toLowerCase(),icon:'circle',fit,Screen}));
let tree:ReturnType<typeof create>,listeners:{type:string;fn:Listener}[],entries:{state:unknown;href:string}[],at:number;
const location={href:'http://loom/'};
const history={state:null as unknown,
 pushState(state:unknown,_:string,url:string){entries=[...entries.slice(0,at+1),{state,href:'http://loom'+url}];at=entries.length-1;this.state=state;location.href=entries[at].href;},
 replaceState(state:unknown,_:string,url:string){entries[at]={state,href:'http://loom'+url};this.state=state;location.href=entries[at].href;}};
/** The browser's own Back and Forward: the entry changes, then the page is told. */
async function browser(step:number){at+=step;history.state=entries[at].state;location.href=entries[at].href;await act(async()=>listeners.filter(l=>l.type==='popstate').forEach(l=>l.fn({})));}
async function mount(width=2400){
 vi.stubGlobal('innerWidth',width);
 await act(async()=>{tree=create(h(Shell,{apps}),{createNodeMock:()=>({focus(){},getBoundingClientRect:()=>({width:width-100,height:1000}),querySelectorAll:()=>[]})});});
}
const dock=(id:string)=>act(async()=>tree.root.findByProps({'data-dock':id}).props.onClick());
const tile=(id:string):Node=>tree.root.find((n:Node)=>n.type==='section'&&n.props['data-tile']===id);
const shownTiles=()=>tree.root.findAll((n:Node)=>n.type==='section'&&!!n.props['data-tile']).map((n:Node)=>n.props['data-tile']);
const bar=(id:string):Node=>tile(id).find((n:Node)=>n.type==='header');
const control=(id:string,name:string):Node=>bar(id).find((n:Node)=>n.type==='button'&&n.props['aria-label']===name);
const screen=(id:string):Node=>tile(id).find((n:Node)=>n.type==='app-screen');
async function altKey(key:string,mods:{shiftKey?:boolean}={}){
 const e={key,code:key,altKey:true,ctrlKey:false,metaKey:false,shiftKey:false,repeat:false,isComposing:false,...mods,timeStamp:1,target:{closest:()=>null},defaultPrevented:false,preventDefault(){this.defaultPrevented=true;},stopPropagation(){}};
 await act(async()=>listeners.filter(l=>l.type==='keydown').forEach(l=>l.fn(e)));return e;
}
beforeEach(()=>{
 listeners=[];entries=[{state:null,href:'http://loom/'}];at=0;history.state=null;location.href='http://loom/';
 const addEventListener=(type:string,fn:Listener)=>{listeners.push({type,fn});},removeEventListener=(type:string,fn:Listener)=>{listeners=listeners.filter(l=>!(l.type===type&&l.fn===fn));};
 vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true);
 vi.stubGlobal('window',{addEventListener,removeEventListener,location,history,setTimeout,clearTimeout});
 vi.stubGlobal('addEventListener',addEventListener);vi.stubGlobal('removeEventListener',removeEventListener);
 vi.stubGlobal('document',{addEventListener,removeEventListener,visibilityState:'visible',querySelector:()=>null,documentElement:{dataset:{}},activeElement:null});
 vi.stubGlobal('innerHeight',1200);vi.stubGlobal('ResizeObserver',class{observe(){}disconnect(){}});
});
afterEach(async()=>{await act(async()=>tree?.unmount());vi.unstubAllGlobals();});

it('a tile’s bar is the app’s key, its title and three window controls, with no history controls',async()=>{
 await mount();await dock('tasks');
 const buttons=bar('tasks').findAll((n:Node)=>n.type==='button');
 expect(buttons.map(b=>b.props['aria-label']??b.props.children)).toEqual(['Go to Tasks','Tasks','Make Tasks big','Minimize Tasks','Close Tasks']);
 // No arrows, no Trail, no fold-out of any kind in the bar.
 expect(bar('tasks').findAll((n:Node)=>n.type==='details'||n.type==='summary'||n.type==='ol')).toEqual([]);
 expect(buttons.some(b=>/back|forward|history|trail/i.test(String(b.props['aria-label']??b.props.children)))).toBe(false);
 // The controls are drawn shapes, named for a screen reader and on hover, never a font glyph.
 const drawn=['Make Tasks big','Minimize Tasks','Close Tasks'].map(name=>control('tasks',name));
 expect(drawn.map(b=>[b.props.className,b.props['data-act'],b.props.title,b.props.type])).toEqual([['next-win','big','Make big','button'],['next-win','dock','Send to the dock','button'],['next-win','close','Close','button']]);
 for(const b of drawn){expect(b.children).toHaveLength(1);expect((b.children[0] as Node).type).toBe('i');expect((b.children[0] as Node).props['aria-hidden']).toBe('true');expect((b.children[0] as Node).children).toEqual([]);}
 expect(JSON.stringify(tree.toJSON())).not.toMatch(/[←→↗−×]|Trail/);
});
it('the three window controls still make a tile big, send it to the dock and close it',async()=>{
 await mount();await dock('tasks');await dock('inbox');expect(shownTiles()).toEqual(['tasks','inbox']);
 await act(async()=>control('inbox','Make Inbox big').props.onClick());expect(shownTiles()).toEqual(['inbox','tasks']);
 await act(async()=>control('inbox','Minimize Inbox').props.onClick());expect(shownTiles()).toEqual(['tasks']);
 // Sent to the dock, it is still an open app there; closed, it is gone.
 await dock('inbox');expect(shownTiles()).toContain('inbox');
 await act(async()=>control('inbox','Close Inbox').props.onClick());expect(shownTiles()).toEqual(['tasks']);
 expect(JSON.parse(new URL(location.href).searchParams.get('paths')!)).toEqual({tasks:'/tasks'});
});
it('double-clicking the bar outside a control still sends the tile to the dock',async()=>{
 await mount();await dock('tasks');
 await act(async()=>bar('tasks').props.onDoubleClick({target:{closest:(selector:string)=>{expect(selector).toBe('button');return {};}}}));expect(shownTiles()).toEqual(['tasks']);
 await act(async()=>bar('tasks').props.onDoubleClick({target:{closest:()=>null}}));expect(shownTiles()).toEqual([]);
});
it('a phone’s tile bar has no make-big control and no history controls either',async()=>{
 await mount(390);await dock('tasks');
 expect(bar('tasks').findAll((n:Node)=>n.type==='button').map(b=>b.props['aria-label']??b.props.children)).toEqual(['Go to Tasks','Tasks','Minimize Tasks','Close Tasks']);
 // Without arrows, the app's key and its title are the way back to where the app starts.
 await act(async()=>{});await act(async()=>screen('tasks').props.go('/tasks/t-1'));expect(screen('tasks').props.path).toBe('/tasks/t-1');
 await act(async()=>control('tasks','Go to Tasks').props.onClick());expect(screen('tasks').props.path).toBe('/tasks');
});
it('Alt+← and Alt+→ still travel the focused tile’s history',async()=>{
 await mount();await dock('tasks');await act(async()=>{});
 await act(async()=>screen('tasks').props.go('/tasks/t-1'));await act(async()=>screen('tasks').props.go('/tasks/t-2'));
 expect(screen('tasks').props.path).toBe('/tasks/t-2');
 const back=await altKey('ArrowLeft');expect(screen('tasks').props.path).toBe('/tasks/t-1');expect(back.defaultPrevented).toBe(true);
 await altKey('ArrowLeft');expect(screen('tasks').props.path).toBe('/tasks');
 // At the start there is nowhere to go: the key is left to the browser.
 const stuck=await altKey('ArrowLeft');expect(screen('tasks').props.path).toBe('/tasks');expect(stuck.defaultPrevented).toBe(false);
 const forward=await altKey('ArrowRight');expect(screen('tasks').props.path).toBe('/tasks/t-1');expect(forward.defaultPrevented).toBe(true);
 await altKey('ArrowRight');expect(screen('tasks').props.path).toBe('/tasks/t-2');
 const end=await altKey('ArrowRight');expect(screen('tasks').props.path).toBe('/tasks/t-2');expect(end.defaultPrevented).toBe(false);
});
it('each tile keeps its own history, and the keys travel only the one in front',async()=>{
 await mount();await dock('tasks');await dock('inbox');await act(async()=>{});
 await act(async()=>screen('tasks').props.go('/tasks/t-1'));await act(async()=>screen('inbox').props.go('/inbox/a-1'));
 await altKey('ArrowLeft');expect(screen('inbox').props.path).toBe('/inbox');expect(screen('tasks').props.path).toBe('/tasks/t-1');
});
it('the browser’s own Back and Forward still move through what a tile opened',async()=>{
 await mount();await dock('tasks');await act(async()=>{});
 await act(async()=>screen('tasks').props.go('/tasks/t-1'));expect(new URL(location.href).pathname).toBe('/tasks/t-1');
 await browser(-1);expect(screen('tasks').props.path).toBe('/tasks');
 await browser(1);expect(screen('tasks').props.path).toBe('/tasks/t-1');
});
it('the dock shows each app’s name alone and keeps "Open …" as its accessible name',async()=>{
 await mount();
 const keys=tree.root.findAll((n:Node)=>n.type==='button'&&!!n.props['data-dock']).map((n:Node)=>[n.props['data-dock'],n.props['data-shown'],n.props['aria-label']]);
 expect(keys).toEqual([['home','Home','Home'],['tasks','Tasks','Open Tasks'],['inbox','Inbox','Open Inbox'],['launcher','All apps','All apps']]);
 expect(tree.root.findByProps({'data-dock':'launcher'}).findAllByType('app-icon').map((n:Node)=>n.props.label)).toEqual(['All apps']);
});
it('the shell’s bar is handed no appearance control',async()=>{
 const Bar=vi.fn((_props:Record<string,unknown>)=>h('header',{'data-bar':true}));
 vi.stubGlobal('innerWidth',2400);
 await act(async()=>{tree=create(h(Shell,{apps,surfaces:{Bar}}),{createNodeMock:()=>({focus(){},getBoundingClientRect:()=>({width:2300,height:1000}),querySelectorAll:()=>[]})});});
 expect(Object.keys(Bar.mock.calls[0][0]).sort()).toEqual(['go','title']);
 expect(tree.root.findAll((n:Node)=>n.type==='details'||n.type==='summary'||n.type==='select')).toEqual([]);
});
