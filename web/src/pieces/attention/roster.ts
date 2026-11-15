import { useMemo } from 'react';
import type { Snapshot } from '../../data';
import { useDataQuery, type DataQuerySnapshot } from '../../data/graphql';
import type { OwnedAgent } from './home-model';

/** Directory visibility includes colleagues; only current memberAgents-owned
 * IDs from the authenticated mailbox projection become owned cards. */
export const deskRosterQuery = `query DeskRoster {
  homeComms { member agents }
  agents { id position }
}`;
export type DeskRosterData = { homeComms: { member: string; agents: string[] } | null; agents: { id: string; position: number }[] };
export function deskRoster(query: DataQuerySnapshot<DeskRosterData>): Snapshot<OwnedAgent> {
  if (query.status !== 'live') return { status: query.status, records: [] };
  if (!query.data) return { status: 'loading', records: [] };
  if (!query.data.homeComms) return { status: 'denied', records: [] };
  const owned = new Set(query.data.homeComms.agents);
  return { status: 'live', records: query.data.agents.filter(agent => owned.has(agent.id))
    .map(agent => ({ ...agent, name: agent.id.replace(/^./, c => c.toUpperCase()) })) };
}
export function useDeskRoster(): Snapshot<OwnedAgent> {
  const query = useDataQuery<DeskRosterData>(deskRosterQuery);
  return useMemo(() => deskRoster(query), [query]);
}
