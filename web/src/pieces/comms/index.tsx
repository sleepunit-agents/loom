import { useEffect, useMemo, useState } from 'react';
import { call, callOnce } from '../../data';
import { useQuery } from '../../data/query';
import { InlineQuestion } from './inline-question';
import { SharedWork } from './shared-work';
import { CommsView } from '../comms-view';
import type { CommsActions } from '../comms-view/model';
import { commsSelection, commsThreadPath, retainedCommsMessage } from './shared-query';
const base = '/p/comms-preview';
export default function CommsApp({ path: shellPath, go }: { path?: string; go?(path: string): void; visible?: boolean } = {}) {
  const [localPath, setLocalPath] = useState(() => typeof location === 'undefined' ? base : location.pathname);
  const [archived, setArchived] = useState(false), [search, setSearch] = useState(''), [offset, setOffset] = useState(0);
  const [before, setBefore] = useState<number>(), [now, setNow] = useState(Date.now);
  const path = (shellPath ?? localPath).split('?')[0];
  let selected: string | undefined;
  try { selected = path.includes('/thread/') ? `th:${decodeURIComponent(path.slice(path.indexOf('/thread/') + 8))}` : undefined; } catch { /* Invalid route selects nothing. */ }
  useEffect(() => { setBefore(undefined); }, [selected]);
  const reading = useQuery(useMemo(() => commsSelection(archived, search, offset, selected, before), [archived, search, offset, selected, before]));
  const data = reading.status === 'live' ? reading.data : undefined, live = !!data?.home;
  const status = reading.status === 'error' ? 'offline' : reading.status === 'live' && !live ? 'denied' : reading.status;
  const navigate = (next: string) => { if (go) go(next); else { if (typeof history !== 'undefined') history.pushState(null, '', next); setLocalPath(next); } };
  const select = (id?: string) => { setBefore(undefined); navigate(id ? commsThreadPath(id) : base); };
  useEffect(() => {
    if (go || typeof window === 'undefined') return;
    const pop = () => setLocalPath(location.pathname); window.addEventListener('popstate', pop); return () => window.removeEventListener('popstate', pop);
  }, [go]);
  useEffect(() => {
    if (!live) return;
    const deadlines = data.messages.map(row => Date.parse(row.wordsKeepUntil ?? '')).filter(at => Number.isFinite(at) && at > now);
    if (!deadlines.length) return;
    const timer = setTimeout(() => setNow(Date.now()), Math.min(2147483647, Math.max(1, Math.min(...deadlines) - Date.now())));
    return () => clearTimeout(timer);
  }, [data, live, now]);
  const mutate = async (name: string, input: object, queued = false) => {
    const result = await (queued ? call(name, input) : callOnce(name, input)).result;
    if (!result.ok) throw new Error(result.message);
  };
  const actions: CommsActions | undefined = live ? {
    open: (agent, thread) => mutate('comms.open', { agent, thread }, true),
    send: (thread, words, clientId) => mutate('comms.send', { thread, words, clientId }),
    read: (thread, seq) => mutate('comms.change', { thread, change: 'read', seq }, true),
    change: async (thread, change) => { await mutate('comms.change', { thread, ...change }); if (change.change === 'delete') select(); },
  } : undefined;
  const messages = live ? data.messages.slice(-50).map(row => retainedCommsMessage(row, Math.max(now, Date.now()))) : [];
  return <CommsView snapshot={{ status, member: data?.home?.member ?? '', threads: live ? data.threads.slice(0,50) : [],
    agents: live ? data.home!.agents.map(id => ({ id, name: id })) : [], folders: live ? data.folders : undefined }}
    detail={{ status, thread: live ? data.thread : null, messages, refs: live ? data.refs : [] }} selected={selected} select={select} actions={actions}
    navigation={{ archived, search, offset, hasNext: (data?.threads.length ?? 0) > 50,
      folder(value) { setArchived(value); setOffset(0); }, query(value) { setSearch(value); setOffset(0); },
      previous() { setOffset(value => Math.max(0,value-50)); }, next() { setOffset(value => value+50); } }}
    cards={{ question: id => <InlineQuestion key={id} id={id} go={navigate} writable={data?.thread?.member === data?.home?.member} />, work: (refs, conversation) => <SharedWork key={conversation} refs={refs} conversation={conversation} go={navigate} /> }}
    messageNavigation={{ earlier: () => setBefore(messages[0]?.seq), latest: () => setBefore(undefined), hasEarlier: (data?.messages.length ?? 0) > 50, before }} />;
}
export { CommsView } from '../comms-view';
