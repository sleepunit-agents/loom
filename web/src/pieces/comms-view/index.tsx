// Comms as its page on the "how it works" site draws it (docs/how-it-works/site/conversations.html, site.css `.cm`):
// threads on the left; the open thread as a conversation, the person's words on the right and tinted, the agent's on
// the left and quiet, a tool step as one dashed line, a question as a small card where it was asked; the message
// bar pinned under it; and the conversation's work in a column on its right where there is room. Built on the kit;
// what the kit has no part for is in comms.css. This file owns no store and no transport.
import { Suspense, lazy, useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import { Split, Row, Empty, Error, Loading, Button, Input, Actions, Search, Pager, Head, Title, Meta, Chip, Menu } from '../../kit';
import { useCommsDraft } from '../comms/drafts';
import { useReplyFollow } from '../comms/use-follow';
import { MessageBar, ComposerOff } from '../comms/composer';
import { briefTime, fullTime } from '../../kit/time';
import { withRefs } from './refs';
import { threadRows, type CommsActions, type CommsDetail, type CommsMessage, type CommsSnapshot, type Status, type ThreadChange } from './model';
import './comms.css';
export type { CommsActions, CommsDetail, CommsSnapshot } from './model';
export { WorkPanel, WorkCard } from './work';
const Prose = lazy(() => import('./prose'));

/** A page of earlier messages, read by the composition: drawn above the ones already shown. */
export type EarlierPage = { status: Status; messages: readonly CommsMessage[]; refs: CommsDetail['refs']; hasEarlier: boolean };
type MessageNavigation = { hasEarlier: boolean; page?(before: number, draw: (page: EarlierPage) => ReactNode): ReactNode };
type Navigation = { archived: boolean; search: string; offset: number; hasNext: boolean; folder(value: boolean): void; query(value: string): void; previous(): void; next(): void };
/** A question card says whether it is waiting on this person, so the thread's head can. */
type Note = (id: string, waiting: boolean) => void;
type Cards = {
  /** The agent's small face, beside the title. */
  screen?: ReactNode;
  /** A question where it was asked. */
  question?(id: string, note: Note): ReactNode;
  /** The conversation's questions that no message in the stream carries (`placed` are the ones that one does). */
  waiting?(conversation: string, placed: readonly string[], note: Note): ReactNode;
  work?(refs: CommsDetail['refs'], conversation: string): ReactNode;
  /** Where a reference in a message opens, when the app knows; undefined leaves it a plain chip. */
  openRef?(ref: string): (() => void) | undefined;
};
type Drawing = { member: string; name(id: string): string; zone?: string; cards?: Cards; note: Note };

const mine = (message: CommsMessage) => message.kind === 'message' || message.kind === 'answer';
const joins = (message: CommsMessage) => message.kind !== 'card' && message.kind !== 'notice';
/** A step's and a delivery's stored state, in plain words. */
const stepWords = { running: 'in progress', done: 'done', failed: 'failed' } as const;
const deliveryWords: Record<string, string | undefined> = { sending: 'Sending…', held: 'On hold', failed: 'Not delivered' };
/** Messages a few minutes apart from one sender are one group, under one name. */
const GROUP_GAP = 5 * 60_000;

function Words({ message, who, refs, drawing }: { message: CommsMessage; who: string; refs: readonly string[]; drawing: Drawing }) {
  const said = <span className="comms-sr">{who}, {fullTime(message.at, drawing.zone)}: </span>;
  if (message.kind === 'ask' && message.inboxItem) return <div className="comms-msg" data-card="">{said}
    {drawing.cards?.question?.(message.inboxItem, drawing.note) ?? <p className="comms-quiet">A question for you. Open Inbox to answer it.</p>}</div>;
  const verdict = message.kind === 'answer' && message.verdict ? `Answered ${message.verdict === 'yes' ? 'Yes' : 'No'}` : undefined;
  const delivery = mine(message) && message.delivery ? deliveryWords[message.delivery] : undefined;
  return <div className="comms-msg">
    {said}
    {message.words == null ? !verdict && <p className="comms-bubble" data-plain="" data-empty="">Message words are unavailable</p>
      : mine(message) ? <p className="comms-bubble" data-plain="">{withRefs(message.words, refs, drawing.cards?.openRef)}</p>
        : <div className="comms-bubble"><Suspense fallback={<p data-plain="">{message.words}</p>}><Prose text={message.words} refs={refs} openRef={drawing.cards?.openRef} /></Suspense></div>}
    {verdict && (message.words == null ? <p className="comms-bubble" data-plain="">{verdict}</p> : <p className="comms-delivery">{verdict}</p>)}
    {delivery && <p className="comms-delivery" data-state={message.delivery}>{delivery}</p>}
  </div>;
}

/** The messages as list items: a group per run of one sender's messages, a line per tool step, a line per notice. */
function Entries({ messages, refs, drawing }: { messages: readonly CommsMessage[]; refs: CommsDetail['refs']; drawing: Drawing }) {
  const groups: CommsMessage[][] = [];
  for (const message of messages) {
    const last = groups.at(-1), before = last?.at(-1);
    if (before && joins(before) && joins(message) && before.sender === message.sender && mine(before) === mine(message) && Date.parse(message.at) - Date.parse(before.at) < GROUP_GAP) last!.push(message);
    else groups.push([message]);
  }
  return <>{groups.map(group => {
    const first = group[0], who = first.sender === drawing.member ? 'You' : drawing.name(first.sender);
    const said = <span className="comms-sr">{who}, {fullTime(first.at, drawing.zone)}: </span>;
    if (first.kind === 'card') return <li key={first.seq} className="comms-step" data-state={first.cardState ?? 'running'}>
      {said}<span>{first.words ?? first.tool ?? 'Working'} · {stepWords[first.cardState ?? 'running']}</span></li>;
    if (first.kind === 'notice') return <li key={first.seq} className="comms-notice">{said}{first.words ?? 'Message words are unavailable'}</li>;
    return <li key={first.seq} className="comms-group" data-side={mine(first) ? 'me' : 'them'}>
      <p className="comms-group__who" aria-hidden="true"><span>{who}</span><time dateTime={first.at} title={fullTime(first.at, drawing.zone)}>{briefTime(first.at, drawing.zone)}</time></p>
      {group.map(message => <Words key={message.seq} message={message} who={who} drawing={drawing} refs={refs.filter(row => row.messageSeq === message.seq).map(row => row.ref)} />)}
    </li>;
  })}</>;
}

/** "Earlier messages": the page before `before`, drawn above what is shown, and above it the way to the page before
 * that. What the person is looking at stays where it is: its distance from the bottom is held while the page arrives. */
function Earlier({ before, navigation, scroller, draw, placed }: { before: number; navigation: MessageNavigation; scroller: RefObject<HTMLDivElement | null>; placed(ids: readonly string[]): void; draw(page: EarlierPage): ReactNode }) {
  const [open, setOpen] = useState(false);
  const hold = useRef<number | undefined>(undefined);
  if (!open || !navigation.page) return <li className="comms-earlier"><Button onClick={() => { const el = scroller.current; hold.current = el ? el.scrollHeight - el.scrollTop : undefined; setOpen(true); }}>Earlier messages</Button></li>;
  return navigation.page(before, page => <EarlierDrawn page={page} hold={hold} navigation={navigation} scroller={scroller} draw={draw} placed={placed} />);
}
function EarlierDrawn({ page, hold, navigation, scroller, draw, placed }: { page: EarlierPage; hold: RefObject<number | undefined>; navigation: MessageNavigation; scroller: RefObject<HTMLDivElement | null>; placed(ids: readonly string[]): void; draw(page: EarlierPage): ReactNode }) {
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el || hold.current === undefined) return;
    el.scrollTop = el.scrollHeight - hold.current;
    if (page.status === 'live') hold.current = undefined;
  });
  const asks = page.status === 'live' ? page.messages.flatMap(message => message.inboxItem ? [message.inboxItem] : []).join(' ') : '';
  useEffect(() => { if (asks) placed(asks.split(' ')); }, [asks]);
  if (page.status === 'loading') return <li className="comms-earlier"><Loading label="Loading earlier messages…" /></li>;
  if (page.status !== 'live') return <li className="comms-earlier"><p className="comms-quiet">Earlier messages are unavailable.</p></li>;
  return <>
    {page.hasEarlier && page.messages.length > 0 && <Earlier before={page.messages[0].seq} navigation={navigation} scroller={scroller} draw={draw} placed={placed} />}
    {draw(page)}
  </>;
}

function ThreadReader({ member, detail, actions, cards, navigation, readVisible = true, name, zone }: { member: string; readVisible?: boolean; detail: CommsDetail; actions?: CommsActions; cards?: Cards; navigation?: MessageNavigation; name(id: string): string; zone?: string }) {
  const thread = detail.thread!;
  const composer = useCommsDraft(member, thread.id, thread.member === member), draft = composer.value;
  const [busy, setBusy] = useState(false), [failed, setFailed] = useState<'send' | 'change'>();
  const [deleting, setDeleting] = useState(false);
  const [renaming, setRenaming] = useState(false), [title, setTitle] = useState(thread.title);
  const [waiting, setWaiting] = useState<readonly string[]>([]), [earlierAsks, setEarlierAsks] = useState<readonly string[]>([]);
  const lock = useRef(false), mounted = useRef(true);
  const scroller = useRef<HTMLDivElement | null>(null);
  const messages = detail.messages.filter(message => message.thread === thread.id).sort((a, b) => a.seq - b.seq);
  const follow = useReplyFollow(scroller, messages, true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const last = messages.at(-1)?.seq ?? 0;
  useEffect(() => { if (readVisible && follow.atLatest() && actions && last > thread.readSeq) void actions.read(thread.id, last).catch(() => { if (mounted.current) setFailed('change'); }); }, [thread.id, last, readVisible, follow.unread]);
  const run = async (action: () => Promise<void>, what: 'send' | 'change' = 'change') => {
    if (lock.current || !actions) return;
    lock.current = true; setBusy(true); setFailed(undefined);
    try { await action(); }
    catch { if (mounted.current) setFailed(what); }
    finally { lock.current = false; if (mounted.current) setBusy(false); }
  };
  const change = (value: ThreadChange) => void run(() => actions!.change(thread.id, value));
  const send = () => {
    if (!draft.text.trim() || lock.current || !actions) return;
    const sent = draft;
    return run(async () => {
      await actions.send(thread.id, sent.text, sent.id);
      composer.acknowledged(sent);
    }, 'send');
  };
  const note = useCallback<Note>((id, on) => setWaiting(ids => on === ids.includes(id) ? ids : on ? [...ids, id] : ids.filter(one => one !== id)), []);
  const placedEarlier = useCallback((ids: readonly string[]) => setEarlierAsks(old => ids.every(id => old.includes(id)) ? old : [...new Set([...old, ...ids])]), []);
  const drawing: Drawing = { member, name, zone, cards, note };
  const agent = name(thread.agent);
  const state = thread.working ? thread.stopRequested ? 'Stopping' : 'Working' : waiting.length ? 'Waiting on you' : undefined;
  const placed = [...new Set([...messages.flatMap(message => message.inboxItem ? [message.inboxItem] : []), ...earlierAsks])];
  const off = thread.venue === 'terminal' ? 'This conversation happens in a terminal. Reply there.'
    : thread.archivedAt ? actions ? 'This conversation is archived. Restore it from More to write here.' : 'This conversation is archived.'
      : !actions ? 'This is someone else’s conversation, so you can read it but not write in it.' : undefined;
  return <article className="comms" aria-label="Conversation">
    <Head leading={cards?.screen} actions={actions && <Actions>
      {thread.venue !== 'terminal' && thread.working && <Button disabled={busy || thread.stopRequested} onClick={() => change({ change: 'stop' })}>{thread.stopRequested ? 'Stopping…' : 'Stop'}</Button>}
      <Menu label="More" name="More for this conversation">{close => <>
        <Button disabled={busy} onClick={() => { close(); change({ change: 'pin', pinned: !thread.pinned }); }}>{thread.pinned ? 'Unpin' : 'Pin'}</Button>
        <Button disabled={busy} onClick={() => { close(); change({ change: 'archive', archived: !thread.archivedAt }); }}>{thread.archivedAt ? 'Restore' : 'Archive'}</Button>
        <Button disabled={busy} onClick={() => { close(false); setDeleting(false); setTitle(thread.title); setRenaming(true); }}>Rename</Button>
        <Button variant="danger-quiet" disabled={busy} onClick={() => { close(false); setRenaming(false); setDeleting(true); }}>Delete</Button>
      </>}</Menu>
    </Actions>}>
      <Title>{thread.title}</Title>
      <Meta>with {agent}{thread.project && <> <Chip>{thread.project}</Chip></>}{state && ` · ${state}`}</Meta>
    </Head>
    {renaming && <Actions className="comms__strip" label="Rename conversation">
      <Input autoFocus className="min-w-0 flex-1 basis-40" aria-label="Conversation title" value={title} maxLength={120} onChange={event => setTitle(event.target.value)} />
      <Button variant="primary" disabled={busy || !title.trim() || [...title.trim()].length > 60} onClick={() => void run(async () => { await actions!.change(thread.id, { change: 'rename', title: title.trim() }); if (mounted.current) setRenaming(false); })}>Save title</Button>
      <Button disabled={busy} onClick={() => setRenaming(false)}>Cancel</Button>
    </Actions>}
    {deleting && <section className="comms__strip" aria-label="Delete conversation"><p>Delete this thread and its private words?</p>
      <Actions><Button variant="danger-quiet" disabled={busy} onClick={() => change({ change: 'delete' })}>Delete thread</Button><Button autoFocus disabled={busy} onClick={() => setDeleting(false)}>Keep thread</Button></Actions></section>}
    {failed === 'change' && <Error text="Could not save. Try again." />}
    <div className="comms__body">
      <div className="comms__stream">
        <div ref={scroller} className="comms-msgs" data-comms-scroll="" tabIndex={0} role="group" aria-label="Messages in this conversation">
          <div className="comms-msgs__in">
            {navigation?.hasEarlier && messages.length > 0 && <ol className="comms-list" aria-label="Earlier messages">
              <Earlier before={messages[0].seq} navigation={navigation} scroller={scroller} placed={placedEarlier} draw={page => <Entries messages={page.messages} refs={page.refs} drawing={drawing} />} />
            </ol>}
            {/* A log: a new message is said politely, once. Earlier pages are above it and are not announced. */}
            <div role="log" aria-live="polite" aria-relevant="additions" aria-label="Messages"><ol className="comms-list"><Entries messages={messages} refs={detail.refs} drawing={drawing} /></ol></div>
          </div>
        </div>
        {follow.unread > 0 && <div className="comms__jump"><Button onClick={follow.down}>{follow.unread} new {follow.unread === 1 ? 'message' : 'messages'}</Button></div>}
      </div>
      {cards?.waiting && <div className="comms__waiting">{cards.waiting(thread.conversation, placed, note)}</div>}
      {cards?.work && <div className="comms__work">{cards.work(detail.refs, thread.conversation)}</div>}
      <div className="comms__compose">
        {off ? <ComposerOff>{off}</ComposerOff> : <MessageBar name={agent} value={draft.text} busy={busy} onChange={composer.edit} onSend={send}
          status={failed === 'send' ? 'Could not send. Your words are still here: try again.' : undefined} />}
      </div>
    </div>
  </article>;
}

function Opener({ agents, busy, open }: { agents: CommsSnapshot['agents']; busy: boolean; open(agent: string): void }) {
  if (!agents.length) return null;
  if (agents.length === 1) return <Button aria-label={`New conversation with ${agents[0].name}`} disabled={busy} onClick={() => open(agents[0].id)}>New</Button>;
  return <Menu label="New" name="New conversation" disabled={busy}>{close => agents.map(agent =>
    <Button key={agent.id} disabled={busy} onClick={() => { close(); open(agent.id); }}>Chat with {agent.name}</Button>)}</Menu>;
}

export function CommsView({ snapshot, detail, selected, select, actions, cards, navigation, messageNavigation, readVisible = true, zone }: {
  readVisible?: boolean;
  navigation?: Navigation; messageNavigation?: MessageNavigation;
  snapshot: CommsSnapshot; detail?: CommsDetail; selected?: string; select(id?: string): void; actions?: CommsActions; cards?: Cards;
  /** The zone times are said in (the household's); the device's own without one. */
  zone?: string;
}) {
  const [localArchived, setArchived] = useState(false), [localQuery, setQuery] = useState(''), [opening, setOpening] = useState(false), [failed, setFailed] = useState(false);
  const latest = useRef(snapshot); latest.current = snapshot;
  const openingRetry = useRef<{ agent: string; member: string; id: string } | undefined>(undefined);
  const openingLock = useRef(false), mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const archived = navigation?.archived ?? localArchived, query = navigation?.search ?? localQuery;
  const live = snapshot.status === 'live';
  /** An agent's name where what is loaded has one; its id otherwise. */
  const name = (id: string) => snapshot.agents.find(agent => agent.id === id)?.name ?? snapshot.names?.[id] ?? id;
  // An open thread whose own reading failed or was refused leaves the list too. One still loading keeps its row:
  // the row is what was clicked, and it holds the keyboard focus.
  const display = selected && detail && detail.status !== 'live' && detail.status !== 'loading' ? { ...snapshot, threads: snapshot.threads.filter(thread => thread.id !== selected) } : snapshot;
  // Rows kept from the last folder are drawn as that folder's until the chosen one answers.
  const drawn = snapshot.archived ?? archived;
  const shown = threadRows(display, drawn, navigation ? '' : query);
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
  const folders = ['Threads', 'Archived'].map((label, index) => ({ id: String(index), label, count: live && snapshot.folders ? index ? snapshot.folders.archived : snapshot.folders.threads : threadRows(display, !!index, '').length }));
  return <Split className="loom-comms" label="Comms" folders={folders} folder={archived ? '1' : '0'} onFolder={id => navigation ? navigation.folder(id === '1') : setArchived(id === '1')}
    listTitle={folders[drawn ? 1 : 0].label} listCount={live ? folders[drawn ? 1 : 0].count : undefined} listBusy={snapshot.settling} listKey={JSON.stringify([archived, navigation?.search, navigation?.offset])}
    listAction={live && actions && <Opener agents={snapshot.agents} busy={opening} open={agent => void open(agent)} />}
    search={<Search label="Search conversations" value={live ? query : ''} disabled={!live} onChange={value => navigation ? navigation.query(value) : setQuery(value)} />}
    listTop={<>{navigation && <Pager label="Conversation pages" disabled={!live} hasPrevious={navigation.offset > 0} hasNext={navigation.hasNext} previous={navigation.previous} next={navigation.next} />}
      {live && failed && <Error text="Could not start the conversation. Try again." />}</>}
    list={!live ? snapshot.status === 'loading' ? <Loading /> : <Empty title="Conversations are unavailable" /> : shown.length ? shown.map(thread => <Row key={thread.id} title={thread.title}
      icon={<span className="comms-letter" aria-hidden="true">{name(thread.agent).slice(0, 1).toUpperCase()}</span>} unread={thread.unread || undefined}
      meta={`${name(thread.agent)}${thread.project ? ` · ${thread.project}` : ''}`} status={thread.working ? 'Working' : thread.pinned ? 'Pinned' : undefined} selected={thread.id === selected} onClick={() => select(thread.id)} />) : <Empty title="No conversations here" />}
    reader={current ? <ThreadReader key={JSON.stringify([snapshot.member, current.thread!.id])} member={snapshot.member} detail={current} actions={current.thread!.member === snapshot.member ? actions : undefined} cards={cards} navigation={messageNavigation} readVisible={readVisible} name={name} zone={zone} /> : selected && live && detail?.status === 'loading' ? <Loading /> : null}
    open={!!selected} onBack={() => select(undefined)} backLabel="Back to conversations" blank={<Empty title="Choose a conversation" />} />;
}
