import {deviceLabel} from '../../../../src/core/signin/browser-device';
import {fullTime} from '../../kit/time';
import {useHouseholdZone} from '../../data/zone';
import {sessionChange} from '../../signin/session-change';
import DeviceLink from '../../signin/DeviceLink';
import { PASSKEY_WORDS, addPasskey, post } from './passkey';
import { accountQuery as query, type Account } from './query';
import { enableNotifications as enableBrowserNotifications } from './notifications';
import { useState, type FormEvent } from 'react';
import { useDataQuery } from '../../data/graphql';
import { memberOperation } from '../../data/operation';
import { AppFrame, Button, Input, Section, Field, Fields, Empty, Error as ErrorView, Loading } from '../../kit';
function Registration({enabled}:{enabled:boolean}){
  const [busy,setBusy]=useState(false),[message,say]=useState('');
  const submit=async(event:FormEvent<HTMLFormElement>)=>{
    event.preventDefault();if(!enabled||busy)return;
    const label=String(new FormData(event.currentTarget).get('label')??'').trim();setBusy(true);say('');
    try{
      await addPasskey(label);say('Passkey added.');
    }catch(e){say(e instanceof Error?e.message:'Could not add the passkey');}finally{setBusy(false);}
  };
  return <form aria-label="Add a passkey" className="grid gap-3" onSubmit={event=>void submit(event)}><p>{PASSKEY_WORDS}</p><Fields disabled={!enabled||busy} className="flex flex-wrap gap-2"><Field label="Passkey name"><Input name="label" maxLength={60} required /></Field><Button disabled={!enabled||busy} type="submit">{busy?'Waiting for device…':'Add a passkey'}</Button></Fields>{message&&<p role="status">{message}</p>}</form>;
}

export default function AccountApp({go=()=>{},active=true}:{path?:string;go?:(path:string)=>void;active?:boolean}={}){
 const zone=useHouseholdZone();
 const feed=useDataQuery<{account:Account|null}>(query),account=feed.data?.account;
 const [busy,setBusy]=useState(false),[message,say]=useState('');
 const enabled=active&&feed.status==='live'&&!!account&&!busy;
 const change=async(name:string,ref:string)=>{if(!enabled)return;setBusy(true);say('');try{if(name==='account.revokeSession'){if(await sessionChange(name,{ref})==='signed-out')return;}else await memberOperation(name,{ref});say('Saved');}catch{say(name==='account.revokeSession'?'Could not confirm sign-out. Check your sign-in and connection.':'Could not save. Check the connection and try again.');}finally{setBusy(false);}};
 const enableNotifications=async()=>{
  if(!enabled||!account?.notifications?.publicKey)return;setBusy(true);say('');
  try{
   await enableBrowserNotifications(account.notifications.publicKey);say('Notifications enabled.');
  }catch(error){say(error instanceof Error?error.message:'Could not enable notifications.');}finally{setBusy(false);}
 };
 return <AppFrame title="Your account" where="Account" go={go}><div className="grid gap-6 overflow-auto p-5">
 {feed.status==='loading'?<Loading label="Opening your account…"/>:!account?<Empty title="Your account is unavailable" text="Sign in as a household member and check the connection."/>:<>
 <h2 className="text-xl font-semibold">{account.member}</h2>
 {feed.status!=='live'&&<ErrorView text="Connection lost. Account changes are disabled."/>}
 {message&&<p role="status" className="break-all">{message}</p>}
 <DeviceLink enabled={enabled} member={account.member}/>
 <Section label="Passkeys" className="grid gap-4"><Registration enabled={enabled}/>{!account.passkeys.length&&<p>No passkeys yet.</p>}{account.passkeys.map(key=><div key={key.ref} className="rounded-xl border p-4"><h3>{key.label}</h3><p>{key.ended?'Stopped':'Active'} · Added {fullTime(key.createdAt,zone)}{key.lastUsedAt?` · Last used ${fullTime(key.lastUsedAt,zone)}`:''}</p><Button disabled={!enabled} variant="danger-quiet" onClick={()=>void change('account.removePasskey',key.ref)}>Remove passkey</Button></div>)}</Section>
 <Section label="Signed-in browsers" className="grid gap-4">{account.sessions.map(session=><div key={session.ref} className="rounded-xl border p-4"><h3>{deviceLabel(session.device)}</h3><p>{session.ended?'Ended':'Signed in'} · Last used {fullTime(session.seenAt,zone)}</p><Button disabled={!enabled} variant="outline" onClick={()=>void change('account.revokeSession',session.ref)}>Sign out browser</Button></div>)}</Section>
 <Section label="Notifications" className="grid gap-4">{account.notifications?.publicKey?<Button disabled={!enabled} onClick={()=>void enableNotifications()}>Enable notifications on this browser</Button>:<p>Notifications are unavailable.</p>}{account.notifications?.devices.map(device=><div key={device.ref} className="rounded-xl border p-4"><h3>{deviceLabel(device.device)}</h3><p>Last confirmed {fullTime(device.seenAt,zone)}</p><Button disabled={!enabled} variant="danger-quiet" onClick={()=>void change('notifications.removeDevice',device.ref)}>Remove notification device</Button></div>)}</Section>
 <Button disabled={!enabled} variant="outline" onClick={async()=>{await post('/logout',{});location.reload();}}>Sign out this device</Button>
 </>}
 </div></AppFrame>;
}
