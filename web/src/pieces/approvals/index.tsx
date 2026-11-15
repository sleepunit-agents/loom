import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { call, type Call, type CallState, type Snapshot } from '../../data';
import { Error, Loading, Button } from '../../kit';
import { type Approval, type Open } from './model';

const idle: CallState<unknown> = { pending:false, status:'done' };
const noop = () => () => {};
function useCall<T>(request?: Call<T>) {
  return useSyncExternalStore(request?.subscribe ?? noop, request?.getSnapshot ?? (() => idle as CallState<T>));
}
function Result({ request }: { request?: Call<unknown> }) {
  const state = useCall(request);
  return state.pending ? <Loading label="Saving…" /> : state.result?.ok === false ? <Error text={state.result.message} /> : state.result?.ok ? <p role="status">Saved</p> : null;
}
export function ApprovalReader({ approval, snapshot }: { approval: Approval; snapshot: Snapshot<Approval> }) {
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
  return <article className="grid min-w-0 grid-cols-1 gap-5 p-5 [overflow-wrap:anywhere]">
    <header><p>{approval.kind} · {approval.state}</p><h1 className="text-2xl font-semibold">{approval.title}</h1><p>{approval.who.agent} · for {approval.for === 'owner' ? 'you' : approval.for}</p></header>
    <section><h3>Why</h3><p>{approval.why}</p></section>
    {approval.if_yes && <section><h3>If you allow</h3><p>{approval.if_yes}</p></section>}
    {approval.if_no && <section><h3>If you deny</h3><p>{approval.if_no}</p></section>}
    {confirmed && state.result?.ok && state.result.value.mayEveryTime && <p>Allow every time: these exact words run as you until you turn the job off under Rules.</p>}
    {confirmed && state.result?.ok && state.result.value.mayAlways && <p>Always allows future merges across {state.result.value.alwaysScope?.replace('project:','the entire project ')}, for this same person, without asking.</p>}
    {approval.details && <section><h3>Details</h3><p className="whitespace-pre-wrap [overflow-wrap:anywhere]">{approval.details}</p></section>}
    <section><h3>Exactly what this allows</h3><p className="[overflow-wrap:anywhere]">{approval.kind}: {approval.target}</p></section>
    {confirmed && <div role="group" aria-label="Answer approval" className="flex flex-wrap gap-2 [&_button]:max-w-full [&_button]:whitespace-normal"><Button disabled={checking || saving.pending} onClick={() => void answer('allow')}>Allow</Button>{state.result?.ok && state.result.value.mayEveryTime && <Button variant="outline" disabled={checking || saving.pending} onClick={()=>void answer('every-time')}>Allow every time</Button>}{state.result?.ok && state.result.value.mayAlways && <Button variant="outline" disabled={checking || saving.pending} onClick={()=>void answer('always')}>Always for {state.result.value.alwaysScope?.replace('project:','project ')}</Button>}<Button variant="outline" disabled={checking || saving.pending} onClick={() => void answer('deny')}>Deny</Button></div>}
    {approval.state === 'pending' && !confirmed && <p>{state.result?.ok && !state.result.value.mayAnswer ? 'You cannot answer this question.' : state.result?.ok === false ? state.result.message : 'Checking whether this question is still open…'}</p>}
    {approval.state==='pending' && !confirmed && !checking && !saving.pending && <Button variant="outline" onClick={()=>setConfirmation({records:snapshot.records,request:call<Open>('approvals.open',{id:approval.id})})}>Check again</Button>}
    <Result request={request} />
    {approval.by && <p>Answered by {approval.by}</p>}
  </article>;
}
