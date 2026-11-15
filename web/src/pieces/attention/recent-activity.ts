import { useMemo } from 'react';
import type { Snapshot } from '../../data';
import { useDataQuery, type DataQuerySnapshot } from '../../data/graphql';
import { memoryQueries } from '../../memory/queries';
import type { ActivityWindow } from '../activity/model';

// Reuse Memory's reviewed document and decoder, never its one-shot HTTP helper.
export const deskRecentActivitySelection = memoryQueries.activity();
export function deskRecentActivity(query: DataQuerySnapshot<Record<string, unknown>>): Snapshot<ActivityWindow> {
  if (query.status !== 'live') return {status:query.status,records:[]};
  if (!query.data) return {status:'loading',records:[]};
  try {
    const window=deskRecentActivitySelection.decode(query.data);
    return window?{status:'live',records:[window]}:{status:'denied',records:[]};
  } catch { return {status:'offline',records:[]}; }
}
export function useDeskRecentActivity(): Snapshot<ActivityWindow> {
  const query=useDataQuery<Record<string,unknown>>(deskRecentActivitySelection.query,deskRecentActivitySelection.variables);
  return useMemo(()=>deskRecentActivity(query),[query]);
}
