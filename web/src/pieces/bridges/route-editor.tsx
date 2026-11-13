import { useState, useSyncExternalStore, type FormEvent } from 'react';
import { type Call } from '../../data';
import { Button, Input, Textarea, Error, Loading } from '../../kit';
import type { RouteInput } from './model';

export interface RouteWrite { kind: 'save' | 'remove'; call: Call<{ id: string }> }
const idle = { pending: false, status: 'done' as const };
const noop = () => () => {};
const signature = (route: RouteInput) => JSON.stringify(route);
const lines = (text: string) => text.split('\n').filter(s => s.length > 0);

/** Writes stay owned by the app, so navigation cannot release the pending lock. */
export function RouteEditor({ route, fresh, request, busy, write }: {
  route: RouteInput; fresh: boolean; request?: RouteWrite; busy?: Call<{ id: string }>;
  write: (kind: RouteWrite['kind'], input: RouteInput | { id: string }) => void;
}) {
  const [draft, setDraft] = useState(route);
  const current = signature(route);
  const [observed, setObserved] = useState({ signature: current, stale: false });
  if (observed.signature !== current) setObserved({ signature: current, stale: true });
  const [readers, setReaders] = useState(route.readers.join('\n'));
  const [notes, setNotes] = useState(route.notes.join('\n'));
  const [editedLists, setEditedLists] = useState({ readers: false, notes: false });
  const [confirm, setConfirm] = useState(false);
  const answer = useSyncExternalStore(request?.call.subscribe ?? noop, request?.call.getSnapshot ?? (() => idle));
  const busyAnswer = useSyncExternalStore(busy?.subscribe ?? noop, busy?.getSnapshot ?? (() => idle));
  const changed = observed.stale || observed.signature !== current;
  const pending = answer.pending || busyAnswer.pending;
  const disabled = pending || changed;
  const field = (key: 'workspace' | 'channel' | 'parent' | 'primary' | 'pair', label: string, required = false) =>
    <label className="grid min-w-0 gap-1">{label}<Input aria-label={label} value={draft[key] ?? ''} required={required} maxLength={200}
      disabled={pending} onChange={e => { setDraft({ ...draft, [key]: e.target.value }); setConfirm(false); }} /></label>;
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (disabled || !draft.workspace || !draft.channel) return;
    write('save', { ...draft, workspace: draft.workspace, channel: draft.channel,
      parent: draft.parent || undefined, primary: draft.primary || undefined,
      pair: draft.pair || undefined, readers: editedLists.readers ? lines(readers) : draft.readers,
      notes: editedLists.notes ? lines(notes) : draft.notes });
    setConfirm(false);
  };
  return <form className="grid min-w-0 gap-4" onSubmit={submit}>
    <h2>{fresh ? 'New route' : 'Edit route'}</h2>
    <p>Routes choose where messages go. Changes affect future intake and pending replies.</p>
    <div className="flex flex-wrap gap-2" role="group" aria-label="Platform">
      {(['discord', 'slack'] as const).map(platform => <Button key={platform} type="button" variant="outline" aria-pressed={draft.platform === platform}
        disabled={pending} onClick={() => { setDraft({ ...draft, platform }); setConfirm(false); }}>{platform === 'discord' ? 'Discord' : 'Slack'}</Button>)}
    </div>
    {field('workspace', 'Workspace ID', true)}{field('channel', 'Channel ID', true)}
    {field('parent', 'Parent channel ID')}{field('primary', 'Primary agent')}{field('pair', 'Paired webhook ID')}
    <div className="flex flex-wrap gap-2">
      <Button type="button" variant="outline" aria-pressed={draft.peer} disabled={pending} onClick={() => { setDraft({ ...draft, peer: !draft.peer }); setConfirm(false); }}>Peers {draft.peer ? 'enabled' : 'disabled'}</Button>
      <Button type="button" variant="outline" aria-pressed={draft.guest} disabled={pending} onClick={() => { setDraft({ ...draft, guest: !draft.guest }); setConfirm(false); }}>{draft.guest ? 'Guest route' : 'Household route'}</Button>
    </div>
    <label className="grid min-w-0 gap-1">Reader agents (one per line)<Textarea aria-label="Reader agents" value={readers} disabled={pending} onChange={e => { setReaders(e.target.value); setEditedLists({ ...editedLists, readers: true }); setConfirm(false); }} /></label>
    <label className="grid min-w-0 gap-1">Note references (one per line)<Textarea aria-label="Note references" value={notes} disabled={pending} onChange={e => { setNotes(e.target.value); setEditedLists({ ...editedLists, notes: true }); setConfirm(false); }} /></label>
    {changed && <Error title="This route changed" text="Reload the current route before saving your changes." retry={() => {
      setDraft(route); setEditedLists({ readers: false, notes: false }); setObserved({ signature: current, stale: false }); setReaders(route.readers.join('\n')); setNotes(route.notes.join('\n')); setConfirm(false);
    }} />}
    <div className="flex flex-wrap gap-2"><Button type="submit" disabled={disabled || !draft.workspace || !draft.channel}>Save route</Button>
      {!fresh && <Button type="button" variant="outline" disabled={disabled} onClick={() => { if (!disabled) setConfirm(true); }}>Remove route</Button>}</div>
    {confirm && !changed && <section className="grid gap-2"><p>Remove this route? Messages will use the remaining routes.</p>
      <Button type="button" disabled={disabled} onClick={() => { if (!disabled) { write('remove', { id: route.id }); setConfirm(false); } }}>Confirm removal</Button>
      <Button type="button" variant="outline" onClick={() => setConfirm(false)}>Keep route</Button></section>}
    {busyAnswer.pending && !answer.pending && <Loading label="Another setup change is pending…" />}
    {answer.pending && <Loading label={request?.kind === 'remove' ? 'Removing route…' : 'Saving route…'} />}
    {answer.result?.ok === false && <Error title="Couldn’t change route" text={`${answer.result.code}: ${answer.result.message}`} />}
    {answer.result?.ok && <p role="status">{request?.kind === 'remove' ? 'Route removed' : 'Route saved'}</p>}
  </form>;
}
