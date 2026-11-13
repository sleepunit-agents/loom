import {afterEach,expect,it,vi} from 'vitest';
import {bindRowHold} from '../../web/src/pieces/comms/row-hold.js';

afterEach(()=>{vi.useRealTimers();vi.unstubAllGlobals();});
function fixture(){
 vi.useFakeTimers();
 const doc=new EventTarget(),win=new EventTarget(),row=new EventTarget();
 vi.stubGlobal('document',doc);vi.stubGlobal('window',win);vi.stubGlobal('getSelection',()=>null);
 const el=Object.assign(row,{contains:(node:unknown)=>node===row});
 let eligible=true;const pin=vi.fn(),bound=bindRowHold(el as unknown as HTMLElement,()=>eligible,pin);
 const pointer=(type:string,props:Record<string,unknown>={})=>{const e=new Event(type,{cancelable:true});Object.defineProperties(e,Object.fromEntries(Object.entries({pointerId:1,pointerType:'touch',button:0,isPrimary:true,clientX:100,clientY:100,target:row,...props}).map(([k,value])=>[k,{value}])));doc.dispatchEvent(e);};
 const click=(detail=1)=>{const e=new Event('click',{cancelable:true});Object.defineProperty(e,'detail',{value:detail});row.dispatchEvent(e);return e.defaultPrevented;};
 return {doc,win,row,pointer,click,pin,bound,disable:()=>{eligible=false;}};
}
it('pins only after a stationary hold, once, and swallows its pointer click but permits the next tap',()=>{
 const f=fixture();f.pointer('pointerdown');vi.advanceTimersByTime(549);expect(f.pin).not.toHaveBeenCalled();
 vi.advanceTimersByTime(1);expect(f.pin).toHaveBeenCalledTimes(1);vi.advanceTimersByTime(5000);expect(f.pin).toHaveBeenCalledTimes(1);
 f.pointer('pointerup');expect(f.click()).toBe(true);f.pointer('pointerdown');f.pointer('pointerup');expect(f.click()).toBe(false);f.bound.dispose();
});
it('cancels for scrolling, release, cancellation, another finger, focus/visibility loss or unmount',()=>{
 for(const end of ['move','up','cancel','second','blur','hidden','dispose']){
  const f=fixture();f.pointer('pointerdown');
  if(end==='move')f.pointer('pointermove',{clientY:111});
  if(end==='up')f.pointer('pointerup');if(end==='cancel')f.pointer('pointercancel');
  if(end==='second')f.pointer('pointerdown',{pointerId:2,isPrimary:false,target:new EventTarget()});
  if(end==='blur')f.win.dispatchEvent(new Event('blur'));if(end==='hidden')f.doc.dispatchEvent(new Event('visibilitychange'));
  if(end==='dispose')f.bound.dispose();vi.advanceTimersByTime(1000);expect(f.pin,end).not.toHaveBeenCalled();expect(f.click(),end).toBe(false);f.bound.dispose();
 }
});
it('ignores a mouse, secondary contact, other controls, selected text and changed eligibility',()=>{
 for(const props of [{pointerType:'mouse'},{isPrimary:false},{button:2},{target:new EventTarget()}]){
  const f=fixture();f.pointer('pointerdown',props);vi.advanceTimersByTime(1000);expect(f.pin).not.toHaveBeenCalled();f.bound.dispose();
 }
 const f=fixture();vi.stubGlobal('getSelection',()=>({isCollapsed:false}));f.pointer('pointerdown');vi.advanceTimersByTime(1000);expect(f.pin).not.toHaveBeenCalled();
 vi.stubGlobal('getSelection',()=>null);f.pointer('pointerdown');f.disable();vi.advanceTimersByTime(1000);expect(f.pin).not.toHaveBeenCalled();f.bound.dispose();
});
it('suppresses the native touch context menu, preserves keyboard clicks and leaves mouse context menus alone',()=>{
 const f=fixture();f.pointer('pointerdown');const context=new Event('contextmenu',{cancelable:true});f.row.dispatchEvent(context);expect(context.defaultPrevented).toBe(true);
 vi.advanceTimersByTime(550);f.pointer('pointerup');expect(f.click(0)).toBe(false);expect(f.click()).toBe(true);
 f.pointer('pointerdown',{pointerType:'mouse'});const mouse=new Event('contextmenu',{cancelable:true});f.row.dispatchEvent(mouse);expect(mouse.defaultPrevented).toBe(false);f.bound.dispose();
});
