import './calendar.css';
import { RecentRuns, type TriggerRun } from './recent-runs';
import { TempoCalendar } from './day';
import { triggerHistoryQuery } from './query';
import { tempoFailureMessage } from './actions';
import { NativeSelect } from '../../kit/native-select';
import { useDataQuery } from '../../data/graphql';
import type { TempoActions } from './actions';
import { CreateTrigger } from './create';
import { useEffect, useRef, useState } from 'react';
import { Split, List, Row, Empty, Error, Loading, Input, Button } from '../../kit';
import { folders, rows, title, source, nextScheduledAt, target, history, status, terminal, triggerAgent, type Trigger, type TriggerEvent, type AgentPause, type Folder } from './model';

export interface TempoSnapshot {
  status: 'loading' | 'live' | 'offline' | 'denied';
  triggers: readonly Trigger[];
  pauses: readonly AgentPause[];
  timezone: string;
}

export type { TempoActions } from './actions';

function TriggerActions({ trigger, pauses, actions }: { trigger: Trigger; pauses: readonly AgentPause[]; actions: TempoActions }) {
  const busy = useRef(false);
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState('');
  const standing = trigger.lifespan === 'until-stopped';
  const start = actions.start;
  const agent = triggerAgent(trigger);
  const paused = !!agent && pauses.some(item => item.agent === agent);
  async function run(action: () => Promise<void>) {
    if (busy.current) return;
    busy.current = true;
    setPending(true);
    setFailure('');
    try { await action(); }
    catch (error) { setFailure(tempoFailureMessage(error, 'Tempo could not complete that action. Try again.')); }
    finally { busy.current = false; setPending(false); }
  }
  return <section aria-label="Trigger actions" className="grid gap-2">
    <div className="flex flex-wrap gap-2">
      {!terminal(trigger) && <>
        <Button disabled={pending || !trigger.enabled || paused || trigger.state === 'held' || trigger.state === 'firing'} onClick={() => void run(() => actions.runNow(trigger.id))}>Run now</Button>
        <Button disabled={pending} onClick={() => void run(() => actions.stop(trigger.id))}>{standing ? 'Stop' : 'Cancel'}</Button>
      </>}
      {start && standing && !trigger.enabled && trigger.state === 'stopped' && !trigger.scheduleRemovedAt &&
        <Button disabled={pending} onClick={()=>void run(()=>start(trigger.id))}>Start</Button>}
      {agent && <Button disabled={pending} onClick={() => void run(() => paused ? actions.resume(agent) : actions.pause(agent))}>{paused ? 'Resume agent' : 'Pause agent'}</Button>}
    </div>
    {pending && <p role="status">Waiting for Tempo…</p>}
    {failure && <p role="alert">{failure}</p>}
  </section>;
}

/** Inline conversation view. Resolve IDs only against the current visible snapshot. */
export function TempoCard({ snapshot, triggerId, actions, go }: { snapshot: TempoSnapshot; triggerId: string; actions?: TempoActions; go?:(path:string)=>void }) {
  if (snapshot.status !== 'live') return snapshot.status === 'loading'
    ? <Loading label="Opening Tempo…" />
    : <Error text={snapshot.status === 'denied' ? 'Sign in with access to see Tempo.' : 'Waiting for connection.'} />;
  const trigger = snapshot.triggers.find(item => item.id === triggerId);
  if (!trigger) return <Empty title="Trigger unavailable" text="This trigger is no longer in your Tempo view." />;
  return <TriggerDetails key={trigger.id} snapshot={snapshot} trigger={trigger} actions={actions} go={go} />;
}

function TriggerDetails({ snapshot, trigger, actions, go }: { snapshot: TempoSnapshot; trigger: Trigger; actions?: TempoActions; go?:(path:string)=>void }) {
  const detail = useDataQuery<{
    tempoProgram: { program: { name: string }; programState: unknown; lastResult: string | null } | null;
  }>('query ProgramDetails($id:String!){tempoProgram(id:$id)}', {id: trigger.id});
  const journalDetail = useDataQuery<{
    tempoJournal: { lessons: string; state: string; stateChangedAt: string | null } | null;
  }>('query JournalDetails($id:String!){tempoJournal(id:$id)}', {id: trigger.id});
  const program = detail.status === 'live' ? detail.data?.tempoProgram : null;
  const journal = journalDetail.status === 'live' ? journalDetail.data?.tempoJournal : null;
  const log = useDataQuery<{ triggerLog: TriggerEvent[]; tempoRecentRuns: TriggerRun[] }>(triggerHistoryQuery, {id: trigger.id});
  const entries = log.status === 'live' && log.data?.triggerLog ? history(log.data.triggerLog, trigger.id) : undefined;
  const next = nextScheduledAt(trigger);
  const lastDecision = program?.lastResult ?? entries?.find(event => event.event === 'program')?.note;
  const format = new Intl.DateTimeFormat(undefined, {
    timeZone: snapshot.timezone, dateStyle: 'medium', timeStyle: 'short',
  });
  const time = (at:string) => format.format(new Date(at));
  return trigger ? <article className="grid gap-4 p-5">
    <header><h1 className="text-2xl font-semibold">{title(trigger)}</h1><p>{trigger.sourceKind} · {trigger.lifespan} · {status(trigger, snapshot.pauses)}</p></header>
    <p>{source(trigger)}</p>
    {next && <p>Due: {time(next)} · {snapshot.timezone}</p>}
    <dl className="grid gap-2">
      <div><dt>Set by</dt><dd>{trigger.ownerKind === 'household' ? 'Household' : trigger.owner}</dd></div>
      {trigger.project && <div><dt>Project</dt><dd>{trigger.project}</dd></div>}
      {!!trigger.needs?.length && <div><dt>Machine needs</dt><dd>{trigger.needs.join(', ')}</dd></div>}
      {trigger.prefers != null && <div><dt>Machine preferences</dt><dd>{trigger.prefers.join(', ') || 'None'}</dd></div>}
      {(trigger.wantsModel || (trigger.targetKind === 'inbox' && trigger.toKind === 'agent')) &&
        <div><dt>Requested model</dt><dd className="break-words">{trigger.wantsModel || 'Agent default'}</dd></div>}
      <div><dt>Target</dt><dd>{program ? program.program.name : target(trigger)}</dd></div>
      {program && <div>
        <dt>House program definition</dt>
        <dd><pre className="whitespace-pre-wrap break-all">{JSON.stringify(program.program, null, 2)}</pre></dd>
      </div>}
      {lastDecision && <div><dt>Last program result</dt><dd>{lastDecision}</dd></div>}
      {program?.programState != null && <div><dt>Program state</dt><dd><pre>{JSON.stringify(program.programState, null, 2)}</pre></dd></div>}
      <div><dt>Enabled</dt><dd>{trigger.enabled ? 'Yes' : 'No'}</dd></div>
      {trigger.lastFiredAt && <div><dt>Last fired</dt><dd>{time(trigger.lastFiredAt)}</dd></div>}
    </dl>
    {journal && <section aria-label="Trigger journal" className="grid gap-2">
      <h2>Lessons</h2><p className="whitespace-pre-wrap break-words">{journal.lessons || 'No lessons yet.'}</p>
      <h2>Saved state</h2><pre className="whitespace-pre-wrap break-all">{journal.state || 'Empty'}</pre>
      {journal.stateChangedAt && <p>Last changed {time(journal.stateChangedAt)} · {snapshot.timezone}</p>}
    </section>}
    {trigger.instructions && <section><h2>Words</h2><p className="whitespace-pre-wrap break-words">{trigger.instructions}</p></section>}
    {trigger.file && <section><h2>Repository file</h2><p>{trigger.file}</p></section>}
    {actions && <TriggerActions trigger={trigger} pauses={snapshot.pauses} actions={actions} />}
    {log.status === 'live' && log.data?.tempoRecentRuns && <RecentRuns runs={log.data.tempoRecentRuns} format={format} go={go}/>}
    <section><h2>Recent history</h2>{entries?.length ? <ol>
      {entries.map(event => <li key={event.seq}>{time(event.at)} · {event.event}{event.note && ` · ${event.note}`}</li>)}
    </ol> : entries ? <p>No events yet.</p> : log.status === 'loading' || log.status === 'live'
      ? <Loading label="Reading trigger history…" /> : <p>Trigger history unavailable.</p>}</section>
  </article> : null;
}

/** The composition supplies one visible, live query snapshot; this view owns no transport. */
/** `inUse`: the agents in use, where the composition knows them; the agent filter then offers no removed agent. */
export default function Tempo({ snapshot, actions, inUse, go }: { snapshot: TempoSnapshot; actions?: TempoActions; inUse?: ReadonlySet<string>; go?:(path:string)=>void }) {
  const [creating, setCreating] = useState(false);
  useEffect(() => { if (snapshot.status !== 'live') setCreating(false); }, [snapshot.status]);
  const [folder, setFolder] = useState<Folder | 'day' | 'week' | 'history'>('day');
  const [query, setQuery] = useState('');
  const [chosenDay,setChosenDay]=useState<string>();
  const [agent, setAgent] = useState('');
  const [selected, setSelected] = useState<string>();
  const live = snapshot.status === 'live';
  // Never keep displaying a previous viewer's rows during reconnect or access loss.
  const triggers = live ? snapshot.triggers : [];
  const selectedAgent = agent && (!inUse || inUse.has(agent)) ? agent : '';
  const calendar = folder === 'day' || folder === 'week' || folder === 'history';
  const shown = rows(triggers, calendar ? 'all' : folder, query, selectedAgent);
  const trigger = triggers.find(item => item.id === selected);
  const agents = [...new Set(triggers.map(triggerAgent).filter((agent): agent is string => !!agent && (!inUse || inUse.has(agent))))].sort();
  const reader = live && creating && actions?.create ? <CreateTrigger timezone={snapshot.timezone} submit={actions.create} done={() => setCreating(false)} /> : trigger ? <TriggerDetails key={trigger.id} snapshot={snapshot} trigger={trigger} actions={actions} go={go} /> : null;
  const time = (at: string) => new Intl.DateTimeFormat(undefined, { timeZone: snapshot.timezone, dateStyle: 'medium', timeStyle: 'short' }).format(new Date(at));
  return <Split label="Tempo" className={folder === 'week' ? 'h-full tempo-week' : 'h-full'} folders={[{id:'day',label:'Day'}, {id:'week',label:'Week'}, ...folders.map(item => ({ ...item, count: live && item.id!=='history' ? rows(triggers, item.id, '', selectedAgent).length : undefined }))]}
    folder={folder} onFolder={id => { setFolder(id as Folder | 'day' | 'week' | 'history'); setCreating(false); setSelected(undefined); }}
    search={<div className="grid gap-2"><label>Search tempo<Input type="search" value={query} onChange={event => setQuery(event.target.value)} /></label>
      <label>Agent<NativeSelect value={selectedAgent} onChange={event => { setAgent(event.target.value); setSelected(undefined); }}><option value="">All agents</option>{agents.map(id => <option key={id}>{id}</option>)}</NativeSelect></label></div>}
    listTitle={folder==='day' ? 'Day' : folder==='week' ? 'Week' : folders.find(item => item.id === folder)?.label} listMeta={live && !calendar ? shown.length : undefined}
    listTop={live ? <div className="grid gap-2 p-3">{actions?.create && <Button onClick={() => setCreating(true)}>Create trigger</Button>}{snapshot.pauses.length > 0 && <p>Paused: {snapshot.pauses.map(pause => pause.agent).join(', ')}</p>}</div> : undefined}
    list={!live ? snapshot.status === 'loading' ? <Loading label="Opening Tempo…" /> : <Error text={snapshot.status === 'denied' ? 'Sign in with access to see Tempo.' : 'Waiting for connection.'} />
      : calendar ? <TempoCalendar week={folder==='week'} history={folder==='history'} chosen={chosenDay} setChosen={setChosenDay} showDay={()=>setFolder('day')} clearReader={()=>{setSelected(undefined);setCreating(false);}} zone={snapshot.timezone} triggers={shown} pauses={snapshot.pauses} open={setSelected}/>
      : shown.length ? <List label="Triggers">{shown.map(item => {
          const next = nextScheduledAt(item);
          return <Row key={item.id} title={title(item)} meta={`${next ? time(next) : terminal(item) ? 'No next firing' : source(item)} · ${item.to ?? 'operation'}`} status={status(item, snapshot.pauses)} selected={item.id === selected} onClick={() => setSelected(item.id)} />;
        })}</List>
        : <Empty title={query ? `Nothing matches “${query}”` : 'No triggers here'} text="Ask an agent in chat to set a trigger." />}
    reader={reader} open={!!reader} onBack={() => { setCreating(false); setSelected(undefined); }} backLabel="Tempo"
    blank={<Empty title="Open a trigger" text="Choose a trigger to see its source, target, words and history." />} />;
}
