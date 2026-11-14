import { Empty, Error, Loading } from '../../kit';

export interface TempoTimings {
  settleSeconds: number;
  dimDays: number;
  muteDays: number;
}

/** The persisted details produced by tempoSettingsService.prepare. */
export interface TempoSettingsChange {
  who: { kind: 'person' | 'agent'; id: string };
  before: TempoTimings;
  after: TempoTimings;
}

export interface TempoSettingsSnapshot {
  status: 'loading' | 'live' | 'offline' | 'denied';
  change: TempoSettingsChange | null;
}

/** Before/after content for the shared approval card in a conversation.
 * The approval owner supplies current visible details and owns Allow/Deny.
 */
export function TempoSettingsChangeCard({ snapshot }: { snapshot: TempoSettingsSnapshot }) {
  if (snapshot.status !== 'live') return snapshot.status === 'loading'
    ? <Loading label="Opening Tempo settings…" />
    : <Error text={snapshot.status === 'denied' ? 'Sign in with access to see this change.' : 'Waiting for connection.'} />;
  const change = snapshot.change;
  if (!change) return <Empty title="Setting change unavailable" text="This proposal is no longer in your view." />;
  const fields = [
    ['How long the inbox waits before waking its owner', 'settleSeconds', 'seconds'],
    ['How long before a dimmed item returns to full', 'dimDays', 'days'],
    ['How long a mute lasts', 'muteDays', 'days'],
  ] as const;
  const amount = (value: number, unit: string) => `${value} ${value === 1 ? unit.slice(0, -1) : unit}`;
  return <section className="grid gap-3 p-4" aria-label="Tempo setting change">
    <h2>Change Tempo settings for {change.who.kind} {change.who.id}</h2>
    <table><thead><tr><th scope="col">Setting</th><th scope="col">Before</th><th scope="col">After</th></tr></thead>
      <tbody>{fields.map(([label, key, unit]) => <tr key={key}>
        <th scope="row">{label}</th><td>{amount(change.before[key], unit)}</td><td>{amount(change.after[key], unit)}</td>
      </tr>)}</tbody>
    </table>
    <p>Allow: loom makes the change and records it. Deny: nothing changes.</p>
  </section>;
}
