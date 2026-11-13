import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { ReplyCursor } from './follow';
const near=80;
/** The kit reader owns its scroller on every width. Earlier pages never enter this cursor. */
export function useReplyFollow(scroller:RefObject<HTMLDivElement|null>,rows:readonly {seq:number;kind:string}[],live:boolean){
 const cursor=useRef(new ReplyCursor()),drawn=useRef<{height:number;viewport:number}|undefined>(undefined),following=useRef(true);
 const [unread,setUnread]=useState(0);
 const measure=(el:HTMLDivElement)=>({height:el.scrollHeight,viewport:el.clientHeight});
 const down=()=>{const el=scroller.current;if(!el)return;el.scrollTop=el.scrollHeight;following.current=true;drawn.current=measure(el);setUnread(0);};
 const onScroll=()=>{const el=scroller.current;if(!el)return;
  // Reflow can itself dispatch scroll before ResizeObserver. Keep the decision
  // made in the previous geometry until the observer has handled that resize.
  if(drawn.current&&(drawn.current.height!==el.scrollHeight||drawn.current.viewport!==el.clientHeight))return;
  following.current=el.scrollHeight-el.scrollTop-el.clientHeight<=near;if(following.current)setUnread(0);
 };
 useLayoutEffect(()=>{
  const el=scroller.current;if(!el)return;
  if(!live){cursor.current.reset();drawn.current=undefined;following.current=true;setUnread(0);return;}
  const change=cursor.current.advance(rows);
  // Read the current position against the previous height: a scroll event may still be queued.
  const there=drawn.current===undefined||drawn.current.viewport!==el.clientHeight?following.current:drawn.current.height-el.scrollTop-el.clientHeight<=near;
  if(change.initial||change.sent||there)down();
  else if(change.added){following.current=false;setUnread(n=>n+change.added);}
  drawn.current=measure(el);
 });
 useEffect(()=>{
  const el=scroller.current,content=el?.querySelector('ol');if(!live||!el||!content)return;
  const observer=new ResizeObserver(()=>{
   if(following.current)down();
   drawn.current=measure(el);
  });
  observer.observe(el);observer.observe(content);return()=>observer.disconnect();
 },[live,scroller]);
 return {unread:live?unread:0,down,onScroll};
}
