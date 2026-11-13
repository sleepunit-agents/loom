import { useEffect, useState } from 'react';
import { useRecords } from '../../data';
import { Split, List, Row, Empty, Error, Loading, Button, Input } from '../../kit';
import { active, time, title, state, type Wake, type Schedule, type Clock } from './model';
import { WorkForm } from './forms';
import { send, useRequest } from './request';
const isWake = (w: Wake | Schedule): w is Wake => typeof w.due === 'number';
type Action = { operation: string; input: object; label: string; why: string };
export default function ClockApp({ path: shellPath, go }: { path?: string; go?: (path: string) => void } = {}) {
  const [localPath,setLocalPath] = useState(() => location.pathname);
  const path = shellPath ?? localPath;
  const selected = /\/item\/(.+)$/.exec(path)?.[1];
  const id = selected ? decodeURIComponent(selected) : undefined;
  const navigate = (next?: string) => {
    const url = '/p/clock-preview' + (next ? `/item/${encodeURIComponent(next)}` : '');
    if (go) go(url); else { history.pushState(null,'',url); setLocalPath(url); }
  };
  useEffect(() => { if (go) return; const pop = () => setLocalPath(location.pathname); window.addEventListener('popstate',pop); return () => window.removeEventListener('popstate',pop); },[go]);
  const wakes = useRecords<Wake>('wake'), schedules = useRecords<Schedule>('schedule'), clocks = useRecords<Clock>('clock');
  const status = [wakes.status,schedules.status,clocks.status];
  const live = status.every(s => s === 'live');
  const [folder,setFolder] = useState('wakes'), [query,setQuery] = useState(''), [agent,setAgent] = useState('');
  const [form,setForm] = useState<'wake' | 'schedule' | 'lane'>(), [editing,setEditing] = useState(false);
  const [confirm,setConfirm] = useState<Action>();
  const receipt = useRequest(), enabled = live && !receipt?.pending;
  const schedule = live ? schedules.records.find(s => s.id === id) : undefined;
  const wake = live ? wakes.records.find(w => w.id === id) : undefined;
  const agents = [...new Set([...wakes.records,...schedules.records,...clocks.records].map(w => 'agent' in w ? String(w.agent) : w.id))].sort();
  const isPaused = (id: string) => clocks.records.some(c => c.id === id && c.paused);
  const filter = (w: Wake | Schedule) => (!agent || w.agent === agent) && [title(w),w.id,w.agent,w.file].join(' ').toLowerCase().includes(query.toLowerCase());
  const items = folder === 'wakes' ? wakes.records.filter(w => active(w) && filter(w)).sort((a,b) => a.due-b.due || a.id.localeCompare(b.id)) : folder === 'history' ? wakes.records.filter(w => !active(w) && filter(w)).sort((a,b) => b.due-a.due) : schedules.records.filter(s => !!s.laneDetails === (folder === 'lanes') && filter(s));
  const open = (id: string) => { navigate(id); setForm(undefined); setEditing(false); setConfirm(undefined); };
  const back = () => { navigate(); setForm(undefined); setEditing(false); setConfirm(undefined); };
  const ask = (operation: string, input: object, label: string, why: string) => setConfirm({operation,input,label,why});
  const action = (operation: string, input: object, label: string, why: string) => <Button variant="outline" size="sm" disabled={!enabled} onClick={() => ask(operation,input,label,why)}>{label}</Button>;
  let reader = null;
  if (form) reader = <WorkForm key={`${form}:${editing ? id : 'new'}`} kind={form} schedule={editing ? schedule : undefined} enabled={enabled} back={back} />;
  else if (wake) reader = <article className="grid gap-4 p-5">
    <header><h1 className="text-2xl font-semibold">{title(wake)}</h1><p>{state(wake,isPaused(wake.agent))} · {wake.agent}</p></header>
    <p>{wake.state === 'parked' ? 'Answer check' : 'Due'}: {time(wake.due)}</p>
    {wake.wait && <p>Waiting on {wake.wait.id} until {time(wake.wait.until)}</p>}
    {wake.outcome && <p className="whitespace-pre-wrap break-words">{wake.outcome}</p>}
    {wake.hold === 'uncertain' && <p>A body may have started. Reconcile with runtime before trying again.</p>}
    {wake.project && <p>Project: {wake.project}</p>}{wake.member && <p>Private to: {wake.member}</p>}
    <p>{wake.id}{wake.schedule && ` · Schedule: ${wake.schedule}`}</p>
    <div className="flex flex-wrap gap-2">
      {['pending','held','parked','failed'].includes(wake.state) && wake.hold !== 'uncertain' && action('now',{id:wake.id},'Run now','Run this wake immediately, including while paused?')}
      {active(wake) && wake.hold !== 'uncertain' && action('cancel',{id:wake.id},'Cancel wake',wake.state === 'firing' ? 'Dispatch is in progress. Cancellation may leave a body running and will require reconciliation.' : wake.schedule ? 'Skip this occurrence. Its schedule will keep running.' : 'Cancel this wake?')}
    </div>
    <section><h2>{wake.file ? 'Repository file' : 'Prompt'}</h2><p className="whitespace-pre-wrap break-words">{wake.file ?? wake.prompt}</p></section>
    {wake.model && <p>Model: {wake.model}</p>}
  </article>;
  else if (schedule) reader = <article className="grid gap-4 p-5">
    <header><h1 className="text-2xl font-semibold">{schedule.lane ?? schedule.id}</h1><p>{schedule.agent} · {schedule.enabled ? 'Enabled' : 'Disabled · review required'}</p></header>
    <p>{schedule.at.join(', ')} CT · {schedule.days || 'Every day'}</p><p>{schedule.note}</p>
    <div className="flex flex-wrap gap-2"><Button variant="outline" size="sm" disabled={!enabled} onClick={() => {setForm(schedule.laneDetails ? 'lane' : 'schedule');setEditing(true);}}>Edit {schedule.laneDetails ? 'lane' : 'schedule'}</Button>
      {action('scheduleRun',{id:schedule.id},'Run once','Run an extra occurrence immediately, including while paused?')}
      {action(schedule.laneDetails ? 'laneRemove' : 'scheduleRemove',schedule.laneDetails ? {name:schedule.lane} : {id:schedule.id},'Remove schedule','Remove the schedule and cancel its pending occurrences? A body already running may continue.')}
    </div>
    {schedule.laneDetails && <form aria-label="Reassign lane" className="flex flex-wrap gap-2" onSubmit={e => { e.preventDefault(); if(enabled) ask('laneAssign',{name:schedule.lane,agent:new FormData(e.currentTarget).get('agent')},'Confirm reassignment','Reassign this lane and replace its pending occurrences?'); }}><label>Assign to<Input name="agent" required defaultValue={schedule.agent} disabled={!enabled} /></label><Button type="submit" variant="outline" disabled={!enabled}>Reassign lane</Button></form>}
    {schedule.laneDetails?.local && <p>Prefers loom’s machine; approval still applies.</p>}
    {schedule.laneDetails?.source && <p>Source: {schedule.laneDetails.source}</p>}
    <section><h2>{schedule.file ? 'Repository file' : 'Text'}</h2><p className="whitespace-pre-wrap break-words">{schedule.laneDetails?.text ?? schedule.file ?? schedule.prompt}</p></section>
  </article>;
  else if (id) reader = <Empty title="This work is no longer in view" text="It may have aged out, been removed or become unavailable." />;
  const saved = receipt?.result?.ok ? receipt.result.value as { alreadyScheduled?: boolean; schedule?: string; due?: number } : undefined;
  const feedback = <div className="grid gap-2">
      {receipt?.pending && <Loading label={receipt.status === 'offline' ? 'Waiting for connection…' : 'Saving…'} />}
      {receipt?.result && (receipt.result.ok ? <p role="status">{saved?.alreadyScheduled && typeof saved.due === 'number' ? `Already scheduled: ${saved.schedule}, next at ${time(saved.due)} (nothing armed)` : 'Saved'}</p> : <Error title="Couldn’t save" text={`${receipt.result.code}: ${receipt.result.message}`} />)}
      {confirm && <section aria-label="Confirm clock action" className="grid gap-2"><p>{confirm.why}</p><Button variant="outline" disabled={!enabled} onClick={() => {if(enabled){send(confirm.operation,confirm.input);setConfirm(undefined);}}}>{confirm.label}</Button><Button variant="outline" onClick={() => setConfirm(undefined)}>Keep unchanged</Button></section>}
  </div>;
  return <Split label="Clock" className="h-full" folders={[{id:'wakes',label:'Wakes'},{id:'schedules',label:'Schedules'},{id:'lanes',label:'Household lanes'},{id:'history',label:'Recent history'}]} folder={folder} onFolder={f => {setFolder(f);back();}}
    search={<div className="grid gap-2"><label>Search clock<Input type="search" value={query} onChange={e => setQuery(e.target.value)} /></label><label>Agent<select value={agent} onChange={e => setAgent(e.target.value)}><option value="">All agents</option>{agents.map(a => <option key={a}>{a}</option>)}</select></label></div>}
    listTitle="Clock" listMeta={items.length} listTop={<div className="grid gap-3 p-3">
      <div className="flex flex-wrap gap-2">{(['wake','schedule','lane'] as const).map(f => <Button variant="outline" size="sm" key={f} disabled={!enabled} onClick={() => {navigate();setForm(f);setEditing(false);setConfirm(undefined);}}>Create {f}</Button>)}</div>
      {agents.filter(a => !agent || a === agent).map(a => <div key={a} className="flex flex-wrap items-center gap-2"><span>{a} · {isPaused(a) ? 'Paused' : 'Active'}</span>{action(isPaused(a) ? 'resume' : 'pause',{agent:a},`${isPaused(a) ? 'Resume' : 'Pause'} ${a}`,isPaused(a) ? 'Release paused work in order, one minute apart?' : 'Keep due work waiting until you resume?')}{action('now',{agent:a},`Wake ${a} now`,'Start a fresh wake with no lane?')}</div>)}
      {!reader && feedback}
    </div>}
    list={!live ? status.includes('denied') ? <Error text="Sign in with access to see this clock." /> : status.includes('offline') ? <Error text="Waiting for connection. Actions are unavailable." /> : <Loading label="Opening clock…" /> : items.length ? <List label="Clock work">{items.map(w => <Row key={w.id} title={!isWake(w) ? w.lane ?? w.id : title(w)} meta={isWake(w) ? `${time(w.due)} · ${w.agent}` : `${w.at.join(', ')} CT · ${w.days || 'Every day'} · ${w.agent}`} status={isWake(w) ? state(w,isPaused(w.agent)) : w.enabled ? 'Enabled' : 'Disabled'} selected={w.id === id} onClick={() => open(w.id)} />)}</List> : <Empty title={query ? `Nothing matches “${query}”` : 'No work here yet'} text="Create a wake, schedule or household lane." />}
    reader={live && reader ? <>{feedback}{reader}</> : null} open={live && (!!id || !!form)} onBack={back} backLabel="Clock" blank={<Empty title="Open clock work" text="Choose a wake or schedule to read its details." />} />;
}
