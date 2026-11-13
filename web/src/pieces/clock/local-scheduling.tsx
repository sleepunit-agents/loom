import { useState, type FormEvent } from 'react';
import type { Snapshot } from '../../data';
import { Button, Input, Error, Loading } from '../../kit';
import type { Approval } from '../approvals/model';
import { time } from './model';
import { send, useRequest } from './request';

type Timing = { approval: string; mode: 'in' | 'at'; when: string; standing: boolean };
/** The window chooses timing only. Clock recovers immutable words and authority. */
export function LocalScheduling({ approval, snapshot }: { approval: Approval; snapshot: Snapshot<Approval> }) {
  const receipt = useRequest();
  const [review,setReview] = useState<{records: readonly Approval[]; input: Timing}>();
  const eligible = snapshot.status === 'live' && ['allowed','used'].includes(approval.state);
  const enabled = eligible && !receipt?.pending;
  const currentReview = review?.records === snapshot.records ? review : undefined;
  const ownReceipt = receipt?.operation === 'scheduleLocalFromWindow' && (receipt.input as Timing)?.approval === approval.id ? receipt : undefined;
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (!enabled) return;
    const values = new FormData(event.currentTarget);
    const mode = values.get('mode'), authority = values.get('authority'), when = String(values.get('when') ?? '');
    if ((mode !== 'in' && mode !== 'at') || !['once','standing'].includes(String(authority)) || !when.trim()) return;
    setReview({records:snapshot.records,input:{approval:approval.id,mode,when,standing:authority === 'standing'}});
  }
  return <section aria-label="Schedule saved local work" className="grid min-w-0 gap-3 p-5 [overflow-wrap:anywhere]">
    <h2>Schedule saved local work</h2>
    <p>Ask your agent in your private conversation to file new local work. Its exact saved words appear above. Allowing a request starts nothing.</p>
    <p>Scheduling keeps those words and the original note. Local delivery is still held; a saved wake does not mean a body has started.</p>
    {eligible ? <form aria-label="Local work timing" onSubmit={submit} className="grid gap-3">
      <fieldset disabled={!enabled} className="grid gap-3">
        <label>Timing <select name="mode" required defaultValue=""><option value="" disabled>Choose explicitly</option><option value="in">In</option><option value="at">At (CT)</option></select></label>
        <label>When<Input name="when" required placeholder="30m, or 2026-11-14 08:31 for At" /></label>
        <label>Use approval <select name="authority" required defaultValue=""><option value="" disabled>Choose explicitly</option><option value="once">One-time Allow</option><option value="standing">Existing Allow every time</option></select></label>
        <p>One-time Allow can be spent once before expiry. Every-time requires an existing active rule for these exact words and permits one outstanding wake.</p>
        <Button variant="outline" type="submit">Review timing</Button>
      </fieldset>
    </form> : <p>Allow this request before choosing a time. Denied, expired and withdrawn requests cannot be scheduled.</p>}
    {currentReview && <section aria-label="Confirm local timing" className="grid gap-3">
      <h3>Confirm these saved words and timing</h3>
      <p className="whitespace-pre-wrap">{approval.details}</p>
      <p>{currentReview.input.mode === 'at' ? 'At (CT)' : 'In'}: {currentReview.input.when}</p>
      <p>{currentReview.input.standing ? 'Use existing Allow every time' : 'Spend one-time Allow'}</p>
      <Button variant="outline" disabled={!enabled} onClick={() => { if (enabled && currentReview.records === snapshot.records) { send('scheduleLocalFromWindow',currentReview.input); setReview(undefined); } }}>Schedule these saved words</Button>
      <Button variant="outline" onClick={() => setReview(undefined)}>Keep unscheduled</Button>
    </section>}
    {ownReceipt?.pending && <Loading label="Saving local timing…" />}
    {ownReceipt?.result && (ownReceipt.result.ok ? <p role="status">Saved wake {(ownReceipt.result.value as {id:string}).id}, due {time((ownReceipt.result.value as {due:number}).due)}. Local delivery remains held.</p> : <Error title="Couldn’t schedule local work" text={ownReceipt.result.message} />)}
  </section>;
}
