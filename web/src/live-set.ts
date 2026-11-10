// A live set (t-2025, t-2027; docs/specs/collections.md): one subscription per tab to one shared-collection query,
// read by every view that shows it, and derived once into what those views need. Null while it isn't live and whole
// (loading, the stream down, an error, no household, a partial answer): a view then reads its page's own copy, as
// before. It loads the collection runtime as its own chunk (page.ts collectionsRuntime) on the first window that asks.
//
// A runtime that was cleared (signed out, revoked, another person signed in) is never read again: the set goes back to
// null and, while anyone listens, starts again on a new runtime, so what one person was shown never stays for another.
import { useEffect, useSyncExternalStore } from 'react';
import { collectionsRuntime } from './page';
import type { CollectionRuntime, QuerySpec, Rec, ViewState } from './collections/runtime';

export interface LiveSet<T> {
  /** The set now, or null. */
  current(): T | null;
  /** Hear it move (and keep it live while listening). */
  subscribe(f: () => void): () => void;
  /** A React view of it; `csrf` is the page's anti-forgery token (none yet: nothing is asked). */
  use(csrf: string | undefined): T | null;
}

export function liveSet<T>(spec: QuerySpec, derive: (state: ViewState, records: ReadonlyMap<string, Rec>) => T | null, onPublish?: (v: T | null) => void): LiveSet<T> {
  let current: T | null = null;
  let rt: CollectionRuntime | null = null;
  let handle: ReturnType<CollectionRuntime['view']> | null = null;
  let starting: Promise<void> | null = null;
  let token: (() => string) | null = null;
  const hearers = new Set<() => void>();

  const set = (v: T | null) => { current = v; onPublish?.(v); for (const f of hearers) f(); };
  const stop = () => { try { handle?.close(); } catch { /* a cleared runtime */ } handle = null; rt = null; starting = null; };

  function publish(): void {
    if (rt?.isCleared()) { stop(); set(null); if (hearers.size && token) start(token); return; }
    set(rt && handle ? derive(handle.state(), rt.records(spec.type)) : null);
  }

  function start(csrf: () => string): void {
    token = csrf;
    if (starting || typeof window === 'undefined') return;
    const mine = starting = collectionsRuntime(csrf).then(({ runtime }) => {
      if (starting !== mine || runtime.isCleared()) return;
      rt = runtime;
      handle = runtime.view(spec, publish);
      publish();
    }, () => { /* no runtime (the chunk didn't load): the pages' own copies stay */ });
  }

  function subscribe(f: () => void): () => void {
    hearers.add(f);
    return () => {
      hearers.delete(f);
      if (!hearers.size) { stop(); current = null; }
    };
  }

  return {
    current: () => current,
    subscribe,
    use(csrf) {
      const value = useSyncExternalStore(subscribe, () => current, () => null);
      useEffect(() => { if (csrf) start(() => csrf); }, [csrf]);
      return value;
    },
  };
}
