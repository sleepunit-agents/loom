import {beforeEach,describe,expect,it} from 'vitest';
import {SHORTCUTS,TAP_GAP_MS,TAP_HELD_MS,keysOf,recency,shortcutEngine,shortcutHints,type Switching} from './shortcuts';

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
 it('the hints list every declared shortcut, for the platform',()=>{
  for(const mac of [false,true])expect(shortcutHints(mac).flatMap(hint=>hint.keys)).toEqual(expect.arrayContaining(SHORTCUTS.map(s=>keysOf(s,mac))));
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
