import type { Snapshot } from '../../data';
import { Body, List, Row, Section } from '../../kit';
import { address, type ActivityWindow } from '../activity/model';
import { stamp } from './time';

/** An agent's last steps, on its own page in the Agents app: the shared recent Activity reading, no readers or separate retained tape. */
export function LastSteps({ agent, name, activity, go, count = 8 }: {
  agent: string; name: string; activity: Snapshot<ActivityWindow>; go(path: string): void; count?: number;
}) {
  const window = activity.status === 'live' ? activity.records.find(w => w.id === 'recent') : undefined;
  const entries = window ? window.entries.filter(e => e.agent === agent)
    .sort((a,b) => Date.parse(b.at) - Date.parse(a.at) || a.id.localeCompare(b.id)).slice(0,count) : [];
  const partial = window && (window.conversations !== 'available' || window.episodes !== 'available');
  return <Section label="Last steps">
    {activity.status === 'loading' ? <Body quiet>Checking…</Body> : !window ? <Body quiet>Can’t read activity right now.</Body> : <>
      {partial && <Body quiet>Some activity can’t be read right now.</Body>}
      {window.truncated && <Body quiet>Showing the most recent activity.</Body>}
      {entries.length ? <List label={`${name} recent steps`}>{entries.map(entry => <Row key={entry.id} layout="stack"
        title={entry.title} meta={<span className="grid gap-1">{entry.line && <span>{entry.line}</span>}
          <span><time dateTime={entry.at}>{stamp(Date.parse(entry.at))}</time> · {entry.where}</span></span>}
        onClick={() => go(address({who:[agent],where:[],what:[]},entry.id,entry.day))} />)}</List>
        : !partial && <Body quiet>None yet.</Body>}
    </>}
  </Section>;
}
