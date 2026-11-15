import { useMemo } from 'react';
import { useDataQuery, type DataQuerySnapshot } from './index';
/** A typed decoder over the canonical client; owns no connection or cache. */
export interface QuerySelection<T> { query: string; variables: Record<string, unknown>; decode(data: Record<string, unknown>): T }
export function useSelection<T>(selection: QuerySelection<T>): DataQuerySnapshot<T> {
  const reading = useDataQuery<Record<string, unknown>>(selection.query, selection.variables);
  return useMemo(() => {
    if (reading.status !== 'live' || !reading.data) return { status: reading.status };
    try { return { status: 'live', data: selection.decode(reading.data) }; }
    catch { return { status: 'offline' }; }
  }, [reading, selection]);
}
