import { useState, useSyncExternalStore, type FormEvent } from 'react';
import { type Call } from '../../data';
import { Button, Input, Textarea, Error, Loading } from '../../kit';
import type { RouteRecord } from './model';

export type RouteInput = Pick<RouteRecord, 'id' | 'platform' | 'workspace' | 'channel' | 'parent' | 'primary' | 'pair' | 'peer' | 'guest' | 'readers' | 'notes'>;
export interface RouteWrite { kind: 'save' | 'remove'; call: Call<{ id: string }> }
const idle = { pending: false, status: 'done' as const };
const noop = () => () => {};
export function routeInput(route: RouteRecord): RouteInput {
  return { id: route.id, platform: route.platform, workspace: route.workspace, channel: route.channel,
    parent: route.parent, primary: route.primary, pair: route.pair, peer: route.peer, guest: route.guest,
    readers: route.readers, notes: route.notes };
}
const signature = (route: RouteInput) => JSON.stringify(route);
const lines = (text: string) => text.split('\n').map(s => s.trim()).filter(Boolean);

/** Writes stay owned by the app, so navigation cannot release the pending lock. */
export function RouteEditor({ route, fresh, request, write }: {
  route: RouteInput; fresh: boolean; request?: RouteWrite;
  write: (kind: RouteWrite['kind'], input: RouteInput | { id: string }) => void;
}) {
  const [draft, setDraft] = useState(route);
  const [base, setBase] = useState(signature(route));
  const [readers, setReaders] = useState(route.readers.join('\n'));
  const [notes, setNotes] = useState(route.notes.join('\n'));
  const [confirm, setConfirm] = useState(false);
  const answer = useSyncExternalStore(request?.call.subscribe ?? noop, request?.call.getSnapshot ?? (() => idle));
  const changed = base !== signature(route);
  const disabled = answer.pending || changed;
  const field = (key: 'workspace' | 'channel' | 'parent' | 'primary' | 'pair', label: string, required = false) =>
    <label className="grid min-w-0 gap-1">{label}<Input aria-label={label} value={draft[key] ?? ''} required={required} maxLength={200}
      disabled={answer.pending} onChange={e => { setDraft({ ...draft, [key]: e.target.value }); setConfirm(false); }} /></label>;
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (disabled || !draft.workspace.trim() || !draft.channel.trim()) return;
    write('save', { ...draft, workspace: draft.workspace.trim(), channel: draft.channel.trim(),
      parent: draft.parent?.trim() || undefined, primary: draft.primary?.trim() || undefined,
      pair: draft.pair?.trim() || undefined, readers: lines(readers), notes: lines(notes) });
    setConfirm(false);
  };
  return <form className="grid min-w-0 gap-4" onSubmit={submit}>
    <h2>{fresh ? 'New route' : 'Edit route'}</h2>
    <p>Routes choose where messages go. Changes affect future intake and pending replies.</p>
    <div className="flex flex-wrap gap-2" role="group" aria-label="Platform">
      {(['discord', 'slack'] as const).map(platform => <Button key={platform} type="button" variant="outline" aria-pressed={draft.platform === platform}
        disabled={answer.pending} onClick={() => { setDraft({ ...draft, platform }); setConfirm(false); }}>{platform === 'discord' ? 'Discord' : 'Slack'}</Button>)}
    </div>
    {field('workspace', 'Workspace ID', true)}{field('channel', 'Channel ID', true)}
    {field('parent', 'Parent channel ID')}{field('primary', 'Primary agent')}{field('pair', 'Paired webhook ID')}
    <div className="flex flex-wrap gap-2">
      <Button type="button" variant="outline" aria-pressed={draft.peer} disabled={answer.pending} onClick={() => { setDraft({ ...draft, peer: !draft.peer }); setConfirm(false); }}>Peers {draft.peer ? 'enabled' : 'disabled'}</Button>
      <Button type="button" variant="outline" aria-pressed={draft.guest} disabled={answer.pending} onClick={() => { setDraft({ ...draft, guest: !draft.guest }); setConfirm(false); }}>{draft.guest ? 'Guest route' : 'Household route'}</Button>
    </div>
    <label className="grid min-w-0 gap-1">Reader agents (one per line)<Textarea aria-label="Reader agents" value={readers} disabled={answer.pending} onChange={e => { setReaders(e.target.value); setConfirm(false); }} /></label>
    <label className="grid min-w-0 gap-1">Note references (one per line)<Textarea aria-label="Note references" value={notes} disabled={answer.pending} onChange={e => { setNotes(e.target.value); setConfirm(false); }} /></label>
    {changed && <Error title="This route changed" text="Reload the current route before saving your changes." retry={() => {
      setDraft(route); setBase(signature(route)); setReaders(route.readers.join('\n')); setNotes(route.notes.join('\n')); setConfirm(false);
    }} />}
    <div className="flex flex-wrap gap-2"><Button type="submit" disabled={disabled || !draft.workspace.trim() || !draft.channel.trim()}>Save route</Button>
      {!fresh && <Button type="button" variant="outline" disabled={disabled} onClick={() => { if (!disabled) setConfirm(true); }}>Remove route</Button>}</div>
    {confirm && !changed && <section className="grid gap-2"><p>Remove this route? Messages will use the remaining routes.</p>
      <Button type="button" disabled={disabled} onClick={() => { if (!disabled) { write('remove', { id: route.id }); setConfirm(false); } }}>Confirm removal</Button>
      <Button type="button" variant="outline" onClick={() => setConfirm(false)}>Keep route</Button></section>}
    {answer.pending && <Loading label={request?.kind === 'remove' ? 'Removing route…' : 'Saving route…'} />}
    {answer.result?.ok === false && <Error title="Couldn’t change route" text={`${answer.result.code}: ${answer.result.message}`} />}
    {answer.result?.ok && <p role="status">{request?.kind === 'remove' ? 'Route removed' : 'Route saved'}</p>}
  </form>;
}
