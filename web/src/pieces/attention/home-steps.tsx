import type { Snapshot } from '../../data';
import { List, Row, Loading } from '../../kit';
import { address, type ActivityWindow } from '../activity/model';
import { stamp } from './index';

/** One shared recent Activity subscription on Home; no readers or separate retained tape. */
export function HomeSteps({ agent, name, activity, go }: {
  agent: string; name: string; activity: Snapshot<ActivityWindow>; go(path: string): void;
}) {
  const window = activity.status === 'live' ? activity.records.find(w => w.id === 'recent') : undefined;
  const entries = window ? window.entries.filter(e => e.agent === agent)
    .sort((a,b) => Date.parse(b.at) - Date.parse(a.at) || a.id.localeCompare(b.id)).slice(0,3) : [];
  const partial = window && (window.conversations !== 'available' || window.episodes !== 'available');
  return <section aria-label={`${name} last steps`} className="grid min-w-0 gap-2">
    <h3>Last steps</h3>
    {activity.status === 'loading' ? <Loading label="Opening activity…" /> : !window ? <p>Activity unavailable.</p> : <>
      {partial && <p>Some activity is unavailable.</p>}
      {window.truncated && <p>Showing the available recent activity.</p>}
      {entries.length ? <List label={`${name} recent steps`}>{entries.map(entry => <Row key={entry.id} layout="stack"
        title={entry.title} meta={<span className="grid gap-1">{entry.line && <span>{entry.line}</span>}
          <span><time dateTime={entry.at}>{stamp(Date.parse(entry.at))}</time> · {entry.where}</span></span>}
        onClick={() => go(address({who:[agent],where:[],what:[]},entry.id,entry.day))} />)}</List>
        : !partial && <p>No recent steps.</p>}
    </>}
  </section>;
}
