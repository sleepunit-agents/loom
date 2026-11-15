import { memberOperation } from '../../data/operation';
import { stamp } from './time';
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { call, callOnce, type Call, type CallState, type Snapshot } from '../../data';
import { Error, Loading, Button, Textarea } from '../../kit';
import { commsThreadPath, isNotice, decisionLink, safeHref, type Ask, type Answer } from './model';
import type { ReplyDraft } from './drafts';
import { InboxView, type InboxActions } from '../inbox-view';
import { inboxSelection, useInboxSelection, inboxPageSize, inboxSourcePath, retainedInboxItem } from './inbox-query';
const idle: CallState<unknown> = { pending:false, status:'done' };
const noop = () => () => {};
function useCall<T>(request?: Call<T>) {
  return useSyncExternalStore(request?.subscribe ?? noop, request?.getSnapshot ?? (() => idle as CallState<T>));
}
export { stamp } from './time';
export interface Guard { lock: {current:boolean}; busy: boolean; setBusy(busy:boolean):void }
function startCheck(guard: Guard, id: string): Call<Ask> | undefined {
  if (guard.lock.current) return;
  guard.lock.current = true; guard.setBusy(true);
  const request = call<Ask>('attention.get',{id});
  void request.result.then(() => { guard.lock.current = false; guard.setBusy(false); });
  return request;
}
type Confirmation = { records: readonly Ask[]; request: Call<Ask> };
/** A receipt always reads the central answer fact; Home keeps no answer cache. */
export function AnswerReceipt({ ask }: { ask: Ask }) {
  return ask.answer ? <section><h3>{isNotice(ask) ? 'Acknowledgement' : 'Answer'}</h3><p>{isNotice(ask) ? 'Acknowledged' : ask.answer.kind} · {ask.answer.by.id} · {stamp(ask.answer.at)}</p>{ask.answer.text && <p className="whitespace-pre-wrap">{ask.answer.text}</p>}</section> : null;
}
export function AskReader({ ask, snapshot, go, initialConfirmation, guard: sharedGuard, onOpened, requireOwnership = false, replyDraft }: { ask: Ask; snapshot: Snapshot<Ask>; go(path: string): void; initialConfirmation?: Confirmation; guard?: Guard; onOpened?():void; requireOwnership?: boolean; replyDraft?: ReplyDraft }) {
  const [confirmation,setConfirmation] = useState<Confirmation | undefined>(initialConfirmation);
  const [request,setRequest] = useState<Call<unknown>>();
  const [checking,setChecking] = useState(false), [localDraft,setLocalDraft] = useState('');
  const draft = replyDraft?.value.text ?? localDraft;
  const setDraft = replyDraft?.edit ?? setLocalDraft;
  const [message,setMessage] = useState('');
  const latest = useRef(snapshot); latest.current = snapshot;
  const localLock = useRef(false), mounted = useRef(true);
  const [localBusy,setLocalBusy] = useState(false);
  const guard = sharedGuard ?? {lock:localLock,busy:localBusy,setBusy:setLocalBusy};
  const {busy} = guard;
  const sending = guard.lock;
  // Consume the opening request once; browser/shell history must never revive it on a later mount.
  useEffect(() => {
    if (initialConfirmation) { setConfirmation(initialConfirmation); onOpened?.(); }
  },[initialConfirmation]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; },[]);
  const link = decisionLink(ask), notice = isNotice(ask);
  const privateReply = !!ask.member && ask.source.kind === 'conversation' && !ask.sourceManaged && !ask.waits_on && !ask.privateQuestion;
  // Opening a row or pressing Check again creates the read; effects never replay requests.
  const checked = useCall(confirmation?.request), saving = useCall(request);
  const confirmed = snapshot.status === 'live' && confirmation?.records === snapshot.records && checked.result?.ok && checked.result.value.id === ask.id && checked.result.value.state === 'open';
  async function answer(value: Answer) {
    if (!confirmed || sending.current || busy || saving.pending || (privateReply && (value.kind !== 'words' || !value.text.trim() || value.text.length > 4000))) return;
    sending.current = true; guard.setBusy(true); setChecking(true); setMessage('');
    const records = snapshot.records, sentDraft = replyDraft?.value;
    try {
      // Always ask again immediately before the write. A reconnect, scope change or changed record invalidates it.
      const fresh = await call<Ask>('attention.get',{id:ask.id}).result;
      if (!mounted.current) return;
      if (latest.current.status !== 'live' || latest.current.records !== records || !fresh.ok || fresh.value.id !== ask.id || fresh.value.state !== 'open') {
        setConfirmation(undefined); setMessage('This ask changed or could not be checked. Nothing was recorded.'); return;
      }
      const write = privateReply && value.kind === 'words'
        ? callOnce('comms.replyToAsk',{ref:ask.id,text:value.text})
        : call('attention.answer',{id:ask.id,answer:value,...(requireOwnership ? {requireOwnership:true} : {})});
      setRequest(write); setConfirmation(undefined);
      const result = await write.result;
      if (result.ok && value.kind === 'words') {
        if (sentDraft) replyDraft?.acknowledged(sentDraft);
        if (privateReply && mounted.current) setLocalDraft('');
      }
    } finally { sending.current = false; guard.setBusy(false); if (mounted.current) setChecking(false); }
  }
  const href = safeHref(ask.href);
  return <article className="grid min-w-0 grid-cols-1 gap-5 p-5 [overflow-wrap:anywhere]">
    <header><p>{ask.agent ?? 'Household'} · {(notice ? ask.state === 'answered' ? 'acknowledged' : 'alert' : ask.state)}</p><h1 className="text-2xl font-semibold">{ask.ask}</h1><p>{stamp(ask.createdAt)}{ask.project && ` · ${ask.project}`}</p></header>
    {ask.why && <section><h3>Why</h3><p className="whitespace-pre-wrap">{ask.why}</p></section>}
    {ask.if_yes && <section><h3>If yes</h3><p className="whitespace-pre-wrap">{ask.if_yes}</p></section>}
    {ask.if_no && <section><h3>If no</h3><p className="whitespace-pre-wrap">{ask.if_no}</p></section>}
    {link && (ask.state === 'open' || notice || ask.sourceManaged && ask.source.kind==='piece' && ask.source.id==='approvals-notices') && <Button variant="outline" onClick={()=>go(link.path)}>{link.label}</Button>}
    {ask.member && !privateReply && ask.state === 'open' && !link && <p>Answer this in its private conversation. Private replies stay there.</p>}
    {ask.state === 'open' && (!link || notice) && (!ask.member || privateReply) && <>
      {!confirmed && <p role="status">{message || (checked.result?.ok === false ? `Couldn’t check this ask: ${checked.result.message}` : checked.result?.ok && checked.result.value.state !== 'open' ? 'This ask is no longer open.' : 'Checking whether this ask is still open…')}</p>}
      {!confirmed && !saving.pending && <Button variant="outline" disabled={snapshot.status !== 'live' || checking || busy} onClick={()=>{const request=startCheck(guard,ask.id);if(request){setMessage('');setConfirmation({records:snapshot.records,request});}}}>Check again</Button>}
      {confirmed && <fieldset disabled={checking || saving.pending || busy} className="grid min-w-0 gap-3">
        <legend>{notice ? 'Acknowledge alert' : privateReply ? 'Reply privately' : 'Record your answer'}</legend>
        {replyDraft && !replyDraft.persistent && <p role="status">Device storage is unavailable. Keep this window open to retain your draft.</p>}
        {!notice && !privateReply && ask.answers !== 'words' && <div className="flex flex-wrap gap-2"><Button disabled={!!draft.trim()} onClick={()=>void answer({kind:'yes'})}>Yes</Button><Button variant="outline" disabled={!!draft.trim()} onClick={()=>void answer({kind:'no'})}>No</Button></div>}
        {!notice && (!ask.sourceManaged || ask.answers === 'words') && <><label className="grid gap-1">{privateReply ? 'Your private reply' : ask.answers === 'words' ? 'Your answer' : 'Or answer in your own words'}<Textarea maxLength={privateReply ? 4000 : undefined} value={draft} onChange={event=>setDraft(event.target.value)} rows={4} /></label><Button disabled={!draft.trim() || privateReply && draft.length > 4000} onClick={()=>void answer({kind:'words',text:draft})}>{privateReply ? 'Send private reply' : 'Record answer'}</Button></>}
        {!privateReply && <div className="flex flex-wrap gap-2"><Button variant="outline" disabled={!!draft.trim()} onClick={()=>void answer({kind:'done'})}>{notice ? 'Acknowledge' : 'Mark done'}</Button>{!notice && <Button variant="outline" disabled={!!draft.trim()} onClick={()=>void answer({kind:'dismiss'})}>Dismiss</Button>}</div>}
      </fieldset>}
      <p>{privateReply ? 'Your reply stays encrypted in Comms. This draft stays in this window only.' : notice ? 'Acknowledging records that you saw this alert. It does not retry or cancel Clock work.' : 'Answers are saved here. When the conversation supports delivery, Yes, No and words also go to its agent. Saved does not mean read. If delivery is refused, the ask stays open and your draft is kept. Mark done and Dismiss send no message.'}</p>
    </>}
    {saving.pending && <Loading label={saving.status === 'offline' ? 'Waiting for connection…' : 'Recording answer…'} />}
    {saving.result?.ok === false && <Error title="Couldn’t record your answer" text={saving.result.message} />}
    {saving.result?.ok && <p role="status">{notice ? 'Alert acknowledged' : privateReply ? 'Private reply saved in Comms' : 'Answer recorded'}</p>}
    <AnswerReceipt ask={ask} />
    {ask.member && ask.answer?.reply && <Button variant="outline" onClick={()=>go(commsThreadPath(ask.answer!.reply!.thread))}>Open private reply</Button>}
    {ask.resolution && <section><h3>Resolved</h3><p>{ask.resolution}</p></section>}
    {(href || ask.refs?.length) && <section><h3>References</h3>{href && <a href={href} target="_blank" rel="noreferrer">Open reference</a>}{ask.refs?.length ? <ul>{ask.refs.map((ref,n)=><li key={n}>{ref}</li>)}</ul> : null}</section>}
  </article>;
}
const inboxBase = '/p/inbox-preview';
export default function InboxApp({ path: shellPath, go }: { path?: string; go?: (path: string) => void } = {}) {
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
    read: id => mutate('inbox.read', { item: id }),
    answer: (id, answer, words) => mutate('inbox.answer', { item: id, answer, ...(words ? { words } : {}) }),
    openSource: current && inboxSourcePath(current) ? row => { const target = inboxSourcePath(row); if (target) navigate(target); } : undefined,
  } : undefined;
  return <InboxView snapshot={{ status, folders: data?.folders, items: data?.items.slice(0, inboxPageSize).map(row => retainedInboxItem(row, Math.max(now, Date.now()))) ?? [] }}
    selected={selected} select={select} detail={{ status, item: current }} actions={actions}
    results={{ status, results: data?.results ?? [] }} dismissResult={live ? id => mutate('inbox.dismissResult', { id }) : undefined}
    navigation={{ folder, query: search, offset, hasNext: (data?.items.length ?? 0) > inboxPageSize,
      onFolder(id) { setFolder(id); setOffset(0); select(); }, onQuery(value) { setSearch(value); setOffset(0); },
      previous() { setOffset(value => Math.max(0, value - inboxPageSize)); }, next() { setOffset(value => value + inboxPageSize); } }} />;
}

export { InboxView, InboxQuestionCard, InboxActionNotices } from "../inbox-view";
