import { useState, type FormEvent } from 'react';
import { Button, Input, Textarea } from '../../kit';
import type { Schedule } from './model';
import { send } from './request';
type Fresh = { id:string; agent:string; prompt:string; note:string; at:string; days:string };
export function ScheduleRecovery({schedule,enabled}:{schedule:Schedule;enabled:boolean}) {
  const [review,setReview]=useState<Fresh>();
  function submit(e:FormEvent<HTMLFormElement>) {
    e.preventDefault(); if(!enabled || !schedule.canRecover) return;
    const data=new FormData(e.currentTarget);
    setReview({id:schedule.id,agent:schedule.agent,prompt:String(data.get('prompt')??''),note:String(data.get('note')??''),at:String(data.get('at')??''),days:String(data.get('days')??'')});
  }
  return <section className="grid gap-3">
    <h2>Recover as my schedule</h2>
    <p>Enter new work and timing as the household owner. Saving replaces the imported schedule and cancels its unstarted occurrences. It creates one next occurrence; pause and dispatch checks still apply.</p>
    <form aria-label="Recover imported schedule" className="grid gap-3" onSubmit={submit} onChange={()=>setReview(undefined)}>
      <fieldset disabled={!enabled} className="grid gap-3">
        <p>Agent: {schedule.agent} · Schedule: {schedule.id}</p>
        <label className="grid gap-1">New note<Input name="note" /></label>
        <label className="grid gap-1">New prompt<Textarea name="prompt" required rows={6} /></label>
        <label className="grid gap-1">New times (CT)<Input name="at" required placeholder="13:17" /></label>
        <label className="grid gap-1">New days<Input name="days" placeholder="Mon-Fri (empty means every day)" /></label>
        <Button type="submit" variant="outline">Review new schedule</Button>
      </fieldset>
    </form>
    {review && <section aria-label="Confirm schedule recovery" className="grid gap-2">
      <p>Save this new work as your schedule for {review.agent}?</p>
      <p className="whitespace-pre-wrap break-words">{review.note || '(Empty note)'}</p>
      <p className="whitespace-pre-wrap break-words">{review.prompt}</p>
      <p>{review.at} CT · {review.days || 'Every day'}</p>
      <Button variant="outline" disabled={!enabled} onClick={()=>{if(enabled && schedule.canRecover){send('scheduleRecover',review);setReview(undefined);}}}>Save my new schedule</Button>
      <Button variant="outline" onClick={()=>setReview(undefined)}>Keep disabled</Button>
    </section>}
  </section>;
}
