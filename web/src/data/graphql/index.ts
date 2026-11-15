import { useMemo } from 'react';
import { useQuery } from '../query';

export type DataQuerySnapshot<T> = { status: 'loading' | 'live' | 'offline' | 'denied'; data?: T };
/** Approvals, Changes and inline cards share the window's existing query store
 * and websocket with every other tile. No second client or cache is created. */
export function useDataQuery<T>(query: string, variables?: Record<string, unknown>): DataQuerySnapshot<T> {
  const selection = useMemo(() => ({ query, variables, decode: (data: Record<string, unknown>) => data as T }), [query, variables]);
  const snapshot = useQuery(selection);
  return { status: snapshot.status === 'error' ? 'offline' : snapshot.status,
    data: snapshot.status === 'live' ? snapshot.data : undefined };
}
