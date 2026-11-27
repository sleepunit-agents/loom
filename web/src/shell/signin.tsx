// The gate before the desk: one page for its three states (connecting, could not reach loom, signed out). The wordmark,
// the thread under it and the woven ground stay put; only what is under the thread changes. Nothing here knows the
// household: no names, faces or counts before sign-in. Its look is signin.css. The server's own page for a one-time
// link (src/core/signin/page.ts) wears the same look with no script; the values the two share are listed there and
// in signin.css, and are kept in step by hand.
import { useLayoutEffect, useState, type ReactNode } from 'react';
import {useSession} from '../signin/use-session';
import { DeskMember } from '../signin/desk-member';
import { lookOf, wearLook } from '../look';
import './signin.css';
import { WovenCloth } from '../woven-cloth';
/** The word for this time of day, from the device's own clock. */
export const greetingAt=(hour:number)=>hour>=5&&hour<12?'Good morning':hour>=12&&hour<18?'Good afternoon':'Good evening';

/** The gate's own look, worn only while the gate is shown: this device's kept copy of a person's look when there is
 * one (looks/boot.js has usually painted it already); with none, the device's own light or dark, never kept. Answers
 * how to put back exactly what was on the document before (its look, its light or dark, the browser bar's colour), so
 * a person who is signed in never has the gate's choice on their desk. Until loom answers, nothing is touched. */
function wearGateLook():(()=>void)|undefined{
  const root=document.documentElement;
  let kept:string|null=null,mode:string|null=null;
  try{kept=localStorage.getItem('loom-look');mode=localStorage.getItem('loom-mode');}catch{/* private window */}
  const light=typeof matchMedia==='function'&&matchMedia('(prefers-color-scheme: light)').matches;
  const look=kept?lookOf(kept,mode):light?'daylight':'neon';
  if(root.dataset.look===look)return;
  const before={look:root.dataset.look,mode:root.dataset.mode},bar=[...document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]')].map(meta=>({meta,content:meta.content,own:meta.dataset.own}));
  wearLook(look);
  return()=>{
    for(const key of ['look','mode'] as const){if(before[key]===undefined)delete root.dataset[key];else root.dataset[key]=before[key];}
    for(const {meta,content,own} of bar){meta.content=content;if(own===undefined)delete meta.dataset.own;else meta.dataset.own=own;}
  };
}

export function Weave(){
  return <div className="loom-gate__ground" aria-hidden="true">
    <span className="loom-wash loom-gate__wash" />
    <WovenCloth />
    <i className="loom-gate__shuttle" data-tint="pink" /><i className="loom-gate__shuttle" data-tint="blue" /><i className="loom-gate__shuttle" data-tint="yellow" />
    <span className="loom-gate__veil" />
  </div>;
}

export default function Signin({children}:{children:ReactNode}){
  const {session,message,login}=useSession();
  const [greeting]=useState(()=>greetingAt(new Date().getHours()));
  const state=session?.viewer?'in':session?'out':message?'down':'connecting',shown=state==='out'||state==='down';
  useLayoutEffect(()=>shown?wearGateLook():undefined,[shown]);
  if(session?.viewer)return <DeskMember.Provider value={session.viewer.id}>{children}</DeskMember.Provider>;
  const words=state==='connecting'?'Connecting to loom…':message;
  return <main className="loom-gate" data-state={state}>
    <Weave />
    <div className="loom-gate__column">
      <p className="loom-gate__greeting">{greeting}</p>
      <h1 className="loom-gate__mark" aria-label="loom">LOOM<i aria-hidden="true">//</i>OS</h1>
      <div className="loom-gate__thread" aria-hidden="true"><i /></div>
      <div className="loom-gate__panel">
        {state==='out'&&<div className="loom-gate__act">
          <h2 className="loom-gate__title">Sign in to loom</h2>
          <button className="loom-gate__go" autoFocus onClick={login}>Sign in with a passkey</button>
          <p className="loom-gate__hint">Have a one-time sign-in link? Open it and press Sign in.</p>
        </div>}
        {/* One element, always the panel's second child, so it is never made again and a reader hears it change. Signed
            out it comes after the button, where someone moving on from the button finds the error. */}
        <p className="loom-gate__status" role="status" data-tone={words?(state==='connecting'?'calm':'error'):undefined}>{words}</p>
        {state==='down'&&<div className="loom-gate__act">
          <button className="loom-gate__go" data-kind="quiet" autoFocus onClick={()=>location.reload()}>Reload</button>
        </div>}
      </div>
    </div>
  </main>;
}
