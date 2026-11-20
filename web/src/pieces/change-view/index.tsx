import { Suspense, useRef, useState } from 'react';
import { Split, List, Row, NoteRow, Empty, Error, Loading, Button, Actions, Search, Reader, Meta, Title, Facts, Fact, Section, Disclosure, ShortIdentifier, Clamp, Body, Chip, Markdown } from '../../kit';
import { briefTime, fullTime } from '../../kit/time';
import { displayName } from '../../kit/words';
import { rows, rowWord, summary, waitingWord, checksWord, checkWord, reviewWord, mergeableWord, roleWord, type Change, type ChangeSnapshot } from './model';
export type { ChangeSnapshot } from './model';
export interface ChangeActions {
  refresh?(): Promise<void>;
  canAnswer?(id:string,head:string): boolean;
  answer(id: string, head: string, answer: 'yes' | 'no'): Promise<void>;
  always?: { label?:string; change: string; head: string; project: string; run(id: string, head: string): Promise<void> };
}
type Name = (id: string) => string;
function Unavailable({ status }: { status: ChangeSnapshot['status'] }) {
  return status === 'loading' ? <Loading label="Opening Changes…" /> : <Error text={status === 'denied' ? 'Sign in with access to see Changes.' : 'Waiting for connection.'} />;
}
/** Reference only, in a conversation or on a task; merge answers belong in the tile. Drawn inside the kit's
 * RefCard. `open` goes to the tile; `link` is the pull request's own page. */
export function ChangeCard({ id, snapshot, open, link, name = displayName }: { id: string; snapshot: { status: ChangeSnapshot['status']; changes: readonly (Pick<Change,'id'|'title'|'state'|'checks'|'review'|'waitingOn'|'draft'> & { agent?: string | null })[] };
  open?(id: string): void; link?: { label: string; href?: string }; name?: Name }) {
  if (snapshot.status !== 'live') return <Unavailable status={snapshot.status} />;
  const change = snapshot.changes.find(c => c.id === id);
  return change ? <article className="grid gap-2 p-3"><p>Pull request</p><h3>{change.title}</h3><p>{summary(change, name)}</p>
    {(open || link) && <Actions>{open && <Button onClick={() => open(change.id)}>Open</Button>}
      {link && (link.href ? <a className="loom-kit-link" href={link.href} target="_blank" rel="noopener noreferrer">{link.label}</a> : <span>{link.label}</span>)}</Actions>}
  </article> : <Empty title="Change unavailable" />;
}
function MergeAnswer({ change: c, actions, name }: { change: Change; actions?: ChangeActions; name: Name }) {
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const active = useRef(false);
  async function send(run: () => Promise<void>) {
    if (active.current) return;
    active.current = true; setBusy(true); setError('');
    try { await run(); } catch { setError('Could not save the merge answer. Refresh and try again.'); }
    finally { active.current = false; setBusy(false); }
  }
  const always = actions?.always;
  const canAnswer = c.state === 'open' && c.waitingOn === 'you' && actions && (actions.canAnswer?.(c.id,c.headCommit) ?? true);
  const canAlways = c.state === 'open' && always?.change === c.id && always.head === c.headCommit && always.project === c.project;
  return <Section label="Merge answer">
    {canAnswer || canAlways ? <Actions label="Merge answer">
      {canAnswer && <><Button variant="primary" disabled={busy} onClick={() => void send(() => actions.answer(c.id, c.headCommit, 'yes'))}>Yes, merge it</Button>
      <Button disabled={busy} onClick={() => void send(() => actions.answer(c.id, c.headCommit, 'no'))}>Not yet</Button></>}
      {canAlways && <Button disabled={busy} onClick={() => void send(() => always.run(c.id, c.headCommit))}>{always.label ?? `Always for ${c.project}`}</Button>}
    </Actions> : <Body>{waitingWord(c, name)}</Body>}
    {canAlways && !canAnswer && <Body quiet>{waitingWord(c, name)}</Body>}
    {busy && <Body quiet role="status">Saving answer…</Body>}{error && <Error text={error} />}
  </Section>;
}
/** A description is long when it would run well past a screen of the reader. */
const isLong = (text: string) => text.length > 700 || text.split('\n').length > 14;
function Details({ change: c, snapshot, actions, openTask, name }: { change: Change; snapshot: ChangeSnapshot; actions?: ChangeActions; openTask?(id: string): void; name: Name }) {
  const tasks = new Set(snapshot.links.filter(l => l.change === c.id).map(l => l.task));
  const linked = snapshot.tasks.filter(t => tasks.has(t.id));
  // Failing ones first, then the ones still running: the only checks the program keeps by name.
  const checks = snapshot.checks.filter(k => k.change === c.id).sort((a, b) => a.state.localeCompare(b.state)), people = snapshot.people.filter(p => p.change === c.id);
  return <Reader aria-label="Change">
    <Meta>{c.id}{c.project && ` · ${c.project}`}</Meta>
    <Title>{c.title}</Title>
    <Meta>{summary(c, name)}</Meta>
    <Meta>{c.authorLogin} · {c.branch} into {c.baseBranch}</Meta>
    <Section label="Checks">
      <Body>{checksWord[c.checks] ?? c.checks}</Body>
      {checks.length > 0 && <Facts>{checks.map(k => <Fact key={k.name} label={checkWord[k.state] ?? k.state}>{k.name}</Fact>)}</Facts>}
    </Section>
    <Section label="Review"><Body>{reviewWord[c.review] ?? c.review}</Body></Section>
    {people.length > 0 && <Section label="People on it"><Facts>{people.map(p => <Fact key={`${p.login}:${p.role}`} label={roleWord[p.role] ?? p.role}>{p.login}</Fact>)}</Facts></Section>}
    <MergeAnswer key={`${c.id}@${c.headCommit}`} change={c} actions={actions} name={name} />
    {linked.length > 0 && <Section label="Tasks"><div role="group" aria-label="Linked tasks" className="grid gap-1">{linked.map(t =>
      <div key={t.id}>{t.title} <Chip onClick={openTask ? () => openTask(t.id) : undefined} label={openTask ? `Open ${t.title}, ${t.id}` : undefined}>{t.id}</Chip></div>)}</div></Section>}
    {c.body && <Section label="Description"><Clamp long={isLong(c.body)}><Suspense fallback={<Body>{c.body}</Body>}><Markdown text={c.body} /></Suspense></Clamp></Section>}
    <Disclosure label="Details"><Facts>
      <Fact label="Can be merged">{mergeableWord[c.mergeable] ?? c.mergeable}</Fact>
      <Fact label="Commit"><ShortIdentifier value={c.headCommit} /></Fact>
    </Facts></Disclosure>
  </Reader>;
}
export default function Changes({ snapshot, actions, openTask, navigation, names }: { snapshot: ChangeSnapshot; actions?: ChangeActions; openTask?(id: string): void; navigation?: { selected?: string; select(id?: string): void; folder?: string; openFolder?(id: string): void };
  /** Agents' display names by id, where the composition has read them. */
  names?: Readonly<Record<string, string>> }) {
  const [localFolder, setLocalFolder] = useState('all'), [query, setQuery] = useState(''), [localSelected, setLocalSelected] = useState<string>();
  const folder = navigation?.folder ?? localFolder;
  const selected = navigation ? navigation.selected : localSelected;
  const setSelected = navigation ? navigation.select : setLocalSelected;
  const [refreshing, setRefreshing] = useState(false), [error, setError] = useState('');
  const refreshActive = useRef(false);
  const live = snapshot.status === 'live';
  const name: Name = id => displayName(id, names);
  const shown = rows(snapshot, folder, query);
  const current = live ? snapshot.changes.find(c => c.id === selected) : undefined;
  const folders = [{ id: 'all', label: 'All changes' }, { id: 'you', label: 'Waiting on you' }, { id: 'lately', label: 'Lately' },
    ...(live ? [...new Set(snapshot.changes.flatMap(c => c.project ? [c.project] : []))].sort().map(id => ({ id: `project:${id}`, label: id })) : [])];
  async function refresh() {
    if (!live || !actions?.refresh || refreshActive.current) return;
    refreshActive.current = true; setRefreshing(true); setError('');
    try { await actions.refresh(); } catch { setError('Could not refresh Changes.'); }
    finally { refreshActive.current = false; setRefreshing(false); }
  }
  const readAt = live ? snapshot.sync?.readAt : undefined;
  // Lately is every change again in another order, so it carries no count of its own.
  return <Split label="Changes" folders={folders.map(f => ({ ...f, count: live && f.id !== 'lately' ? rows(snapshot, f.id, '').length : undefined }))}
    folder={folder} onFolder={id => { if (navigation?.openFolder) navigation.openFolder(id); else { setLocalFolder(id); setSelected(undefined); } }}
    search={<Search label="Search changes" value={query} onChange={setQuery} />}
    listTitle={folders.find(f => f.id === folder)?.label ?? 'Changes'} listCount={live ? shown.length : undefined} listKey={JSON.stringify([folder, query])}
    listAction={actions?.refresh && <Button disabled={!live || refreshing} onClick={() => void refresh()}>{refreshing ? 'Refreshing…' : 'Refresh'}</Button>}
    listTop={readAt && <Meta>Last read <time dateTime={readAt} title={fullTime(readAt, snapshot.timezone)}>{briefTime(readAt, snapshot.timezone)}</time></Meta>}
    list={!live ? <Unavailable status={snapshot.status} /> : <>
      {snapshot.sync?.failed && <NoteRow role="status" title="GitHub read failed" meta="Showing the last successful copy." />}
      {error && <NoteRow role="alert" title={error} />}
      {shown.length ? <List label="Pull requests">{shown.map(c => <Row key={c.id} title={c.title} meta={`${c.id}${c.project ? ` · ${c.project}` : ''}`} status={rowWord(c, name)} selected={selected === c.id} onClick={() => setSelected(c.id)} />)}</List> : <Empty title={query ? 'No matching changes' : 'No changes here'} />}</>}
    reader={current ? <Details key={current.id} change={current} snapshot={snapshot} actions={actions} openTask={openTask} name={name} /> : null}
    open={!!current} onBack={() => setSelected(undefined)} backLabel="Back to Changes"
    blank={<Empty title="Open a change" text="Choose a pull request to see its checks, review and tasks." />} />;
}
