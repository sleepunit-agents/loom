import { InboxActionNotices, type InboxResultsSnapshot } from './outcomes';
export { InboxActionNotices } from './outcomes';
export type { InboxActionResult, InboxResultsSnapshot } from './outcomes';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Split, Row, Empty, Error, Loading, Button, Input, Textarea, type SplitFolder } from '../../kit';
import { managed, rows, type InboxActions, type InboxAnswer, type InboxItem, type InboxSnapshot } from './model';
export type { InboxActions, InboxItem, InboxSnapshot } from './model';
const safeLink = (value?: string | null) => value && (/^https?:\/\//i.test(value) || /^\/(?!\/)/.test(value)) ? value : undefined;
const time = (at: string) => `${new Date(at).toLocaleString('en-US', { timeZone: 'America/Chicago' })} CT`;

/** The same reader can appear inline or in the Inbox tile. Mutations belong to
 * the authenticated operation client supplied by composition. */
function QuestionReader({ item, actions, inline, sourceCard }: { item: InboxItem; actions?: InboxActions; inline?: boolean; sourceCard?: ReactNode }) {
  const [draft, setDraft] = useState(''), [busy, setBusy] = useState(false), [error, setError] = useState(false);
  const lock = useRef(false), mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => { setDraft(''); setError(false); }, [item.id, item.body?.words]);
  const canRead = !!actions?.read;
  useEffect(() => {
    if (!item.read && actions?.read) void actions.read(item.id).catch(() => { if (mounted.current) setError(true); });
  }, [item.id, canRead]);
  const answer = async (verdict: InboxAnswer, words?: string) => {
    if (lock.current || item.state !== 'waiting' || !item.answers || !item.body || managed(item) || !actions?.answer) return;
    if (verdict === 'words' && !words?.trim()) return;
    lock.current = true; setBusy(true); setError(false);
    try { await actions.answer(item.id, verdict, words?.trim()); }
    catch { if (mounted.current) setError(true); }
    finally { lock.current = false; if (mounted.current) setBusy(false); }
  };
  const volume = async (value: InboxItem['volume']) => {
    if (lock.current || !item.canSetVolume || !actions?.volume) return;
    lock.current = true; setBusy(true); setError(false);
    try { await actions.volume(item.id, value); }
    catch { if (mounted.current) setError(true); }
    finally { lock.current = false; if (mounted.current) setBusy(false); }
  };
  const waiting = item.state === 'waiting';
  return <article aria-label="Inbox item" className="grid gap-4 p-4">
    <p>{item.agent ?? item.fromId ?? 'Loom'} · {item.state} · <time dateTime={item.at}>{time(item.at)}</time>{item.project && ` · ${item.project}`}</p>
    <h2>{item.body?.words ?? 'Message words are unavailable'}</h2>
    {item.body?.why && <p>{item.body.why}</p>}
    {(item.body?.ifYes || item.body?.ifNo) && <dl>{item.body.ifYes && <><dt>If yes</dt><dd>{item.body.ifYes}</dd></>}{item.body.ifNo && <><dt>If no</dt><dd>{item.body.ifNo}</dd></>}</dl>}
    {safeLink(item.body?.link) && <a href={safeLink(item.body?.link)} target="_blank" rel="noreferrer">Open linked page</a>}
    {item.canSetVolume && actions?.volume && <section aria-label="Item volume" className="grid gap-2">
      <p>Volume: {item.volume}{item.volume !== 'full' && item.quietUntil && <> · returns to full <time dateTime={item.quietUntil}>{time(item.quietUntil)}</time></>}</p>
      <div>{(['full', 'dim', 'mute'] as const).map(value => <Button key={value} disabled={busy || value === item.volume} onClick={() => void volume(value)}>{value === 'full' ? 'Full' : value === 'dim' ? 'Dim' : 'Mute'}</Button>)}</div>
    </section>}
    {item.refs.length > 0 && <p>About: {item.refs.join(' · ')}</p>}
    {waiting && managed(item) && !sourceCard && <p>Answer this at its source.</p>}
    {waiting && managed(item) && !sourceCard && actions?.openSource && <Button onClick={() => actions.openSource!(item)}>Open {item.waitsOnKind ?? (item.source === 'approval' ? 'Approvals' : item.source === 'task' ? 'task' : 'Secrets')}</Button>}
    {waiting && item.answers && item.body && !managed(item) && actions?.answer && <section aria-label="Record your answer" className="grid gap-2">
      {item.answers === 'yes-no' && <div><Button disabled={busy} onClick={() => void answer('yes')}>{inline ? 'Allow' : 'Yes'}</Button><Button disabled={busy} onClick={() => void answer('no')}>{inline ? 'Deny' : 'No'}</Button></div>}
      <Textarea aria-label="Answer in your own words" value={draft} onChange={event => setDraft(event.target.value)} disabled={busy} />
      <div><Button disabled={busy || !draft.trim()} onClick={() => void answer('words', draft)}>Record answer</Button><Button disabled={busy} onClick={() => void answer('done')}>Mark done</Button><Button disabled={busy} onClick={() => void answer('dismiss')}>Dismiss</Button></div>
    </section>}
    {sourceCard}
    {item.answer && <section><h3>Answer</h3><p>{item.answer} · {item.answeredBy}{item.answeredAt && ` · ${time(item.answeredAt)}`}</p>{item.answerText && <p className="whitespace-pre-wrap">{item.answerText}</p>}</section>}
    {item.resolution && <p>{item.resolution}</p>}
    {error && <Error text="Could not save. Try again." />}
  </article>;
}

export function InboxQuestionCard({ id, snapshot, actions, inline, sourceCard }: { id: string; snapshot: InboxSnapshot; actions?: InboxActions; inline?: boolean; sourceCard?: ReactNode }) {
  const item = snapshot.status === 'live' ? snapshot.items.find(row => row.id === id) : undefined;
  return item ? <QuestionReader key={item.id} item={item} actions={actions} inline={inline} sourceCard={sourceCard} /> : <Empty title="Item is unavailable" />;
}

export function InboxView({ snapshot, selected, select, detail, actions, results, dismissResult, navigation }: {
  navigation?: { folder: string; query: string; offset: number; hasNext: boolean; onFolder(id: string): void; onQuery(value: string): void; previous(): void; next(): void };
  results?: InboxResultsSnapshot; dismissResult?(id: string): Promise<void>;
  snapshot: InboxSnapshot; selected?: string; select(id?: string): void;
  detail?: { status: InboxSnapshot['status']; item: InboxItem | null }; actions?: InboxActions;
}) {
  const [localFolder, setFolder] = useState('needs'), [localQuery, setQuery] = useState('');
  const folder = navigation?.folder ?? localFolder, query = navigation?.query ?? localQuery;
  const display = selected && detail && detail.status !== 'live'
    ? { ...snapshot, items: snapshot.items.filter(row => row.id !== selected) } : snapshot;
  const shown = folder === 'errors' ? [] : rows(display, folder, navigation ? '' : query);
  const currentResults = snapshot.status === 'live' && results?.status === 'live' ? results : undefined;
  const live = snapshot.status === 'live';
  const item = live ? (detail ? detail.status === 'live' && detail.item?.id === selected ? detail.item : undefined : snapshot.items.find(row => row.id === selected)) : undefined;
  const folders: SplitFolder[] = [
    ...[['needs', 'Needs you'], ['alerts', 'Alerts'], ['answered', 'Answered'], ['fyi', 'FYI'], ['all', 'All items']].map(([id, label]) => ({ id, label, count: live && snapshot.folders ? snapshot.folders[id as 'needs' | 'alerts' | 'answered' | 'fyi' | 'all'] : rows(display, id, '').length })),
    { id: 'errors', label: 'Errors', count: currentResults?.results.filter(row => !row.ok && !row.readAt).length ?? 0 },
    { heading: 'By agent' }, ...(live && snapshot.folders ? snapshot.folders.agents : [...new Set(live ? display.items.flatMap(row => row.agent ? [row.agent] : []) : [])].sort().map(id => ({ id, count: rows(display, `agent:${id}`, '').length })))
      .map(agent => ({ id: `agent:${agent.id}`, label: agent.id, count: agent.count })),
  ];
  return <Split label="Inbox" folders={folders} folder={folder} onFolder={id => navigation ? navigation.onFolder(id) : setFolder(id)} listTitle="Inbox"
    listTop={<>{navigation && folder !== 'errors' && <nav aria-label="Inbox pages"><Button disabled={!live || navigation.offset === 0} onClick={navigation.previous}>Previous page</Button><Button disabled={!live || !navigation.hasNext} onClick={navigation.next}>Next page</Button></nav>}{currentResults && (folder === 'fyi' || folder === 'errors' || folder === 'all') && <InboxActionNotices snapshot={currentResults} errorsOnly={folder === 'errors'} dismiss={dismissResult} />}</>}
    search={<Input aria-label="Search asks" value={live ? query : ''} disabled={!live} onChange={event => navigation ? navigation.onQuery(event.target.value) : setQuery(event.target.value)} />}
    list={!live ? snapshot.status === 'loading' ? <Loading /> : <Empty title="Inbox is unavailable" /> : shown.length ? shown.map(row => <Row key={row.id} title={row.body?.words ?? `Item from ${row.agent ?? row.fromId ?? 'Loom'}`} className={row.volume === 'dim' ? '[&_.loom-kit-title]:line-clamp-1' : undefined} meta={row.volume === 'dim' ? undefined : row.body?.why ?? row.source} status={row.volume === 'dim' ? undefined : `${row.agent ?? 'Loom'} · ${row.state} · ${row.read ? 'Read' : 'Unread'}`} selected={row.id === selected} onClick={() => select(row.id)} />) : folder === 'errors' && currentResults?.results.some(row => !row.ok && !row.readAt) ? null : <Empty title="No items here" />}
    reader={item ? <InboxQuestionCard key={item.id} id={item.id} snapshot={{ status: 'live', items: [item] }} actions={actions} /> : selected && live && detail?.status === 'loading' ? <Loading /> : null}
    open={!!selected} onBack={() => select(undefined)} backLabel="Back to Inbox" blank={<Empty title="Choose an item" />} />;
}
