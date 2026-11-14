import { useRef, useState, type FormEvent } from 'react';
import { readMeasuringChange } from '../../../../src/core/measuring/change';
import { Button, Input } from '../../kit';

export interface MeasuringSettings {
  on: boolean;
  send_outside: boolean;
  outside_address: string;
  keep_days: number;
}

function Values({ value }: { value: Readonly<MeasuringSettings> }) {
  return <dl className="grid gap-2">
    <div><dt>Measuring</dt><dd>{value.on ? 'On' : 'Off'}</dd></div>
    <div><dt>Outside monitoring tool</dt><dd>{value.send_outside ? 'Send measurements' : 'Do not send measurements'}</dd></div>
    <div><dt>Monitoring address</dt><dd className="[overflow-wrap:anywhere]">{value.outside_address || 'None'}</dd></div>
    <div><dt>Local history</dt><dd>{value.keep_days} days</dd></div>
  </dl>;
}

/** Presentation inside the normal owner approval card. The parent supplies
 * the validated, persisted change and owns Allow/Deny and authentication. */
export function MeasuringChange({ before, after }: {
  before: Readonly<MeasuringSettings>; after: Readonly<MeasuringSettings>;
}) {
  return <section aria-label="Measuring settings change" className="grid gap-4">
    <h2>Change Measuring settings</h2>
    <div className="grid gap-4 sm:grid-cols-2">
      <section aria-label="Before"><h3>Before</h3><Values value={before} /></section>
      <section aria-label="After"><h3>After</h3><Values value={after} /></section>
    </div>
    <p>Allow applies these settings. Deny keeps the current settings.</p>
  </section>;
}

export type MeasuringSettingsSnapshot =
  | { status: 'live'; value: Readonly<MeasuringSettings> }
  | { status: 'loading' | 'offline' | 'denied' };

/** The root mounts this only in an owner's settings flow, and routes propose
 * through the normal durable approval mechanism. This is never a direct save. */
export function MeasuringSettingsProposal({ snapshot, propose }: {
  snapshot: MeasuringSettingsSnapshot;
  propose: (after: MeasuringSettings) => Promise<void>;
}) {
  if (snapshot.status !== 'live') return <p role="status">{snapshot.status === 'loading'
    ? 'Opening Measuring settings…' : snapshot.status === 'denied'
      ? 'Only household owners can change Measuring settings.' : 'Waiting for connection.'}</p>;
  // A changed authoritative value discards the old draft and pending result.
  return <Proposal key={JSON.stringify(snapshot.value)} current={snapshot.value} propose={propose} />;
}

function Proposal({ current, propose }: {
  current: Readonly<MeasuringSettings>; propose: (after: MeasuringSettings) => Promise<void>;
}) {
  const [draft, setDraft] = useState<MeasuringSettings>(() => ({ ...current }));
  const [pending, setPending] = useState(false);
  const [result, setResult] = useState<'sent' | 'failed'>();
  const submitted = useRef(false);
  const changed = draft.on !== current.on || draft.send_outside !== current.send_outside
    || draft.outside_address !== current.outside_address || draft.keep_days !== current.keep_days;
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (submitted.current || !changed) return;
    submitted.current = true;
    setPending(true); setResult(undefined);
    try { await propose({ ...draft }); setResult('sent'); }
    catch { submitted.current = false; setResult('failed'); }
    finally { setPending(false); }
  }
  return <form aria-label="Propose Measuring settings" onSubmit={submit} className="grid gap-4">
    <h2>Measuring</h2><p>Off by default. Measures requests, operations and background jobs only when turned on.</p>
    <fieldset disabled={pending || result === 'sent'} className="grid gap-3">
      <label><input type="checkbox" checked={draft.on} onChange={e => setDraft({ ...draft, on: e.target.checked })} /> Measure how long things take</label>
      <label><input type="checkbox" checked={draft.send_outside} onChange={e => setDraft({ ...draft, send_outside: e.target.checked })} /> Also send to an outside monitoring tool</label>
      <label>Monitoring address<Input type="url" value={draft.outside_address} required={draft.send_outside} onChange={e => setDraft({ ...draft, outside_address: e.target.value })} /></label>
      <label>Days of local history<Input type="number" min={1} max={3650} step={1} required value={draft.keep_days} onChange={e => setDraft({ ...draft, keep_days: e.target.valueAsNumber })} /></label>
      {changed && <MeasuringChange before={current} after={draft} />}
      <Button type="submit" disabled={!changed || pending || result === 'sent'}>Request approval</Button>
    </fieldset>
    {pending && <p role="status">Requesting approval…</p>}
    {result === 'sent' && <p role="status">Approval requested. Settings change only when the request is allowed.</p>}
    {result === 'failed' && <p role="alert">Could not request approval. Settings have not been changed here. Try again.</p>}
  </form>;
}

/** Bind as shared Approvals renderChange; parsing is never an Allow decision. */
export function renderMeasuringChange(approval: {
  kind: string; target: string; details: string; changeSummary: string | null;
}) {
  const change = readMeasuringChange(approval);
  return change ? <MeasuringChange {...change} /> : null;
}
