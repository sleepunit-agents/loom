import { useMemo } from 'react';
import type { Snapshot } from '../../data';
import { useSelection } from '../../data/graphql/selection';
import type { DataQuerySnapshot } from '../../data/graphql';
import { memoryQueries } from '../../memory/queries';
import type { ActivityWindow } from '../activity/model';

// Reuse Memory's reviewed document and decoder, never its one-shot HTTP helper.
export const deskRecentActivitySelection = memoryQueries.activity();
export function deskRecentActivity(query: DataQuerySnapshot<ActivityWindow | null>): Snapshot<ActivityWindow> {
  if (query.status !== 'live') return {status:query.status,records:[]};
  if (query.data === undefined) return {status:'loading',records:[]};
  return query.data?{status:'live',records:[query.data]}:{status:'denied',records:[]};
}
export function useDeskRecentActivity(): Snapshot<ActivityWindow> {
  const query=useSelection(deskRecentActivitySelection);
  return useMemo(()=>deskRecentActivity(query),[query]);
}
