import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {createElement as h,Fragment,lazy,type ReactNode} from 'react';
// @ts-expect-error Renderer has no bundled declarations.
import {act,create} from 'react-test-renderer';
vi.mock('../app-icon',()=>({AppIcon:()=>null}));
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
vi.mock('../components/ui/dock',()=>({Dock:({items}:{items:{value:string;onSelect():void}[]})=>h('nav',null,items.map(item=>h('button',{key:item.value,'data-dock':item.value,onClick:item.onSelect})))}));
import Shell,{type RegisteredApp} from './index';
import Launcher from './launcher';
import {SHORTCUTS,TAP_GAP_MS,TAP_HELD_MS,keysOf,recency,shortcutEngine,shortcutHints,type Switching} from './shortcuts';

const fit={min:[320,280] as [number,number],ideal:520,max:null,big:false,why:'Fixture app'};
const Screen=lazy(async()=>({default:()=>null}));
const apps:RegisteredApp[]=['Tasks','Inbox','Notes','Clock'].map(title=>({id:title.toLowerCase(),title,path:'/'+title.toLowerCase(),icon:'circle',fit,Screen}));

/** A key as the page sees it. `typed` is what a text field would take from it: nothing once it is prevented. */
type Mods={ctrlKey?:boolean;shiftKey?:boolean;altKey?:boolean;metaKey?:boolean;repeat?:boolean};
let now=0;
const wait=(ms:number)=>{now+=ms;};
function keyEvent(code:string,key:string,mods:Mods={}) {
 return {code,key,ctrlKey:false,shiftKey:false,altKey:false,metaKey:false,repeat:false,isComposing:false,...mods,timeStamp:now,defaultPrevented:false,stopped:false,target:null as unknown,
  preventDefault(){this.defaultPrevented=true;},stopPropagation(){this.stopped=true;}};
}
const CTRL={ctrlKey:true},SHIFT={shiftKey:true};

describe('the declared list',()=>{
 it('names every shortcut, what it does and its keys, with Control spelled out on a Mac',()=>{
  expect(SHORTCUTS.map(s=>[s.id,keysOf(s,false)])).toEqual([['launcher','Ctrl+Space'],['launcher-taps','double-tap Shift'],['launcher-alias','Ctrl+Shift+Space'],['switch','Ctrl+`'],['agent-thread','Ctrl+Shift+1…9']]);
  expect(SHORTCUTS.map(s=>keysOf(s,true))).toEqual(['Control+Space','double-tap Shift','Cmd+Shift+Space','Control+`','Control+Shift+1…9']);
  for(const s of SHORTCUTS){expect(s.name).toBeTruthy();expect(s.does).toBeTruthy();}
 });
 it('binds no letter as a modifier and nothing the browser or the system owns',()=>{
  const chords=SHORTCUTS.flatMap(s=>'chords' in s?[...s.chords]:[]) as {code:string;ctrl?:boolean;meta?:boolean;alt?:boolean}[];
  for(const chord of chords){
   expect(chord.code).not.toMatch(/^(Tab|Key[WTN]|Digit\d|F\d+)$/);
   expect(chord.alt).toBeFalsy();
   expect(chord.ctrl||chord.meta).toBe(true);
   if(chord.code==='Space'&&chord.meta)expect((chord as {shift?:boolean}).shift).toBe(true);
  }
 });
 it('the launcher’s hint line lists every declared shortcut, for the platform',async()=>{
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true);vi.stubGlobal('document',{activeElement:null});
  for(const mac of [false,true]){
   vi.stubGlobal('navigator',{platform:mac?'MacIntel':'Linux x86_64'});
   let tree!:ReturnType<typeof create>;
   await act(async()=>{tree=create(h(Launcher,{apps,open:true,onOpenChange:()=>{},launch:()=>{}}));});
   const line=tree.root.findByProps({className:'loom-launcher__foot loom-launcher__keys'});
   const shown=line.findAllByType('kbd').map((k:{props:{children:string}})=>k.props.children);
   expect(shown).toEqual(expect.arrayContaining(SHORTCUTS.map(s=>keysOf(s,mac))));expect(shown).toHaveLength(SHORTCUTS.length);
   expect(shown.some((k:string)=>k.startsWith('Ctrl+'))).toBe(!mac);
   expect(shortcutHints(mac).flatMap(hint=>hint.keys)).toEqual(shown);
   await act(async()=>tree.unmount());
  }
  vi.unstubAllGlobals();
 });
});

describe('most recently used',()=>{
 it('puts the app in front first, keeps the rest in order, takes in new apps and drops closed ones',()=>{
  expect(recency([],['b','a'],'a')).toEqual(['a','b']);
  expect(recency(['a','b','c'],['a','b','c'],'c')).toEqual(['c','a','b']);
  expect(recency(['c','a','b'],['a','c'],undefined)).toEqual(['c','a']);
  expect(recency(['a'],['d','a'],'a')).toEqual(['a','d']);
  const same=['a','b'];expect(recency(same,['b','a'],'a')).toBe(same);
 });
});

describe('the keys alone',()=>{
 let shown:Switching|null,landed:string[],toggles:number,order:string[],focused:string|undefined,engine:ReturnType<typeof shortcutEngine>;
 beforeEach(()=>{
  now=1000;shown=null;landed=[];toggles=0;order=['a','b','c','d'];focused='a';
  engine=shortcutEngine({toggleLauncher:()=>{toggles++;},apps:()=>({order,focused}),show:s=>{shown=s;},land:id=>{landed.push(id);}});
 });
 const down=(code:string,key:string,mods?:Mods)=>{const e=keyEvent(code,key,mods);engine.keydown(e);return e;};
 const up=(code:string,key:string,mods?:Mods)=>{const e=keyEvent(code,key,mods);engine.keyup(e);return e;};
 const shiftTap=(heldFor=60,side='ShiftLeft')=>{down(side,'Shift',SHIFT);wait(heldFor);up(side,'Shift');};
 const hold=()=>down('ControlLeft','Control',CTRL);
 const release=()=>up('ControlLeft','Control');
 const tick=(mods:Mods=CTRL)=>{const e=down('Backquote','`',mods);up('Backquote','`',mods);return e;};
 const selected=()=>shown&&shown.order[shown.index];

 it('Ctrl+Space and the older Ctrl+Shift+Space or Cmd+Shift+Space toggle the launcher; Space alone and Shift+Space are left to type',()=>{
  expect(down('Space',' ',CTRL).defaultPrevented).toBe(true);expect(toggles).toBe(1);
  expect(down('Space',' ',{ctrlKey:true,shiftKey:true}).defaultPrevented).toBe(true);expect(down('Space',' ',{metaKey:true,shiftKey:true}).defaultPrevented).toBe(true);expect(toggles).toBe(3);
  for(const mods of [{},SHIFT,{altKey:true},{metaKey:true},{ctrlKey:true,altKey:true}])expect(down('Space',' ',mods).defaultPrevented).toBe(false);
  expect(toggles).toBe(3);
  expect(down('Space',' ',{ctrlKey:true,repeat:true}).defaultPrevented).toBe(true);expect(toggles).toBe(3);
 });
 it('one tap and release lands on the previous app',()=>{
  hold();expect(tick().defaultPrevented).toBe(true);expect(shown).toEqual({order:['a','b','c','d'],index:1});
  release();expect(shown).toBeNull();expect(landed).toEqual(['b']);
 });
 it('three taps move three along, a fourth wraps, and Shift goes back',()=>{
  hold();tick();tick();tick();expect(selected()).toBe('d');tick();expect(selected()).toBe('a');
  tick({ctrlKey:true,shiftKey:true});expect(selected()).toBe('d');tick({ctrlKey:true,shiftKey:true});expect(selected()).toBe('c');
  release();expect(landed).toEqual(['c']);
 });
 it('a first tap with Shift goes to the least recent app, and from the empty desk a tap picks the most recent',()=>{
  hold();tick({ctrlKey:true,shiftKey:true});expect(selected()).toBe('d');release();
  focused=undefined;hold();tick();expect(selected()).toBe('a');release();expect(landed).toEqual(['d','a']);
 });
 it('landing where the person already was changes nothing',()=>{
  hold();tick();tick({ctrlKey:true,shiftKey:true});expect(selected()).toBe('a');release();expect(shown).toBeNull();expect(landed).toEqual([]);
 });
 it('Escape cancels, and takes the key so nothing behind the switcher closes',()=>{
  hold();tick();const escape=down('Escape','Escape',CTRL);expect(escape.defaultPrevented).toBe(true);expect(escape.stopped).toBe(true);
  expect(shown).toBeNull();release();expect(landed).toEqual([]);
  expect(down('Escape','Escape').defaultPrevented).toBe(false);
 });
 it('losing the window while Control is held closes without switching, and the next backtick is typed',()=>{
  hold();tick();engine.away();expect(shown).toBeNull();
  const typed=down('Backquote','`');expect(typed.defaultPrevented).toBe(false);expect(shown).toBeNull();up('Backquote','`');expect(landed).toEqual([]);
  hold();tick();expect(shown).toEqual({order:['a','b','c','d'],index:1});
 });
 it('a key that arrives without Control ends a switch whose release was never seen',()=>{
  hold();tick();expect(down('KeyA','a').defaultPrevented).toBe(false);expect(shown).toBeNull();expect(landed).toEqual([]);
 });
 it('a backtick without Control, or with Alt or Cmd, is not ours',()=>{
  for(const mods of [{},SHIFT,{ctrlKey:true,altKey:true},{ctrlKey:true,metaKey:true},{metaKey:true}]){expect(down('Backquote','`',mods).defaultPrevented).toBe(false);up('Backquote','`',mods);}
  expect(shown).toBeNull();
 });
 it('does nothing with fewer than two apps open',()=>{
  order=['a'];hold();expect(tick().defaultPrevented).toBe(false);expect(shown).toBeNull();release();expect(landed).toEqual([]);
  order=[];focused=undefined;hold();tick();release();expect(shown).toBeNull();
 });
 it('a click on an item lands on it',()=>{
  hold();tick();engine.pick('c');expect(shown).toBeNull();expect(landed).toEqual(['c']);release();expect(landed).toEqual(['c']);
 });

 it('two quick taps of Shift toggle the launcher, with either Shift key',()=>{
  shiftTap();wait(120);shiftTap();expect(toggles).toBe(1);
  wait(2000);shiftTap(60,'ShiftRight');wait(TAP_GAP_MS);shiftTap(TAP_HELD_MS,'ShiftLeft');expect(toggles).toBe(2);
 });
 it('Shift+A is typing, not a tap',()=>{
  for(let i=0;i<2;i++){down('ShiftLeft','Shift',SHIFT);wait(30);expect(down('KeyA','A',SHIFT).defaultPrevented).toBe(false);wait(30);up('KeyA','A',SHIFT);wait(30);up('ShiftLeft','Shift');wait(50);}
  expect(toggles).toBe(0);
  // A capital straight after one real tap does not complete a pair either.
  shiftTap();wait(50);down('ShiftLeft','Shift',SHIFT);down('KeyA','A',SHIFT);up('KeyA','A',SHIFT);up('ShiftLeft','Shift');expect(toggles).toBe(0);
 });
 it('a slow second tap does not count, and starts no pair of its own with the first',()=>{
  shiftTap();wait(TAP_GAP_MS+1);shiftTap();expect(toggles).toBe(0);
  wait(50);shiftTap();expect(toggles).toBe(1);
 });
 it('a held Shift is not a tap',()=>{
  shiftTap(TAP_HELD_MS+1);wait(50);shiftTap();expect(toggles).toBe(0);
  wait(2000);shiftTap();wait(50);shiftTap(TAP_HELD_MS+1);expect(toggles).toBe(0);
 });
 it('Shift, another key, Shift is not a double tap',()=>{
  shiftTap();wait(40);down('KeyX','x');up('KeyX','x');wait(40);shiftTap();expect(toggles).toBe(0);
  wait(2000);shiftTap();wait(40);down('ArrowRight','ArrowRight');up('ArrowRight','ArrowRight');shiftTap();expect(toggles).toBe(0);
 });
 it('key repeat is not a tap',()=>{
  down('ShiftLeft','Shift',SHIFT);wait(20);down('ShiftLeft','Shift',{shiftKey:true,repeat:true});wait(20);up('ShiftLeft','Shift');wait(20);
  down('ShiftLeft','Shift',SHIFT);wait(20);down('ShiftLeft','Shift',{shiftKey:true,repeat:true});wait(20);up('ShiftLeft','Shift');expect(toggles).toBe(0);
 });
 it('Shift with a modifier, with another key held, with both Shifts or around a click is not a tap',()=>{
  down('ControlLeft','Control',CTRL);for(let i=0;i<2;i++){down('ShiftLeft','Shift',{ctrlKey:true,shiftKey:true});up('ShiftLeft','Shift',CTRL);}up('ControlLeft','Control');expect(toggles).toBe(0);
  down('KeyJ','j');shiftTap();shiftTap();up('KeyJ','j');expect(toggles).toBe(0);
  wait(2000);down('ShiftLeft','Shift',SHIFT);down('ShiftRight','Shift',SHIFT);up('ShiftRight','Shift',SHIFT);up('ShiftLeft','Shift');shiftTap();expect(toggles).toBe(0);
  wait(2000);shiftTap();engine.pointerdown();shiftTap();expect(toggles).toBe(0);
  wait(2000);down('ShiftLeft','Shift',SHIFT);engine.pointerdown();up('ShiftLeft','Shift');shiftTap();expect(toggles).toBe(0);
  wait(2000);shiftTap();shiftTap();expect(toggles).toBe(1);
 });
 it('selecting with Shift+arrows never opens the launcher',()=>{
  for(let i=0;i<3;i++){down('ShiftLeft','Shift',SHIFT);down('ArrowLeft','ArrowLeft',SHIFT);up('ArrowLeft','ArrowLeft',SHIFT);up('ShiftLeft','Shift');wait(30);}
  expect(toggles).toBe(0);
 });
});

describe('in the shell',()=>{
 type Listener=(e:unknown)=>void;
 let tree:ReturnType<typeof create>,listeners:{target:string;type:string;fn:Listener;capture:boolean}[],field:{value:string;closest():unknown},page:{visibilityState:string};
 const target=(name:string)=>({
  addEventListener:(type:string,fn:Listener,capture?:boolean)=>{listeners.push({target:name,type,fn,capture:!!capture});},
  removeEventListener:(type:string,fn:Listener,capture?:boolean)=>{listeners=listeners.filter(l=>!(l.target===name&&l.type===type&&l.fn===fn&&l.capture===!!capture));},
 });
 let tiles:Record<string,{focus():void;contains(el:unknown):boolean}>;
 /** Capture listeners first; a stopped event reaches nobody after. */
 function send(type:string,event:{stopped?:boolean}={}) {
  for(const l of [...listeners].filter(l=>l.type===type).sort((a,b)=>Number(b.capture)-Number(a.capture))){if(event.stopped)break;l.fn(event);}
 }
 async function key(type:'keydown'|'keyup',code:string,k:string,mods:Mods={}) {
  const e=keyEvent(code,k,mods);e.target=field;
  await act(async()=>send(type,e));
  if(type==='keydown'&&!e.defaultPrevented&&k.length===1&&!e.ctrlKey&&!e.metaKey&&!e.altKey)field.value+=k;
  return e;
 }
 const press=async(code:string,k:string,mods:Mods={})=>{await key('keydown',code,k,mods);wait(20);await key('keyup',code,k,mods);wait(20);};
 const hold=()=>key('keydown','ControlLeft','Control',CTRL);
 const release=()=>key('keyup','ControlLeft','Control');
 const tick=(mods:Mods=CTRL)=>press('Backquote','`',mods);
 const shiftTap=async()=>{await key('keydown','ShiftLeft','Shift',SHIFT);wait(50);await key('keyup','ShiftLeft','Shift');wait(50);};
 const launcherOpen=()=>tree.root.findAllByProps({'data-launcher':true}).length>0;
 const options=()=>tree.root.findAllByProps({role:'option'});
 const offered=()=>options().map((o:{props:{id:string}})=>o.props.id.replace('next-switch-',''));
 const selected=()=>options().filter((o:{props:{'aria-selected':boolean}})=>o.props['aria-selected']).map((o:{props:{id:string}})=>o.props.id.replace('next-switch-',''));
 const front=()=>tree.root.findAll((n:{type:unknown;props:Record<string,unknown>})=>n.type==='section'&&!!n.props['data-focused']).map((n:{props:Record<string,string>})=>n.props['data-tile']);
 const dock=(id:string)=>act(async()=>tree.root.findByProps({'data-dock':id}).props.onClick());
 const click=(id:string)=>act(async()=>tree.root.findByProps({'data-tile':id}).props.onPointerDown());
 async function launch(title:string){await dock('launcher');await act(async()=>tree.root.find((n:{type:unknown;props:{className?:string};findByProps(props:object):{props:{children:string}}})=>n.type==='button'&&n.props.className==='loom-lapp'&&n.findByProps({className:'loom-lapp__nm'}).props.children===title).props.onClick());}
 /** The order the switcher offers, read without switching. */
 async function recent(){await hold();await tick();const order=offered();await key('keydown','Escape','Escape',CTRL);await release();return order;}

 beforeEach(async()=>{
  now=1000;listeners=[];tiles={};field={value:'',closest(){return field;}};page={visibilityState:'visible'};
  const location={href:'http://loom/'};
  const history={state:null as unknown,pushState(state:unknown,_:string,url:string){this.state=state;location.href='http://loom'+url;},replaceState(state:unknown,_:string,url:string){this.state=state;location.href='http://loom'+url;}};
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true);
  const win=target('window');vi.stubGlobal('window',{...win,location,history,setTimeout,clearTimeout});
  vi.stubGlobal('addEventListener',win.addEventListener);vi.stubGlobal('removeEventListener',win.removeEventListener);
  vi.stubGlobal('document',{...target('document'),get visibilityState(){return page.visibilityState;},querySelector:(selector:string)=>tiles[selector]??null,documentElement:{dataset:{}},activeElement:null});
  vi.stubGlobal('innerWidth',2400);vi.stubGlobal('innerHeight',1200);
  vi.stubGlobal('ResizeObserver',class{observe(){}disconnect(){}});
  await act(async()=>{tree=create(h(Shell,{apps}),{createNodeMock:()=>({focus(){},getBoundingClientRect:()=>({width:2300,height:1000}),querySelectorAll:()=>[]})});});
 });
 afterEach(async()=>{await act(async()=>tree?.unmount());expect(listeners.filter(l=>l.capture&&l.type.startsWith('key')||['pointerdown','blur','visibilitychange'].includes(l.type))).toEqual([]);vi.unstubAllGlobals();});
 const openThree=async()=>{await dock('tasks');await dock('inbox');await dock('notes');};

 it('Ctrl+Space opens and closes the launcher from a text field and types nothing; Space and Shift+Space still type',async()=>{
  await press('KeyH','h');await press('Space',' ');await press('Space',' ',SHIFT);expect(field.value).toBe('h  ');expect(launcherOpen()).toBe(false);
  await key('keydown','ControlLeft','Control',CTRL);await press('Space',' ',CTRL);await key('keyup','ControlLeft','Control');expect(launcherOpen()).toBe(true);
  await key('keydown','ControlLeft','Control',CTRL);await press('Space',' ',CTRL);await key('keyup','ControlLeft','Control');expect(launcherOpen()).toBe(false);
  expect(field.value).toBe('h  ');
 });
 it('the older Ctrl+Shift+Space and Cmd+Shift+Space still toggle it',async()=>{
  await press('Space',' ',{ctrlKey:true,shiftKey:true});expect(launcherOpen()).toBe(true);
  await press('Space',' ',{metaKey:true,shiftKey:true});expect(launcherOpen()).toBe(false);expect(field.value).toBe('');
 });
 it('a double tap of Shift opens the launcher and another closes it; a capital letter does neither',async()=>{
  await key('keydown','ShiftLeft','Shift',SHIFT);await press('KeyA','A',SHIFT);await key('keyup','ShiftLeft','Shift');
  await key('keydown','ShiftLeft','Shift',SHIFT);await press('KeyB','B',SHIFT);await key('keyup','ShiftLeft','Shift');expect(launcherOpen()).toBe(false);expect(field.value).toBe('AB');
  await shiftTap();await shiftTap();expect(launcherOpen()).toBe(true);
  wait(1000);await shiftTap();await shiftTap();expect(launcherOpen()).toBe(false);
  wait(1000);await shiftTap();wait(TAP_GAP_MS);await shiftTap();expect(launcherOpen()).toBe(false);
 });
 it('one tap of Ctrl+` and a release goes to the previous app, and again goes back',async()=>{
  await openThree();expect(front()).toEqual(['notes']);
  await hold();await tick();expect(offered()).toEqual(['notes','inbox','tasks']);expect(selected()).toEqual(['inbox']);
  const list=tree.root.findByProps({role:'listbox'});expect(list.props['aria-activedescendant']).toBe('next-switch-inbox');
  expect(tree.root.findByProps({role:'status','aria-live':'assertive'}).props.children).toContain('Inbox, 2 of 3');
  await release();expect(options()).toEqual([]);expect(front()).toEqual(['inbox']);
  await hold();await tick();await release();expect(front()).toEqual(['notes']);expect(field.value).toBe('');
 });
 it('three taps move three along and wrap, Shift reverses, Escape stays put',async()=>{
  await openThree();await dock('clock');
  await hold();await tick();await tick();await tick();expect(selected()).toEqual(['tasks']);await tick();expect(selected()).toEqual(['clock']);
  await tick({ctrlKey:true,shiftKey:true});expect(selected()).toEqual(['tasks']);await release();expect(front()).toEqual(['tasks']);
  await hold();await tick();await tick();expect(selected()).toEqual(['notes']);
  expect((await key('keydown','Escape','Escape',CTRL)).defaultPrevented).toBe(true);expect(options()).toEqual([]);await release();expect(front()).toEqual(['tasks']);
 });
 it('losing the window while Control is held closes the switcher without switching, and a backtick then types',async()=>{
  await openThree();
  await hold();await tick();expect(options()).toHaveLength(3);await act(async()=>send('blur'));expect(options()).toEqual([]);expect(front()).toEqual(['notes']);
  await press('Backquote','`');expect(field.value).toBe('`');expect(options()).toEqual([]);
  await hold();await tick();expect(options()).toHaveLength(3);page.visibilityState='hidden';await act(async()=>send('visibilitychange'));expect(options()).toEqual([]);
  page.visibilityState='visible';await press('Backquote','`');expect(field.value).toBe('``');expect(front()).toEqual(['notes']);
 });
 it('with one app open, or none, Ctrl+` shows nothing, and a plain backtick is typed',async()=>{
  await hold();await tick();expect(options()).toEqual([]);await release();
  await dock('tasks');await hold();await tick();expect(options()).toEqual([]);await release();expect(front()).toEqual(['tasks']);
  await press('Backquote','`');expect(field.value).toBe('`');
 });
 it('keeps most-recently-used order through a click on a tile, the launcher, the dock and the switcher',async()=>{
  await openThree();expect(await recent()).toEqual(['notes','inbox','tasks']);
  await click('tasks');expect(front()).toEqual(['tasks']);expect(await recent()).toEqual(['tasks','notes','inbox']);
  await launch('Inbox');expect(front()).toEqual(['inbox']);expect(await recent()).toEqual(['inbox','tasks','notes']);
  await launch('Clock');expect(await recent()).toEqual(['clock','inbox','tasks','notes']);
  await hold();await tick();await tick();await tick();await release();expect(front()).toEqual(['notes']);expect(await recent()).toEqual(['notes','clock','inbox','tasks']);
  await hold();await tick();await act(async()=>tree.root.findByProps({id:'next-switch-tasks'}).props.onClick());expect(options()).toEqual([]);await release();
  expect(front()).toEqual(['tasks']);expect(await recent()).toEqual(['tasks','notes','clock','inbox']);
  await act(async()=>tree.root.findByProps({'aria-label':'Close Notes'}).props.onClick());expect(await recent()).toEqual(['tasks','clock','inbox']);
 });
 it('takes no focus while open, and a landing puts it where it last was in that app, or on the app',async()=>{
  await openThree();const focus=vi.fn(),caret={isConnected:true,focus:()=>focus('inbox caret')};
  for(const id of ['tasks','inbox','notes'])tiles[`[data-tile="${id}"]`]={focus:()=>focus(id),contains:el=>id==='inbox'&&el===caret};
  const inbox=tree.root.findByProps({'data-tile':'inbox'});await act(async()=>inbox.props.onFocusCapture({target:caret,currentTarget:{}}));
  await click('tasks');await hold();await tick();expect(selected()).toEqual(['inbox']);expect(focus).not.toHaveBeenCalled();
  await release();expect(focus.mock.calls).toEqual([['inbox caret']]);
  await hold();await tick();await release();expect(front()).toEqual(['tasks']);expect(focus.mock.calls).toEqual([['inbox caret'],['tasks']]);
  await hold();await tick();await key('keydown','Escape','Escape',CTRL);await release();expect(focus).toHaveBeenCalledTimes(2);
 });
 it('opening the switcher takes the launcher out of the way, and a cancel puts it back',async()=>{
  await openThree();await dock('launcher');expect(launcherOpen()).toBe(true);
  await hold();await tick();expect(launcherOpen()).toBe(false);await key('keydown','Escape','Escape',CTRL);await release();expect(launcherOpen()).toBe(true);
  await hold();await tick();await release();expect(launcherOpen()).toBe(false);expect(front()).toEqual(['inbox']);
 });
});
