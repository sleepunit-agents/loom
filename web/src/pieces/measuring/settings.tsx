import { readMeasuringChange } from '../../../../src/core/measuring/change';

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
    <div><dt>Local history</dt><dd>{value.keep_days === 0 ? 'No local history' : `${value.keep_days} days`}</dd></div>
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

/** Bind as shared Approvals renderChange; parsing is never an Allow decision. */
export function renderMeasuringChange(approval: {
  kind: string; target: string; details: string; changeSummary: string | null;
}) {
  const change = readMeasuringChange(approval);
  return change ? <MeasuringChange {...change} /> : null;
}
