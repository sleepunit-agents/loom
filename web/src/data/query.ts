import { useMemo } from 'react';
import { useDataQuery } from './graphql';
export interface QuerySelection<T> {
  query: string;
  variables?: Record<string, unknown>;
  decode(data: Record<string, unknown>): T;
}
export interface SelectionSnapshot<T> { status: 'loading' | 'live' | 'offline' | 'denied' | 'error'; data?: T }
/** Existing decoders share the canonical normalized cache and window socket. */
export function useQuery<T>(selection: QuerySelection<T>): SelectionSnapshot<T> {
  const raw = useDataQuery<Record<string, unknown>>(selection.query, selection.variables);
  return useMemo(() => {
    if (raw.status !== 'live' || !raw.data) return { status: raw.status };
    try { return { status: 'live', data: selection.decode(raw.data) }; }
    catch { return { status: 'error' }; }
  }, [raw, selection]);
}
