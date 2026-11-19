import {Empty} from '../../kit';
import {ConversationActivity} from './conversation';
import CommsCompanion from '../attention/comms-companion';
import { useReadingVisible } from '../../data/visibility';
import { useDeadline } from './use-deadline';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { conversationOperation as mutate } from './operations';
import { useAnswered, useSelection } from '../../data/graphql/selection';
import { InlineQuestion } from './inline-question';
import { ConversationQuestions } from './conversation-questions';
import { SharedWork } from './shared-work';
import { CommsView, type EarlierPage } from '../comms-view';
import type { CommsActions } from '../comms-view/model';
import { commsSelection, commsThreadSelection, commsThreadPath, retainedCommsMessage } from './shared-query';
import { useDeskAgentDirectory } from '../attention/agent-directory';
import { inboxRefPath } from '../attention/inbox-query';
import { useHouseholdZone } from '../../data/zone';
const base = '/p/comms-preview';
/** The page of a thread's messages before `before`, read on its own request and drawn by the view above the ones
 * already shown. Nothing is kept here: it is a live reading like the thread's own, its words expire on their
 * deadline, and it draws nothing of a thread the reading no longer returns. */
function EarlierMessages({ thread, before, draw }: { thread: string; before: number; draw(page: EarlierPage): ReactNode }) {
  const reading = useSelection(useMemo(() => commsThreadSelection(thread, before), [thread, before]), { keep: true });
  const read = reading.status === 'live' && reading.data?.thread?.id === thread ? reading.data : undefined;
  const now = useDeadline(read ? read.messages.map(row => row.wordsKeepUntil) : []);
  return <>{draw({ status: read ? 'live' : reading.status === 'live' ? reading.settling ? 'loading' : 'denied' : reading.status,
    messages: read ? read.messages.slice(-50).map(row => retainedCommsMessage(row, now)) : [], refs: read ? read.refs : [], hasEarlier: (read?.messages.length ?? 0) > 50 })}</>;
}
function SharedCommsApp({ path: shellPath, go, visible = true }: { path?: string; go?(path: string): void; visible?: boolean } = {}) {
  const readingVisible = useReadingVisible(visible);
  const [localPath, setLocalPath] = useState(() => typeof location === 'undefined' ? base : location.pathname);
  const [archived, setArchived] = useState(false), [search, setSearch] = useState(''), [offset, setOffset] = useState(0);
  const path = (shellPath ?? localPath).split('?')[0];
  let selected: string | undefined;
  try { selected = path.includes('/thread/') ? `th:${decodeURIComponent(path.slice(path.indexOf('/thread/') + 8))}` : undefined; } catch { /* Invalid route selects nothing. */ }
  // Two readings, so opening a thread cannot disturb the list: the folder, search and page select the rows and
  // counts; the open thread and its page of messages are read by the thread's id alone. Each keeps its last
  // answer on screen while its next one loads.
  const reading = useSelection(useMemo(() => commsSelection(archived, search, offset), [archived, search, offset]), { keep: true });
  const opened = useSelection(useMemo(() => commsThreadSelection(selected ?? ''), [selected]), { keep: true, pause: !selected });
  const zone = useHouseholdZone(), directory = useDeskAgentDirectory();
  const drawnArchived = useAnswered(reading, archived);
  const data = reading.status === 'live' ? reading.data : undefined, live = !!data?.home;
  const status = reading.status === 'live' && !live ? 'denied' : reading.status;
  // Everything the reader draws or acts on comes from `open`, and `open` is only ever the thread the path names.
  // A kept answer for the thread that was open before is not it: the reader waits for its own.
  const open = live && opened.status === 'live' && opened.data?.thread?.id === selected ? opened.data : undefined;
  const detailStatus = !live ? status : !selected ? 'live' : opened.status === 'live' && opened.settling && !open ? 'loading' : opened.status;
  const navigate = (next: string) => { if (go) go(next); else { if (typeof history !== 'undefined') history.pushState(null, '', next); setLocalPath(next); } };
  const select = (id?: string) => navigate(id ? commsThreadPath(id) : base);
  useEffect(() => {
    if (go || typeof window === 'undefined') return;
    const pop = () => setLocalPath(location.pathname); window.addEventListener('popstate', pop); return () => window.removeEventListener('popstate', pop);
  }, [go]);
  const now = useDeadline(open ? open.messages.map(row => row.wordsKeepUntil) : []);

  const actions: CommsActions | undefined = live ? {
    open: (agent, thread) => mutate('comms.open', { agent, thread }),
    send: (thread, words, clientId) => mutate('comms.send', { thread, words, clientId }),
    read: (thread, seq) => mutate('comms.change', { thread, change: 'read', seq }),
    change: async (thread, change) => { await mutate('comms.change', { thread, ...change }); if (change.change === 'delete') select(); },
  } : undefined;
  const messages = open ? open.messages.slice(-50).map(row => retainedCommsMessage(row, now)) : [];
  const thread = open?.thread ?? null, own = !!thread && thread.member === data?.home?.member;
  // An agent's display name is the shared directory's, as the desk's cards say it; its id with a capital until that is read.
  const named = (id: string) => (directory.status === 'live' ? directory.records.find(person => person.id === `commons:${id}` && person.slug === id)?.name : undefined) ?? id.slice(0, 1).toUpperCase() + id.slice(1);
  const shownThreads = live ? data.threads.slice(0,50) : [];
  return <CommsView snapshot={{ status, settling: reading.settling, archived: drawnArchived, member: data?.home?.member ?? '', threads: shownThreads,
    agents: live ? data.home!.agents.map(id => ({ id, name: named(id) })) : [], folders: live ? data.folders : undefined,
    names: Object.fromEntries([...shownThreads, ...(thread ? [thread] : [])].map(row => [row.agent, named(row.agent)])) }}
    detail={{ status: detailStatus, thread, messages, refs: open ? open.refs : [] }} selected={selected} select={select} actions={actions}
    readVisible={readingVisible} zone={zone}
    navigation={{ archived, search, offset, hasNext: (data?.threads.length ?? 0) > 50,
      folder(value) { setArchived(value); setOffset(0); }, query(value) { setSearch(value); setOffset(0); },
      previous() { setOffset(value => Math.max(0,value-50)); }, next() { setOffset(value => value+50); } }}
    cards={{ screen: thread?<CommsCompanion agent={thread.agent} working={thread.working} visible={readingVisible} go={navigate}/>:undefined,
      question: (id, note) => <InlineQuestion key={id} id={id} go={navigate} readVisible={readingVisible} writable={own} onWaiting={note} />,
      waiting: own ? (conversation, placed, note) => <ConversationQuestions key={conversation} conversation={conversation} go={navigate} readVisible={readingVisible} placed={placed} onWaiting={note} /> : undefined,
      work: (refs, conversation) => <SharedWork key={conversation} refs={refs} conversation={conversation} go={navigate} />,
      openRef: ref => { const to = inboxRefPath(ref); return to ? () => navigate(to) : undefined; } }}
    messageNavigation={{ hasEarlier: (open?.messages.length ?? 0) > 50,
      page: (before, draw) => selected ? <EarlierMessages thread={selected} before={before} draw={draw} /> : null }} />;
}
export { CommsView } from '../comms-view';

/** Route Memory links to wordless history before mounting the thread view. */
export default function CommsApp(props:{path?:string;go?:(path:string)=>void;visible?:boolean}={}){
 const [localPath,setLocalPath]=useState(()=>typeof location==='undefined'?'/p/comms-preview':location.pathname);
 useEffect(()=>{if(props.go)return;const pop=()=>setLocalPath(location.pathname);window.addEventListener('popstate',pop);return()=>window.removeEventListener('popstate',pop);},[props.go]);
 const path=props.path??localPath;
 const visit=(next:string)=>{if(props.go)props.go(next);else{history.pushState(null,'',next);setLocalPath(next);}};
 const prefix='/p/comms-preview/conversation/';
 if(path.startsWith(prefix)){
  let conversation:string;try{conversation=decodeURIComponent(path.slice(prefix.length));}catch{return <Empty title="Conversation unavailable"/>;}
  return <ConversationActivity key={conversation} conversation={conversation}/>;
 }
 return <SharedCommsApp {...props} path={path} go={visit}/>;
}
