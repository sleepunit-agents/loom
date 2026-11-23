import { tempoFailureMessage } from './actions';
import { NativeSelect } from '../../kit/native-select';
import { useRef, useState, type FormEvent } from 'react';
import { Button, Input, Textarea } from '../../kit';
import type { NewTrigger } from '../../../../src/core/tempo/triggers';
export type { NewTrigger };
export function CreateTrigger({ timezone, submit, done }: { timezone: string; submit(input: NewTrigger): Promise<void>; done(): void }) {
  const [source, setSource] = useState<NewTrigger['sourceKind']>('time');
  const [owner, setOwner] = useState<NewTrigger['ownerKind']>('member');
  const [target, setTarget] = useState<NewTrigger['targetKind']>('inbox');
  const [content, setContent] = useState('words');
  const [busy, setBusy] = useState(false), [failure, setFailure] = useState('');
  const pending = useRef(false);
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (pending.current) return;
    const data = new FormData(event.currentTarget), text = (name: string) => String(data.get(name) ?? '').trim();
    const to = text('to');
    const input: NewTrigger = { ownerKind: owner, owner: owner === 'household' ? null : text('owner'),
      sourceKind: source, lifespan: text('lifespan') as NewTrigger['lifespan'], targetKind: target,
      note: text('note'), project: text('project') || null,
      ...(source === 'time' ? { times: text('times'), days: text('days') || null } : { watches: text('watches') }),
      ...(to ? { toKind: text('toKind') as 'person' | 'agent', to } : {}),
      ...(target === 'operation' ? { target: text('target') } : content === 'file' ? { file: text('words') } : { instructions: text('words') }) };
    pending.current = true; setBusy(true); setFailure('');
    try { await submit(input); done(); }
    catch (error) { setFailure(tempoFailureMessage(error, 'Tempo could not create that trigger. Check the details and your access.')); }
    finally { pending.current = false; setBusy(false); }
  }
  return <form aria-label="Create trigger" onSubmit={save} className="grid gap-3 p-5">
    <h1>Create trigger</h1>
    <fieldset disabled={busy} className="grid gap-3">
      <label>Label<Input name="note" required /></label>
      <label>Source<NativeSelect aria-label="Source" value={source} onChange={e => setSource(e.target.value as typeof source)}><option value="time">A time</option><option value="pull-request">A pull request changing</option><option value="answer">An answer arriving</option><option value="job">A job stopping</option></NativeSelect></label>
      {source === 'time' ? <>
        <label>Time ({timezone})<Input name="times" required placeholder="08:31" /></label>
        <p>Use household times such as 08:31, 14:31, or a date with its offset such as 2026-11-20T08:31-06:00.</p>
        <label>Days<Input name="days" placeholder="weekdays, or leave empty for every day" /></label>
      </> : <label>{source === 'pull-request' ? 'Pull request' : source === 'job' ? 'Job' : 'Answer to'}<Input name="watches" required placeholder={source === 'pull-request' ? 'change:…' : source === 'job' ? 'job:…' : 'approval:… or question:…'} /></label>}
      <label>Lifespan<NativeSelect aria-label="Lifespan" name="lifespan" defaultValue="once"><option value="once">The next time only</option><option value="today">For today</option><option value="until-stopped">Until stopped</option></NativeSelect></label>
      <label>Set by<NativeSelect aria-label="Set by" value={owner} onChange={e => setOwner(e.target.value as typeof owner)}><option value="member">A person</option><option value="agent">An agent</option><option value="household">The household</option></NativeSelect></label>
      {owner !== 'household' && <label>{owner === 'member' ? 'Person' : 'Agent'}<Input name="owner" required /></label>}
      <label>Target<NativeSelect aria-label="Target" value={target} onChange={e => setTarget(e.target.value as typeof target)}><option value="inbox">An inbox item</option><option value="operation">An operation</option></NativeSelect></label>
      <label>Recipient kind<NativeSelect aria-label="Recipient kind" name="toKind"><option value="agent">Agent</option><option value="person">Person</option></NativeSelect></label>
      <label>Recipient<Input name="to" required={target === 'inbox'} /></label>
      {target === 'operation' ? <label>Operation<Input name="target" required placeholder="tempo.sweep" /></label> : <>
        <label>Content<NativeSelect aria-label="Content" value={content} onChange={e => setContent(e.target.value)}><option value="words">Words</option><option value="file">Repository file</option></NativeSelect></label>
        <label>{content === 'file' ? 'Repository file' : 'Words'}<Textarea name="words" required /></label>
      </>}
      <label>Project<Input name="project" /></label>
      <Button variant="primary" type="submit">{busy ? 'Creating…' : 'Create trigger'}</Button>
    </fieldset>
    {failure && <p role="alert">{failure}</p>}
    <Button type="button" variant="outline" onClick={done}>Back to Tempo</Button>
  </form>;
}
