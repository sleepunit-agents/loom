import { useEffect, useState } from 'react';
import { useEnv } from '../blocks';
import { collectionsRuntime } from '../page';
import type { QuerySpec, Rec, ViewState } from '../collections/runtime';

type Collection = ViewState & { rows: readonly Rec[]; loading: boolean; stale: boolean; loadMore: () => void };
const waiting = (): Collection => ({ keys: [], withheld: [], status: 'loading', more: false, rows: [], loading: true, stale: false, loadMore: () => {} });

/** One scoped runtime per tab; identical queries share its subscription. Never keeps a second record cache. */
export function useCollection(name: string, query: Omit<QuerySpec, 'type'> = {}): Collection {
  const { ctx } = useEnv();
  const csrf = ctx.csrf;
  const key = JSON.stringify({ ...query, type: name });
  const [value, setValue] = useState<{ key: string; csrf: string | undefined; result: Collection }>();
  useEffect(() => {
    let cancelled = false;
    let close: (() => void) | undefined;
    if (!csrf) return;
    void collectionsRuntime(() => csrf).then(({ runtime }) => {
      if (cancelled) return;
      if (runtime.isCleared()) { setValue({ key, csrf, result: { ...waiting(), loading: false, status: 'denied', error: 'Sign in again to load this.' } }); return; }
      const publish = () => {
        if (cancelled) return;
        const state = handle.state();
        const records = runtime.records(name);
        setValue({ key, csrf, result: { ...state, rows: state.keys.flatMap((k) => { const r = records.get(k); return r ? [r] : []; }),
          loading: state.status === 'loading', stale: state.status === 'stale', loadMore: handle.more } });
      };
      const handle = runtime.view(JSON.parse(key) as QuerySpec, publish);
      close = handle.close;
      publish();
    }).catch(() => { if (!cancelled) setValue({ key, csrf, result: { ...waiting(), status: 'error', loading: false, error: 'Couldn’t load this. Try again.' } }); });
    return () => { cancelled = true; close?.(); };
  }, [key, csrf, name]);
  if (!csrf) return { ...waiting(), status: 'denied', loading: false, error: 'Sign in to load this.' };
  return value?.key === key && value.csrf === csrf ? value.result : waiting();
}
