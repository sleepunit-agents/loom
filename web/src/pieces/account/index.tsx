import {OwnerMachines} from '../runtime/machines';
import {sessionChange} from '../../signin/session-change';
import DeviceLink from '../../signin/DeviceLink';
import { decode as dec } from './encoding';
import { useState, type FormEvent } from 'react';
import { useDataQuery } from '../../data/graphql';
import { memberOperation } from '../../data/operation';
import { AppFrame, Button, Input, Empty, Error as ErrorView, Loading } from '../../kit';
interface Account { member:string;notifications?:{publicKey:string|null;devices:Array<{ref:string;device:string;createdAt:string;seenAt:string}>};passkeys:Array<{ref:string;label:string;createdAt:string;lastUsedAt:string|null;ended:boolean}>;sessions:Array<{ref:string;device:string;issuedAt:string;seenAt:string;ended:boolean}> }
const query=`{ account { member notifications { publicKey devices { ref device createdAt seenAt } } passkeys { ref label createdAt lastUsedAt ended } sessions { ref device issuedAt seenAt ended } } }`;
const enc=(buf:ArrayBuffer)=>btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
async function post(path:string,input:unknown){const r=await fetch(path,{method:'POST',credentials:'same-origin',headers:{'content-type':'application/json'},body:JSON.stringify(input),redirect:'error'});const value=await r.json();if(!r.ok)throw Error(value.error??'Sign-in request refused');return value;}
function Registration({enabled}:{enabled:boolean}){
  const [busy,setBusy]=useState(false),[message,say]=useState('');
  const submit=async(event:FormEvent<HTMLFormElement>)=>{
    event.preventDefault();if(!enabled||busy)return;
    const label=String(new FormData(event.currentTarget).get('label')??'').trim();setBusy(true);say('');
    try{
      const o=await post('/passkeys/options',{});
      const c=await navigator.credentials.create({publicKey:{...o,user:{...o.user,id:dec(o.user.id)},challenge:dec(o.challenge),excludeCredentials:o.excludeCredentials.map((x:{id:string})=>({type:'public-key',id:dec(x.id)})),attestation:'none'}}) as PublicKeyCredential|null;
      if(!c)throw Error('Passkey creation cancelled');const r=c.response as AuthenticatorAttestationResponse;
      if(!r.getPublicKey||!r.getAuthenticatorData||!r.getPublicKey())throw Error('This browser cannot register a passkey here');
      await post('/passkeys',{label,id:enc(c.rawId),clientDataJSON:enc(r.clientDataJSON),authenticatorData:enc(r.getAuthenticatorData()),publicKey:enc(r.getPublicKey()!),publicKeyAlgorithm:r.getPublicKeyAlgorithm()});say('Passkey added.');
    }catch(e){say(e instanceof Error?e.message:'Could not add the passkey');}finally{setBusy(false);}
  };
  return <form aria-label="Add a passkey" className="grid gap-3" onSubmit={event=>void submit(event)}><p>Add a passkey within ten minutes of signing in. Your device asks for its lock.</p><fieldset disabled={!enabled||busy} className="flex flex-wrap gap-2"><label className="grid gap-1">Passkey name<Input name="label" maxLength={60} required /></label><Button disabled={!enabled||busy} type="submit">{busy?'Waiting for device…':'Add a passkey'}</Button></fieldset>{message&&<p role="status">{message}</p>}</form>;
}

export default function AccountApp({go=()=>{},active=true}:{path?:string;go?:(path:string)=>void;active?:boolean}={}){
 const feed=useDataQuery<{account:Account|null}>(query),account=feed.data?.account;
 const [busy,setBusy]=useState(false),[message,say]=useState('');
 const enabled=active&&feed.status==='live'&&!!account&&!busy;
 const change=async(name:string,ref:string)=>{if(!enabled)return;setBusy(true);say('');try{if(name==='account.revokeSession'){if(await sessionChange(name,{ref})==='signed-out')return;}else await memberOperation(name,{ref});say('Saved');}catch{say(name==='account.revokeSession'?'Could not confirm sign-out. Check your sign-in and connection.':'Could not save. Check the connection and try again.');}finally{setBusy(false);}};
 const enableNotifications=async()=>{
  if(!enabled||!account?.notifications?.publicKey)return;setBusy(true);say('');
  try{
   if(!('serviceWorker'in navigator)||!('PushManager'in window)||!('Notification'in window))throw Error('This browser does not support notifications.');
   if(await Notification.requestPermission()!=='granted')throw Error('Notifications were not allowed.');
   const registration=await navigator.serviceWorker.ready,existing=await registration.pushManager.getSubscription();
   const sub=existing??await registration.pushManager.subscribe({userVisibleOnly:true,applicationServerKey:dec(account.notifications.publicKey)}),value=sub.toJSON();
   await memberOperation('notifications.subscribe',{sub:{endpoint:sub.endpoint,keys:value.keys},device:navigator.userAgent.slice(0,120)||'Browser'});say('Notifications enabled.');
  }catch(error){say(error instanceof Error?error.message:'Could not enable notifications.');}finally{setBusy(false);}
 };
 return <AppFrame title="Your account" where="Account" go={go}><div className="grid gap-6 overflow-auto p-5">
 {feed.status==='loading'?<Loading label="Opening your account…"/>:!account?<Empty title="Your account is unavailable" text="Sign in as a household member and check the connection."/>:<>
 <h2 className="text-xl font-semibold">{account.member}</h2>
 {feed.status!=='live'&&<ErrorView text="Connection lost. Account changes are disabled."/>}
 {message&&<p role="status" className="break-all">{message}</p>}
 {active&&feed.status==='live'&&<OwnerMachines key={account.member} member={account.member}/>}
 <DeviceLink enabled={enabled} member={account.member}/>
 <section aria-label="Passkeys" className="grid gap-4"><h2>Passkeys</h2><Registration enabled={enabled}/>{!account.passkeys.length&&<p>No passkeys yet.</p>}{account.passkeys.map(key=><div key={key.ref} className="rounded-xl border p-4"><h3>{key.label}</h3><p>{key.ended?'Stopped':'Active'} · Added {new Date(key.createdAt).toLocaleDateString()}{key.lastUsedAt?` · Last used ${new Date(key.lastUsedAt).toLocaleString()}`:''}</p><Button disabled={!enabled} variant="danger-quiet" onClick={()=>void change('account.removePasskey',key.ref)}>Remove passkey</Button></div>)}</section>
 <section aria-label="Signed-in browsers" className="grid gap-4"><h2>Signed-in browsers</h2>{account.sessions.map(session=><div key={session.ref} className="rounded-xl border p-4"><h3>{session.device}</h3><p>{session.ended?'Ended':'Signed in'} · Last used {new Date(session.seenAt).toLocaleString()}</p><Button disabled={!enabled} variant="outline" onClick={()=>void change('account.revokeSession',session.ref)}>Sign out browser</Button></div>)}</section>
 <section aria-label="Notifications" className="grid gap-4"><h2>Notifications</h2>{account.notifications?.publicKey?<Button disabled={!enabled} onClick={()=>void enableNotifications()}>Enable notifications on this browser</Button>:<p>Notifications are unavailable.</p>}{account.notifications?.devices.map(device=><div key={device.ref} className="rounded-xl border p-4"><h3>{device.device}</h3><p>Last confirmed {new Date(device.seenAt).toLocaleString()}</p><Button disabled={!enabled} variant="danger-quiet" onClick={()=>void change('notifications.removeDevice',device.ref)}>Remove notification device</Button></div>)}</section>
 <Button disabled={!enabled} variant="outline" onClick={async()=>{await post('/logout',{});location.reload();}}>Sign out this device</Button>
 </>}
 </div></AppFrame>;
}
