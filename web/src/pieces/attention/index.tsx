import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { call, callOnce, useRecords, type Call, type CallState, type Snapshot, type LiveRecord } from '../../data';
import { Split, List, Row, Empty, Error, Loading, Button, Input, Textarea } from '../../kit';
import { commsThreadPath, isNotice, listedAsks, decisionLink, inFolder, matches, safeHref, type Ask, type Answer } from './model';
import { useWaitChecks } from './wait-checks';
import { useMemberRetention } from './member-retention';
import { useReplyDraft, type ReplyDraft } from './drafts';
const idle: CallState<unknown> = { pending:false, status:'done' };
const noop = () => () => {};
function useCall<T>(request?: Call<T>) {
  return useSyncExternalStore(request?.subscribe ?? noop, request?.getSnapshot ?? (() => idle as CallState<T>));
}
export const stamp = (at: number) => `${new Date(at).toLocaleString('en-US', { timeZone:'America/Chicago' })} CT`;
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
    {link && (ask.state === 'open' || notice) && <Button variant="outline" onClick={()=>go(link.path)}>{link.label}</Button>}
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
      <p>{privateReply ? 'Your reply stays encrypted in Comms. This draft stays in this window only.' : notice ? 'Acknowledging records that you saw this alert. It does not retry or cancel Clock work.' : 'Answers are recorded here. Delivery to the agent is not connected in this preview.'}</p>
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
function PersistentReader({ member, ...props }: Parameters<typeof AskReader>[0] & { member: string }) {
  const replyDraft = useReplyDraft(member, props.ask.id);
  return <AskReader {...props} replyDraft={replyDraft} />;
}
function InboxReader(props: Parameters<typeof AskReader>[0] & { member: string }) {
  return props.ask.member ? <AskReader {...props} /> : <PersistentReader {...props} />;
}
interface ReadMark extends LiveRecord { ask: string; member: string; readAt: number }
interface MemberPreferences extends LiveRecord { member: string }
export default function InboxApp({ path: shellPath, go }: { path?: string; go?: (path:string)=>void } = {}) {
  const [localPath,setLocalPath] = useState(() => typeof location === 'undefined' ? '/p/inbox-preview' : location.pathname);
  const path = (shellPath ?? localPath).split('?')[0], base = path.split('/ask/')[0];
  let selected: string | undefined;
  try { selected = path.includes('/ask/') ? decodeURIComponent(path.slice(path.indexOf('/ask/')+5)) : undefined; } catch { /* Malformed paths select nothing. */ }
  const snapshot = useRecords<Ask>('attention.ask'), {records,status} = snapshot;
  const identity = useRecords<MemberPreferences>('household.preferences');
  const member = identity.status === 'live' ? identity.records[0]?.member : undefined;
  const marks = useRecords<ReadMark>('attention.readMark');
  const read = new Set(marks.status === 'live' && member ? marks.records.filter(mark => mark.member === member).map(mark => mark.ask) : []);
  useWaitChecks(snapshot);
  useMemberRetention(snapshot.status);
  const [folder,setFolder] = useState('needs'), [query,setQuery] = useState('');
  const [opening,setOpening] = useState<{id:string;confirmation:Confirmation}>();
  const [busy,setBusy] = useState(false);
  const lock = useRef(false);
  const guard: Guard = {lock,busy,setBusy};
  function navigate(id?: string) {
    const record = records.find(a=>a.id===id);
    const request = record && status==='live' && record.state==='open' && (!record.member || record.source.kind === 'conversation' && !record.sourceManaged && !record.waits_on) && (!decisionLink(record) || isNotice(record)) ? startCheck(guard,record.id) : undefined;
    setOpening(request && record ? {id:record.id,confirmation:{records,request}} : undefined);
    const next = id ? `${base}/ask/${encodeURIComponent(id)}` : base;
    if (go) go(next); else { if (typeof history !== 'undefined') history.pushState(null,'',next); setLocalPath(next); }
  }
  const openLink = (next: string) => { if (go) go(next); else location.assign(next); };
  useEffect(() => {
    if (go || typeof window === 'undefined') return;
    const pop = () => setLocalPath(location.pathname);
    window.addEventListener('popstate',pop); return () => window.removeEventListener('popstate',pop);
  },[go]);
  const current = status === 'live' ? records.find(a=>a.id===selected) : undefined;
  // Reading is idempotent and independent of answering. Reconnect retries a refused read.
  useEffect(() => {
    if (current && member) void call('attention.markRead', {id:current.id}).result.catch(() => {});
  }, [current?.id, member, status]);
  const listed = listedAsks(records);
  const shown = listed.filter(a=>inFolder(a,folder) && matches(a,query)).sort((a,b)=>folder==='answered' || folder==='fyi' ? b.changedAt-a.changedAt || a.id.localeCompare(b.id) : a.createdAt-b.createdAt || a.id.localeCompare(b.id));
  const agents = [...new Set(records.flatMap(a=>a.agent ? [a.agent] : []))].sort();
  return <Split className="h-full" label="Inbox" folder={folder} onFolder={id=>{setFolder(id);navigate();}}
    folders={[{id:'needs',label:'Needs you',count:listed.filter(a=>a.state==='open').length},{id:'alerts',label:'Alerts',count:listed.filter(a=>inFolder(a,'alerts')).length},{id:'answered',label:'Answered',count:listed.filter(a=>inFolder(a,'answered')).length},{id:'fyi',label:'FYI',count:listed.filter(a=>inFolder(a,'fyi')).length},{heading:'By agent'},...agents.map(agent=>({id:`agent:${agent}`,label:agent,count:listed.filter(a=>a.agent===agent && a.state==='open').length}))]}
    search={<label className="grid gap-1">Search asks<Input type="search" value={query} onChange={e=>setQuery(e.target.value)} /></label>}
    listTop={busy ? <p role="status" className="p-3">An answer is still being checked or recorded. Other answers wait.</p> : undefined}
    listTitle={folder==='alerts' ? 'Alerts' : folder==='fyi' ? 'FYI' : folder==='answered' ? 'Answered' : folder.startsWith('agent:') ? `From ${folder.slice(6)}` : 'Needs you'} listMeta={shown.length}
    list={status==='loading' ? <Loading label="Opening Inbox…" /> : status!=='live' ? <Error text={status==='denied' ? 'Sign in to see your Inbox.' : 'Waiting for connection. Answers wait until loom is reachable.'} /> : <><List label="Ask list">{shown.map(ask=><Row key={ask.id} title={ask.ask} meta={isNotice(ask) && ask.state==='answered' ? 'Acknowledged' : ask.state==='resolved' ? `Cleared itself: ${ask.resolution ?? 'No longer needs an answer'}` : ask.why} unread={marks.status === 'live' && !!member && !read.has(ask.id)} status={`${ask.agent ?? 'Household'} · ${ask.state} · ${marks.status !== 'live' || !member ? 'Read state unavailable' : read.has(ask.id) ? 'Read' : 'Unread'}`} selected={ask.id===selected} onClick={()=>navigate(ask.id)} />)}</List>{!shown.length && <Empty title={query ? `Nothing matches “${query}”` : folder==='needs' ? 'Nothing needs you' : 'No asks here'} text={query ? 'Try another search.' : 'Asks from your agents appear here.'} />}</>}
    reader={current && member ? <InboxReader key={`${member}:${current.id}:${current.member ?? "public"}`} member={member} ask={current} snapshot={snapshot} go={openLink} initialConfirmation={opening?.id===current.id ? opening.confirmation : undefined} guard={guard} onOpened={()=>setOpening(undefined)} /> : current ? <Loading label="Checking Inbox member…" /> : selected ? <Empty title="This ask is no longer in view" text="It may have changed or become unavailable." /> : null}
    open={!!selected} onBack={()=>navigate()} backLabel="Inbox" blank={<Empty title="Open an ask" text="Read the full question and what happens either way." />} />;
}
