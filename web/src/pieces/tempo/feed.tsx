import { useDataQuery } from '../../data/graphql';
import Tempo, { TempoCard, type TempoActions, type TempoSnapshot } from './index';
import { tempoQuery, type TempoData } from './query';
export { tempoQuery, type TempoData } from './query';

/** Household timezone comes from the root's safe household projection, rather
 * than exposing the household settings table to obtain one field. */
export function useTempoSnapshot(timezone: string): TempoSnapshot {
  const feed = useDataQuery<TempoData>(tempoQuery);
  const data = feed.status === 'live' ? feed.data : undefined;
  return {
    status: feed.status === 'live' && !data ? 'loading' : feed.status,
    ...(data?.tempoMachineReviewer ? { reviewer: data.tempoMachineReviewer } : {}),
    ...(data?.boxes ? { machines: data.boxes.filter(box => !box.revokedAt) } : {}),
    triggers: data?.triggers ?? [], events: data?.triggerLog ?? [],
    pauses: data?.agentPauses ?? [], timezone: data?.tempoTimezone ?? timezone,
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
