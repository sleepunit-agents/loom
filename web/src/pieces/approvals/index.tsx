import { useEffect, useRef, useState, useSyncExternalStore, type FormEvent } from 'react';
import { call, useRecords, type Call, type CallState, type Snapshot } from '../../data';
import { Split, List, Row, Empty, Error, Loading, Button, Input } from '../../kit';
import { type Approval, type Rule, type Open, matches } from './model';

const idle: CallState<unknown> = { pending:false, status:'done' };
const noop = () => () => {};
function useCall<T>(request?: Call<T>) {
  return useSyncExternalStore(request?.subscribe ?? noop, request?.getSnapshot ?? (() => idle as CallState<T>));
}
function Result({ request }: { request?: Call<unknown> }) {
  const state = useCall(request);
  return state.pending ? <Loading label="Saving…" /> : state.result?.ok === false ? <Error text={state.result.message} /> : state.result?.ok ? <p role="status">Saved</p> : null;
}
function Reader({ approval, snapshot }: { approval: Approval; snapshot: Snapshot<Approval> }) {
  const [confirmation,setConfirmation] = useState<{ records: readonly Approval[]; request: Call<Open> }>();
  const [request,setRequest] = useState<Call<unknown>>();
  const [checking,setChecking] = useState(false);
  const latest = useRef(snapshot);
  latest.current = snapshot;
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; },[]);
  useEffect(() => {
    if (snapshot.status === 'live' && approval.state === 'pending') {
      setConfirmation({ records:snapshot.records, request:call<Open>('approvals.open',{id:approval.id}) });
    }
  },[snapshot.records,snapshot.status,approval.id,approval.state]);
  const state = useCall(confirmation?.request), saving = useCall(request);
  const confirmed = snapshot.status === 'live' && confirmation?.records === snapshot.records && state.result?.ok && state.result.value.open && state.result.value.mayAnswer;
  async function answer(action: 'allow' | 'deny' | 'every-time' | 'always') {
    if (!confirmed || checking || saving.pending) return;
    setChecking(true);
    const records = snapshot.records;
    const check = await call<Open>('approvals.open',{id:approval.id}).result;
    if (!mounted.current) return;
    setChecking(false);
    if (latest.current.status !== 'live' || latest.current.records !== records) return;
    if (!check.ok || !check.value.open || !check.value.mayAnswer) {
      setConfirmation(undefined);
      return;
    }
    if (action === 'every-time' && !check.value.mayEveryTime || action === 'always' && !check.value.mayAlways) return;
    if (action === 'always' && state.result?.ok && state.result.value.alwaysScope !== check.value.alwaysScope) { setConfirmation(undefined); return; }
    setRequest(action === 'every-time' || action === 'always' ? call(`approvals.${action}`,{id:approval.id,...(action === 'always' ? {scope:check.value.alwaysScope} : {})}) : call('approvals.answer',{id:approval.id,action}));
    setConfirmation(undefined);
  }
  return <article className="grid gap-5 p-5">
    <header><p>{approval.kind} · {approval.state}</p><h1 className="text-2xl font-semibold">{approval.title}</h1><p>{approval.who.agent} · for {approval.for === 'owner' ? 'you' : approval.for}</p></header>
    <section><h3>Why</h3><p>{approval.why}</p></section>
    {approval.if_yes && <section><h3>If you allow</h3><p>{approval.if_yes}</p></section>}
    {approval.if_no && <section><h3>If you deny</h3><p>{approval.if_no}</p></section>}
    {confirmed && state.result?.ok && state.result.value.mayEveryTime && <p>Allow every time: these exact words run as you until you turn the job off under Rules.</p>}
    {confirmed && state.result?.ok && state.result.value.mayAlways && <p>Always allows future merges across {state.result.value.alwaysScope?.replace('project:','the entire project ')}, for this same person, without asking.</p>}
    {approval.details && <section><h3>Details</h3><p className="whitespace-pre-wrap break-words">{approval.details}</p></section>}
    <section><h3>Exactly what this allows</h3><p className="break-words">{approval.kind}: {approval.target}</p></section>
    {confirmed && <div role="group" aria-label="Answer approval" className="flex gap-2"><Button disabled={checking || saving.pending} onClick={() => void answer('allow')}>Allow</Button>{state.result?.ok && state.result.value.mayEveryTime && <Button variant="outline" disabled={checking || saving.pending} onClick={()=>void answer('every-time')}>Allow every time</Button>}{state.result?.ok && state.result.value.mayAlways && <Button variant="outline" disabled={checking || saving.pending} onClick={()=>void answer('always')}>Always for {state.result.value.alwaysScope?.replace('project:','project ')}</Button>}<Button variant="outline" disabled={checking || saving.pending} onClick={() => void answer('deny')}>Deny</Button></div>}
    {approval.state === 'pending' && !confirmed && <p>{state.result?.ok && !state.result.value.mayAnswer ? 'You cannot answer this question.' : state.result?.ok === false ? state.result.message : 'Checking whether this question is still open…'}</p>}
    {approval.state==='pending' && !confirmed && !checking && !saving.pending && <Button variant="outline" onClick={()=>setConfirmation({records:snapshot.records,request:call<Open>('approvals.open',{id:approval.id})})}>Check again</Button>}
    <Result request={request} />
    {approval.by && <p>Answered by {approval.by}</p>}
  </article>;
}
function Rules() {
  const { records,status } = useRecords<Rule>('approval-rule');
  const [permission,setPermission] = useState<Call<{mayEdit:boolean}>>();
  const [request,setRequest] = useState<Call<unknown>>();
  const auth = useCall(permission), saving = useCall(request);
  useEffect(() => { if (status === 'live') setPermission(call('approvals.rules',{})); },[records,status]);
  const enabled = status === 'live' && auth.result?.ok && auth.result.value.mayEdit;
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (!enabled || saving.pending) return;
    const input = Object.fromEntries(new FormData(event.currentTarget));
    if (!input.person) delete input.person;
    setRequest(call('approvals.set-rule',input));
  }
  return <div className="grid gap-5 p-5"><h1>Household rules</h1>
    {status !== 'live' ? status==='loading' ? <Loading label="Opening rules…" /> : <Error text={status==='denied'?'Sign in to see rules.':'Waiting for connection.'} /> : <List label="Standing rules">{records.map(r => <Row key={r.id} title={r.scope ?? r.target ?? r.id} meta={`${r.kind}${r.person ? ` · for ${r.person}` : ''}`} status={r.tier ?? (r.off ? 'Turned off' : 'Every time')} actions={enabled && !r.scope && !r.off ? <Button variant="outline" disabled={saving.pending} onClick={()=>setRequest(call('approvals.standing-off',{id:r.id}))}>Turn off</Button> : undefined} />)}</List>}
    {enabled && <form aria-label="Set standing rule" onSubmit={submit} className="grid gap-3"><h3>Set a rule</h3><fieldset disabled={saving.pending} className="grid gap-3">
      <label>Action <select name="kind"><option value="merge">Merge</option><option value="host">Step on loom’s machine</option></select></label>
      <label>Scope<Input name="scope" required /></label><label>For someone else (optional)<Input name="person" /></label>
      <label>Rule <select name="tier"><option value="ask">Ask me</option><option value="tell">Tell me after</option><option value="do">Just do it</option><option value="none">Remove rule</option></select></label>
      <Button type="submit">Save rule</Button></fieldset><Result request={request} /></form>}
    {auth.result?.ok && !auth.result.value.mayEdit && <p>Only the household owner edits rules.</p>}
  </div>;
}
export default function ApprovalsApp({ path: shellPath, go }: { path?: string; go?: (path:string)=>void } = {}) {
  const [localPath,setLocalPath] = useState(() => typeof location === 'undefined' ? '/p/approvals-preview' : location.pathname);
  const path = shellPath ?? localPath, base = path.split('/approval/')[0];
  const selected = /\/approval\/(a-[0-9a-f]{8})$/.exec(path)?.[1];
  const snapshot = useRecords<Approval>('approval');
  const { records,status } = snapshot;
  const [folder,setFolder] = useState('pending'), [query,setQuery] = useState('');
  const [archiveRequest,setHistory] = useState<{ records:readonly Approval[]; request:Call<{approvals:Approval[]}> }>();
  const archive=useCall(archiveRequest?.request);
  const older=status==='live' && archiveRequest?.records===records && archive.result?.ok ? archive.result.value.approvals : [];
  const all=[...records,...older.filter(a=>!records.some(r=>r.id===a.id))];
  function navigate(id?: string) {
    const next = id ? `${base}/approval/${id}` : base;
    if (go) go(next); else { history.pushState(null,'',next); setLocalPath(next); }
  }
  useEffect(() => {
    if (go || typeof window === 'undefined') return;
    const pop = () => setLocalPath(location.pathname);
    window.addEventListener('popstate',pop); return () => window.removeEventListener('popstate',pop);
  },[go]);
  const current = status === 'live' ? all.find(a => a.id === selected) : undefined;
  const shown = all.filter(a => (folder === 'pending' ? a.state === 'pending' : a.state !== 'pending') && matches(a,query)).sort((a,b) => b.at.localeCompare(a.at));
  return <Split className="h-full" label="Approvals" folder={folder} onFolder={id => { setFolder(id); navigate(); }}
    folders={[{id:'pending',label:'Pending',count:records.filter(a=>a.state==='pending').length},{id:'history',label:'History'},{id:'rules',label:'Rules'}]}
    search={<label>Search approvals<Input type="search" value={query} onChange={e=>setQuery(e.target.value)} /></label>}
    listTop={folder === 'history' ? <div className="p-3"><Button variant="outline" disabled={status!=='live'||archive.pending} onClick={()=>setHistory({records,request:call('approvals.history',{})})}>Load older approvals</Button>{archive.result?.ok===false && <Error text={archive.result.message} />}</div> : undefined}
    listTitle={folder === 'rules' ? 'Rules' : 'Approvals'} listMeta={folder === 'rules' ? undefined : shown.length}
    list={folder === 'rules' ? <Rules /> : status === 'loading' ? <Loading label="Opening approvals…" /> : status !== 'live' ? <Error text={status === 'denied' ? 'Sign in to see approvals.' : 'Waiting for connection.'} /> : <><List label="Approval list">{shown.map(a=><Row key={a.id} title={a.title} meta={a.why} status={`${a.who.agent} · ${a.state}`} selected={selected===a.id} onClick={()=>navigate(a.id)} />)}</List>{!shown.length && <Empty title="No approvals here" text={query ? 'Try another search.' : 'Choose another folder.'} />}</>}
    reader={current ? <Reader key={current.id} approval={current} snapshot={snapshot} /> : selected ? <Empty title="This approval is no longer in view" text="It may have changed or become unavailable." /> : null}
    open={!!selected} onBack={()=>navigate()} backLabel="Approvals" blank={<Empty title="Open a question" text="Read the question and what happens either way before answering." />} />;
}
