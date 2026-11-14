import { useEffect, useRef, useState } from 'react';
import { Split, Row, Empty, Error, Loading, Button, Input, Textarea, type SplitFolder } from '../../kit';
import { managed, rows, type InboxActions, type InboxAnswer, type InboxItem, type InboxSnapshot } from './model';
export type { InboxActions, InboxItem, InboxSnapshot } from './model';
const safeLink = (value?: string | null) => value && (/^https?:\/\//i.test(value) || /^\/(?!\/)/.test(value)) ? value : undefined;
const time = (at: string) => `${new Date(at).toLocaleString('en-US', { timeZone: 'America/Chicago' })} CT`;

/** The same reader can appear inline or in the Inbox tile. Mutations belong to
 * the authenticated operation client supplied by composition. */
function QuestionReader({ item, actions, inline }: { item: InboxItem; actions?: InboxActions; inline?: boolean }) {
  const [draft, setDraft] = useState(''), [busy, setBusy] = useState(false), [error, setError] = useState(false);
  const lock = useRef(false), mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => { setDraft(''); setError(false); }, [item.id, item.body?.words]);
  useEffect(() => {
    if (!item.read && actions?.read) void actions.read(item.id).catch(() => { if (mounted.current) setError(true); });
  }, [item.id]);
  const answer = async (verdict: InboxAnswer, words?: string) => {
    if (lock.current || item.state !== 'waiting' || !item.answers || !item.body || managed(item) || !actions) return;
    if (verdict === 'words' && !words?.trim()) return;
    lock.current = true; setBusy(true); setError(false);
    try { await actions.answer(item.id, verdict, words?.trim()); }
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
    {item.refs.length > 0 && <p>About: {item.refs.join(' · ')}</p>}
    {waiting && managed(item) && actions?.openSource && <Button onClick={() => actions.openSource!(item)}>Open {item.waitsOnKind ?? (item.source === 'approval' ? 'Approvals' : item.source === 'task' ? 'task' : 'Secrets')}</Button>}
    {waiting && item.answers && item.body && !managed(item) && actions && <section aria-label="Record your answer" className="grid gap-2">
      {item.answers === 'yes-no' && <div><Button disabled={busy} onClick={() => void answer('yes')}>{inline ? 'Allow' : 'Yes'}</Button><Button disabled={busy} onClick={() => void answer('no')}>{inline ? 'Deny' : 'No'}</Button></div>}
      <Textarea aria-label="Answer in your own words" value={draft} onChange={event => setDraft(event.target.value)} disabled={busy} />
      <div><Button disabled={busy || !draft.trim()} onClick={() => void answer('words', draft)}>Record answer</Button><Button disabled={busy} onClick={() => void answer('done')}>Mark done</Button><Button disabled={busy} onClick={() => void answer('dismiss')}>Dismiss</Button></div>
    </section>}
    {item.answer && <section><h3>Answer</h3><p>{item.answer} · {item.answeredBy}{item.answeredAt && ` · ${time(item.answeredAt)}`}</p>{item.answerText && <p className="whitespace-pre-wrap">{item.answerText}</p>}</section>}
    {item.resolution && <p>{item.resolution}</p>}
    {error && <Error text="Could not save. Try again." />}
  </article>;
}

export function InboxQuestionCard({ id, snapshot, actions, inline }: { id: string; snapshot: InboxSnapshot; actions?: InboxActions; inline?: boolean }) {
  const item = snapshot.status === 'live' ? snapshot.items.find(row => row.id === id) : undefined;
  return item ? <QuestionReader key={item.id} item={item} actions={actions} inline={inline} /> : <Empty title="Item is unavailable" />;
}

export function InboxView({ snapshot, selected, select, detail, actions }: {
  snapshot: InboxSnapshot; selected?: string; select(id?: string): void;
  detail?: { status: InboxSnapshot['status']; item: InboxItem | null }; actions?: InboxActions;
}) {
  const [folder, setFolder] = useState('needs'), [query, setQuery] = useState('');
  const display = selected && detail && detail.status !== 'live'
    ? { ...snapshot, items: snapshot.items.filter(row => row.id !== selected) } : snapshot;
  const shown = rows(display, folder, query);
  const live = snapshot.status === 'live';
  const item = live ? (detail ? detail.status === 'live' && detail.item?.id === selected ? detail.item : undefined : snapshot.items.find(row => row.id === selected)) : undefined;
  const folders: SplitFolder[] = [
    ...[['needs', 'Needs you'], ['answered', 'Answered'], ['fyi', 'FYI'], ['all', 'All items']].map(([id, label]) => ({ id, label, count: rows(display, id, '').length })),
    { heading: 'By agent' }, ...[...new Set(live ? display.items.flatMap(row => row.agent ? [row.agent] : []) : [])].sort().map(agent => ({ id: `agent:${agent}`, label: agent, count: rows(display, `agent:${agent}`, '').length })),
  ];
  return <Split label="Inbox" folders={folders} folder={folder} onFolder={setFolder} listTitle="Inbox"
    search={<Input aria-label="Search asks" value={live ? query : ''} disabled={!live} onChange={event => setQuery(event.target.value)} />}
    list={!live ? snapshot.status === 'loading' ? <Loading /> : <Empty title="Inbox is unavailable" /> : shown.length ? shown.map(row => <Row key={row.id} title={row.body?.words ?? `Item from ${row.agent ?? row.fromId ?? 'Loom'}`} meta={row.body?.why ?? row.source} status={`${row.agent ?? 'Loom'} · ${row.state} · ${row.read ? 'Read' : 'Unread'}`} selected={row.id === selected} onClick={() => select(row.id)} />) : <Empty title="No items here" />}
    reader={item ? <InboxQuestionCard key={item.id} id={item.id} snapshot={{ status: 'live', items: [item] }} actions={actions} /> : selected && live && detail?.status === 'loading' ? <Loading /> : null}
    open={!!selected} onBack={() => select(undefined)} backLabel="Back to Inbox" blank={<Empty title="Choose an item" />} />;
}
