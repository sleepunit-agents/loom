import { MachineAccess } from './machine-access';
import { TempoFiringFailure, type TempoActions } from './actions';
import { CreateTrigger } from './create';
import { useEffect, useRef, useState } from 'react';
import { Split, List, Row, Empty, Error, Loading, Input, Button } from '../../kit';
import { folders, rows, title, source, target, history, status, terminal, triggerAgent, type Trigger, type TriggerEvent, type AgentPause, type Folder } from './model';

export interface TempoSnapshot {
  status: 'loading' | 'live' | 'offline' | 'denied';
  machines?: readonly { id: string; name: string }[];
  triggers: readonly Trigger[];
  events: readonly TriggerEvent[];
  pauses: readonly AgentPause[];
  timezone: string;
}

export type { TempoActions } from './actions';

function TriggerActions({ trigger, machines, pauses, actions }: { trigger: Trigger; machines: TempoSnapshot['machines']; pauses: readonly AgentPause[]; actions: TempoActions }) {
  const [machine, setMachine] = useState('');
  const [card, setCard] = useState('');
  const requestMachine = actions.requestMachine;
  const withdraw = actions.withdrawMachine;
  const busy = useRef(false);
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState<string>();
  const agent = triggerAgent(trigger);
  const paused = !!agent && pauses.some(item => item.agent === agent);
  async function run(action: () => Promise<void>) {
    if (busy.current) return;
    busy.current = true;
    setPending(true);
    setFailed(undefined);
    try { await action(); }
    catch (error) { setFailed(error instanceof TempoFiringFailure ? error.message : 'Tempo could not complete that action. Try again.'); }
    finally { busy.current = false; setPending(false); }
  }
  return <section aria-label="Trigger actions" className="grid gap-2">
    <div className="flex flex-wrap gap-2">
      {!terminal(trigger) && <>
        <Button disabled={pending || !trigger.enabled || paused || trigger.state === 'held' || trigger.state === 'firing'} onClick={() => void run(() => actions.runNow(trigger.id))}>Run now</Button>
        <Button disabled={pending} onClick={() => void run(() => actions.stop(trigger.id))}>Cancel</Button>
      </>}
      {trigger.machine && withdraw && <Button disabled={pending} onClick={() => void run(() => withdraw(trigger.id))}>Withdraw machine request</Button>}
      {agent && <Button disabled={pending} onClick={() => void run(() => paused ? actions.resume(agent) : actions.pause(agent))}>{paused ? 'Resume agent' : 'Pause agent'}</Button>}
    </div>
    {requestMachine && !!machines?.length && !trigger.machine && !card && trigger.targetKind === 'inbox' && trigger.toKind === 'agent' && !trigger.conversation && !trigger.member && <div className="grid gap-2">
      <label>Requested machine <select aria-label="Requested machine" value={machine} onChange={e => setMachine(e.target.value)}>
        <option value="">Choose a machine</option>
        {machines.map(box => <option key={box.id} value={box.id}>{box.name}</option>)}
      </select></label>
      <p>Requesting review holds this trigger. Withdraw the request to resume ordinary firing.</p>
      <Button disabled={pending || !machines.some(box => box.id === machine)} onClick={() => void run(async () => setCard(await requestMachine(trigger.id, machine)))}>Request machine review</Button>
    </div>}
    {card && <a href={`/p/approvals-preview/approval/${encodeURIComponent(card)}`}>Open owner review</a>}
    {pending && <p role="status">Waiting for Tempo…</p>}
    {failed && <p role="alert">{failed}</p>}
  </section>;
}

/** Inline conversation view. Resolve IDs only against the current visible snapshot. */
export function TempoCard({ snapshot, triggerId, actions }: { snapshot: TempoSnapshot; triggerId: string; actions?: TempoActions }) {
  if (snapshot.status !== 'live') return snapshot.status === 'loading'
    ? <Loading label="Opening Tempo…" />
    : <Error text={snapshot.status === 'denied' ? 'Sign in with access to see Tempo.' : 'Waiting for connection.'} />;
  const trigger = snapshot.triggers.find(item => item.id === triggerId);
  if (!trigger) return <Empty title="Trigger unavailable" text="This trigger is no longer in your Tempo view." />;
  return <TriggerDetails key={trigger.id} snapshot={snapshot} trigger={trigger} actions={actions} />;
}

function TriggerDetails({ snapshot, trigger, actions }: { snapshot: TempoSnapshot; trigger: Trigger; actions?: TempoActions }) {
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
      {trigger.machine && <div><dt>Requested machine</dt><dd>{trigger.machineRow?.name ?? trigger.machine}</dd><dt>Approval record</dt><dd>{trigger.machineApproval ?? 'None'}</dd></div>}
      <div><dt>Enabled</dt><dd>{trigger.enabled ? 'Yes' : 'No'}</dd></div>
      {trigger.machineApprovalRow?.decidedBy && <div><dt>Allowed by</dt><dd>{trigger.machineApprovalRow.decidedBy}</dd></div>}
      {trigger.machineApprovalRow?.decidedAt && <div><dt>Allowed at</dt><dd>{time(trigger.machineApprovalRow.decidedAt)}</dd></div>}
      {trigger.lastFiredAt && <div><dt>Last fired</dt><dd>{time(trigger.lastFiredAt)}</dd></div>}
    </dl>
    {trigger.machine && <MachineAccess />}
    {trigger.instructions && <section><h2>Words</h2><p className="whitespace-pre-wrap break-words">{trigger.instructions}</p></section>}
    {trigger.file && <section><h2>Repository file</h2><p>{trigger.file}</p></section>}
    {actions && <TriggerActions trigger={trigger} machines={snapshot.machines} pauses={snapshot.pauses} actions={actions} />}
    <section><h2>Recent history</h2>{history(snapshot.events, trigger.id).length ? <ol>
      {history(snapshot.events, trigger.id).map(event => <li key={event.seq}>{time(event.at)} · {event.event}{event.note && ` · ${event.note}`}</li>)}
    </ol> : <p>No events yet.</p>}</section>
  </article> : null;
}

/** The composition supplies one visible, live query snapshot; this view owns no transport. */
export default function Tempo({ snapshot, actions }: { snapshot: TempoSnapshot; actions?: TempoActions }) {
  const [creating, setCreating] = useState(false);
  useEffect(() => { if (snapshot.status !== 'live') setCreating(false); }, [snapshot.status]);
  const [folder, setFolder] = useState<Folder>('due');
  const [query, setQuery] = useState('');
  const [agent, setAgent] = useState('');
  const [selected, setSelected] = useState<string>();
  const live = snapshot.status === 'live';
  // Never keep displaying a previous viewer's rows during reconnect or access loss.
  const triggers = live ? snapshot.triggers : [];
  const shown = rows(triggers, folder, query, agent);
  const trigger = triggers.find(item => item.id === selected);
  const agents = [...new Set(triggers.map(triggerAgent).filter((agent): agent is string => !!agent))].sort();
  const reader = live && creating && actions?.create ? <CreateTrigger timezone={snapshot.timezone} submit={actions.create} done={() => setCreating(false)} /> : trigger ? <TriggerDetails key={trigger.id} snapshot={snapshot} trigger={trigger} actions={actions} /> : null;
  const time = (at: string) => new Intl.DateTimeFormat(undefined, { timeZone: snapshot.timezone, dateStyle: 'medium', timeStyle: 'short' }).format(new Date(at));
  return <Split label="Tempo" className="h-full" folders={folders.map(item => ({ ...item, count: live ? rows(triggers, item.id, '', agent).length : undefined }))}
    folder={folder} onFolder={id => { setFolder(id as Folder); setSelected(undefined); }}
    search={<div className="grid gap-2"><label>Search tempo<Input type="search" value={query} onChange={event => setQuery(event.target.value)} /></label>
      <label>Agent<select value={agent} onChange={event => { setAgent(event.target.value); setSelected(undefined); }}><option value="">All agents</option>{agents.map(id => <option key={id}>{id}</option>)}</select></label></div>}
    listTitle={folders.find(item => item.id === folder)?.label} listMeta={live ? shown.length : undefined}
    listTop={live ? <div className="grid gap-2 p-3">{actions?.create && <Button onClick={() => setCreating(true)}>Create trigger</Button>}{snapshot.pauses.length > 0 && <p>Paused: {snapshot.pauses.map(pause => pause.agent).join(', ')}</p>}</div> : undefined}
    list={!live ? snapshot.status === 'loading' ? <Loading label="Opening Tempo…" /> : <Error text={snapshot.status === 'denied' ? 'Sign in with access to see Tempo.' : 'Waiting for connection.'} />
      : shown.length ? <List label="Triggers">{shown.map(item => <Row key={item.id} title={title(item)} meta={`${item.nextDueAt ? time(item.nextDueAt) : source(item)} · ${item.to ?? 'operation'}`} status={status(item, snapshot.pauses)} selected={item.id === selected} onClick={() => setSelected(item.id)} />)}</List>
        : <Empty title={query ? `Nothing matches “${query}”` : 'No triggers here'} text="Ask an agent in chat to set a trigger." />}
    reader={reader} open={!!reader} onBack={() => { setCreating(false); setSelected(undefined); }} backLabel="Tempo"
    blank={<Empty title="Open a trigger" text="Choose a trigger to see its source, target, words and history." />} />;
}
