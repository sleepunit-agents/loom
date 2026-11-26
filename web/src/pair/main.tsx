import { useEffect, useRef, useState, type FormEvent } from 'react';
import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';
import { sha256 } from '@noble/hashes/sha2.js';
import { useDataQuery } from '../data/graphql';
import { memberOperation } from '../data/operation';
import { useSession } from '../signin/use-session';
import { newId } from '../data/id';
import { useDeadline } from '../pieces/comms/use-deadline';
import type { CommsMessage, CommsThread } from '../pieces/comms-view/model';
import { Button } from './ui/button';
import { Badge } from './ui/badge';
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from './ui/card';
import { ArrowUpIcon, XIcon, MessageSquareIcon, CircleAlertIcon } from 'lucide-react';
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
  InputGroupTextarea,
  InputGroupText,
} from './ui/input-group';
import { Item, ItemContent, ItemTitle, ItemDescription } from './ui/item';
import { Alert, AlertDescription } from './ui/alert';
import {
  MessageScrollerProvider,
  MessageScroller,
  MessageScrollerViewport,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerButton,
} from './ui/message-scroller';
import { Message, MessageContent, MessageHeader } from './ui/message';
import { Bubble, BubbleContent } from './ui/bubble';
import {
  Trace,
  TraceCollapsible,
  TraceCollapsibleContent,
  TraceCollapsibleTrigger,
  TraceLine,
  TraceTitle,
} from './ui/trace';
import { WorkTrace } from './work-trace';
import { workTree, type EventMessage } from './work-tree';
import { Reply } from './reply';
import { ContextSwitcher, type Place } from './context-switcher';
import './screen.css';

interface Ticket {
  id: string;
  title: string;
  project: string | null;
  status: string;
  goal: string;
  why: string;
  doneWhen: string;
  description: string;
  assignee: string | null;
  changeTasksByTask: {
    changeRow: {
      repository: string;
      number: number;
      title: string;
      url: string;
      state: string;
      checks: string;
    } | null;
  }[];
}
const subjectQuery =
  'query PairTicket($id:String!){ticket:tasksSingle(where:{id:{eq:$id}}){id title project status assignee goal why doneWhen description changeTasksByTask{changeRow{repository number title url state checks}}} agent:workDiscussionAgent(kind:"ticket",id:$id) homeComms{agents}}';
const fields =
  'clientId run seq kind sender at words wordsKeepUntil inboxItem tool cardState delivery verdict notice{error} stepInfo{parent exit limit t0 t1} stepDetails{detail body result items{text state}}';
const historyQuery =
  'query PairLog($id:String!,$before:Int){thread:commsThread(id:$id){id member agent project conversation working readSeq} rows:commsMessages(thread:$id,beforeSeq:$before,limit:50){' +
  fields +
  '}}';
const defaultId = 't-2384';
function TicketLinks({ words }: { words: string }) {
  if (/^ {0,3}(`{3,}|~{3,})/m.test(words)) return <Reply words={words} />;
  return (
    <>
      {words.split(/(\bt-\d+\b)/gi).map((v, i) =>
        /^t-\d+$/i.test(v) ? (
          <a className="underline" key={i} href={'?ticket=' + v.toLowerCase()}>
            {v}
          </a>
        ) : (
          v
        ),
      )}
    </>
  );
}

function RunDetails({ id }: { id: string }) {
  const read = useDataQuery<{
    jobUsage: {
      state: string;
      usage: { harness: string; model: string; tools: { name: string; count: number }[] | null } | null;
    } | null;
  }>('query PairRun($id:String!){jobUsage(id:$id){state usage{harness model tools{name count}}}}', { id });
  const run = read.data?.jobUsage;
  if (read.status !== 'live' || !run?.usage) return null;
  return (
    <Trace>
      <TraceCollapsible>
        <TraceCollapsibleTrigger>
          <TraceLine>
            <TraceTitle>Run details · {run.usage.harness}</TraceTitle>
          </TraceLine>
        </TraceCollapsibleTrigger>
        <TraceCollapsibleContent>
          <p>
            {run.usage.model} · {run.state}
          </p>
          {run.usage.tools?.map((t) => (
            <p key={t.name}>
              {t.name} × {t.count}
            </p>
          ))}
        </TraceCollapsibleContent>
      </TraceCollapsible>
    </Trace>
  );
}
function Entry({ m }: { m: EventMessage }) {
  const mine = m.kind === 'message' || m.kind === 'answer';
  return (
    <Message align={mine ? 'end' : 'start'}>
      <MessageContent>
        <MessageHeader>
          {mine ? 'You' : m.sender === 'art' ? 'Art' : m.sender} ·{' '}
          {new Date(m.at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}
        </MessageHeader>
        <Bubble variant={mine ? 'secondary' : 'ghost'} align={mine ? 'end' : 'start'}>
          <BubbleContent className="whitespace-pre-wrap break-words">
            {m.kind === 'reply' && m.words ? (
              <Reply words={m.words} />
            ) : (
              <TicketLinks
                words={
                  m.words?.replace(/^\[Ticket workspace · ([^\n]+)\]\n/, '$1\n') ||
                  m.notice?.error ||
                  m.verdict ||
                  'Content unavailable'
                }
              />
            )}
          </BubbleContent>
        </Bubble>
        {m.kind === 'reply' && m.run && <RunDetails id={m.run} />}
        {m.delivery === 'failed' && <small>Delivery failed</small>}
      </MessageContent>
    </Message>
  );
}
type ThreadTail = {
  last: number;
  read: number;
  working: boolean;
  conversation: string;
  tool: string | null;
  update: boolean;
  status: 'connecting' | 'live' | 'unavailable';
};
const emptyTail: ThreadTail = {
  last: 0,
  read: 0,
  working: false,
  conversation: '',
  tool: null,
  update: false,
  status: 'connecting',
};
function quickPresence({
  agent,
  error,
  ready,
  busy,
  quick,
  tail,
  question,
}: {
  agent: string | null;
  error: string;
  ready: boolean;
  busy: boolean;
  quick: boolean;
  tail: ThreadTail;
  question: boolean;
}) {
  if (!agent || tail.status === 'unavailable') return { mood: 'error', text: 'Conversation unavailable' };
  if (error) return { mood: 'error', text: ready ? 'Delivery unconfirmed' : 'Couldn’t connect' };
  if (!ready || tail.status === 'connecting') return { mood: 'thinking', text: 'Connecting…' };
  if (busy) return { mood: 'thinking', text: 'Sending your message…' };
  if (question) return { mood: 'waiting', text: 'Has a question for you' };
  if (tail.working) {
    const tool = tail.tool?.split(' → ').at(-1);
    const text = tool === 'Terminal' ? 'Working in the terminal' : tool ? 'Working · ' + tool : 'Working';
    return { mood: 'working', text };
  }
  if (tail.update) return { mood: 'talking', text: 'Has a reply for you' };
  return quick ? { mood: 'thinking', text: 'Listening' } : { mood: 'idle', text: 'Here with you' };
}
type Feed = { thread: CommsThread | null; rows: CommsMessage[] };
function TranscriptPage({
  id,
  before,
  visible,
  onTail,
}: {
  id: string;
  before?: number;
  visible: boolean;
  onTail?: (tail: ThreadTail) => void;
}) {
  const read = useDataQuery<Feed>(historyQuery, { id, before: before ?? null });
  const [older, showOlder] = useState(false),
    rows = read.data?.rows || [];
  const now = useDeadline(rows.map((m) => m.wordsKeepUntil));
  const latest = rows.at(-1);
  const last = latest?.seq || 0;
  const thread = read.data?.thread;
  const status =
    read.status === 'live' && thread ? 'live' : read.status === 'loading' ? 'connecting' : 'unavailable';
  const working = !!thread?.working,
    readSeq = thread?.readSeq || 0,
    conversation = thread?.conversation || '';
  const tool =
    working && latest?.kind === 'card' && latest.cardState === 'running' ? latest.tool || null : null;
  const update = rows.some((m) => m.seq > readSeq && m.kind === 'reply');
  useEffect(() => {
    if (status !== 'connecting')
      onTail?.({ last, read: readSeq, working, conversation, tool, update, status });
  }, [last, readSeq, working, conversation, tool, update, status, onTail]);
  if (read.status !== 'live' || !read.data?.thread)
    return visible ? (
      <p role="status">{read.status === 'loading' ? 'Opening conversation…' : 'Conversation unavailable.'}</p>
    ) : null;
  if (!visible) return null;
  const latestTerminal = rows.findLast(
    (m) => m.kind === 'card' && m.tool?.endsWith('Terminal') && m.cardState !== 'running',
  )?.seq;
  return (
    <>
      {rows.length === 50 &&
        (older ? (
          <TranscriptPage id={id} before={rows[0].seq} visible />
        ) : (
          <Button variant="ghost" onClick={() => showOlder(true)}>
            Earlier messages
          </Button>
        ))}
      {workTree(
        rows.map((m) =>
          Date.parse(m.wordsKeepUntil ?? '') > now ? m : { ...m, words: null, stepDetails: null },
        ),
      ).map((node) => (
        <MessageScrollerItem key={node.events[0].seq} messageId={String(node.events[0].seq)}>
          {node.events[0].kind === 'card' ? (
            <WorkTrace
              key={node.events[0].seq}
              node={node}
              latestTerminal={before ? undefined : latestTerminal}
            />
          ) : (
            <Entry key={node.events[0].seq} m={node.events[0]} />
          )}
        </MessageScrollerItem>
      ))}
      {!before && <span hidden data-tail-seq={last} />}
    </>
  );
}
function threadId(prefix: string, parts: (string | null)[]) {
  return (
    prefix +
    Array.from(sha256(new TextEncoder().encode(JSON.stringify(parts))), (n) =>
      n.toString(16).padStart(2, '0'),
    ).join('')
  );
}
type Draft = { words: string; command: string };
const emptyDraft: Draft = { words: '', command: '' };

function ContextCanvas({ place }: { place: Place }) {
  const feed = useDataQuery<Feed>(historyQuery, { id: place.thread, before: null });
  const rows = feed.data?.rows || [];
  const now = useDeadline(rows.map((m) => m.wordsKeepUntil));
  const recent = rows.findLast(
    (m) =>
      (m.kind === 'reply' || m.kind === 'message') && m.words && Date.parse(m.wordsKeepUntil || '') > now,
  );
  return (
    <div className="mx-auto max-w-2xl">
      {recent ? (
        <Card>
          <CardHeader>
            <CardDescription>{place.name}</CardDescription>
            <CardTitle>{recent.kind === 'reply' ? place.agent : 'You'}</CardTitle>
          </CardHeader>
          <CardContent>
            <Reply words={recent.words!} />
          </CardContent>
        </Card>
      ) : (
        <h1 className="pt-16 text-center text-sm text-muted-foreground">{place.name}</h1>
      )}
    </div>
  );
}
function Workspace({
  member,
  ticket,
  place,
  draft,
  edit,
}: {
  member: string;
  ticket: Ticket | null;
  place: Place;
  draft: Draft;
  edit: (update: (old: Draft) => Draft) => void;
}) {
  const { thread: id, agent } = place;
  const pref = 'pair:chat:' + member;
  const [open, setOpen] = useState(() => localStorage.getItem(pref) !== 'hidden'),
    [quick, setQuick] = useState(false),
    [ready, setReady] = useState(false),
    [retry, again] = useState(0);
  const { words, command } = draft;
  const [busy, sending] = useState(false),
    [error, fail] = useState('');
  const [tail, setTail] = useState<ThreadTail>(emptyTail);
  const composing = useRef(false),
    scroll = useRef<HTMLDivElement>(null),
    mark = useRef(0);
  const questions = useDataQuery<{ inboxItems: { answers: string | null }[] }>(
    'query PairNeeds($conversation:String!){inboxItems(conversation:$conversation,state:"waiting",folder:"needs",limit:50){id answers}}',
    { conversation: tail.conversation },
    { pause: !tail.conversation },
  );
  const name = agent === 'art' ? 'Art' : agent || 'Agent';
  const presence = quickPresence({
    agent,
    error,
    ready,
    busy,
    quick,
    tail,
    question: questions.status === 'live' && !!questions.data?.inboxItems.some((item) => item.answers),
  });
  const launcher = useRef<HTMLButtonElement>(null);
  const chatLauncher = useRef<HTMLButtonElement>(null);
  const chatInput = useRef<HTMLTextAreaElement>(null);
  const chatActivity = tail.working ? 'Working' : tail.last > tail.read ? 'New activity' : '';
  useEffect(() => {
    let live = true;
    if (place.id.startsWith('th:ctx-')) {
      setReady(true);
      return;
    }
    if (agent)
      memberOperation(
        'comms.open',
        {
          thread: id,
          agent,
          ...(ticket?.project ? { project: ticket.project } : {}),
          title: ticket ? 'Pairing · ' + (ticket.project || member) : 'Workspace',
        },
        id.slice(3),
      )
        .then(() => {
          if (live) setReady(true);
        })
        .catch(() => {
          if (live) fail('Could not open conversation.');
        });
    return () => {
      live = false;
    };
  }, [id, agent, retry, ticket?.project, member, place.id]);
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        if (document.activeElement?.closest('#quick-message')) closeQuick();
        else setQuick((v) => !v);
      }
      if (e.key === 'Escape' && document.activeElement?.closest('#quick-message')) closeQuick();
      else if (e.key === 'Escape') setQuick(false);
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, []);
  useEffect(() => {
    if (!open || !tail.last) return;
    const el = scroll.current;
    if (!el) return;
    const seen = () => {
      if (
        document.visibilityState !== 'visible' ||
        !document.hasFocus() ||
        !el.querySelector(`[data-tail-seq="${tail.last}"]`) ||
        !el.clientHeight ||
        el.scrollHeight - el.scrollTop - el.clientHeight > 8 ||
        tail.last <= Math.max(mark.current, tail.read)
      )
        return;
      mark.current = tail.last;
      void memberOperation('comms.change', { thread: id, change: 'read', seq: tail.last }).catch(() => {
        mark.current = 0;
      });
    };
    const observer = new ResizeObserver(seen);
    observer.observe(el);
    if (el.firstElementChild) observer.observe(el.firstElementChild);
    seen();
    window.addEventListener('focus', seen);
    document.addEventListener('visibilitychange', seen);
    el?.addEventListener('scroll', seen);
    return () => {
      window.removeEventListener('focus', seen);
      document.removeEventListener('visibilitychange', seen);
      el.removeEventListener('scroll', seen);
      observer.disconnect();
    };
  }, [open, tail.last, tail.read, id]);
  function closeQuick() {
    setQuick(false);
    launcher.current?.focus();
  }
  function showChat(visible: boolean) {
    localStorage.setItem(pref, visible ? 'open' : 'hidden');
    // Commit the panel's inert state before transferring keyboard focus.
    flushSync(() => setOpen(visible));
    (visible ? chatInput.current : chatLauncher.current)?.focus({ preventScroll: true });
  }
  async function send(e: FormEvent, bar: boolean) {
    e.preventDefault();
    const form = e.currentTarget;
    const value = (bar ? command : words).trim();
    if (composing.current || !value || !ready) return;
    composing.current = true;
    sending(true);
    fail('');
    const message = ticket ? '[Ticket workspace · ' + ticket.id + ']\n' + value : value;
    const receipt = 'pair-send:' + id + ':' + Array.from(sha256(new TextEncoder().encode(message))).join('.');
    try {
      const clientId = sessionStorage.getItem(receipt) || newId();
      sessionStorage.setItem(receipt, clientId);
      await memberOperation('comms.send', { thread: id, clientId, words: message }, clientId);
      sessionStorage.removeItem(receipt);
      if (bar) {
        edit((current) => (current.command.trim() === value ? { ...current, command: '' } : current));
        if (form.isConnected) {
          setQuick(false);
          showChat(true);
        }
      } else edit((current) => (current.words.trim() === value ? { ...current, words: '' } : current));
    } catch {
      fail('Delivery unconfirmed. Send the same message to retry.');
    } finally {
      composing.current = false;
      sending(false);
    }
  }
  return (
    <main className="pair-workspace flex h-dvh overflow-hidden">
      <section className="relative flex min-w-0 flex-1 flex-col">
        <div className="min-h-0 flex-1 overflow-auto px-4 pt-10 pb-4 sm:px-8 sm:pb-8">
          {ticket ? (
            <Card className="mx-auto max-w-2xl">
              <CardHeader>
                <CardDescription>
                  {ticket.project} · {ticket.id}
                </CardDescription>
                <CardTitle>{ticket.title}</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <Badge variant="secondary">{ticket.status.replaceAll('_', ' ')}</Badge>
                {ticket.assignee && <p>Assigned to {ticket.assignee}</p>}
                {Object.entries({
                  Goal: ticket.goal,
                  Why: ticket.why,
                  'Done when': ticket.doneWhen,
                  Description: ticket.description,
                }).map(
                  ([k, v]) =>
                    v && (
                      <section key={k}>
                        <h2 className="font-medium">{k}</h2>
                        <div className="whitespace-pre-wrap text-sm">
                          <TicketLinks words={v} />
                        </div>
                      </section>
                    ),
                )}
                {ticket.changeTasksByTask.map(
                  ({ changeRow: p }) =>
                    p && (
                      <Item key={p.url} asChild variant="outline" size="sm">
                        <a href={p.url} target="_blank" rel="noreferrer">
                          <ItemContent>
                            <ItemTitle>
                              {p.repository} #{p.number} · {p.title}
                            </ItemTitle>
                            <ItemDescription>
                              {p.state} · Checks {p.checks}
                            </ItemDescription>
                          </ItemContent>
                        </a>
                      </Item>
                    ),
                )}
              </CardContent>
            </Card>
          ) : (
            <ContextCanvas place={place} />
          )}
        </div>
        <div
          className={'mx-auto max-w-full p-2 sm:p-3 ' + (quick ? '@container z-20 w-full sm:max-w-lg' : '')}
        >
          <Item
            variant="outline"
            className={
              'relative grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-2 gap-y-0 rounded-3xl bg-card p-2 text-card-foreground pair-dock ' +
              (quick ? '@min-[25rem]:grid-cols-[auto_minmax(0,1fr)_auto]' : '')
            }
          >
            <div className="flex min-w-0 items-center gap-3 pr-1 @min-[25rem]:max-w-48">
              {agent === 'art' && (
                <span className="flex size-11 shrink-0 items-center justify-center overflow-hidden rounded-2xl bg-muted sm:size-16">
                  <span
                    aria-hidden="true"
                    className="art-portrait shrink-0 scale-125"
                    data-mood={presence.mood}
                  />
                </span>
              )}
              <div className="min-w-0 flex-1">
                <div className="font-semibold leading-tight">{name}</div>
                <div
                  id="quick-presence"
                  role="status"
                  className="mt-1 wrap-anywhere text-xs leading-snug text-muted-foreground"
                >
                  {presence.text}
                </div>
              </div>
            </div>
            <Button
              ref={launcher}
              type="button"
              variant={quick ? 'ghost' : 'secondary'}
              size="icon-sm"
              title={quick ? 'Close quick bar' : `Talk to ${name}`}
              aria-label={quick ? 'Close quick bar' : `Talk to ${name}`}
              aria-describedby="quick-presence"
              aria-expanded={quick}
              className={
                'col-start-2 row-start-1 mr-1 rounded-full focus-visible:bg-foreground focus-visible:text-background focus-visible:ring-0 ' +
                (quick ? '@min-[25rem]:col-start-3' : 'after:absolute after:inset-0 after:rounded-3xl')
              }
              onClick={() => setQuick((v) => !v)}
            >
              {quick ? <XIcon /> : <MessageSquareIcon />}
            </Button>
            {quick ? (
              <form
                id="quick-message"
                className="col-span-full mt-2 min-w-0 @min-[25rem]:col-span-1 @min-[25rem]:col-start-2 @min-[25rem]:row-start-1 @min-[25rem]:mt-0"
                onSubmit={(e) => void send(e, true)}
              >
                <InputGroup className="rounded-2xl bg-background has-[[data-slot=input-group-control]:focus-visible]:border-input has-[[data-slot=input-group-control]:focus-visible]:ring-0">
                  <InputGroupInput
                    autoFocus
                    aria-label="Quick message"
                    placeholder={`Ask ${name}…`}
                    value={command}
                    onChange={(e) => {
                      const command = e.target.value;
                      edit((old) => ({ ...old, command }));
                    }}
                  />
                  <InputGroupAddon align="inline-end">
                    <InputGroupButton
                      type="submit"
                      variant="default"
                      size="icon-sm"
                      aria-label="Send quick message"
                      className="focus-visible:bg-secondary focus-visible:text-secondary-foreground focus-visible:ring-0"
                      disabled={busy || !ready || !command.trim()}
                    >
                      <ArrowUpIcon />
                    </InputGroupButton>
                  </InputGroupAddon>
                </InputGroup>
              </form>
            ) : null}
          </Item>
        </div>
      </section>
      {!open && (
        <Button
          ref={chatLauncher}
          variant="ghost"
          size="icon-sm"
          aria-expanded={open}
          aria-label={chatActivity ? 'Open conversation · ' + chatActivity : 'Open conversation'}
          title={chatActivity ? 'Open conversation · ' + chatActivity : 'Open conversation'}
          aria-controls="pair-conversation"
          onClick={() => showChat(true)}
          className="fixed top-2 right-2 z-10 rounded-full text-muted-foreground hover:text-foreground"
        >
          <MessageSquareIcon />
          {chatActivity && (
            <span aria-hidden="true" className="absolute top-1 right-1 size-1.5 rounded-full bg-primary" />
          )}
        </Button>
      )}
      <aside
        id="pair-conversation"
        aria-label="Conversation"
        aria-hidden={!open}
        inert={!open}
        className={
          // Slide the dock while keeping the transcript at its final reading width.
          'fixed inset-y-0 right-0 z-10 flex shrink-0 flex-col overflow-hidden bg-background ' +
          '[--chat-width:min(90vw,32rem)] sm:static sm:[--chat-width:min(44vw,36rem)] ' +
          '*:w-[calc(var(--chat-width)-1px)] transition-[width] motion-reduce:transition-none ' +
          (open ? 'w-(--chat-width) border-l' : 'w-0')
        }
      >
        <header className="flex items-center justify-between border-b p-4">
          <h2 className="font-semibold">You and {agent === 'art' ? 'Art' : agent || 'Art'}</h2>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Hide conversation"
            onClick={() => showChat(false)}
          >
            <XIcon />
          </Button>
        </header>
        <MessageScrollerProvider key={open ? 'open' : 'hidden'} defaultScrollPosition="end" autoScroll>
          <MessageScroller>
            <MessageScrollerViewport ref={scroll} preserveScrollOnPrepend aria-label="Conversation history">
              <MessageScrollerContent className="p-4">
                {ready && <TranscriptPage id={id} visible={open} onTail={setTail} />}
              </MessageScrollerContent>
            </MessageScrollerViewport>
            <MessageScrollerButton />
          </MessageScroller>
        </MessageScrollerProvider>
        <form onSubmit={(e) => void send(e, false)} className="p-3">
          <InputGroup>
            <InputGroupTextarea
              ref={chatInput}
              aria-label="Message Art"
              placeholder="Message Art…"
              value={words}
              onChange={(e) => {
                const words = e.target.value;
                edit((old) => ({ ...old, words }));
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  e.currentTarget.form?.requestSubmit();
                }
              }}
            />
            <InputGroupAddon align="block-end">
              {tail.working && <InputGroupText role="status">Working…</InputGroupText>}
              <InputGroupButton
                className="ms-auto"
                type="submit"
                variant="default"
                size="icon-sm"
                aria-label="Send"
                disabled={busy || !ready || !words.trim()}
              >
                <ArrowUpIcon />
              </InputGroupButton>
            </InputGroupAddon>
          </InputGroup>
        </form>
      </aside>
      {(error || !agent) && (
        <Alert variant="destructive" className="fixed top-2 left-2 z-30 max-w-sm">
          <CircleAlertIcon />
          <AlertDescription>
            {error || 'No agent available for this ticket.'}
            {!ready && agent && (
              <Button
                onClick={() => {
                  fail('');
                  again((v) => v + 1);
                }}
              >
                Retry
              </Button>
            )}
          </AlertDescription>
        </Alert>
      )}
    </main>
  );
}
function TicketScreen({ member }: { member: string }) {
  const id = new URL(location.href).searchParams.get('ticket') || defaultId;
  const read = useDataQuery<{
    ticket: Ticket | null;
    agent: string | null;
    homeComms: { agents: string[] } | null;
  }>(subjectQuery, { id });
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  if (read.status !== 'live' || !read.data?.ticket)
    return <p role="status">{read.status === 'loading' ? 'Opening ticket…' : 'Ticket unavailable.'}</p>;
  const { ticket, agent } = read.data;
  const ticketPlace = {
    id: 'loom',
    name: ticket.project || 'Loom',
    agent,
    detail: ticket.id + ' · ' + ticket.title,
    thread: threadId('th:pair-', [member, agent, ticket.project]),
  };
  const homeAgent = read.data.homeComms?.agents[0] || agent;
  const home = {
    id: 'home',
    name: 'Home',
    agent: homeAgent,
    detail: 'Conversation',
    thread: threadId('th:home-', [member, homeAgent]),
  };
  return (
    <ContextSwitcher member={member} ticket={ticketPlace} home={home}>
      {(place) => (
        <Workspace
          key={place.thread}
          member={member}
          place={place}
          ticket={place.id === 'loom' ? ticket : null}
          draft={drafts[place.thread] || emptyDraft}
          edit={(update) =>
            setDrafts((old) => ({ ...old, [place.thread]: update(old[place.thread] || emptyDraft) }))
          }
        />
      )}
    </ContextSwitcher>
  );
}
function App() {
  const { session, login, message } = useSession();
  return session?.viewer ? (
    <TicketScreen member={session.viewer.id} />
  ) : (
    <main className="p-6">
      {session ? (
        <Button onClick={() => void login()}>Sign in with a passkey</Button>
      ) : (
        <p>Connecting to Loom…</p>
      )}
      {message && <p role="status">{message}</p>}
    </main>
  );
}
createRoot(document.getElementById('root')!).render(<App />);
