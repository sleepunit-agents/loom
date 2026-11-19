import { TaskQuestionAnswer } from '../tasks/question-answer';
import { useReadingVisible } from '../../data/visibility';
import { memberOperation } from '../../data/operation';
import { useEffect, useMemo, useState } from 'react';
import { InboxView, type InboxActions } from '../inbox-view';
import { inboxSelection, useInboxSelection, inboxPageSize, inboxSourcePath, inboxRefPath, retainedInboxItem } from './inbox-query';
export { stamp } from './time';
const inboxBase = '/p/inbox-preview';
export default function InboxApp({ path: shellPath, go, visible = true }: { path?: string; go?: (path: string) => void; visible?: boolean } = {}) {
  const readingVisible = useReadingVisible(visible);
  const [localPath, setLocalPath] = useState(() => typeof location === 'undefined' ? inboxBase : location.pathname);
  const [folder, setFolder] = useState('needs'), [search, setSearch] = useState(''), [offset, setOffset] = useState(0);
  const [now, setNow] = useState(Date.now);
  const path = (shellPath ?? localPath).split('?')[0];
  let selected: string | undefined;
  try { selected = path.includes('/ask/') ? decodeURIComponent(path.slice(path.indexOf('/ask/') + 5)) : undefined; } catch { /* Invalid routes select nothing. */ }
  const selection = useMemo(() => inboxSelection(folder, search, offset, selected), [folder, search, offset, selected]);
  const reading = useInboxSelection(selection), live = reading.status === 'live';
  const status = reading.status;
  const data = live ? reading.data : undefined;
  const navigate = (next: string) => {
    if (go) go(next);
    else { if (typeof history !== 'undefined') history.pushState(null, '', next); setLocalPath(next); }
  };
  const select = (id?: string) => navigate(id ? `${inboxBase}/ask/${encodeURIComponent(id)}` : inboxBase);
  useEffect(() => {
    if (go || typeof window === 'undefined') return;
    const pop = () => setLocalPath(location.pathname);
    window.addEventListener('popstate', pop); return () => window.removeEventListener('popstate', pop);
  }, [go]);
  useEffect(() => {
    if (!data) return;
    const deadlines = [...data.items, ...(data.item ? [data.item] : [])]
      .flatMap(row => [row.bodyKeepUntil, row.answerKeepUntil]).map(value => Date.parse(value ?? ''))
      .filter(value => Number.isFinite(value) && value > now);
    if (!deadlines.length) return;
    const timer = setTimeout(() => setNow(Date.now()), Math.min(2147483647, Math.max(1, Math.min(...deadlines) - Date.now())));
    return () => clearTimeout(timer);
  }, [data, now]);
  const current = data?.item ? retainedInboxItem(data.item, Math.max(now, Date.now())) : null;
  const mutate = memberOperation;

  const actions: InboxActions | undefined = live ? {
    volume: current?.canSetVolume ? (id, volume) => mutate('inbox.volume', { item: id, volume }) : undefined,
    read: readingVisible ? id => mutate('inbox.read', { item: id }) : undefined,
    answer: current?.canAnswer ? (id, answer, words) => mutate('inbox.answer', { item: id, answer, ...(words ? { words } : {}) }) : undefined,
    openSource: current && inboxSourcePath(current) ? row => { const target = inboxSourcePath(row); if (target) navigate(target); } : undefined,
    openRef: ref => { const target = inboxRefPath(ref); return target ? () => navigate(target) : undefined; },
  } : undefined;
  return <InboxView snapshot={{ status, folders: data?.folders, items: data?.items.slice(0, inboxPageSize).map(row => retainedInboxItem(row, Math.max(now, Date.now()))) ?? [] }}
    selected={selected} select={select} detail={{ status, item: current }} actions={actions}
    sourceCard={item => item.source === 'task' && item.waitsOnKind === 'task' ? <TaskQuestionAnswer key={item.id} item={item}/> : undefined}
    results={{ status, results: data?.results ?? [] }} dismissResult={live ? id => mutate('inbox.dismissResult', { id }) : undefined}
    navigation={{ folder, query: search, offset, hasNext: (data?.items.length ?? 0) > inboxPageSize,
      onFolder(id) { setFolder(id); setOffset(0); select(); }, onQuery(value) { setSearch(value); setOffset(0); },
      previous() { setOffset(value => Math.max(0, value - inboxPageSize)); }, next() { setOffset(value => value + inboxPageSize); } }} />;
}

export { InboxView, InboxQuestionCard, InboxActionNotices } from "../inbox-view";
