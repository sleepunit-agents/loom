import { useLiveAgentIds } from '../../data/live-agents';
import { useDataQuery } from '../../data/graphql';
import Tempo, { TempoCard, type TempoActions, type TempoSnapshot } from './index';
import { tempoCardQuery, tempoQuery, type TempoData } from './query';
export { tempoQuery, type TempoData } from './query';

/** Household timezone comes from the root's safe household projection, rather
 * than exposing the household settings table to obtain one field. */
export function useTempoSnapshot(timezone: string, triggerId?: string): TempoSnapshot {
  const feed = useDataQuery<TempoData>(triggerId === undefined ? tempoQuery : tempoCardQuery,
    triggerId === undefined ? undefined : {id: triggerId});
  const data = feed.status === 'live' ? feed.data : undefined;
  return {
    status: feed.status === 'live' && !data ? 'loading' : feed.status,
    triggers: data?.triggers ?? [],
    pauses: data?.agentPauses ?? [], timezone: data?.tempoTimezone ?? timezone,
  };
}
export function TempoApp({ timezone, actions }: { timezone: string; actions?: TempoActions }) {
  const snapshot = useTempoSnapshot(timezone), inUse = useLiveAgentIds();
  return <Tempo snapshot={snapshot} actions={actions} inUse={inUse ?? new Set()} />;
}
export function LiveTempoCard({ triggerId, timezone, actions }: { triggerId: string; timezone: string; actions?: TempoActions }) {
  const snapshot = useTempoSnapshot(timezone, triggerId);
  return <TempoCard snapshot={snapshot} triggerId={triggerId} actions={actions} />;
}
