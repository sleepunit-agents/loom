import { useMemo } from 'react';
import type { Snapshot } from '../../data/snapshot';
import { useDataQuery, type DataQuerySnapshot } from '../../data/graphql';
import type { OwnedAgent } from './home-model';
import { liveAgents } from '../../data/live-agents';

/** Directory visibility includes colleagues; only current memberAgents-owned
 * IDs from the authenticated mailbox projection become owned cards. */
export const deskRosterQuery = `query DeskRoster {
  homeComms { member agents }
  agents { id position removedAt }
}`;
export type DeskRosterData = { homeComms: { member: string; agents: string[] } | null; agents: { id: string; position: number; removedAt?: string | null }[] };
export function deskRoster(query: DataQuerySnapshot<DeskRosterData>): Snapshot<OwnedAgent> {
  if (query.status !== 'live') return { status: query.status, records: [] };
  if (!query.data) return { status: 'loading', records: [] };
  if (!query.data.homeComms) return { status: 'denied', records: [] };
  const owned = new Set(query.data.homeComms.agents);
  // A removed agent is on no roster (data/live-agents.ts); the server's list leaves it out too.
  return { status: 'live', records: liveAgents(query.data.agents).filter(agent => owned.has(agent.id))
    .map(({ removedAt: _removedAt, ...agent }) => ({ ...agent, name: agent.id.replace(/^./, c => c.toUpperCase()) })) };
}
export function useDeskRoster(): Snapshot<OwnedAgent> {
  const query = useDataQuery<DeskRosterData>(deskRosterQuery);
  return useMemo(() => deskRoster(query), [query]);
}
