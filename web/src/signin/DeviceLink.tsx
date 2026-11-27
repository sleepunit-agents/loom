import {useEffect,useRef,useState} from 'react';
import {Button} from '../kit';
import {DEVICE_LINK_WORDS,requestSigninLink} from './device-link';
/** A current member's one-time credential, never retained across screen scopes. */
export default function DeviceLink({enabled,member}:{enabled:boolean;member?:string}){
 const [link,setLink]=useState<{path:string;member?:string}|null>(null),[busy,setBusy]=useState(false),[message,say]=useState('');
 const generation=useRef(0),pending=useRef(false);
 useEffect(()=>{generation.current++;setLink(null);},[enabled,member]);
 useEffect(()=>()=>{generation.current++;},[]);
 async function make(){
  if(!enabled||pending.current)return;pending.current=true;setBusy(true);setLink(null);say('');const current=++generation.current;
  try{
   const result=await requestSigninLink();
   if(result==='signin'){if(current===generation.current)say(DEVICE_LINK_WORDS.again);return;}
   if(current===generation.current)setLink({path:result.path,member});
  }catch{if(current===generation.current)say(DEVICE_LINK_WORDS.lost);}
  finally{pending.current=false;setBusy(false);}
 }
 return <section aria-label="Sign in another device" className="grid min-w-0 gap-2"><p>{DEVICE_LINK_WORDS.about(member)}</p><Button disabled={!enabled||busy} variant="outline" onClick={()=>void make()}>Make sign-in link</Button>
 {enabled&&link&&link.member===member&&<><p role="status" className="break-all" data-signin-link>{new URL(link.path,location.origin).href}</p><Button variant="outline" onClick={()=>setLink(null)}>Hide sign-in link</Button></>}{message&&<p role="status">{message}</p>}</section>;
}
