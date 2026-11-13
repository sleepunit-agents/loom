import { useState, useSyncExternalStore, type FormEvent } from 'react';
import { type Call } from '../../data';
import { Button, Input, Textarea, Error, Loading } from '../../kit';
import type { VenueInput } from './model';

export interface VenueWrite { kind: 'save' | 'remove'; call: Call<{ id: string }> }
const idle = { pending: false, status: 'done' as const };
const noop = () => () => {};
const signature = (connection: VenueInput) => JSON.stringify(connection);
const lines = (text: string) => text.split('\n').filter(s => s.length > 0);

/** Writes stay owned by the app, so navigation cannot release the pending lock. */
export function VenueEditor({ connection, fresh, request, busy, write }: {
  connection: VenueInput; fresh: boolean; request?: VenueWrite; busy?: Call<{ id: string }>;
  write: (kind: VenueWrite['kind'], input: VenueInput | { id: string }) => void;
}) {
  const [draft, setDraft] = useState(connection);
  const current = signature(connection);
  const [observed, setObserved] = useState({ signature: current, stale: false });
  if (observed.signature !== current) setObserved({ signature: current, stale: true });
  const [lists, setLists] = useState({ only: connection.only.join('\n'), ignore: connection.ignore.join('\n'), botRoles: connection.botRoles.join('\n') });
  const [confirm, setConfirm] = useState(false);
  const answer = useSyncExternalStore(request?.call.subscribe ?? noop, request?.call.getSnapshot ?? (() => idle));
  const busyAnswer = useSyncExternalStore(busy?.subscribe ?? noop, busy?.getSnapshot ?? (() => idle));
  const changed = observed.stale || observed.signature !== current;
  const pending = answer.pending || busyAnswer.pending;
  const disabled = pending || changed;
  const field = (key: 'workspace' | 'agent' | 'bot' | 'tokenSecret' | 'appSecret', label: string, required = false) =>
    <label className="grid min-w-0 gap-1">{label}<Input aria-label={label} value={draft[key] ?? ''} required={required} maxLength={200}
      disabled={pending} onChange={e => { setDraft({ ...draft, [key]: e.target.value }); setConfirm(false); }} /></label>;
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (disabled || !draft.workspace || !draft.agent || !draft.bot || !draft.tokenSecret) return;
    write('save', { ...draft, appSecret: draft.appSecret || undefined,
      only: lists.only === draft.only.join('\n') ? draft.only : lines(lists.only),
      ignore: lists.ignore === draft.ignore.join('\n') ? draft.ignore : lines(lists.ignore),
      botRoles: lists.botRoles === draft.botRoles.join('\n') ? draft.botRoles : lines(lists.botRoles) });
    setConfirm(false);
  };
  return <form className="grid min-w-0 gap-4" onSubmit={submit}>
    <h2>{fresh ? 'New connection' : 'Edit connection'}</h2>
    <p>Connection changes affect future intake and pending replies. Secret fields take existing secret names; manage values and service grants in Secrets.</p>
    <div className="flex flex-wrap gap-2" role="group" aria-label="Platform">
      {(['discord', 'slack'] as const).map(platform => <Button key={platform} type="button" variant="outline" aria-pressed={draft.platform === platform}
        disabled={pending} onClick={() => { setDraft({ ...draft, platform }); setConfirm(false); }}>{platform === 'discord' ? 'Discord' : 'Slack'}</Button>)}
    </div>
    {field('agent', 'Agent', true)}{field('workspace', 'Workspace ID', true)}{field('bot', 'Bot ID', true)}
    {field('tokenSecret', 'Token secret name', true)}{field('appSecret', 'App secret name')}
    <Button type="button" variant="outline" aria-pressed={draft.enabled} disabled={pending}
      onClick={() => { setDraft({ ...draft, enabled: !draft.enabled }); setConfirm(false); }}>Connection {draft.enabled ? 'enabled' : 'disabled'}</Button>
    {([['only', 'Only channels'], ['ignore', 'Ignored channels'], ['botRoles', 'Bot role IDs']] as const).map(([key, label]) =>
      <label key={key} className="grid min-w-0 gap-1">{label} (one per line)<Textarea aria-label={label} value={lists[key]} disabled={pending}
        onChange={e => { setLists({ ...lists, [key]: e.target.value }); setConfirm(false); }} /></label>)}
    {changed && <Error title="This connection changed" text="Reload the current connection before saving your changes." retry={() => {
      setDraft(connection); setObserved({ signature: current, stale: false }); setLists({ only: connection.only.join('\n'), ignore: connection.ignore.join('\n'), botRoles: connection.botRoles.join('\n') }); setConfirm(false);
    }} />}
    <div className="flex flex-wrap gap-2"><Button type="submit" disabled={disabled || !draft.workspace || !draft.agent || !draft.bot || !draft.tokenSecret}>Save connection</Button>
      {!fresh && <Button type="button" variant="outline" disabled={disabled} onClick={() => { if (!disabled) setConfirm(true); }}>Remove connection</Button>}</div>
    {confirm && !changed && <section className="grid gap-2"><p>Remove this connection? Pending intake and replies for this connection will be held.</p>
      <Button type="button" disabled={disabled} onClick={() => { if (!disabled) { write('remove', { id: connection.id }); setConfirm(false); } }}>Confirm removal</Button>
      <Button type="button" variant="outline" onClick={() => setConfirm(false)}>Keep connection</Button></section>}
    {busyAnswer.pending && !answer.pending && <Loading label="Another setup change is pending…" />}
    {answer.pending && <Loading label={request?.kind === 'remove' ? 'Removing connection…' : 'Saving connection…'} />}
    {answer.result?.ok === false && <Error title="Couldn’t change connection" text={`${answer.result.code}: ${answer.result.message}`} />}
    {answer.result?.ok && <p role="status">{request?.kind === 'remove' ? 'Connection removed' : 'Connection saved'}</p>}
  </form>;
}
