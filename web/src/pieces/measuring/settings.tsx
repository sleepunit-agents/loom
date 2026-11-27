import { measuringChangeWords, measuringWords, type MeasuringSettings } from './change';
import type { ChangeRow, ChangeWords } from '../approval-view/answering';
export type { MeasuringSettings } from './change';

function Values({ value }: { value: readonly ChangeRow[] }) {
  return <dl className="grid gap-2">
    {value.map(row => <div key={row.label}><dt>{row.label}</dt><dd className={row.long ? '[overflow-wrap:anywhere]' : undefined}>{row.value}</dd></div>)}
  </dl>;
}
function Change({ words }: { words: ChangeWords }) {
  return <section aria-label={words.label} className="grid gap-4">
    <h2>{words.heading}</h2>
    <div className="grid gap-4 sm:grid-cols-2">
      <section aria-label="Before"><h3>Before</h3><Values value={words.before} /></section>
      <section aria-label="After"><h3>After</h3><Values value={words.after} /></section>
    </div>
    <p>{words.note}</p>
  </section>;
}

/** Presentation inside the normal owner approval card. The parent supplies
 * the validated, persisted change and owns Allow/Deny and authentication. */
export function MeasuringChange({ before, after }: {
  before: Readonly<MeasuringSettings>; after: Readonly<MeasuringSettings>;
}) {
  return <Change words={measuringWords(before, after)} />;
}

/** Bind as shared Approvals renderChange; parsing is never an Allow decision. */
export function renderMeasuringChange(approval: {
  kind: string; target: string; details: string; changeSummary: string | null;
}) {
  const words = measuringChangeWords(approval);
  return words ? <Change words={words} /> : null;
}
