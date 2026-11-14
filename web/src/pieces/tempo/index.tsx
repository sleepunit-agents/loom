import { useState } from 'react';
import { Split, List, Row, Empty, Error, Loading, Input } from '../../kit';
import { folders, rows, title, source, target, history, status, type Trigger, type TriggerEvent, type AgentPause, type Folder } from './model';

export interface TempoSnapshot {
  status: 'loading' | 'live' | 'offline' | 'denied';
  triggers: readonly Trigger[];
  events: readonly TriggerEvent[];
  pauses: readonly AgentPause[];
  timezone: string;
}

/** Inline conversation view. Resolve IDs only against the current visible snapshot. */
export function TempoCard({ snapshot, triggerId }: { snapshot: TempoSnapshot; triggerId: string }) {
  if (snapshot.status !== 'live') return snapshot.status === 'loading'
    ? <Loading label="Opening Tempo…" />
    : <Error text={snapshot.status === 'denied' ? 'Sign in with access to see Tempo.' : 'Waiting for connection.'} />;
  const trigger = snapshot.triggers.find(item => item.id === triggerId);
  if (!trigger) return <Empty title="Trigger unavailable" text="This trigger is no longer in your Tempo view." />;
  return <TriggerDetails snapshot={snapshot} trigger={trigger} />;
}

function TriggerDetails({ snapshot, trigger }: { snapshot: TempoSnapshot; trigger: Trigger }) {
  const time = (at: string) => new Intl.DateTimeFormat(undefined, {
    timeZone: snapshot.timezone, dateStyle: 'medium', timeStyle: 'short',
  }).format(new Date(at));
  return trigger ? <article className="grid gap-4 p-5">
    <header><h1 className="text-2xl font-semibold">{title(trigger)}</h1><p>{trigger.sourceKind} · {trigger.lifespan} · {status(trigger, snapshot.pauses)}</p></header>
    <p>{source(trigger)}</p>
    {trigger.nextDueAt && <p>Due: {time(trigger.nextDueAt)} · {snapshot.timezone}</p>}
    <dl className="grid gap-2">
      <div><dt>Set by</dt><dd>{trigger.ownerKind === 'household' ? 'Household' : trigger.owner}</dd></div>
      {trigger.project && <div><dt>Project</dt><dd>{trigger.project}</dd></div>}
      <div><dt>Target</dt><dd>{target(trigger)}</dd></div>
      <div><dt>Enabled</dt><dd>{trigger.enabled ? 'Yes' : 'No'}</dd></div>
      {trigger.lastFiredAt && <div><dt>Last fired</dt><dd>{time(trigger.lastFiredAt)}</dd></div>}
    </dl>
    {trigger.instructions && <section><h2>Words</h2><p className="whitespace-pre-wrap break-words">{trigger.instructions}</p></section>}
    {trigger.file && <section><h2>Repository file</h2><p>{trigger.file}</p></section>}
    <section><h2>Recent history</h2>{history(snapshot.events, trigger.id).length ? <ol>
      {history(snapshot.events, trigger.id).map(event => <li key={event.seq}>{time(event.at)} · {event.event}{event.note && ` · ${event.note}`}</li>)}
    </ol> : <p>No events yet.</p>}</section>
  </article> : null;
}

/** The composition supplies one visible, live query snapshot; this view owns no transport. */
export default function Tempo({ snapshot }: { snapshot: TempoSnapshot }) {
  const [folder, setFolder] = useState<Folder>('due');
  const [query, setQuery] = useState('');
  const [agent, setAgent] = useState('');
  const [selected, setSelected] = useState<string>();
  const live = snapshot.status === 'live';
  // Never keep displaying a previous viewer's rows during reconnect or access loss.
  const triggers = live ? snapshot.triggers : [];
  const shown = rows(triggers, folder, query, agent);
  const trigger = triggers.find(item => item.id === selected);
  const agents = [...new Set(triggers.filter(item => item.toKind === 'agent').map(item => item.to!))].sort();
  const reader = trigger ? <TriggerDetails snapshot={snapshot} trigger={trigger} /> : null;
  const time = (at: string) => new Intl.DateTimeFormat(undefined, { timeZone: snapshot.timezone, dateStyle: 'medium', timeStyle: 'short' }).format(new Date(at));
  return <Split label="Tempo" className="h-full" folders={folders.map(item => ({ ...item, count: live ? rows(triggers, item.id, '', agent).length : undefined }))}
    folder={folder} onFolder={id => { setFolder(id as Folder); setSelected(undefined); }}
    search={<div className="grid gap-2"><label>Search tempo<Input type="search" value={query} onChange={event => setQuery(event.target.value)} /></label>
      <label>Agent<select value={agent} onChange={event => { setAgent(event.target.value); setSelected(undefined); }}><option value="">All agents</option>{agents.map(id => <option key={id}>{id}</option>)}</select></label></div>}
    listTitle={folders.find(item => item.id === folder)?.label} listMeta={live ? shown.length : undefined}
    listTop={live && snapshot.pauses.length > 0 ? <p className="p-3">Paused: {snapshot.pauses.map(pause => pause.agent).join(', ')}</p> : undefined}
    list={!live ? snapshot.status === 'loading' ? <Loading label="Opening Tempo…" /> : <Error text={snapshot.status === 'denied' ? 'Sign in with access to see Tempo.' : 'Waiting for connection.'} />
      : shown.length ? <List label="Triggers">{shown.map(item => <Row key={item.id} title={title(item)} meta={`${item.nextDueAt ? time(item.nextDueAt) : source(item)} · ${item.to ?? 'operation'}`} status={status(item, snapshot.pauses)} selected={item.id === selected} onClick={() => setSelected(item.id)} />)}</List>
        : <Empty title={query ? `Nothing matches “${query}”` : 'No triggers here'} text="Ask an agent in chat to set a trigger." />}
    reader={reader} open={!!reader} onBack={() => setSelected(undefined)} backLabel="Tempo"
    blank={<Empty title="Open a trigger" text="Choose a trigger to see its source, target, words and history." />} />;
}
