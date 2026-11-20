import {useEffect,useRef,useState} from 'react';
import {Button} from '../kit';
/** A current member's one-time credential, never retained across screen scopes. */
export default function DeviceLink({enabled,member}:{enabled:boolean;member?:string}){
 const [link,setLink]=useState<{path:string;member?:string}|null>(null),[busy,setBusy]=useState(false),[message,say]=useState('');
 const generation=useRef(0),pending=useRef(false);
 useEffect(()=>{generation.current++;setLink(null);},[enabled,member]);
 useEffect(()=>()=>{generation.current++;},[]);
 async function make(){
  if(!enabled||pending.current)return;pending.current=true;setBusy(true);setLink(null);say('');const current=++generation.current;
  try{
   const response=await fetch('/api/signin/link',{method:'POST',credentials:'same-origin',redirect:'error',headers:{'content-type':'application/json'},body:'{}',signal:AbortSignal.timeout(10000)});
   if(response.status===401||response.status===403){if(current===generation.current)say('Sign in again before making a sign-in link.');return;}
   const result:unknown=await response.json();
   if(!response.ok||!result||typeof result!=='object'||!('ok'in result)||result.ok!==true||!('value'in result)||!result.value||typeof result.value!=='object'||!('path'in result.value)||typeof result.value.path!=='string'||!/^\/login\/[a-f0-9]{64}$/.test(result.value.path))throw Error();
   if(current===generation.current)setLink({path:result.value.path,member});
  }catch{if(current===generation.current)say('The link could not be shown. It was not retried; any unseen link expires within five minutes.');}
  finally{pending.current=false;setBusy(false);}
 }
 return <section aria-label="Sign in another device" className="grid min-w-0 gap-2"><p>One sign-in within five minutes{member?` as ${member}`:''}. Anyone with the link can use it. The other device is signed in for as long as this one, and can add a passkey only within ten minutes of this browser's own sign-in.</p><Button disabled={!enabled||busy} variant="outline" onClick={()=>void make()}>Make sign-in link</Button>
 {enabled&&link&&link.member===member&&<><p role="status" className="break-all" data-signin-link>{new URL(link.path,location.origin).href}</p><Button variant="outline" onClick={()=>setLink(null)}>Hide sign-in link</Button></>}{message&&<p role="status">{message}</p>}</section>;
}
