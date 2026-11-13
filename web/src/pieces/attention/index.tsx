import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { call, useRecords, type Call, type CallState, type Snapshot } from '../../data';
import { Split, List, Row, Empty, Error, Loading, Button, Input, Textarea } from '../../kit';
import { decisionLink, inFolder, matches, safeHref, type Ask, type Answer } from './model';
const idle: CallState<unknown> = { pending:false, status:'done' };
const noop = () => () => {};
function useCall<T>(request?: Call<T>) {
  return useSyncExternalStore(request?.subscribe ?? noop, request?.getSnapshot ?? (() => idle as CallState<T>));
}
const stamp = (at: number) => `${new Date(at).toLocaleString('en-US', { timeZone:'America/Chicago' })} CT`;
interface Guard { lock: {current:boolean}; busy: boolean; setBusy(busy:boolean):void }
function startCheck(guard: Guard, id: string): Call<Ask> | undefined {
  if (guard.lock.current) return;
  guard.lock.current = true; guard.setBusy(true);
  const request = call<Ask>('attention.get',{id});
  void request.result.then(() => { guard.lock.current = false; guard.setBusy(false); });
  return request;
}
type Confirmation = { records: readonly Ask[]; request: Call<Ask> };
export function AskReader({ ask, snapshot, go, initialConfirmation, guard: sharedGuard, onOpened }: { ask: Ask; snapshot: Snapshot<Ask>; go(path: string): void; initialConfirmation?: Confirmation; guard?: Guard; onOpened?():void }) {
  const [confirmation,setConfirmation] = useState<Confirmation | undefined>(initialConfirmation);
  const [request,setRequest] = useState<Call<Ask>>();
  const [checking,setChecking] = useState(false), [draft,setDraft] = useState('');
  const [message,setMessage] = useState('');
  const latest = useRef(snapshot); latest.current = snapshot;
  const localLock = useRef(false), mounted = useRef(true);
  const [localBusy,setLocalBusy] = useState(false);
  const guard = sharedGuard ?? {lock:localLock,busy:localBusy,setBusy:setLocalBusy};
  const {busy} = guard;
  const sending = guard.lock;
  // Consume the opening request once; browser/shell history must never revive it on a later mount.
  useEffect(() => { onOpened?.(); },[]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; },[]);
  const link = decisionLink(ask);
  // Opening a row or pressing Check again creates the read; effects never replay requests.
  const checked = useCall(confirmation?.request), saving = useCall(request);
  const confirmed = snapshot.status === 'live' && confirmation?.records === snapshot.records && checked.result?.ok && checked.result.value.id === ask.id && checked.result.value.state === 'open';
  async function answer(value: Answer) {
    if (!confirmed || sending.current || busy || saving.pending) return;
    sending.current = true; guard.setBusy(true); setChecking(true); setMessage('');
    const records = snapshot.records;
    try {
      // Always ask again immediately before the write. A reconnect, scope change or changed record invalidates it.
      const fresh = await call<Ask>('attention.get',{id:ask.id}).result;
      if (!mounted.current) return;
      if (latest.current.status !== 'live' || latest.current.records !== records || !fresh.ok || fresh.value.id !== ask.id || fresh.value.state !== 'open') {
        setConfirmation(undefined); setMessage('This ask changed or could not be checked. Nothing was recorded.'); return;
      }
      const write = call<Ask>('attention.answer',{id:ask.id,answer:value});
      setRequest(write); setConfirmation(undefined);
      await write.result;
    } finally { sending.current = false; guard.setBusy(false); if (mounted.current) setChecking(false); }
  }
  const href = safeHref(ask.href);
  return <article className="grid min-w-0 grid-cols-1 gap-5 p-5 [overflow-wrap:anywhere]">
    <header><p>{ask.agent ?? 'Household'} · {ask.state}</p><h1 className="text-2xl font-semibold">{ask.ask}</h1><p>{stamp(ask.createdAt)}{ask.project && ` · ${ask.project}`}</p></header>
    {ask.why && <section><h3>Why</h3><p className="whitespace-pre-wrap">{ask.why}</p></section>}
    {ask.if_yes && <section><h3>If yes</h3><p className="whitespace-pre-wrap">{ask.if_yes}</p></section>}
    {ask.if_no && <section><h3>If no</h3><p className="whitespace-pre-wrap">{ask.if_no}</p></section>}
    {link && ask.state === 'open' && <Button variant="outline" onClick={()=>go(link.path)}>{link.label}</Button>}
    {ask.member && ask.state === 'open' && !link && <p>Answer this in its private conversation. Private replies stay there.</p>}
    {ask.state === 'open' && !link && !ask.member && <>
      {!confirmed && <p role="status">{message || (checked.result?.ok === false ? `Couldn’t check this ask: ${checked.result.message}` : checked.result?.ok && checked.result.value.state !== 'open' ? 'This ask is no longer open.' : 'Checking whether this ask is still open…')}</p>}
      {!confirmed && !saving.pending && <Button variant="outline" disabled={snapshot.status !== 'live' || checking || busy} onClick={()=>{const request=startCheck(guard,ask.id);if(request){setMessage('');setConfirmation({records:snapshot.records,request});}}}>Check again</Button>}
      {confirmed && <fieldset disabled={checking || saving.pending || busy} className="grid gap-3">
        <legend>Record your answer</legend>
        {ask.answers !== 'words' && <div className="flex flex-wrap gap-2"><Button onClick={()=>void answer({kind:'yes'})}>Yes</Button><Button variant="outline" onClick={()=>void answer({kind:'no'})}>No</Button></div>}
        {ask.answers === 'words' && <><label className="grid gap-1">Your answer<Textarea value={draft} onChange={event=>setDraft(event.target.value)} rows={4} /></label><Button disabled={!draft.trim()} onClick={()=>void answer({kind:'words',text:draft})}>Record answer</Button></>}
        <div className="flex flex-wrap gap-2"><Button variant="outline" disabled={!!draft.trim()} onClick={()=>void answer({kind:'done'})}>Mark done</Button><Button variant="outline" disabled={!!draft.trim()} onClick={()=>void answer({kind:'dismiss'})}>Dismiss</Button></div>
      </fieldset>}
      <p>Answers are recorded here. Delivery to the agent is not connected in this preview.</p>
    </>}
    {saving.pending && <Loading label={saving.status === 'offline' ? 'Waiting for connection…' : 'Recording answer…'} />}
    {saving.result?.ok === false && <Error title="Couldn’t record your answer" text={saving.result.message} />}
    {saving.result?.ok && <p role="status">Answer recorded</p>}
    {ask.answer && <section><h3>Answer</h3><p>{ask.answer.kind} · {ask.answer.by.id} · {stamp(ask.answer.at)}</p>{ask.answer.text && <p className="whitespace-pre-wrap">{ask.answer.text}</p>}</section>}
    {ask.resolution && <section><h3>Resolved</h3><p>{ask.resolution}</p></section>}
    {(href || ask.refs?.length) && <section><h3>References</h3>{href && <a href={href} target="_blank" rel="noreferrer">Open reference</a>}{ask.refs?.length ? <ul>{ask.refs.map((ref,n)=><li key={n}>{ref}</li>)}</ul> : null}</section>}
  </article>;
}
export default function InboxApp({ path: shellPath, go }: { path?: string; go?: (path:string)=>void } = {}) {
  const [localPath,setLocalPath] = useState(() => typeof location === 'undefined' ? '/p/inbox-preview' : location.pathname);
  const path = (shellPath ?? localPath).split('?')[0], base = path.split('/ask/')[0];
  let selected: string | undefined;
  try { selected = path.includes('/ask/') ? decodeURIComponent(path.slice(path.indexOf('/ask/')+5)) : undefined; } catch { /* Malformed paths select nothing. */ }
  const snapshot = useRecords<Ask>('attention.ask'), {records,status} = snapshot;
  const [folder,setFolder] = useState('needs'), [query,setQuery] = useState('');
  const [opening,setOpening] = useState<{id:string;confirmation:Confirmation}>();
  const [busy,setBusy] = useState(false);
  const lock = useRef(false);
  const guard: Guard = {lock,busy,setBusy};
  function navigate(id?: string) {
    const record = records.find(a=>a.id===id);
    const request = record && status==='live' && record.state==='open' && !record.member && !decisionLink(record) ? startCheck(guard,record.id) : undefined;
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
  const shown = records.filter(a=>inFolder(a,folder) && matches(a,query)).sort((a,b)=>folder==='answered' ? b.changedAt-a.changedAt || a.id.localeCompare(b.id) : a.createdAt-b.createdAt || a.id.localeCompare(b.id));
  const agents = [...new Set(records.flatMap(a=>a.agent ? [a.agent] : []))].sort();
  return <Split className="h-full" label="Inbox" folder={folder} onFolder={id=>{setFolder(id);navigate();}}
    folders={[{id:'needs',label:'Needs you',count:records.filter(a=>a.state==='open').length},{id:'answered',label:'Answered',count:records.filter(a=>a.state!=='open').length},{heading:'By agent'},...agents.map(agent=>({id:`agent:${agent}`,label:agent,count:records.filter(a=>a.agent===agent && a.state==='open').length}))]}
    search={<label className="grid gap-1">Search asks<Input type="search" value={query} onChange={e=>setQuery(e.target.value)} /></label>}
    listTop={busy ? <p role="status" className="p-3">An answer is still being checked or recorded. Other answers wait.</p> : undefined}
    listTitle={folder==='answered' ? 'Answered' : folder.startsWith('agent:') ? `From ${folder.slice(6)}` : 'Needs you'} listMeta={shown.length}
    list={status==='loading' ? <Loading label="Opening Inbox…" /> : status!=='live' ? <Error text={status==='denied' ? 'Sign in to see your Inbox.' : 'Waiting for connection. Answers wait until loom is reachable.'} /> : <><List label="Ask list">{shown.map(ask=><Row key={ask.id} title={ask.ask} meta={ask.why} status={`${ask.agent ?? 'Household'} · ${ask.state}`} selected={ask.id===selected} onClick={()=>navigate(ask.id)} />)}</List>{!shown.length && <Empty title={query ? `Nothing matches “${query}”` : folder==='needs' ? 'Nothing needs you' : 'No asks here'} text={query ? 'Try another search.' : 'Asks from your agents appear here.'} />}</>}
    reader={current ? <AskReader key={current.id} ask={current} snapshot={snapshot} go={openLink} initialConfirmation={opening?.id===current.id ? opening.confirmation : undefined} guard={guard} onOpened={()=>setOpening(undefined)} /> : selected ? <Empty title="This ask is no longer in view" text="It may have changed or become unavailable." /> : null}
    open={!!selected} onBack={()=>navigate()} backLabel="Inbox" blank={<Empty title="Open an ask" text="Read the full question and what happens either way." />} />;
}
