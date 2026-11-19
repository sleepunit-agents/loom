import {useEffect, useState} from 'react';
import {useDataQuery} from '../../data/graphql';
import {memberOperation} from '../../data/operation';
import {Button, Error as ErrorView, Loading} from '../../kit';
import {conditionLine, readingLine, readingsOf, type Reading} from './machine-readings';

type Machine = {id:string; name:string; owner:string; revokedAt:string|null; readers:string[]|null};
type Entry = {id:string; agent:string; job:string; conversation:string|null; word:string; person:string|null; read:string; args:string; askedAt:string; bytes:number; outcome:string};
type Card = {id:string; ask:string};
const query = 'query OwnerMachines { boxes { id name owner readers revokedAt } boxReadings { box kind thing usedPercent sizeMib freeMib answers level } agents { id } }';

/** What the machine's worker last read on it: any open condition plainly, then the numbers quietly. */
function MachineReadings({readings}: {readings:Reading[]}) {
 if(!readings.length)return null;
 const disks=readings.filter(reading=>reading.kind==='disk').length;
 const open=readings.map(conditionLine).filter((line):line is string=>!!line);
 return <div className="grid gap-1">
  {open.map(line=><p key={line} role="status"><strong>{line}</strong></p>)}
  <p className="text-muted-foreground">{readings.map(reading=>readingLine(reading,disks)).join(' · ')}</p>
 </div>;
}

function MachineSettings({box, agents}: {box:Machine; agents:string[]}) {
 const [revision, refresh] = useState(0);
 const [history, setHistory] = useState<Entry[]>();
 const [cards, setCards] = useState<Card[]>();
 const [busy, setBusy] = useState(false);
 const [error, setError] = useState('');
 const [agent, select] = useState('');
 const readers = box.readers ?? [];
 useEffect(() => {
  let current = true;
  setHistory(undefined); setCards(undefined); setError('');
  Promise.all([
   memberOperation<Entry[]>('machine.history', {machine:box.id}),
   box.revokedAt ? Promise.resolve([]) : memberOperation<Card[]>('machine.readerCards', {machine:box.id}),
  ]).then(([entries, pending]) => {
   if (current) {setHistory(entries); setCards(pending);}
  }).catch(() => {if (current) setError('Machine settings and history are unavailable.');});
  return () => {current = false;};
 }, [box.id, box.revokedAt, revision]);
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
    <label>Agent <select value={agent} onChange={event => select(event.target.value)}><option value="">Choose an agent</option>
     {agents.filter(id=>!readers.includes(id)).map(id=><option key={id} value={id}>{id}</option>)}</select></label>
    <Button type="submit" disabled={busy || !agent || readers.includes(agent)}>Request read grant</Button>
   </form>
   {cards?.map(card=><div key={card.id}><p>{card.ask}</p>
    <Button disabled={busy} onClick={()=>void change('machine.answerReader',{id:card.id,answer:'allow'})}>Allow</Button>
    <Button disabled={busy} variant="outline" onClick={()=>void change('machine.answerReader',{id:card.id,answer:'deny'})}>Deny</Button></div>)}
  </section>}
  <section aria-label="Machine read history"><h4>Read history</h4>
   <Button variant="outline" disabled={busy} onClick={()=>refresh(n=>n+1)}>Refresh</Button>
   {error&&<ErrorView text={error}/>}
   {!history&&!error&&<Loading label="Opening machine history…"/>}
   {history?.length===0&&<p>No machine reads recorded.</p>}
   <ol>{history?.map(row=><li key={row.id} className="rounded-xl border p-3">
    <strong>{row.read}</strong> · <time dateTime={row.askedAt}>{new Date(row.askedAt).toLocaleString()}</time>
    <p>{row.agent} · {row.word}{row.person?' · '+row.person:''}</p>
    <p>Job {row.job}{row.conversation?' · Conversation '+row.conversation:''}</p>
    <p>Arguments <code>{row.args}</code></p><p>{row.outcome} · {row.bytes} bytes</p>
   </li>)}</ol>
  </section>
 </div>;
}

export function OwnerMachines({member}:{member:string}) {
 const feed=useDataQuery<{boxes:Machine[]; boxReadings?:Reading[]; agents:{id:string}[]}>(query);
 const [open, setOpen]=useState('');
 const machines=feed.status==='live'?feed.data?.boxes?.filter(box=>box.owner===member):undefined;
 if(!machines?.length)return null;
 return <section aria-label="Your machines" className="grid gap-3"><h2>Your machines</h2>
  {machines.map(box=><article key={box.id} className="grid gap-3 rounded-xl border p-4"><h3>
   <Button variant="outline" aria-expanded={open===box.id} onClick={()=>setOpen(open===box.id?'':box.id)}>{box.name}{box.revokedAt?' (revoked)':''}</Button></h3>
   {!box.revokedAt&&<MachineReadings readings={readingsOf(feed.data?.boxReadings,box.id)}/>}
   {open===box.id&&<MachineSettings box={box} agents={(feed.data?.agents??[]).map(agent=>agent.id)}/>}
  </article>)}
 </section>;
}
