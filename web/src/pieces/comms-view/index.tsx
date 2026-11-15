import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Split, Row, Empty, Error, Loading, Button, Input, Textarea } from '../../kit';
import { useCommsDraft } from '../comms/drafts';
import { useReplyFollow } from '../comms/use-follow';
import { threadRows, type CommsActions, type CommsDetail, type CommsSnapshot, type ThreadChange } from './model';
export type { CommsActions, CommsDetail, CommsSnapshot } from './model';
const time = (at: string) => `${new Date(at).toLocaleString('en-US', { timeZone: 'America/Chicago' })} CT`;
type MessageNavigation = { earlier(): void; latest(): void; hasEarlier: boolean; before?: number };
type Navigation = { archived: boolean; search: string; offset: number; hasNext: boolean; folder(value: boolean): void; query(value: string): void; previous(): void; next(): void };
type Cards = { screen?: ReactNode; question?(id: string): ReactNode; work?(refs: CommsDetail['refs'], conversation: string): ReactNode };
function ThreadReader({ member, detail, actions, cards, navigation, readVisible = true }: { member: string; readVisible?: boolean; detail: CommsDetail; actions?: CommsActions; cards?: Cards; navigation?: MessageNavigation }) {
  const thread = detail.thread!;
  const composer=useCommsDraft(member,thread.id,thread.member===member),draft=composer.value;
  const [busy, setBusy] = useState(false), [failed, setFailed] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [renaming, setRenaming] = useState(false), [title, setTitle] = useState(thread.title);
  const lock = useRef(false), mounted = useRef(true);
  const scroller = useRef<HTMLDivElement | null>(null);
  const messages = detail.messages.filter(message => message.thread === thread.id).sort((a, b) => a.seq - b.seq);
  const follow = useReplyFollow(scroller, messages, true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const last = messages.at(-1)?.seq ?? 0;
  useEffect(() => { if (readVisible && follow.atLatest() && actions && last > thread.readSeq) void actions.read(thread.id, last).catch(() => { if (mounted.current) setFailed(true); }); }, [thread.id, last, readVisible, follow.unread]);
  const run = async (action: () => Promise<void>) => {
    if (lock.current || !actions) return;
    lock.current = true; setBusy(true); setFailed(false);
    try { await action(); }
    catch { if (mounted.current) setFailed(true); }
    finally { lock.current = false; if (mounted.current) setBusy(false); }
  };
  const change = (value: ThreadChange) => void run(() => actions!.change(thread.id, value));
  const send = () => {
    if (!draft.text.trim() || lock.current || !actions) return;
    const sent = draft;
    void run(async () => {
      await actions.send(thread.id, sent.text, sent.id);
      composer.acknowledged(sent);
    });
  };
  return <article ref={node => { scroller.current = node?.closest<HTMLDivElement>('.loom-split__reader') ?? null; }} className="grid gap-4 p-4" aria-label="Conversation">
    {cards?.screen}
    <header><h2>{thread.title}</h2><p>with {thread.agent}{thread.project && ` · ${thread.project}`}{thread.working && ' · working'}</p></header>
    {actions && <div><Button disabled={busy} onClick={() => change({ change: 'pin', pinned: !thread.pinned })}>{thread.pinned ? 'Unpin' : 'Pin'}</Button><Button disabled={busy} onClick={() => change({ change: 'archive', archived: !thread.archivedAt })}>{thread.archivedAt ? 'Restore' : 'Archive'}</Button><Button disabled={busy} onClick={() => { setTitle(thread.title); setRenaming(true); }}>Rename</Button>{thread.working && <Button disabled={busy || thread.stopRequested} onClick={() => change({ change: 'stop' })}>{thread.stopRequested ? 'Stopping…' : 'Stop'}</Button>}</div>}
    {renaming && <div><Input aria-label="Conversation title" value={title} maxLength={120} onChange={event => setTitle(event.target.value)} /><Button disabled={busy || !title.trim() || [...title.trim()].length > 60} onClick={() => void run(async () => { await actions!.change(thread.id, { change: 'rename', title: title.trim() }); if (mounted.current) setRenaming(false); })}>Save title</Button><Button disabled={busy} onClick={() => setRenaming(false)}>Cancel</Button></div>}
    {navigation && <nav aria-label="Message pages"><Button disabled={!navigation.hasEarlier} onClick={navigation.earlier}>Earlier messages</Button>{navigation.before !== undefined && <Button onClick={navigation.latest}>Latest messages</Button>}</nav>}
    {actions && <div><Button disabled={busy} onClick={() => setDeleting(true)}>Delete</Button>{deleting && <section aria-label="Delete conversation"><p>Delete this thread and its private words?</p><Button disabled={busy} onClick={() => change({ change: 'delete' })}>Delete thread</Button><Button disabled={busy} onClick={() => setDeleting(false)}>Keep thread</Button></section>}</div>}
    <ol className="grid gap-4">{messages.map(message => <li key={message.seq}>
      <p>{message.sender} · <time dateTime={message.at}>{time(message.at)}</time>{message.kind === 'card' && ` · ${message.tool ?? 'Progress'} · ${message.cardState ?? 'running'}`}{message.delivery && ` · ${message.delivery}`}</p>
      {message.kind === 'ask' && message.inboxItem ? cards?.question?.(message.inboxItem) ?? <p>Question · open Inbox</p> : <p className="whitespace-pre-wrap break-words">{message.words ?? 'Message words are unavailable'}</p>}
      {message.kind === 'answer' && message.verdict && <p>Answered {message.verdict}</p>}
    </li>)}</ol>
    {follow.unread > 0 && <Button onClick={follow.down}>{follow.unread} new messages</Button>}
    {cards?.work && <section aria-label="Work in this conversation"><h3>Work</h3>{cards.work(detail.refs, thread.conversation)}</section>}
    {actions && !thread.archivedAt && <div><label>Message {thread.agent}<Textarea aria-label={`Message ${thread.agent}`} value={draft.text} maxLength={100000} rows={3} disabled={busy} onChange={event => composer.edit(event.target.value)} onKeyDown={event => { if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) { event.preventDefault(); send(); } }} /></label><Button disabled={busy || !draft.text.trim()} onClick={send}>Send</Button></div>}
    {failed && <Error text="Could not save. Try again." />}
  </article>;
}
export function CommsView({ snapshot, detail, selected, select, actions, cards, navigation, messageNavigation, readVisible = true }: {
  readVisible?: boolean;
  navigation?: Navigation; messageNavigation?: MessageNavigation;
  snapshot: CommsSnapshot; detail?: CommsDetail; selected?: string; select(id?: string): void; actions?: CommsActions; cards?: Cards;
}) {
  const [localArchived, setArchived] = useState(false), [localQuery, setQuery] = useState(''), [opening, setOpening] = useState(false), [failed, setFailed] = useState(false);
  const latest = useRef(snapshot); latest.current = snapshot;
  const openingRetry = useRef<{ agent: string; member: string; id: string } | undefined>(undefined);
  const openingLock = useRef(false), mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const archived = navigation?.archived ?? localArchived, query = navigation?.search ?? localQuery;
  const live = snapshot.status === 'live';
  const display = selected && detail && detail.status !== 'live' ? { ...snapshot, threads: snapshot.threads.filter(thread => thread.id !== selected) } : snapshot;
  const shown = threadRows(display, archived, navigation ? '' : query);
  const current = live && !!selected && !!detail?.thread && detail.status === 'live' && detail.thread.id === selected ? detail : undefined;
  const open = async (agent: string) => {
    if (openingLock.current || !live || !actions) return;
    openingLock.current = true; setOpening(true); setFailed(false);
    const request = openingRetry.current?.agent === agent && openingRetry.current.member === snapshot.member
      ? openingRetry.current : { agent, member: snapshot.member, id: `th:${crypto.randomUUID()}` };
    openingRetry.current = request;
    try {
      await actions.open(agent, request.id);
      if (mounted.current && latest.current.status === 'live' && latest.current.member === request.member && latest.current.agents.some(row => row.id === agent)) select(request.id);
      if (openingRetry.current === request) openingRetry.current = undefined;
    }
    catch { if (mounted.current) setFailed(true); }
    finally { openingLock.current = false; if (mounted.current) setOpening(false); }
  };
  return <Split label="Comms" folders={['Threads', 'Archived'].map((label, index) => ({ id: String(index), label, count: live && snapshot.folders ? index ? snapshot.folders.archived : snapshot.folders.threads : threadRows(display, !!index, '').length }))} folder={archived ? '1' : '0'} onFolder={id => navigation ? navigation.folder(id === '1') : setArchived(id === '1')} listTitle="Threads"
    search={<Input aria-label="Search conversations" value={live ? query : ''} disabled={!live} onChange={event => navigation ? navigation.query(event.target.value) : setQuery(event.target.value)} />}
    listTop={<>{navigation && <nav aria-label="Conversation pages"><Button disabled={!live || navigation.offset === 0} onClick={navigation.previous}>Previous page</Button><Button disabled={!live || !navigation.hasNext} onClick={navigation.next}>Next page</Button></nav>}{live && actions && <div><details><summary>New conversation</summary>{snapshot.agents.map(agent => <Button key={agent.id} disabled={opening} onClick={() => void open(agent.id)}>Chat with {agent.name}</Button>)}</details>{failed && <Error text="Could not start the conversation. Try again." />}</div>}</>}
    list={!live ? snapshot.status === 'loading' ? <Loading /> : <Empty title="Conversations are unavailable" /> : shown.length ? shown.map(thread => <Row key={thread.id} title={thread.title} meta={`${thread.agent}${thread.project ? ` · ${thread.project}` : ''}`} status={thread.working ? 'Working' : thread.pinned ? 'Pinned' : 'Ready'} selected={thread.id === selected} onClick={() => select(thread.id)} />) : <Empty title="No conversations here" />}
    reader={current ? <ThreadReader key={JSON.stringify([snapshot.member, current.thread!.id])} member={snapshot.member} detail={current} actions={current.thread!.member === snapshot.member ? actions : undefined} cards={cards} navigation={messageNavigation} readVisible={readVisible} /> : selected && live && detail?.status === 'loading' ? <Loading /> : null}
    open={!!selected} onBack={() => select(undefined)} backLabel="Back to conversations" blank={<Empty title="Choose a conversation" />} />;
}
