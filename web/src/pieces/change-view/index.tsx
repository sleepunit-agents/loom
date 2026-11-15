import { useRef, useState } from 'react';
import { Split, List, Row, Empty, Error, Loading, Button, Input } from '../../kit';
import { rows, summary, type Change, type ChangeSnapshot } from './model';
export type { ChangeSnapshot } from './model';
export interface ChangeActions {
  refresh(): Promise<void>;
  answer(id: string, head: string, answer: 'yes' | 'no'): Promise<void>;
  always?: { change: string; head: string; project: string; run(id: string, head: string): Promise<void> };
}
function Unavailable({ status }: { status: ChangeSnapshot['status'] }) {
  return status === 'loading' ? <Loading label="Opening Changes…" /> : <Error text={status === 'denied' ? 'Sign in with access to see Changes.' : 'Waiting for connection.'} />;
}
/** Reference only in a conversation; merge answers belong in the tile. */
export function ChangeCard({ id, snapshot, open }: { id: string; snapshot: { status: ChangeSnapshot['status']; changes: readonly Pick<Change,'id'|'title'|'state'|'checks'|'review'|'waitingOn'|'draft'>[] }; open(id: string): void }) {
  if (snapshot.status !== 'live') return <Unavailable status={snapshot.status} />;
  const change = snapshot.changes.find(c => c.id === id);
  return change ? <article className="grid gap-2 p-3"><p>Pull request</p><h3>{change.title}</h3><p>{summary(change)}</p><Button variant="outline" onClick={() => open(change.id)}>Open</Button></article> : <Empty title="Change unavailable" />;
}
function MergeAnswer({ change: c, actions }: { change: Change; actions?: ChangeActions }) {
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const active = useRef(false);
  async function send(run: () => Promise<void>) {
    if (active.current) return;
    active.current = true; setBusy(true); setError('');
    try { await run(); } catch { setError('Could not save the merge answer. Refresh and try again.'); }
    finally { active.current = false; setBusy(false); }
  }
  const always = actions?.always;
  return <section><h3>Merge answer</h3>
    {c.state === 'open' && c.waitingOn === 'you' && actions ? <div role="group" aria-label="Merge answer" className="flex flex-wrap gap-2">
      <Button disabled={busy} onClick={() => void send(() => actions.answer(c.id, c.headCommit, 'yes'))}>Yes, merge it</Button>
      <Button variant="outline" disabled={busy} onClick={() => void send(() => actions.answer(c.id, c.headCommit, 'no'))}>Not yet</Button>
      {always?.change === c.id && always.head === c.headCommit && always.project === c.project && <Button variant="outline" disabled={busy} onClick={() => void send(() => always.run(c.id, c.headCommit))}>Always for {c.project}</Button>}
    </div> : <p>{c.state === 'open' ? `Waiting on ${c.waitingOn}` : c.state}</p>}
    {busy && <p role="status">Saving answer…</p>}{error && <Error text={error} />}
  </section>;
}
function Details({ change: c, snapshot, actions, openTask }: { change: Change; snapshot: ChangeSnapshot; actions?: ChangeActions; openTask?(id: string): void }) {
  const tasks = new Set(snapshot.links.filter(l => l.change === c.id).map(l => l.task));
  const linked = snapshot.tasks.filter(t => tasks.has(t.id));
  return <article className="grid min-w-0 gap-4 p-5 [overflow-wrap:anywhere]">
    <header><p>{c.id}{c.project && ` · ${c.project}`}</p><h2 className="text-xl font-semibold">{c.title}</h2><p>{summary(c)}</p></header>
    <p>{c.authorLogin} · {c.branch} into {c.baseBranch}</p>
    <section><h3>Checks</h3><p>{c.checks}</p><ul>{snapshot.checks.filter(k => k.change === c.id).map(k => <li key={k.name}>{k.name} · {k.state}</li>)}</ul></section>
    <section><h3>Review</h3><p>{c.review.replaceAll('_', ' ')}</p></section>
    <section><h3>People on it</h3><ul>{snapshot.people.filter(p => p.change === c.id).map(p => <li key={`${p.login}:${p.role}`}>{p.login} · {p.role}</li>)}</ul></section>
    <p>Mergeable: {c.mergeable}</p><p className="font-mono">Commit: {c.headCommit}</p>
    <MergeAnswer key={`${c.id}@${c.headCommit}`} change={c} actions={actions} />
    <section><h3>Tasks</h3>{linked.length ? <List label="Linked tasks">{linked.map(t => <Row key={t.id} title={t.title} meta={t.id} status={t.status} onClick={openTask ? () => openTask(t.id) : undefined} />)}</List> : <p>None linked</p>}</section>
    {c.body && <section><h3>Description</h3><p className="whitespace-pre-wrap">{c.body}</p></section>}
  </article>;
}
export default function Changes({ snapshot, actions, openTask, navigation }: { snapshot: ChangeSnapshot; actions?: ChangeActions; openTask?(id: string): void; navigation?: { selected?: string; select(id?: string): void; folder?: string; openFolder?(id: string): void } }) {
  const [localFolder, setLocalFolder] = useState('all'), [query, setQuery] = useState(''), [localSelected, setLocalSelected] = useState<string>();
  const folder = navigation?.folder ?? localFolder;
  const selected = navigation ? navigation.selected : localSelected;
  const setSelected = navigation ? navigation.select : setLocalSelected;
  const [refreshing, setRefreshing] = useState(false), [error, setError] = useState('');
  const refreshActive = useRef(false);
  const live = snapshot.status === 'live';
  const shown = rows(snapshot, folder, query);
  const current = live ? snapshot.changes.find(c => c.id === selected) : undefined;
  const folders = [{ id: 'all', label: 'All changes' }, { id: 'you', label: 'Waiting on you' }, { id: 'lately', label: 'Lately' },
    ...(live ? [...new Set(snapshot.changes.flatMap(c => c.project ? [c.project] : []))].sort().map(id => ({ id: `project:${id}`, label: id })) : [])];
  async function refresh() {
    if (!live || !actions || refreshActive.current) return;
    refreshActive.current = true; setRefreshing(true); setError('');
    try { await actions.refresh(); } catch { setError('Could not refresh Changes.'); }
    finally { refreshActive.current = false; setRefreshing(false); }
  }
  return <Split label="Changes" className="h-full" folders={folders.map(f => ({ ...f, count: live ? rows(snapshot, f.id, '').length : undefined }))}
    folder={folder} onFolder={id => { if (navigation?.openFolder) navigation.openFolder(id); else { setLocalFolder(id); setSelected(undefined); } }}
    search={<label>Search changes<Input type="search" value={query} onChange={e => setQuery(e.target.value)} /></label>}
    listTitle="Changes" listMeta={live ? shown.length : undefined}
    listTop={<>{actions && <Button variant="outline" disabled={!live || refreshing} onClick={() => void refresh()}>Refresh</Button>}
      {live && snapshot.sync?.readAt && <p>Last read {new Intl.DateTimeFormat(undefined, { timeZone: snapshot.timezone, dateStyle: 'short', timeStyle: 'short' }).format(new Date(snapshot.sync.readAt))} · {snapshot.timezone}</p>}
      {live && snapshot.sync?.failed && <Error text="GitHub read failed. Showing the last successful copy." />}{error && <Error text={error} />}</>}
    list={!live ? <Unavailable status={snapshot.status} /> : shown.length ? <List label="Pull requests">{shown.map(c => <Row key={c.id} title={c.title} meta={`${c.id}${c.project ? ` · ${c.project}` : ''}`} status={summary(c)} selected={selected === c.id} onClick={() => setSelected(c.id)} />)}</List> : <Empty title={query ? 'No matching changes' : 'No changes here'} />}
    reader={current ? <Details key={current.id} change={current} snapshot={snapshot} actions={actions} openTask={openTask} /> : null}
    open={!!current} onBack={() => setSelected(undefined)} backLabel="Changes"
    blank={<Empty title="Open a change" text="Choose a pull request to see its checks, review and tasks." />} />;
}
