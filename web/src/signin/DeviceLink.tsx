import { useEffect, useRef, useState } from 'react';
import { callOnce } from '../data';
import { Button } from '../kit';
/** Ephemeral credential: stays in this mounted, active, connected screen only. */
export default function DeviceLink({enabled,member}:{enabled:boolean;member?:string}) {
  const [path,setPath]=useState(''),[busy,setBusy]=useState(false),[message,say]=useState('');
  const generation=useRef(0),pending=useRef(false);
  useEffect(()=>{generation.current++;setPath('');},[enabled,member]);
  useEffect(()=>()=>{generation.current++;},[]);
  async function make(){
    if(!enabled||pending.current)return;
    pending.current=true;setBusy(true);setPath('');say('');const current=++generation.current;
    const result=await callOnce<{path:string}>('signin.browserLink',member?{member}:{}).result;
    pending.current=false;setBusy(false);
    if(current!==generation.current)return;
    if(result.ok)setPath(result.value.path);
    else say('The link could not be shown. A lost reply is not retried; any unseen link expires within ten minutes.');
  }
  return <section aria-label={member?`Sign-in link for ${member}`:'Sign in another device'} className="grid min-w-0 gap-2">
    <p>One sign-in within ten minutes{member?` as ${member}`:''}. Anyone with the link can use it. It keeps this browser’s original sign-in time; sign in again to add a passkey.</p>
    <Button disabled={!enabled||busy} variant="outline" onClick={()=>void make()}>Make sign-in link</Button>
    {enabled&&path&&<><p className="break-all" data-signin-link>{new URL(path,location.origin).href}</p><Button variant="outline" onClick={()=>setPath('')}>Hide sign-in link</Button></>}
    {message&&<p role="status">{message}</p>}
  </section>;
}
