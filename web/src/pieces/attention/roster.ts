import { useMemo } from 'react';
import { useRecords, type Snapshot } from '../../data';
import { useDataQuery, type DataQuerySnapshot } from '../../data/graphql';
import type { OwnedAgent } from './home-model';

/** Visible agents include project colleagues. Ownership is a separate fact:
 * until the generated ownership projection is composed, intersect the existing
 * owned roster with current generated rows, never turn directory access into ownership. */
export const deskRosterQuery = `query DeskRoster { agents { id position } }`;
export type DeskRosterData = { agents: { id: string; position: number }[] };
export function deskRoster(owned: Snapshot<OwnedAgent>, query: DataQuerySnapshot<DeskRosterData>): Snapshot<OwnedAgent> {
  if (owned.status !== 'live') return { status: owned.status, records: [] };
  if (query.status !== 'live') return { status: query.status, records: [] };
  if (!query.data) return { status: 'loading', records: [] };
  const positions = new Map(query.data.agents.map(agent => [agent.id, agent.position]));
  return { status: 'live', records: owned.records.filter(agent => positions.has(agent.id))
    .map(agent => ({ ...agent, position: positions.get(agent.id)! })) };
}
export function useDeskRoster(): Snapshot<OwnedAgent> {
  const owned = useRecords<OwnedAgent>('attention.ownedAgent');
  const query = useDataQuery<DeskRosterData>(deskRosterQuery);
  return useMemo(() => deskRoster(owned, query), [owned, query]);
}
