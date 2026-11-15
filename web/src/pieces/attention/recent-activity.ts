import { useMemo } from 'react';
import type { Snapshot } from '../../data';
import { useQuery, type SelectionSnapshot } from '../../data/query';
import { memoryQueries } from '../../memory/queries';
import type { ActivityWindow } from '../activity/model';

// Reuse Memory's reviewed document and decoder, never its one-shot HTTP helper.
export const deskRecentActivitySelection = memoryQueries.activity();
export function deskRecentActivity(query: SelectionSnapshot<ActivityWindow | null>): Snapshot<ActivityWindow> {
  if (query.status !== 'live') return {status:query.status==='error'?'offline':query.status,records:[]};
  if (query.data === undefined) return {status:'loading',records:[]};
  return query.data?{status:'live',records:[query.data]}:{status:'denied',records:[]};
}
export function useDeskRecentActivity(): Snapshot<ActivityWindow> {
  const query=useQuery(deskRecentActivitySelection);
  return useMemo(()=>deskRecentActivity(query),[query]);
}
