import { useReadingVisible } from '../../data/visibility';
import { useDeadline } from './use-deadline';
import { useEffect, useMemo, useState } from 'react';
import { conversationOperation as mutate } from './operations';
import { useSelection } from '../../data/graphql/selection';
import { InlineQuestion } from './inline-question';
import { SharedWork } from './shared-work';
import { CommsView } from '../comms-view';
import type { CommsActions } from '../comms-view/model';
import { commsSelection, commsThreadPath, retainedCommsMessage } from './shared-query';
const base = '/p/comms-preview';
export default function CommsApp({ path: shellPath, go, visible = true }: { path?: string; go?(path: string): void; visible?: boolean } = {}) {
  const readingVisible = useReadingVisible(visible);
  const [localPath, setLocalPath] = useState(() => typeof location === 'undefined' ? base : location.pathname);
  const [archived, setArchived] = useState(false), [search, setSearch] = useState(''), [offset, setOffset] = useState(0);
  const [before, setBefore] = useState<number>();
  const path = (shellPath ?? localPath).split('?')[0];
  let selected: string | undefined;
  try { selected = path.includes('/thread/') ? `th:${decodeURIComponent(path.slice(path.indexOf('/thread/') + 8))}` : undefined; } catch { /* Invalid route selects nothing. */ }
  useEffect(() => { setBefore(undefined); }, [selected]);
  const reading = useSelection(useMemo(() => commsSelection(archived, search, offset, selected, before), [archived, search, offset, selected, before]));
  const data = reading.status === 'live' ? reading.data : undefined, live = !!data?.home;
  const status = reading.status === 'live' && !live ? 'denied' : reading.status;
  const navigate = (next: string) => { if (go) go(next); else { if (typeof history !== 'undefined') history.pushState(null, '', next); setLocalPath(next); } };
  const select = (id?: string) => { setBefore(undefined); navigate(id ? commsThreadPath(id) : base); };
  useEffect(() => {
    if (go || typeof window === 'undefined') return;
    const pop = () => setLocalPath(location.pathname); window.addEventListener('popstate', pop); return () => window.removeEventListener('popstate', pop);
  }, [go]);
  const now = useDeadline(live ? data.messages.map(row => row.wordsKeepUntil) : []);

  const actions: CommsActions | undefined = live ? {
    open: (agent, thread) => mutate('comms.open', { agent, thread, title: 'New conversation' }),
    send: (thread, words, clientId) => mutate('comms.send', { thread, words, clientId }),
    read: (thread, seq) => mutate('comms.change', { thread, change: 'read', seq }),
    change: async (thread, change) => { await mutate('comms.change', { thread, ...change }); if (change.change === 'delete') select(); },
  } : undefined;
  const messages = live ? data.messages.slice(-50).map(row => retainedCommsMessage(row, now)) : [];
  return <CommsView snapshot={{ status, member: data?.home?.member ?? '', threads: live ? data.threads.slice(0,50) : [],
    agents: live ? data.home!.agents.map(id => ({ id, name: id })) : [], folders: live ? data.folders : undefined }}
    detail={{ status, thread: live ? data.thread : null, messages, refs: live ? data.refs : [] }} selected={selected} select={select} actions={actions}
    readVisible={readingVisible}
    navigation={{ archived, search, offset, hasNext: (data?.threads.length ?? 0) > 50,
      folder(value) { setArchived(value); setOffset(0); }, query(value) { setSearch(value); setOffset(0); },
      previous() { setOffset(value => Math.max(0,value-50)); }, next() { setOffset(value => value+50); } }}
    cards={{ question: id => <InlineQuestion key={id} id={id} go={navigate} readVisible={readingVisible} writable={data?.thread?.member === data?.home?.member} />, work: (refs, conversation) => <SharedWork key={conversation} refs={refs} conversation={conversation} go={navigate} /> }}
    messageNavigation={{ earlier: () => setBefore(messages[0]?.seq), latest: () => setBefore(undefined), hasEarlier: (data?.messages.length ?? 0) > 50, before }} />;
}
export { CommsView } from '../comms-view';
