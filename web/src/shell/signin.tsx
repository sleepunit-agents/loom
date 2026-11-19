// The gate before the desk: one page for its three states (connecting, could not reach loom, signed out). The wordmark,
// the thread under it and the woven ground stay put; only what is under the thread changes. Nothing here knows the
// household: no names, faces or counts before sign-in. Its look is signin.css. The server's own page for a one-time
// link (src/core/signin/page.ts) wears the same look with no script; the values the two share are listed there and
// in signin.css, and are kept in step by hand.
import { useEffect, useLayoutEffect, useState, type ReactNode } from 'react';
import { lookOf, wearLook } from '../look';
import './signin.css';
const enc=(buf:ArrayBuffer)=>btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
const dec=(s:string)=>Uint8Array.from(atob(s.replace(/-/g,'+').replace(/_/g,'/')+'==='.slice((s.length+3)%4)),c=>c.charCodeAt(0));
async function post(url:string,body:unknown){const r=await fetch(url,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});const j=await r.json();if(!r.ok)throw new Error(j.error ?? 'Sign-in failed');return j;}

/** The word for this time of day, from the device's own clock. */
export const greetingAt=(hour:number)=>hour>=5&&hour<12?'Good morning':hour>=12&&hour<18?'Good afternoon':'Good evening';

/** The look before sign-in: this device's kept copy of a person's look when there is one (looks/boot.js has usually
 * painted it already); with none, the device's own light or dark, for this page only and never kept. */
function wearGateLook(){
  const root=document.documentElement as HTMLElement|undefined;if(!root)return;
  let kept:string|null=null,mode:string|null=null;
  try{kept=localStorage.getItem('loom-look');mode=localStorage.getItem('loom-mode');}catch{/* private window */}
  const light=typeof matchMedia==='function'&&matchMedia('(prefers-color-scheme: light)').matches;
  const look=kept?lookOf(kept,mode):light?'daylight':'neon';
  if(root.dataset.look!==look)wearLook(look);
}

// The ground: one tile of plain weave, eight warp and eight weft threads, each broken where it passes under.
const TILE=192,GAP=5,AT=[12,36,60,76,108,132,156,172];
const WARP=['border','edge','pink','border','border','blue','edge','border'],WEFT=['border','olive','border','edge','border','yellow','border','edge'];
function threadPath(i:number,weft:boolean){
  const line=(a:number,b:number)=>weft?`M${a} ${AT[i]}H${b}`:`M${AT[i]} ${a}V${b}`;
  let d='',from=0;
  for(const [j,at] of AT.entries())if((i+j)%2===(weft?0:1)){d+=line(from,at-GAP);from=at+GAP;}
  return d+line(from,TILE);
}
const THREADS=[...WEFT.map((tint,i)=>({tint,d:threadPath(i,true)})),...WARP.map((tint,i)=>({tint,d:threadPath(i,false)}))];
function Weave(){
  return <div className="loom-gate__ground" aria-hidden="true">
    <span className="loom-wash loom-gate__wash" />
    <div className="loom-gate__cloth"><svg width="100%" height="100%" focusable="false">
      <defs><pattern id="loom-gate-weave" width={TILE} height={TILE} patternUnits="userSpaceOnUse">{THREADS.map(t=><path key={t.d} className="loom-gate__ply" data-tint={t.tint} d={t.d} />)}</pattern></defs>
      <rect width="100%" height="100%" fill="url(#loom-gate-weave)" />
    </svg></div>
    <i className="loom-gate__shuttle" data-tint="pink" /><i className="loom-gate__shuttle" data-tint="blue" /><i className="loom-gate__shuttle" data-tint="yellow" />
    <span className="loom-gate__veil" />
  </div>;
}

export default function Signin({children}:{children:ReactNode}){
  const [session,setSession]=useState<{viewer:{id:string}|null;csrf?:string}|undefined>(),[message,say]=useState('');
  const [greeting]=useState(()=>greetingAt(new Date().getHours()));
  useLayoutEffect(wearGateLook,[]);
  useEffect(()=>{fetch('/auth/session').then(r=>r.json()).then(s=>{setSession(s);const m=document.createElement('meta');m.name='loom-csrf';m.content=s.csrf ?? '';document.head.append(m);}).catch(()=>say('Could not reach loom. Reload to try again.'));},[]);
  const login=async()=>{try{const o=await post('/login/passkey/options',{});const c=await navigator.credentials.get({publicKey:{challenge:dec(o.challenge),rpId:o.rpId,userVerification:'required',timeout:o.timeout}}) as PublicKeyCredential;const r=c.response as AuthenticatorAssertionResponse;await post('/login/passkey',{id:enc(c.rawId),clientDataJSON:enc(r.clientDataJSON),authenticatorData:enc(r.authenticatorData),signature:enc(r.signature)});location.reload();}catch(e){say(e instanceof Error?e.message:'Sign-in cancelled');}};
  if(session?.viewer)return <>{children}</>;
  const state=session?'out':message?'down':'connecting',words=state==='connecting'?'Connecting to loom…':message;
  return <main className="loom-gate" data-state={state}>
    <Weave />
    <div className="loom-gate__column">
      <p className="loom-gate__greeting">{greeting}</p>
      <h1 className="loom-gate__mark" aria-label="loom">LOOM<i aria-hidden="true">//</i>OS</h1>
      <div className="loom-gate__thread" aria-hidden="true"><i /></div>
      <div className="loom-gate__panel">
        <p className="loom-gate__status" role="status" data-tone={state==='connecting'?'calm':'error'}>{words}</p>
        {state==='out'&&<div className="loom-gate__act" key="out">
          <h2 className="loom-gate__title">Sign in to loom</h2>
          <button className="loom-gate__go" autoFocus onClick={login}>Sign in with a passkey</button>
          <p className="loom-gate__hint">Have a one-time sign-in link? Open it and press Sign in.</p>
        </div>}
        {state==='down'&&<div className="loom-gate__act" key="down">
          <button className="loom-gate__go" data-kind="quiet" autoFocus onClick={()=>location.reload()}>Reload</button>
        </div>}
      </div>
    </div>
  </main>;
}
