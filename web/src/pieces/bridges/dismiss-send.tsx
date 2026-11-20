import { useState, useSyncExternalStore } from 'react';
import type { Call } from '../../data';
import { Button, Error, Loading } from '../../kit';
import type { SendRecord } from './model';

export type DismissInput = { id: string; state: 'held' | 'uncertain' };
const idle = { pending: false, status: 'done' as const };
const noop = () => () => {};

/** The app retains requests across navigation; confirmation belongs to this observed row. */
export function DismissSend({ send, request, dismiss }: {
  send: SendRecord; request?: Call<{ id: string }>; dismiss: (input: DismissInput) => void;
}) {
  const [confirm, setConfirm] = useState(false);
  const answer = useSyncExternalStore(request?.subscribe ?? noop, request?.getSnapshot ?? (() => idle));
  if (send.state !== 'held' && send.state !== 'uncertain') return null;
  const state = send.state;
  const disabled = answer.pending || answer.result?.ok === true;
  return <section className="grid min-w-0 gap-3" aria-label="Dismiss send">
    <p>Check the reply on the venue first. Dismissal permanently removes this send from pending review and prevents another attempt. It does not confirm delivery.</p>
    <Button variant="outline" disabled={disabled} onClick={() => { if (!disabled) setConfirm(true); }}>Dismiss this send</Button>
    {confirm && !disabled && <section className="grid gap-2">
      <p>Dismiss this {state} send permanently?</p>
      <Button disabled={disabled} onClick={() => { if (!disabled) { dismiss({ id: send.id, state }); setConfirm(false); } }}>Confirm dismissal</Button>
      <Button variant="outline" onClick={() => setConfirm(false)}>Keep for review</Button>
    </section>}
    {answer.pending && <Loading label="Dismissing send…" />}
    {answer.result?.ok === false && <Error title="Couldn’t dismiss send" text={`${answer.result.code}: ${answer.result.message}`} />}
    {answer.result?.ok && <p role="status">Dismissal accepted</p>}
  </section>;
}
