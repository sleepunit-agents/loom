import { TaskQuestionAnswer } from '../tasks/question-answer';
import { LiveApprovalCard, useApprovalList } from '../../data/work-views';
import { approvalTitle } from '../approval-view/model';
import { useReadingVisible } from '../../data/visibility';
import { memberOperation } from '../../data/operation';
import { useEffect, useMemo, useState } from 'react';
import { useAnswered } from '../../data/graphql/selection';
import { approvalRequestId } from '../inbox-view/model';
import { InboxView, type InboxActions } from '../inbox-view';
import { useHouseholdZone } from '../../data/zone';
import { answerInboxItem, inboxSelection, useInboxSelection, useInboxItem, inboxPageSize, inboxSourcePath, inboxRefPath, retainedInboxItem, useInboxProposalTitles } from './inbox-query';
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
  // Two readings, so opening an item cannot disturb the list: the folder, search and page select the rows,
  // counts and outcomes; the open item is read by its id alone.
  const selection = useMemo(() => inboxSelection(folder, search, offset), [folder, search, offset]);
  const reading = useInboxSelection(selection), live = reading.status === 'live', zone = useHouseholdZone();
  const opened = useInboxItem(selected);
  const drawnFolder = useAnswered(reading, folder);
  const status = reading.status;
  const data = live ? reading.data : undefined;
  // Until the item's own reading answers, the reader shows the row the list already holds for this id
  // (the list reads the same fields). A list still showing its previous folder or page lends nothing.
  const known = live && !reading.settling && opened.status === 'loading' ? data?.items.find(row => row.id === selected) : undefined;
  const item = !selected ? null : opened.status === 'live' ? opened.data ?? null : known ?? null;
  const detailStatus = !live ? status : !selected || known ? 'live' : opened.status;
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
    const deadlines = [...data.items, ...(item ? [item] : [])]
      .flatMap(row => [row.bodyKeepUntil, row.answerKeepUntil]).map(value => Date.parse(value ?? ''))
      .filter(value => Number.isFinite(value) && value > now);
    if (!deadlines.length) return;
    const timer = setTimeout(() => setNow(Date.now()), Math.min(2147483647, Math.max(1, Math.min(...deadlines) - Date.now())));
    return () => clearTimeout(timer);
  }, [data, item, now]);
  // Every control below acts on `current`, and `current` is only ever the item the path names.
  const current = live && item && item.id === selected ? retainedInboxItem(item, Math.max(now, Date.now())) : null;
  const mutate = memberOperation;
  // An approval's item is said as its card says it: the same plain sentence, made when it is read, and the same
  // card with its Allow and Deny in the reader. The words stored with the item stay where the card is not readable.
  const cards = useApprovalList();
  const cardOf = (row: { waitsOnKind?: string | null; waitsOnId?: string | null }) => row.waitsOnKind === 'approval' && cards.status === 'live' ? cards.approvals.find(card => card.id === row.waitsOnId) : undefined;

  const ids = [...new Set([...(data?.items.slice(0,inboxPageSize).filter(approvalRequestId) ?? []), ...(current ? [current] : [])]
    .map(cardOf).filter(card => card?.operation === 'household.change').map(card => card!.id))];
  const {named} = useInboxProposalTitles(ids);

  const actions: InboxActions | undefined = live ? {
    volume: current?.canSetVolume ? (id, volume) => mutate('inbox.volume', { item: id, volume }) : undefined,
    read: readingVisible ? id => mutate('inbox.read', { item: id }) : undefined,
    answer: current?.canAnswer ? answerInboxItem : undefined,
    openSource: current && inboxSourcePath(current) ? row => { const target = inboxSourcePath(row); if (target) navigate(target); } : undefined,
    openRef: ref => { const target = inboxRefPath(ref); return target ? () => navigate(target) : undefined; },
  } : undefined;
  return <InboxView zone={zone} snapshot={{ status, settling: reading.settling, folder: drawnFolder, folders: data?.folders, items: data?.items.slice(0, inboxPageSize).map(row => retainedInboxItem(row, Math.max(now, Date.now()))) ?? [] }}
    selected={selected} select={select} detail={{ status: detailStatus, item: current }} actions={actions}
    words={row => { const approval = approvalRequestId(row) ? cardOf(row) : undefined; return approval?.operation === 'household.change' ? named.get(approval.id) ?? approvalTitle(approval) : undefined; }}
    sourceCard={item => item.source === 'task' && item.waitsOnKind === 'task' ? <TaskQuestionAnswer key={item.id} item={item}/>
      : cardOf(item) ? <LiveApprovalCard showBlocker key={item.id} id={item.waitsOnId!} displayTitle={named.get(item.waitsOnId!)} /> : undefined}
    results={{ status, results: data?.results ?? [] }} dismissResult={live ? id => mutate('inbox.dismissResult', { id }) : undefined}
    navigation={{ folder, query: search, offset, hasNext: (data?.items.length ?? 0) > inboxPageSize,
      onFolder(id) { setFolder(id); setOffset(0); select(); }, onQuery(value) { setSearch(value); setOffset(0); },
      previous() { setOffset(value => Math.max(0, value - inboxPageSize)); }, next() { setOffset(value => value + inboxPageSize); } }} />;
}

export { InboxView, InboxQuestionCard, InboxActionNotices } from "../inbox-view";
