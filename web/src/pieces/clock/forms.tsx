import type { FormEvent } from 'react';
import { Button, Input, Textarea } from '../../kit';
import type { Schedule } from './model';
import { send } from './request';
export function WorkForm({ kind, schedule, enabled, back }: { kind: 'wake' | 'schedule' | 'lane'; schedule?: Schedule; enabled: boolean; back(): void }) {
  const lane = kind === 'lane';
  function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault(); if (!enabled) return;
    const values = Object.fromEntries(new FormData(e.currentTarget));
    const input: Record<string, unknown> = { agent: values.agent, note: values.note };
    if (values.model) input.model = values.model;
    if (lane) {
      Object.assign(input, { name: values.name, at: values.at, days: values.days, text: values.text, local: values.local === 'on' });
      if (values.slot) input.slot = values.slot;
    } else {
      input[values.content === 'file' ? 'file' : 'prompt'] = values.words;
      if (values.project) input.project = values.project;
      if (values.member) input.member = values.member;
      if (kind === 'wake') input.when = values.when;
      else Object.assign(input, { id: values.id, at: values.at, days: values.days });
    }
    send(lane ? 'laneSet' : kind === 'wake' ? 'in' : 'scheduleSet', input);
  }
  return <form aria-label={schedule ? 'Edit schedule' : `Create ${kind}`} onSubmit={submit} className="grid gap-3 p-5">
    <h2>{schedule ? `Edit ${lane ? 'lane' : 'schedule'}` : `Create ${kind}`}</h2>
    <fieldset disabled={!enabled} className="grid gap-3">
      <label className="grid gap-1">Agent<Input name="agent" required defaultValue={schedule?.agent ?? 'art'} readOnly={!!schedule && !lane} /></label>
      <label className="grid gap-1">Note<Input name="note" required={!lane} defaultValue={schedule?.note} /></label>
      {kind === 'wake' ? <label className="grid gap-1">In<Input name="when" required placeholder="2h or 30m" /></label> : <>
        <label className="grid gap-1">{lane ? 'Lane name' : 'Schedule id'}<Input name={lane ? 'name' : 'id'} required defaultValue={lane ? schedule?.lane : schedule?.id} readOnly={!!schedule} /></label>
        <label className="grid gap-1">Times (CT)<Input name="at" required defaultValue={schedule?.at.join(', ') ?? '08:31'} placeholder="08:31, 14:31" /></label>
        <label className="grid gap-1">Days<Input name="days" defaultValue={schedule?.days ?? ''} placeholder="Mon-Fri (empty means every day)" /></label>
      </>}
      {lane ? <>
        <label className="grid gap-1">Lane text<Textarea name="text" required defaultValue={schedule?.laneDetails?.text} rows={10} /></label>
        <p>Replacing text clears its former source-file link.</p>
        <label><input type="checkbox" name="local" defaultChecked={schedule?.laneDetails?.local} /> Prefer loom’s machine (approval still required)</label>
        <label className="grid gap-1">Slot<Input name="slot" defaultValue={schedule?.slot} /></label>
      </> : <>
        <label>Content <select name="content" defaultValue={schedule?.file ? 'file' : 'prompt'}><option value="prompt">Prompt</option><option value="file">Repository file</option></select></label>
        <label className="grid gap-1">Words or file path<Textarea name="words" required defaultValue={schedule?.file ?? schedule?.prompt} rows={6} /></label>
        <label className="grid gap-1">Project<Input name="project" defaultValue={schedule?.project} readOnly={!!schedule} /></label>
        <label className="grid gap-1">Private to member<Input name="member" defaultValue={schedule?.member} readOnly={!!schedule} /></label>
      </>}
      <label className="grid gap-1">Model (optional)<Input name="model" defaultValue={schedule?.model} /></label>
      <Button variant="outline" type="submit">Save {kind}</Button>
    </fieldset>
    <Button variant="outline" type="button" onClick={back}>Back to clock</Button>
  </form>;
}
