import { useState, useSyncExternalStore, type FormEvent } from 'react';
import { call, useRecords, type LiveRecord } from '../../data';
import { AppFrame, Button, Input, Empty, Error as ErrorView, Loading } from '../../kit';
import { idle, frozen } from '../../data/mutation';
import { mutation } from './model';
interface Account extends LiveRecord { member:string; passkeys:Array<{ref:string;label:string;created:number;lastUsed?:number;ended:boolean;made:number}>;sessions:Array<{ref:string;label?:string;device?:string;issuedAt:number;seenAt?:number;ended:boolean}> }
const noop=()=>()=>{};
const enc=(buf:ArrayBuffer)=>btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
const dec=(s:string)=>Uint8Array.from(atob(s.replace(/-/g,'+').replace(/_/g,'/')+'==='.slice((s.length+3)%4)),c=>c.charCodeAt(0));
async function post(path:string,input:unknown){const r=await fetch(path,{method:'POST',credentials:'same-origin',headers:{'content-type':'application/json'},body:JSON.stringify(input),redirect:'error'});const value=await r.json();if(!r.ok)throw Error(value.error??'Sign-in request refused');return value;}
const csrf=()=>document.querySelector<HTMLMetaElement>('meta[name="loom-csrf"]')?.content;
function Registration({enabled}:{enabled:boolean}){
  const [busy,setBusy]=useState(false),[message,say]=useState('');
  const submit=async(event:FormEvent<HTMLFormElement>)=>{
    event.preventDefault();if(!enabled||busy)return;
    const label=String(new FormData(event.currentTarget).get('label')??'').trim();setBusy(true);say('');
    try{
      const _csrf=csrf(),o=await post('/passkeys/options',{_csrf});
      const c=await navigator.credentials.create({publicKey:{...o,user:{...o.user,id:dec(o.user.id)},challenge:dec(o.challenge),excludeCredentials:o.excludeCredentials.map((x:{id:string})=>({type:'public-key',id:dec(x.id)})),attestation:'none'}}) as PublicKeyCredential|null;
      if(!c)throw Error('Passkey creation cancelled');const r=c.response as AuthenticatorAttestationResponse;
      if(!r.getPublicKey||!r.getAuthenticatorData||!r.getPublicKey())throw Error('This browser cannot register a passkey here');
      await post('/passkeys',{_csrf,label,id:enc(c.rawId),clientDataJSON:enc(r.clientDataJSON),authenticatorData:enc(r.getAuthenticatorData()),publicKey:enc(r.getPublicKey()!),publicKeyAlgorithm:r.getPublicKeyAlgorithm()});say('Passkey added.');
    }catch(e){say(e instanceof Error?e.message:'Could not add the passkey');}finally{setBusy(false);}
  };
  return <form aria-label="Add a passkey" className="grid gap-3" onSubmit={event=>void submit(event)}><p>Add a passkey within ten minutes of signing in. Your device asks for its lock.</p><fieldset disabled={!enabled||busy} className="flex flex-wrap gap-2"><label className="grid gap-1">Passkey name<Input name="label" maxLength={60} required /></label><Button type="submit">{busy?'Waiting for device…':'Add a passkey'}</Button></fieldset>{message&&<p role="status">{message}</p>}</form>;
}
export default function AccountApp({go=()=>{},active=true}:{path?:string;go?:(path:string)=>void;active?:boolean}={}){
  const feed=useRecords<Account>('account.self'),account=feed.records[0];
  const held=useSyncExternalStore(mutation.subscribe,mutation.getSnapshot),state=useSyncExternalStore(held.request?.subscribe??noop,held.request?.getSnapshot??(()=>idle));
  const enabled=active&&feed.status==='live'&&!!account&&!frozen(state);
  const submit=(operation:string,ref:string)=>(event:FormEvent<HTMLFormElement>)=>{event.preventDefault();if(!enabled||frozen(mutation.getSnapshot().request?.getSnapshot()??idle))return;const data=new FormData(event.currentTarget);mutation.set(call(operation,{ref,...(operation==='account.removePasskey'?{withMade:data.get('made')==='on'}:{})}),operation);event.currentTarget.reset();};
  return <AppFrame title="Your account" where="Account" go={go}><div className="grid min-w-0 gap-6 overflow-auto p-4 sm:p-6">
    {feed.status==='loading'?<Loading label="Opening your account…"/>:feed.status==='denied'||!account?<Empty title="Your account is unavailable" text="Sign in as a household member and check the connection."/>:<>
      <h2 className="text-xl font-semibold">{account.member}</h2><p>Your passkeys and browsers. Removing a passkey stops it signing in again and ends browsers using its own sign-in credential. Older shared sign-ins stay active; use the browser list to sign them out. Other passkeys keep working unless you also remove those made from it.</p>
      {feed.status!=='live'&&<ErrorView text="Connection lost. Account changes are disabled."/>}
      {held.label?.startsWith('account.')&&<section aria-live="polite">{state.pending?<Loading label="Saving…"/>:state.result?.ok?<p role="status">Saved</p>:state.result&&<><ErrorView text={state.result.message}/>{state.result.code==='unavailable'&&<Button disabled={!active||feed.status!=='live'} onClick={()=>{if(active&&feed.status==='live')held.request?.retry?.();}}>Retry this change</Button>}</>}</section>}
      <section aria-label="Passkeys" className="grid gap-4"><h2 className="text-xl font-semibold">Passkeys</h2><Registration enabled={enabled}/>{!account.passkeys.length&&<p>No passkeys yet.</p>}{account.passkeys.map(k=><form key={k.ref} aria-label={`Remove passkey ${k.label}`} onSubmit={submit('account.removePasskey',k.ref)} className="grid gap-2 rounded-xl border p-4"><h3 className="font-semibold">{k.label}</h3><p className="break-all">Reference: {k.ref}</p><p>{k.ended?'Stopped':'Active'} · Added {new Date(k.created*1000).toLocaleDateString()}{k.lastUsed!==undefined?` · Last used ${new Date(k.lastUsed*1000).toLocaleDateString()}`:''}</p><fieldset disabled={!enabled} className="grid gap-2">{k.made>0&&<label><input type="checkbox" name="made"/> Also remove the {k.made} passkeys made from it</label>}<label><input type="checkbox" required/> I confirm removing {k.label}</label><Button type="submit" variant="outline">Remove passkey</Button></fieldset></form>)}</section>
      <section aria-label="Signed-in browsers" className="grid gap-4"><h2 className="text-xl font-semibold">Signed-in browsers</h2><p>Signing out a browser also stops its notifications.</p>{account.sessions.map(s=><form key={s.ref} aria-label={`Sign out session ${s.ref}`} onSubmit={submit('account.revokeSession',s.ref)} className="grid gap-2 rounded-xl border p-4"><h3 className="font-semibold">{s.device??'Browser'}</h3>{s.label&&<p>Label: {s.label}</p>}<p className="break-all">Reference: {s.ref}</p><p>{s.ended?'Ended':'Signed in'} · Signed in {new Date(s.issuedAt*1000).toLocaleString()} · Last used {new Date((s.seenAt??s.issuedAt)*1000).toLocaleString()}</p><fieldset disabled={!enabled} className="grid gap-2"><label><input type="checkbox" required/> I confirm signing out this browser</label><Button type="submit" variant="outline">Sign out browser</Button></fieldset></form>)}</section>
      <Button disabled={!enabled} variant="outline" onClick={async()=>{try{await post('/logout',{_csrf:csrf()});location.reload();}catch{/* Existing session remains; reloading rechecks it. */location.reload();}}}>Sign out this device</Button>
    </>}
  </div></AppFrame>;
}
