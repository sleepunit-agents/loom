import { tempoChangeWords } from './change';
import type { ChangeRow } from '../approval-view/answering';
export { readTempoChange } from './change';
function Values({value}:{value:readonly ChangeRow[]}) {
  return <dl className="grid gap-2">
    {value.map(row=><div key={row.label}><dt>{row.label}</dt><dd>{row.value}</dd></div>)}
  </dl>;
}
export function renderTempoChange(approval:Parameters<typeof tempoChangeWords>[0]) {
  const words=tempoChangeWords(approval);if(!words)return null;
  return <section aria-label={words.label} className="grid gap-4">
    <h2>{words.heading}</h2>
    <div className="grid gap-4 sm:grid-cols-2">
      <section aria-label="Before"><h3>Before</h3><Values value={words.before}/></section>
      <section aria-label="After"><h3>After</h3><Values value={words.after}/></section>
    </div>
    <p>{words.note}</p>
  </section>;
}
