import { useEffect, useRef, useState } from 'react';
import { callOnce, useRecords } from '../../data';
import { Button, Empty, Error, Loading, Textarea } from '../../kit';
import { commsThreadPath, safeHref, type Ask } from './model';
import { stamp } from './time';
import type { Guard } from './index';

export interface SealedQuestion {
  id: string; thread: string; seq: number; state: Ask['state']; createdAt: number; changedAt: number;
  keepUntil: number; answer?: Ask['answer'];
  question: null | { ask: string; why?: string; if_yes?: string; if_no?: string; href?: string; refs?: string[]; answers: 'yes-no' | 'words' };
  [key: string]: unknown;
}
/** Only the selected ref is subscribed. Decrypted words never enter Attention or device storage. */
export function SealedQuestionReader({ ask, guard, go }: { ask: Ask; guard: Guard; go(path:string):void }) {
  const snapshot = useRecords<SealedQuestion>('comms.question', ask.id);
  const [now,setNow] = useState(Date.now), [draft,setDraft] = useState('');
  const [checked,setChecked] = useState<readonly SealedQuestion[]>(), [message,setMessage] = useState('');
  const latest = useRef(snapshot); latest.current = snapshot;
  const latestAsk = useRef(ask); latestAsk.current = ask;
  const mounted = useRef(true);
  useEffect(()=>{mounted.current=true;return ()=>{mounted.current=false;};},[]);
  const row = snapshot.status === 'live' ? snapshot.records.find(q=>q.id===ask.id && q.thread===ask.privateQuestion?.thread && q.seq===ask.privateQuestion.seq && q.state===ask.state && q.changedAt===ask.changedAt) : undefined;
  const retained = row && Number.isFinite(row.keepUntil) && row.keepUntil > Math.max(now,Date.now());
  const question = retained ? row.question : null;
  useEffect(()=>{
    if (!row || !Number.isFinite(row.keepUntil)) return;
    const current=Date.now();
    // The deadline can pass between render and this passive effect. Withdraw now rather than skip the timer.
    if (row.keepUntil<=current) { if (now<row.keepUntil) setNow(current); return; }
    const timer=setTimeout(()=>setNow(Date.now()),Math.min(2147483647,Math.max(1,row.keepUntil-current)));
    return ()=>clearTimeout(timer);
  },[row,now]);
  // Withdraw drafts and confirmation on connection/scope/retention loss.
  useEffect(()=>{setChecked(undefined);setDraft('');setMessage('');},[snapshot.records,snapshot.status,!!question]);
  const confirmed = !!question && checked===snapshot.records;
  async function act(answer?: 'yes'|'no'|'words') {
    if (!row || !question || row.state!=='open' || guard.lock.current || guard.busy || answer && !confirmed || answer==='words' && (!draft.trim() || draft.length>4000)) return;
    const records=snapshot.records, original=JSON.stringify(row), originalAsk=JSON.stringify(ask), words=draft;
    guard.lock.current=true;guard.setBusy(true);setMessage('');
    try {
      // Ephemeral plaintext response: never put a Call carrying words in component state.
      const fresh=await callOnce<SealedQuestion>('comms.question',{ref:ask.id}).result;
      if (!mounted.current) return;
      if (JSON.stringify(latestAsk.current)!==originalAsk || latest.current.status!=='live' || latest.current.records!==records || !fresh.ok || JSON.stringify(fresh.value)!==original || fresh.value.keepUntil<=Date.now() || !fresh.value.question) {
        setChecked(undefined);setMessage('This question changed or could not be checked. Nothing was recorded.');return;
      }
      if (!answer) {setChecked(records);return;}
      setChecked(undefined);
      const result=await (answer==='words'
        ? callOnce('comms.replyToAsk',{ref:ask.id,text:words})
        : callOnce('comms.answer',{thread:row.thread,ref:ask.id,verdict:answer})).result;
      if (!mounted.current || latest.current.status!=='live' || latest.current.records!==records) return;
      setMessage(result.ok?'Private answer saved in Comms':`Couldn’t record your answer: ${result.message}`);
      if (result.ok) setDraft('');
    } finally {guard.lock.current=false;guard.setBusy(false);}
  }
  const href=safeHref(question?.href);
  return <article className="grid min-w-0 gap-5 p-5 [overflow-wrap:anywhere]">
    <header><p>{ask.agent} · {row?.state??ask.state}</p><h1 className="text-2xl font-semibold">{question?.ask??'Private question'}</h1><p>{stamp(ask.createdAt)}</p></header>
    {snapshot.status==='loading'?<Loading label="Opening private question…"/>:snapshot.status!=='live'?<Error text="Private question unavailable. Waiting for your signed-in connection."/>:!row?<Empty title="This question is no longer in view"/>:!question?<p>Words no longer kept</p>:<>
      {question.why&&<section><h3>Why</h3><p className="whitespace-pre-wrap">{question.why}</p></section>}
      {question.if_yes&&<section><h3>If yes</h3><p className="whitespace-pre-wrap">{question.if_yes}</p></section>}
      {question.if_no&&<section><h3>If no</h3><p className="whitespace-pre-wrap">{question.if_no}</p></section>}
      <p>Private words kept until {stamp(row.keepUntil)}.</p>
      {row.state==='open'&&!ask.sourceManaged&&!ask.waits_on&&<>
        {!confirmed&&<Button variant="outline" disabled={guard.busy} onClick={()=>void act()}>Check private question</Button>}
        {confirmed&&<fieldset disabled={guard.busy} className="grid gap-3"><legend>Reply privately</legend>
          {question.answers==='yes-no'&&<div className="flex gap-2"><Button disabled={!!draft.trim()} onClick={()=>void act('yes')}>Yes</Button><Button variant="outline" disabled={!!draft.trim()} onClick={()=>void act('no')}>No</Button></div>}
          <label className="grid gap-1">Your private reply<Textarea rows={4} maxLength={4000} value={draft} onChange={e=>setDraft(e.target.value)}/></label>
          <Button disabled={!draft.trim()||draft.length>4000} onClick={()=>void act('words')}>Send private reply</Button>
          <p>Your reply stays encrypted in Comms. This draft stays in this window only.</p>
        </fieldset>}
      </>}
      {(href||question.refs?.length)&&<section><h3>References</h3>{href&&<a href={href} target="_blank" rel="noreferrer">Open reference</a>}{question.refs?.map((ref,i)=><p key={i}>{ref}</p>)}</section>}
    </>}
    {message&&<p role="status">{message}</p>}
    {row?.answer&&<section><h3>Answer</h3><p>{row.answer.kind} · {row.answer.by.id} · {stamp(row.answer.at)}</p></section>}
    {row&&<Button variant="outline" onClick={()=>go(commsThreadPath(row.thread))}>Open private conversation</Button>}
    {row?.answer?.reply&&<Button variant="outline" onClick={()=>go(commsThreadPath(row.answer!.reply!.thread))}>Open private reply</Button>}
  </article>;
}
