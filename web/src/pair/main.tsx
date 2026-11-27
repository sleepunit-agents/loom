import { WorkspaceIndex } from './workspace-index';
import { LibraryIcon } from 'lucide-react';
import { ViewPreview, TicketReference } from './entity-preview';
import { useEffect, useLayoutEffect, useRef, useState, type FormEvent } from 'react';
import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';
import { sha256 } from '@noble/hashes/sha2.js';
import { useDataQuery } from '../data/graphql';
import { memberOperation } from '../data/operation';
import { useSession } from '../signin/use-session';
import { newId } from '../data/id';
import { useDeadline } from '../pieces/comms/use-deadline';
import type { CommsMessage, CommsThread } from '../pieces/comms-view/model';
import { Portrait } from '../contexts/portrait';
import type { FaceState } from '../face';
import type { IdleTiming } from '../contexts/portrait-player';
import { Button } from './ui/button';
import { projectQuery, ProjectCanvas, type ProjectOverview, entityQueries, EntityCanvas, type EntityData } from './project-entities';
import { detailsQuery, ticketView, TicketCanvas, viewKey, viewLabel, type Ticket, type View, type SecondaryState } from './ticket-view';
import { useViewRing } from './view-ring';
import { ModuleCard } from './module-card';
import { Attachment, AttachmentAction, AttachmentActions, AttachmentContent, AttachmentGroup, AttachmentTitle, AttachmentMedia } from "./ui/attachment";
import { PaperclipIcon, ArrowUpIcon, XIcon, CircleAlertIcon } from 'lucide-react';
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupTextarea,
  InputGroupText,
} from './ui/input-group';
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
import { conversationText } from './conversation-text';
import { QuickBar } from './quick-bar';
import { ContextSwitcher, type Place } from './context-switcher';
import './screen.css';

type RootTicket = Pick<Ticket,'id' | 'title' | 'project'>;
const subjectQuery =
  'query PairTicket($id:String!){ticket:tasksSingle(where:{id:{eq:$id}}){id title project} agent:workDiscussionAgent(kind:"ticket",id:$id) homeComms{agents}}';
// This existing trial predates explicit view subjects. Its agreed starting view is the split parent.
const initialSubjects: Record<string,string> = { 'th:ctx-b7ac31a9-6b61-49aa-b730-91e1af5cadaa': 't-2424' };
const fields =
  'hasFiles clientId run seq kind sender at words wordsKeepUntil inboxItem tool cardState delivery verdict notice{error} stepInfo{parent exit limit t0 t1} stepDetails{detail body result items{text state}}';
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
          <TicketReference className="underline" key={i} id={v.toLowerCase()}>
            {v}
          </TicketReference>
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
    <Trace className="pair-run-details">
      <TraceCollapsible>
        <TraceCollapsibleTrigger>
          <TraceLine>
            <TraceTitle>Run details</TraceTitle>
          </TraceLine>
        </TraceCollapsibleTrigger>
        <TraceCollapsibleContent>
          <p>
            {run.usage.harness} · {run.usage.model} · {run.state}
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
  let words = m.words;
  let attachments: string[] = [];
  const marker = m.hasFiles && m.kind === 'message' && words?.match(/(?:^|\n)Attached files: (\[[^\n]*\])$/);
  if (marker && words) {
    try {
      const names: unknown = JSON.parse(marker[1]);
      if (Array.isArray(names) && names.length && names.every(name => typeof name === 'string')) {
        attachments = names;
        words = words.slice(0,marker.index);
      }
    } catch { /* Keep ordinary prose containing the same label. */ }
  }
  if (words) words = conversationText(m.kind, words);
  return (
    <Message align={mine ? 'end' : 'start'}>
      <MessageContent>
        <MessageHeader>
          {mine ? 'You' : m.sender === 'art' ? 'Art' : m.sender} ·{' '}
          {new Date(m.at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}
        </MessageHeader>
        <Bubble variant={mine ? 'secondary' : 'ghost'} align={mine ? 'end' : 'start'}>
          <BubbleContent className="whitespace-pre-wrap break-words">
            {m.kind === 'reply' && words ? (
              <Reply words={words} />
            ) : (
              <TicketLinks
                words={
                  words ||
                  m.notice?.error ||
                  m.verdict ||
                  (attachments.length ? '' : 'Content unavailable')
                }
              />
            )}
            {attachments.length > 0 && <AttachmentGroup aria-label="Sent attachments">
              {attachments.map((name,index) => <Attachment key={index} size="xs">
                <AttachmentMedia><PaperclipIcon /></AttachmentMedia>
                <AttachmentContent><AttachmentTitle title={name}>{name}</AttachmentTitle></AttachmentContent>
              </Attachment>)}
            </AttachmentGroup>}
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
}): { mood: FaceState; text: string } {
  if (!agent || tail.status === 'unavailable') return { mood: 'error', text: 'Conversation unavailable' };
  if (error) return { mood: 'error', text: ready ? error : 'Couldn’t connect' };
  if (!ready || tail.status === 'connecting') return { mood: 'thinking', text: 'Connecting…' };
  if (busy) return { mood: 'thinking', text: 'Sending your message…' };
  if (question) return { mood: 'needs-input', text: 'Has a question for you' };
  if (tail.working) {
    const tool = tail.tool?.split(' → ').at(-1);
    const text = tool === 'Terminal' ? 'Working in the terminal' : tool ? 'Working · ' + tool : 'Working';
    return { mood: 'working', text };
  }
  if (tail.update) return { mood: 'talking', text: 'Has a reply for you' };
  return quick ? { mood: 'thinking', text: 'Listening' } : { mood: 'idle', text: '' };
}
const idleLines = ['I’m around.', 'Here when you need me.', 'What’ve we got?'];
const idleTiming: IdleTiming = { gap: [3500, 9000] };

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
  const initialTail = useRef<number | null>(null);
  useEffect(() => {
    if (visible && read.status === 'live' && initialTail.current === null) initialTail.current = last;
  }, [visible, read.status, last]);
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
        <MessageScrollerItem key={node.events[0].seq} messageId={String(node.events[0].seq)} data-arrived={initialTail.current !== null && node.events[0].seq > initialTail.current || undefined}>
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
type Draft = { words: string; command: string; files: File[] };
const emptyDraft: Draft = { words: '', command: '', files: [] };

function ContextCanvas({ place }: { place: Place }) {
  const feed = useDataQuery<Feed>(historyQuery, { id: place.thread, before: null });
  const rows = feed.data?.rows || [];
  const now = useDeadline(rows.map((m) => m.wordsKeepUntil));
  const refs = new Set<string>();
  for (const row of [...rows].reverse()) {
    if (['message','reply'].includes(row.kind) && Date.parse(row.wordsKeepUntil || '') > now)
      for (const match of (row.words || '').matchAll(/\bt-\d+\b/gi)) refs.add(match[0].toLowerCase());
  }
  return <ModuleCard title={place.name} description={refs.size ? 'Tickets mentioned in this conversation' : 'Open a ticket from chat to start a view.'}>
    {refs.size > 0 && <ul className="flex flex-wrap gap-3">{[...refs].map(id=><li key={id}><TicketReference className="pair-id" id={id}>{id}</TicketReference></li>)}</ul>}
  </ModuleCard>;
}
function Workspace({
  member,
  ticket,
  place,
  draft,
  namingContext,
  edit,
}: {
  member: string;
  ticket: RootTicket | null;
  place: Place;
  draft: Draft;
  namingContext: boolean;
  edit: (update: (old: Draft) => Draft) => void;
}) {
  const { thread: id, agent } = place;
  const root = ticket?.id || initialSubjects[place.id];
  const ring = useViewRing(JSON.stringify(['pair-views',member,id]),root);
  const active = ring.active;
  const directory=active?.kind==='index' || active?.kind==='profile' ? active : null;
  const peopleSearch=useRef('');
  const directoryPages=useRef(new Map<string,number>());
  const projectId = active?.kind === 'project' ? active.project : '';
  const ticketId = active?.kind === 'ticket' || active?.kind === 'comment' ? active.ticket : '';
  const entity = active && (active.kind === 'pull' || active.kind === 'repository' || active.kind === 'agent' || active.kind === 'member') ? active : null;
  const other = useDataQuery<EntityData>(entityQueries[entity?.kind || 'pull'],
    entity?.kind === 'repository' ? {id:entity.project,repo:entity.ref.replace(/^github:/,'')} :
    entity && 'project' in entity ? {id:entity.project,ref:entity.ref} : {ref:entity?.ref || ''},{pause:!entity});
  const details = useDataQuery<{ticket: Ticket | null}>(detailsQuery,{id:ticketId},{pause:!ticketId});
  const project = useDataQuery<ProjectOverview>(projectQuery,{id:projectId},{pause:!projectId});
  const viewStatus = directory ? 'live' : entity ? other.status : projectId ? project.status : details.status;
  const secondaryState = useRef(new Map<string, SecondaryState>());
  const viewNav = useRef<HTMLElement>(null);
  const canvasScroll = useRef<HTMLDivElement>(null);
  const positions = useRef(new Map<string,number>());
  const activeKey = active ? viewKey(active) : '';
  const focusView = useRef(false);
  useLayoutEffect(() => {
    const nav = viewNav.current;
    const selected = nav?.querySelector<HTMLElement>('[aria-current="page"]');
    if (!nav || !selected) return;
    const reveal = () => {
      const bounds = nav.getBoundingClientRect();
      const item = selected.getBoundingClientRect();
      if (item.left < bounds.left) nav.scrollLeft += item.left - bounds.left;
      else if (item.right > bounds.right) nav.scrollLeft += item.right - bounds.right;
    };
    reveal();
    const resize = new ResizeObserver(reveal);
    resize.observe(nav);
    return () => resize.disconnect();
  }, [activeKey, ring.views.length]);
  function workOn(view: View) {
    focusView.current = viewKey(view) !== activeKey;
    ring.work(view);
  }
  useLayoutEffect(() => {
    if (!canvasScroll.current) return;
    if (viewStatus !== 'live') return;
    canvasScroll.current.scrollTop = positions.current.get(activeKey) || 0;
    if (focusView.current) {
      canvasScroll.current.querySelector<HTMLElement>('h1')?.focus({preventScroll:true});
      focusView.current = false;
    }
  },[activeKey,viewStatus]);
  const pref = 'pair:chat:' + member;
  const [open, setOpen] = useState(() => localStorage.getItem(pref) !== 'hidden'),
    [quick, setQuick] = useState(false),
    [ready, setReady] = useState(false),
    [retry, again] = useState(0);
  const { words, command, files } = draft;
  const picker = useRef<HTMLInputElement>(null);
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
  const [idleLine, setIdleLine] = useState(() => Math.floor(Math.random() * idleLines.length));
  useEffect(() => {
    if (presence.mood === 'idle') setIdleLine(i => (i + 1) % idleLines.length);
  }, [presence.mood]);
  const statusText = presence.mood === 'idle' ? idleLines[idleLine] : presence.text;
  const quickOrigin = useRef<HTMLElement | null>(null);
  const chatLauncher = useRef<HTMLButtonElement>(null);
  const chatInput = useRef<HTMLTextAreaElement>(null);
  const chatBody = useRef<HTMLDivElement>(null);
  const [closingChat, setClosingChat] = useState(false);
  const [historyVisit, setHistoryVisit] = useState(0);
  useEffect(() => {
    if (namingContext) setQuick(false);
  }, [namingContext]);
  useEffect(() => {
    if (!closingChat) return;
    let current = true;
    const transitions = chatBody.current?.getAnimations() ?? [];
    Promise.allSettled(transitions.map(animation => animation.finished)).then(() => {
      if (current) setClosingChat(false);
    });
    return () => { current = false; };
  }, [closingChat]);
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
      if (!e.defaultPrevented && !namingContext && !quick && (e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        quickOrigin.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
        setQuick(true);
      }
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [quick, namingContext]);
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
    const target = quickOrigin.current;
    (target?.isConnected && target !== document.body ? target : chatLauncher.current)?.focus({
      preventScroll: true,
    });
  }
  function showChat(visible: boolean) {
    localStorage.setItem(pref, visible ? 'open' : 'hidden');
    // Commit the panel's inert state before transferring keyboard focus.
    flushSync(() => {
      if (visible && !open) setHistoryVisit(visit => visit + 1);
      setClosingChat(!visible);
      setOpen(visible);
    });
    (visible ? chatInput.current : chatLauncher.current)?.focus({ preventScroll: true });
  }
  async function send(e: FormEvent, bar: boolean) {
    e.preventDefault();
    const form = e.currentTarget;
    const value = (bar ? command : words).trim();
    if (composing.current || (!value && (bar || !files.length)) || !ready) return;
    composing.current = true;
    sending(true);
    fail('');
    const subject = active && (active.kind === 'project' ? active.project : active.kind === 'ticket' ? active.ticket : active.kind === 'pull' ? active.ref : 'project' in active ? active.kind + ' ' + active.ref + ' in ' + active.project : viewLabel(active));
    const contextLabel = projectId ? 'Project workspace' : entity || directory ? 'Entity workspace' : 'Ticket workspace';
    const message = subject ? '['+contextLabel+' · '+subject+']\n'+value : value;
    try {
      const payload = bar || !files.length ? {} : {files: await Promise.all(files.map(async file => {
        const contents = await new Promise<string>((resolve,reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(String(reader.result).split(',')[1]);
          reader.onerror = () => reject(reader.error);
          reader.readAsDataURL(file);
        });
        return {name:file.name, contents};
      }))};
      const receipt = 'pair-send:' + id + ':' + Array.from(sha256(new TextEncoder().encode('files' in payload ? JSON.stringify([message,payload]) : message))).join('.');
      const clientId = sessionStorage.getItem(receipt) || newId();
      sessionStorage.setItem(receipt, clientId);
      await memberOperation('comms.send', { thread: id, clientId, words: message, ...payload }, clientId);
      sessionStorage.removeItem(receipt);
      if (bar) {
        edit((current) => (current.command.trim() === value ? { ...current, command: '' } : current));
        if (form.isConnected) {
          setQuick(false);
          showChat(true);
        }
      } else edit((current) => ({...current, words:current.words.trim() === value ? '' : current.words, files:current.files.filter(file => !files.includes(file))}));
    } catch {
      fail('Delivery unconfirmed. Send the same message to retry.');
    } finally {
      composing.current = false;
      sending(false);
    }
  }
  return (
    <main className="pair-workspace flex h-dvh overflow-hidden" onClick={e=>{
      const link = e.target instanceof Element && e.target.closest('a');
      const match = link && /^\?ticket=(t-\d+)$/i.exec(link.getAttribute('href') || '');
      if (match && !e.defaultPrevented && !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey) {
        e.preventDefault();
        if (open && link.closest('.pair-chat') && matchMedia('(max-width: 639px)').matches) showChat(false);
        workOn(ticketView(match[1].toLowerCase()));
      }
    }}>
      <section className="pair-canvas relative flex min-w-0 flex-1 flex-col">
          <nav aria-label="Open views" ref={viewNav} className="pair-view-ring flex items-center gap-1">
            <Button size="sm" variant="ghost" title="Browse across projects" onClick={()=>workOn({kind:'index',ref:'projects'})}><LibraryIcon/>Browse</Button>
            {(ring.views.length > 1 || (active && !root)) && ring.views.map(v=><ViewPreview key={viewKey(v)} view={v} intent="Show this open view."><Button size="sm" variant={viewKey(v)===activeKey ? 'secondary' : 'ghost'}
              aria-current={viewKey(v)===activeKey ? 'page' : undefined} onClick={()=>workOn(v)}>{viewLabel(v)}</Button></ViewPreview>)}
            {active && !(active.kind === 'ticket' && active.intent === 'work' && active.ticket === root) && <Button size="icon-xs" variant="ghost"
              aria-label="Close current view" onClick={ring.close}><XIcon/></Button>}
          </nav>
        <div ref={canvasScroll} className="pair-canvas-scroll" onScroll={e=>{if(viewStatus === 'live') positions.current.set(activeKey,e.currentTarget.scrollTop);}}>
          <div className="pair-zones" key={activeKey}>
            {directory ? <WorkspaceIndex view={directory} work={workOn} pages={directoryPages.current} peopleSearch={peopleSearch}/> : entity ? other.status === 'live' && other.data ?
              <EntityCanvas view={entity} data={other.data} work={workOn} memory={secondaryState.current}/> :
              <p role="status">{other.status==='loading' ? 'Opening view…' : 'Record unavailable.'}</p> :
              active?.kind === 'project' ? project.data?.project?.id === projectId && project.status === 'live' ?
              <ProjectCanvas data={project.data} work={workOn} memory={secondaryState.current}/> :
              <p role="status">{project.status === 'loading' ? 'Opening project…' : 'Project unavailable.'}</p> :
              active ? details.data?.ticket?.id === ticketId && details.status==='live' ?
              <TicketCanvas projectOpen={ring.views.some(v=>v.kind === 'project' && v.project === details.data?.ticket?.project)} ticket={details.data.ticket} view={active} work={workOn} memory={secondaryState.current}/> :
              <p role="status">{details.status === 'loading' ? 'Opening view…' : 'Ticket unavailable.'}</p>
              : <ContextCanvas place={place}/>}
          </div>
        </div>
      </section>
      <div aria-hidden="true" className="pair-chat-space" data-open={open} />
      <aside
        id="pair-conversation"
        role={open ? 'complementary' : 'presentation'}
        aria-label={open ? 'Conversation' : undefined}
        data-open={open}
        className="pair-chat rounded-xl"
      >
        <header className="shrink-0">
          <button
            ref={chatLauncher}
            type="button"
            className="pair-presence"
            aria-label={
              open
                ? 'Hide conversation'
                : chatActivity
                  ? 'Open conversation · ' + chatActivity
                  : 'Open conversation'
            }
            aria-describedby="pair-presence-status"
            aria-expanded={open}
            aria-controls="pair-chat-body"
            onClick={() => showChat(!open)}
          >
            {agent === 'art' && (
              <span className="pair-face rounded-lg bg-muted/40" aria-hidden="true">
                <svg className="pair-contour" aria-hidden="true">
                  <rect />
                  <rect className="pair-contour-highlight" pathLength="100" />
                </svg>
                <Portrait className="art-portrait shrink-0" state={presence.mood} idleTiming={idleTiming} />
              </span>
            )}
            <span className="min-w-0 flex-1 text-left">
              <span className="block text-sm font-semibold">{name}</span>
              <span
                id="pair-presence-status"
                role="status"
                className="block truncate text-xs text-muted-foreground"
                title={statusText}
              >
                {statusText}
              </span>
            </span>
            {open && <XIcon aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />}
            {!open && chatActivity && (
              <span aria-hidden="true" className="size-1.5 shrink-0 rounded-full bg-primary" />
            )}
          </button>
        </header>
        <div ref={chatBody} id="pair-chat-body" aria-hidden={!open} inert={!open} className="pair-chat-body">
          <MessageScrollerProvider key={historyVisit} defaultScrollPosition="end" autoScroll>
            <MessageScroller>
              <MessageScrollerViewport ref={scroll} preserveScrollOnPrepend aria-label="Conversation history">
                <MessageScrollerContent className="p-4">
                  {ready && <TranscriptPage id={id} visible={open || closingChat} onTail={setTail} />}
                </MessageScrollerContent>
              </MessageScrollerViewport>
              <MessageScrollerButton />
            </MessageScroller>
          </MessageScrollerProvider>
          <form onSubmit={(e) => void send(e, false)} className="p-3">
            <input ref={picker} type="file" multiple hidden onChange={e => {
              const selected = Array.from(e.currentTarget.files ?? []);
              e.currentTarget.value = '';
              const next = [...files, ...selected];
              if (next.length > 4 || next.reduce((total,file) => total + file.size, 0) > 8 * 1024 * 1024) {
                fail('Choose up to four files totaling 8 MiB per message.');
              } else if (next.some(file => !file.name || file.name.length > 255 || /[\p{C}\u2028\u2029]/u.test(file.name))) {
                fail('Choose files with printable names of up to 255 characters.');
              } else {
                fail('');
                edit(old => ({...old, files:next}));
              }
            }} />
            {files.length > 0 && <AttachmentGroup aria-label="Attachments">
              {files.map((file,index) => <Attachment key={index} size="xs">
                <AttachmentMedia><PaperclipIcon /></AttachmentMedia>
                <AttachmentContent><AttachmentTitle title={file.name}>{file.name}</AttachmentTitle></AttachmentContent>
                <AttachmentActions><AttachmentAction type="button" disabled={busy} aria-label={'Remove ' + file.name} onClick={() => edit(old => ({...old,files:old.files.filter((_,i) => i !== index)}))}><XIcon /></AttachmentAction></AttachmentActions>
              </Attachment>)}
            </AttachmentGroup>}
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
                <InputGroupButton type="button" size="icon-sm" disabled={busy || !ready} title="Attach files (8 MiB total)" aria-label="Attach files" onClick={() => picker.current?.click()}><PaperclipIcon /></InputGroupButton>
                {tail.working && <InputGroupText role="status">Working…</InputGroupText>}
                {(!!words.trim() || files.length > 0) && <InputGroupButton
                  className="ms-auto"
                  type="submit"
                  variant="default"
                  size="icon-sm"
                  aria-label="Send"
                  disabled={busy || !ready || (!words.trim() && !files.length)}
                >
                  <ArrowUpIcon />
                </InputGroupButton>}
              </InputGroupAddon>
            </InputGroup>
          </form>
        </div>
      </aside>
      <QuickBar id="quick-message" open={quick && !namingContext} label="Quick message"
        placeholder={`Ask ${name}…`} action="Send quick message" value={command} busy={busy} disabled={!ready}
        onChange={command => edit(old => ({ ...old, command }))} onSubmit={e => void send(e, true)}
        onClose={restore => restore ? closeQuick() : setQuick(false)} />
      {(error || !agent) && (
        <Alert variant="destructive" className="fixed top-2 left-2 z-50 max-w-sm">
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
    ticket: RootTicket | null;
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
    thread: threadId('th:pair-', [member, agent, ticket.project]),
  };
  const homeAgent = read.data.homeComms?.agents[0] || agent;
  const home = {
    id: 'home',
    name: 'Home',
    agent: homeAgent,
    thread: threadId('th:home-', [member, homeAgent]),
  };
  return (
    <ContextSwitcher member={member} ticket={ticketPlace} home={home}>
      {(place, namingContext) => (
        <Workspace
          key={place.thread}
          member={member}
          place={place}
          namingContext={namingContext}
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
