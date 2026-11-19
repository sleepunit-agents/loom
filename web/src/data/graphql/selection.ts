import { useMemo, useState } from 'react';
import { useDataQuery, type DataQueryOptions, type DataQuerySnapshot } from './index';
/** A typed decoder over the canonical client; owns no connection or cache. */
export interface QuerySelection<T> { query: string; variables: Record<string, unknown>; decode(data: Record<string, unknown>): T }
export function useSelection<T>(selection: QuerySelection<T>, options?: DataQueryOptions): DataQuerySnapshot<T> {
  const reading = useDataQuery<Record<string, unknown>>(selection.query, selection.variables, options);
  // What this mount decoded, by the answer it came from. A kept answer belongs to
  // the previous variables, so it is shown as it was decoded then: the current
  // selection's decoder never runs over it.
  const [decoded] = useState(() => new WeakMap<object, { value: T }>());
  return useMemo(() => {
    if (reading.status !== 'live' || !reading.data) return { status: reading.status };
    if (reading.settling) {
      const kept = decoded.get(reading.data);
      return kept ? { status: 'live', data: kept.value, settling: true } : { status: 'loading' };
    }
    try { const value = selection.decode(reading.data); decoded.set(reading.data, { value }); return { status: 'live', data: value }; }
    catch { return { status: 'offline' }; }
  }, [reading, selection, decoded]);
}
/** What a kept answer was asked with. A view that also filters rows itself (by folder, say) must filter kept rows
 * by the folder they were read for, not the one just chosen, or they vanish until the new ones arrive. Returns
 * `asked` once the reading is current and the earlier value while it settles. */
export function useAnswered<T>(reading: DataQuerySnapshot<unknown>, asked: T): T {
  const [answered, setAnswered] = useState(asked);
  if (reading.status === 'live' && !reading.settling && !Object.is(answered, asked)) setAnswered(asked);
  return reading.settling ? answered : asked;
}
