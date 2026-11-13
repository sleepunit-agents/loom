import { useState, useSyncExternalStore, type FormEvent } from 'react';
import type { Call } from '../../data';
import { Button, Input, Error, Loading } from '../../kit';
import type { LinkInput } from './model';
import type { RouteWrite } from './route-editor';

const idle = { pending: false, status: 'done' as const };
const noop = () => () => {};

export function LinkEditor({ link, fresh, request, busy, write }: {
  link: LinkInput; fresh: boolean; request?: RouteWrite; busy?: Call<{ id: string }>;
  write: (kind: RouteWrite['kind'], input: LinkInput | { id: string }) => void;
}) {
  const [draft, setDraft] = useState(link);
  const current = JSON.stringify(link);
  const [observed, setObserved] = useState({ signature: current, stale: false });
  if (observed.signature !== current) setObserved({ signature: current, stale: true });
  const [confirm, setConfirm] = useState(false);
  const answer = useSyncExternalStore(request?.call.subscribe ?? noop, request?.call.getSnapshot ?? (() => idle));
  const busyAnswer = useSyncExternalStore(busy?.subscribe ?? noop, busy?.getSnapshot ?? (() => idle));
  const pending = answer.pending || busyAnswer.pending;
  const changed = observed.stale || observed.signature !== current;
  const disabled = pending || changed;
  const complete = !!draft.workspace && !!draft.user && !!draft.person;
  const field = (key: 'workspace' | 'user' | 'person', label: string) =>
    <label className="grid min-w-0 gap-1">{label}<Input aria-label={label} value={draft[key]} required maxLength={200} disabled={pending}
      onChange={e => { setDraft({ ...draft, [key]: e.target.value }); setConfirm(false); }} /></label>;
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (disabled || !complete) return;
    write('save', draft); setConfirm(false);
  };
  return <form className="grid min-w-0 gap-4" onSubmit={submit}>
    <h2>{fresh ? 'New person link' : 'Edit person link'}</h2>
    <p>This maps a platform account to a People person ID. Intake uses that identity; runtime policy decides admission. It does not grant access or change the person’s tier.</p>
    <div className="flex flex-wrap gap-2" role="group" aria-label="Platform">
      {(['discord', 'slack'] as const).map(platform => <Button key={platform} type="button" variant="outline" aria-pressed={draft.platform === platform}
        disabled={pending} onClick={() => { setDraft({ ...draft, platform }); setConfirm(false); }}>{platform === 'discord' ? 'Discord' : 'Slack'}</Button>)}
    </div>
    {field('workspace', 'Workspace ID')}{field('user', 'Platform user ID')}{field('person', 'Person ID')}
    {changed && <Error title="This person link changed" text="Reload the current person link before saving your changes." retry={() => {
      setDraft(link); setObserved({ signature: current, stale: false }); setConfirm(false);
    }} />}
    <div className="flex flex-wrap gap-2"><Button type="submit" disabled={disabled || !complete}>Save person link</Button>
      {!fresh && <Button type="button" variant="outline" disabled={disabled} onClick={() => { if (!disabled) setConfirm(true); }}>Remove person link</Button>}</div>
    {confirm && !changed && <section className="grid gap-2"><p>Remove this person link? Future intake must find an unambiguous remaining link before it can use this account’s identity.</p>
      <Button type="button" disabled={disabled} onClick={() => { if (!disabled) { write('remove', { id: link.id }); setConfirm(false); } }}>Confirm removal</Button>
      <Button type="button" variant="outline" onClick={() => setConfirm(false)}>Keep person link</Button></section>}
    {busyAnswer.pending && !answer.pending && <Loading label="Another setup change is pending…" />}
    {answer.pending && <Loading label={request?.kind === 'remove' ? 'Removing person link…' : 'Saving person link…'} />}
    {answer.result?.ok === false && <Error title="Couldn’t change person link" text={`${answer.result.code}: ${answer.result.message}`} />}
    {answer.result?.ok && <p role="status">{request?.kind === 'remove' ? 'Person link removed' : 'Person link saved'}</p>}
  </form>;
}
