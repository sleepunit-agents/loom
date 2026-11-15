import { useQuery, type QuerySelection } from '../../data/query';
import Tempo, { TempoCard, type TempoActions, type TempoSnapshot } from './index';
import { tempoQuery, type TempoData } from './query';
export { tempoQuery, type TempoData } from './query';

/** Household timezone comes from the root's safe household projection, rather
 * than exposing the household settings table to obtain one field. */
const selection: QuerySelection<TempoData> = {
  query: tempoQuery,
  decode(data) {
    if (!Array.isArray(data.triggers) || !Array.isArray(data.triggerLog) || !Array.isArray(data.agentPauses)) throw new Error('Missing Tempo result');
    return data as unknown as TempoData;
  },
};
export function useTempoSnapshot(timezone: string): TempoSnapshot {
  const feed = useQuery(selection);
  const data = feed.status === 'live' ? feed.data : undefined;
  return {
    status: feed.status === 'error' ? 'offline' : feed.status === 'live' && !data ? 'loading' : feed.status,
    triggers: data?.triggers ?? [], events: data?.triggerLog ?? [],
    pauses: data?.agentPauses ?? [], timezone,
  };
}
export function TempoApp({ timezone, actions }: { timezone: string; actions?: TempoActions }) {
  const snapshot = useTempoSnapshot(timezone);
  return <Tempo snapshot={snapshot} actions={actions} />;
}
export function LiveTempoCard({ triggerId, timezone, actions }: { triggerId: string; timezone: string; actions?: TempoActions }) {
  const snapshot = useTempoSnapshot(timezone);
  return <TempoCard snapshot={snapshot} triggerId={triggerId} actions={actions} />;
}
