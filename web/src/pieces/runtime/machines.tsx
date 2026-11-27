import {SignInWarning} from './sign-in-warning';
import { NativeSelect } from '../../kit/native-select';
import {useEffect, useState} from 'react';
import {useDataQuery} from '../../data/graphql';
import {memberOperation} from '../../data/operation';
import {Button, Error as ErrorView, Loading} from '../../kit';
import {conditionLine, readingAge, readingLine, readingsOf, type Reading} from './machine-readings';
import {fullTime} from '../../kit/time';
import {useHouseholdZone} from '../../data/zone';

import {MachineHostingDetails} from './machine-hosting';
import {ownerMachinesQuery, type Machine, type MachineReadEntry, type OwnerMachinesData, type ReaderCard} from './machines-query';

type Entry = MachineReadEntry;
type Card = ReaderCard;
const query = ownerMachinesQuery;

/** What the machine's worker last read on it: any open condition plainly, then the numbers quietly. */
function MachineReadings({readings}: {readings:Reading[]}) {
 const zone=useHouseholdZone();
 const [,tick]=useState(0);
 const hasReadings=readings.length>0;
 useEffect(()=>{
  if(!hasReadings)return;
  const timer=setInterval(()=>tick(value=>value+1),60_000);
  return ()=>clearInterval(timer);
 },[hasReadings]);
 if(!hasReadings)return null;
 const disks=readings.filter(reading=>reading.kind==='disk').length,now=Date.now();
 const open=readings.flatMap(reading=>{
  const line=conditionLine(reading);
  return line?[{key:JSON.stringify([reading.kind,reading.thing]),line:line+readingAge(reading,now,zone)}]:[];
 });
 return <div className="grid gap-1">
  {open.map(({key,line})=><p key={key} role="status"><strong>{line}</strong></p>)}
  <p className="text-muted-foreground">{readings.map(reading=>readingLine(reading,disks,now,zone)).join(' · ')}</p>
 </div>;
}

function MachineSettings({box, agents}: {box:Machine; agents:string[]}) {
 const zone=useHouseholdZone();
 const [revision, refresh] = useState(0);
 const [history, setHistory] = useState<Entry[] | null>();
 const [cards, setCards] = useState<Card[] | null>();
 const [busy, setBusy] = useState(false);
 const [error, setError] = useState('');
 const [agent, select] = useState('');
 const readers = box.readers ?? [];
 const readerList=JSON.stringify(readers);
 useEffect(() => {
  let current = true;
  setHistory(undefined); setCards(undefined); setError('');
  void memberOperation<Entry[]>('machine.history', {machine:box.id}).then(
   entries => {if (current) setHistory(entries);},
   () => {if (current) setHistory(null);},
  );
  if (!box.revokedAt) void memberOperation<Card[]>('machine.readerCards', {machine:box.id}).then(
   pending => {if (current) setCards(pending);},
   () => {if (current) setCards(null);},
  );
  return () => {current = false;};
 }, [box.id, box.revokedAt, readerList, revision]);
 async function change(operation:string, input:object) {
  if (busy) return;
  setBusy(true); setError('');
  try {await memberOperation(operation, input); refresh(n => n + 1);}
  catch {setError('Could not change the read grant. Refresh to check the current settings.');}
  finally {setBusy(false);}
 }
 return <div className="grid gap-4">
  {!box.revokedAt && <section aria-label="Explicit machine read grants">
   <h4>Explicit read grants</h4>
   <p>Agents allowed to run on this machine may also read it.</p>
   <ul>{readers.map(id => <li key={id}>{id} <Button disabled={busy} variant="danger-quiet" onClick={() => void change('machine.proposeReader',{box:box.id,agent:id,allow:false})}>Request revocation for {id}</Button></li>)}</ul>
   {!readers.length && <p>No explicit grants.</p>}
   <form onSubmit={event => {event.preventDefault(); if(agent && !readers.includes(agent)) void change('machine.proposeReader',{box:box.id,agent,allow:true});}}>
    <label>Agent <NativeSelect value={agent} onChange={event => select(event.target.value)}><option value="">Choose an agent</option>
     {agents.filter(id=>!readers.includes(id)).map(id=><option key={id} value={id}>{id}</option>)}</NativeSelect></label>
    <Button type="submit" disabled={busy || !agent || readers.includes(agent)}>Request read grant</Button>
   </form>
   {error&&<ErrorView text={error}/>}
   {cards===undefined&&<Loading label="Opening pending read grants…"/>}
   {cards===null&&<ErrorView text="Pending read grants are unavailable."/>}
   {cards?.map(card=><div key={card.id}><p>{card.ask}</p>{card.review&&<p>Updated to show the current readers.</p>}
    <Button disabled={busy} onClick={()=>void change('machine.answerReader',{id:card.id,answer:'allow',...(card.review?{review:card.review}:{})})}>Allow</Button>
    <Button disabled={busy} variant="outline" onClick={()=>void change('machine.answerReader',{id:card.id,answer:'deny'})}>Deny</Button></div>)}
  </section>}
  <section aria-label="Machine read history"><h4>Read history</h4>
   <Button variant="outline" disabled={busy} onClick={()=>refresh(n=>n+1)}>Refresh</Button>
   {history===null&&<ErrorView text="Machine read history is unavailable."/>}
   {history===undefined&&<Loading label="Opening machine history…"/>}
   {history?.length===0&&<p>No machine reads recorded.</p>}
   <ol>{history?.map(row=><li key={row.id} className="rounded-xl border p-3">
    <strong>{row.read}</strong> · <time dateTime={row.askedAt}>{fullTime(row.askedAt,zone)}</time>
    <p>{row.agent} · {row.word}{row.person?' · '+row.person:''}</p>
    <p>Job {row.job}{row.conversation?' · Conversation '+row.conversation:''}</p>
    <p>Arguments <code>{row.args}</code></p><p>{row.outcome} · {row.bytes} bytes</p>
   </li>)}</ol>
  </section>
 </div>;
}

export function OwnerMachines({member,signInWarnings}:{member:string;signInWarnings?:ReadonlySet<string>}) {
 const feed=useDataQuery<OwnerMachinesData>(query);
 const [open, setOpen]=useState('');
 const machines=feed.status==='live'?feed.data?.boxes?.filter(box=>box.owner===member):undefined;
 if(!machines?.length)return null;
 return <section aria-label="Your machines" className="grid gap-3"><h2>Your machines</h2>
  {machines.map(box=><article key={box.id} className="grid gap-3 rounded-xl border p-4"><h3>
   <Button variant="outline" aria-expanded={open===box.id} onClick={()=>setOpen(open===box.id?'':box.id)}>{box.name}{box.revokedAt?' (revoked)':''}</Button>{!box.revokedAt&&signInWarnings?.has(box.id)&&<SignInWarning/>}</h3>
   <MachineHostingDetails box={box}/>
   {!box.revokedAt&&box.readingsLeftOut>0&&<p role="status">More than 24 things reported; {box.readingsLeftOut} were left out.</p>}
   {!box.revokedAt&&<MachineReadings readings={readingsOf(feed.data?.boxReadings,box.id)}/>}
   {open===box.id&&<MachineSettings box={box} agents={(feed.data?.agents??[]).map(agent=>agent.id)}/>}
  </article>)}
 </section>;
}
