import { useEffect, useState, type ReactNode } from 'react';
const enc=(buf:ArrayBuffer)=>btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
const dec=(s:string)=>Uint8Array.from(atob(s.replace(/-/g,'+').replace(/_/g,'/')+'==='.slice((s.length+3)%4)),c=>c.charCodeAt(0));
async function post(url:string,body:unknown){const r=await fetch(url,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});const j=await r.json();if(!r.ok)throw new Error(j.error ?? 'Sign-in failed');return j;}
export default function Signin({children}:{children:ReactNode}){
  const [restart,setRestart]=useState(false);
  const [session,setSession]=useState<{viewer:{id:string}|null;csrf?:string}|undefined>(),[message,say]=useState('');
  useEffect(()=>{
    let stopped=false,leaving=false,generation=0,currentId:string|null|undefined;
    const refresh=async()=>{
      if(stopped||leaving)return;const attempt=++generation;
      try{
        const response=await fetch('/auth/session',{credentials:'same-origin',cache:'no-store',redirect:'error'});
        if(!response.ok)throw Error('Session unavailable');const value:unknown=await response.json();
        if(!value||typeof value!=='object'||!('viewer'in value))throw Error('Session unavailable');
        const viewer=value.viewer;let nextId:string|null;
        if(viewer===null)nextId=null;else if(viewer&&typeof viewer==='object'&&'id'in viewer&&typeof viewer.id==='string'&&viewer.id)nextId=viewer.id;else throw Error('Session unavailable');
        if(stopped||attempt!==generation)return;
        // Cookie changes must restart the shared data client, never reuse the
        // previous member's authenticated socket or normalized entities.
        if(currentId!==undefined&&nextId!==null&&currentId!==nextId){leaving=true;setSession(undefined);setRestart(true);return;}
        currentId=nextId;say('');setSession({viewer:nextId===null?null:{id:nextId}});
        const existing=document.querySelector<HTMLMetaElement>('meta[name="loom-csrf"]'),meta=existing??document.createElement('meta');
        meta.name='loom-csrf';meta.content='csrf'in value&&typeof value.csrf==='string'?value.csrf:'';if(!existing)document.head.append(meta);
      }catch{if(!stopped&&attempt===generation)say('Could not reach loom. Reload to try again.');}
    };
    const focus=()=>{void refresh();},visible=()=>{if(document.visibilityState==='visible')void refresh();};
    window.addEventListener('focus',focus);document.addEventListener('visibilitychange',visible);void refresh();
    return()=>{stopped=true;generation++;window.removeEventListener('focus',focus);document.removeEventListener('visibilitychange',visible);};
  },[]);
  // Commit the empty gate before navigating away from the old member's desk.
  useEffect(()=>{if(restart)location.reload();},[restart]);
  const login=async()=>{try{const o=await post('/login/passkey/options',{});const c=await navigator.credentials.get({publicKey:{challenge:dec(o.challenge),rpId:o.rpId,userVerification:'required',timeout:o.timeout}}) as PublicKeyCredential;const r=c.response as AuthenticatorAssertionResponse;await post('/login/passkey',{id:enc(c.rawId),clientDataJSON:enc(r.clientDataJSON),authenticatorData:enc(r.authenticatorData),signature:enc(r.signature)});location.reload();}catch(e){say(e instanceof Error?e.message:'Sign-in cancelled');}};
  if(!session)return <main style={{padding:32}}>Connecting to loom…<p role="status">{message}</p></main>;
  if(!session.viewer)return <main style={{padding:32,maxWidth:480,margin:'12vh auto'}}><h1>Sign in to loom</h1><button onClick={login}>Sign in with a passkey</button><p>Have a one-time sign-in link? Open it and press Sign in.</p><p role="status">{message}</p></main>;
  return <>{children}</>;
}
