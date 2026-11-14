import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import type { MenuAt } from '../tiling/menu';
type Mode = 'always' | 'strip' | 'auto';
type Part = 'rail' | 'dock';
const labels: Record<Mode,string> = {always:'Always show',strip:'Minimize to strip',auto:'Auto-hide'};
const read = (part: Part): Mode => {try {const v=localStorage.getItem(`loom-next-${part}`);return v==='strip'||v==='auto'?v:'always';}catch{return 'always';}};
/** Browser choices only. Peeking changes no reserved room and never writes app state. */
export function useHiding(menuOpen: boolean, announce: (text:string)=>void) {
  const [modes,setModes]=useState(()=>({rail:read('rail'),dock:read('dock')}));
  const [peek,setPeek]=useState({rail:false,dock:false});
  const timers=useRef<Partial<Record<Part,number>>>({});
  const show=(part:Part,on:boolean)=>{clearTimeout(timers.current[part]);if(on)setPeek(p=>({...p,[part]:true}));else timers.current[part]=window.setTimeout(()=>setPeek(p=>({...p,[part]:false})),280);};
  const choose=(part:Part,mode:Mode)=>{
    clearTimeout(timers.current[part]);
    try{localStorage.setItem(`loom-next-${part}`,mode);}catch{/* Private browsers can still use this window's choice. */}
    setModes(p=>({...p,[part]:mode}));setPeek(p=>({...p,[part]:false}));announce(`${part==='rail'?'Agents rail':'Dock'}: ${labels[mode]}`);
  };
  const menu=(part:Part,e:ReactPointerEvent|React.MouseEvent):MenuAt=>{
    e.preventDefault();return {x:e.clientX,y:e.clientY,title:part==='rail'?'Agents rail':'Dock',back:(e.target as Element).closest<HTMLElement>('button')??e.currentTarget as HTMLElement,items:(['always','strip','auto'] as const).map(mode=>({id:mode,label:labels[mode],hint:modes[part]===mode?'✓':undefined,run:()=>choose(part,mode)}))};
  };
  useEffect(()=>{
    if(menuOpen)Object.values(timers.current).forEach(clearTimeout);
    const outside=(e:PointerEvent)=>{if(menuOpen)return;const el=e.target as Element;setPeek(p=>({rail:p.rail&&!!el.closest('[data-hide-part=rail]'),dock:p.dock&&!!el.closest('[data-hide-part=dock]')}));};
    const esc=(e:KeyboardEvent)=>{if(e.key==='Escape'&&!menuOpen)setPeek({rail:false,dock:false});};
    const moved=(e:PointerEvent)=>{if(menuOpen||e.pointerType!=='mouse')return;for(const part of ['rail','dock'] as const)if(peek[part]&&modes[part]==='auto')show(part,!!(e.target as Element).closest(`[data-hide-part=${part}]`));};
    addEventListener('pointerdown',outside,true);addEventListener('keydown',esc);addEventListener('pointermove',moved,{passive:true});
    return()=>{removeEventListener('pointerdown',outside,true);removeEventListener('keydown',esc);removeEventListener('pointermove',moved);};
  },[peek,modes,menuOpen]);
  useEffect(()=>()=>{Object.values(timers.current).forEach(clearTimeout);},[]);
  // Storage is deliberately separate from the old side; other next windows on this device follow it.
  useEffect(()=>{const changed=(e:StorageEvent)=>{if(e.key===null||e.key==='loom-next-rail'||e.key==='loom-next-dock'){setModes({rail:read('rail'),dock:read('dock')});setPeek({rail:false,dock:false});}};addEventListener('storage',changed);return()=>removeEventListener('storage',changed);},[]);
  return {modes,peek,show,menu};
}
