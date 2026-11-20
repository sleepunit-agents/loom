import { useMemo } from 'react';
import { useDataQuery } from './graphql';

/** The household's agents in use. A removed agent keeps its row, its owner link and its history (so it can be
 * restored), and is in no roster, picker or count: every place that lists agents for choosing or counting
 * goes through here. A place that shows history (an old conversation, a task's comments, a job) names the
 * agent it was, removed or not, and does not. The one screen that lists removed agents is Household setup. */
export const liveAgents = <T extends { removedAt?: string | null }>(rows: readonly T[]): T[] => rows.filter(row => !row.removedAt);

export const liveAgentsQuery = 'query LiveAgents { agents { id removedAt } }';
/** For a place whose own list does not say which agents are removed: the ids of the agents this viewer may see
 * that are in use. Undefined until that is known, and then nothing is left out. */
export function useLiveAgentIds(): ReadonlySet<string> | undefined {
  const query = useDataQuery<{ agents: { id: string; removedAt: string | null }[] }>(liveAgentsQuery);
  return useMemo(() => query.status === 'live' && Array.isArray(query.data?.agents) ? new Set(liveAgents(query.data.agents).map(agent => agent.id)) : undefined, [query]);
}
