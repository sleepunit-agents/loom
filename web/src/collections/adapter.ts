/**
 * The client library behind the collection runtime (docs/specs/collections.md, "Decided", 1 and 4): TanStack DB, the
 * versions t-2018 measured, pinned exactly in web/package.json (@tanstack/db and @tanstack/react-db 1.0.0-rc.1.4).
 * This is the only file that imports it. Swapping the library changes this file and nothing else.
 *
 * Each record type the runtime holds is mirrored into one TanStack collection, written through its sync seam as the
 * runtime's stores move, so every view of a type in the tab reads one collection. A view binds the runtime's state
 * (which keys, in which order, coverage, counts, freshness) to the records that collection holds.
 */
import { createCollection, type Collection } from '@tanstack/db';
import { useLiveQuery } from '@tanstack/react-db';
import { useEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import { CollectionRuntime, type QuerySpec, type Rec, type StoreHook, type Transport, type ViewState } from './runtime';

type Writer = { begin: () => void; write: (m: { type: 'insert' | 'update' | 'delete'; value: Rec }) => void; commit: () => void };

/** The TanStack collections, one per record type, fed by the runtime's stores. */
export class LibraryStores implements StoreHook {
  private colls = new Map<string, { coll: Collection<Rec, string>; writer?: Writer; held: Map<string, Rec> }>();

  collection(type: string): Collection<Rec, string> {
    let c = this.colls.get(type);
    if (!c) {
      const entry: { coll?: Collection<Rec, string>; writer?: Writer; held: Map<string, Rec> } = { held: new Map() };
      entry.coll = createCollection<Rec, string>({
        id: `loom:${type}`,
        getKey: (r) => r.key,
        // Kept while the runtime holds the type; it decides when records go.
        gcTime: 0,
        sync: {
          sync: ({ begin, write, commit, markReady }) => {
            entry.writer = { begin, write: (m) => write(m as never), commit: () => { commit(); } };
            // What the runtime already held before anything read this collection.
            if (entry.held.size) { begin(); for (const r of entry.held.values()) write({ type: 'insert', value: r } as never); commit(); }
            markReady();
            return () => { entry.writer = undefined; };
          },
        },
      }) as Collection<Rec, string>;
      c = entry as { coll: Collection<Rec, string>; writer?: Writer; held: Map<string, Rec> };
      this.colls.set(type, c);
    }
    return c.coll;
  }

  upsert(type: string, recs: readonly Rec[]): void {
    const c = this.colls.get(type) ?? (this.collection(type), this.colls.get(type)!);
    const w = c.writer;
    if (w) w.begin();
    for (const r of recs) {
      const had = c.held.has(r.key);
      c.held.set(r.key, r);
      w?.write({ type: had ? 'update' : 'insert', value: r });
    }
    w?.commit();
  }

  remove(type: string, keys: readonly string[]): void {
    const c = this.colls.get(type);
    if (!c) return;
    const gone = keys.filter((k) => c.held.has(k));
    if (!gone.length) return;
    c.writer?.begin();
    for (const k of gone) { const r = c.held.get(k)!; c.held.delete(k); c.writer?.write({ type: 'delete', value: r }); }
    c.writer?.commit();
  }

  drop(type: string): void {
    const c = this.colls.get(type);
    if (!c) return;
    this.remove(type, [...c.held.keys()]);
    this.colls.delete(type);
    void c.coll.cleanup();
  }

  /** What a type's collection holds (tests). */
  held(type: string): number { return this.colls.get(type)?.held.size ?? 0; }
}

/** The tab's runtime and its library stores, made together. */
export function makeRuntime(t: Transport): { runtime: CollectionRuntime; stores: LibraryStores } {
  const stores = new LibraryStores();
  return { runtime: new CollectionRuntime(t, stores), stores };
}

export interface LiveView extends ViewState {
  rows: Rec[];
  more: boolean;
  loadMore: () => void;
}

/**
 * A live view of `spec` for a window: its rows in order, with coverage, counts and freshness. Windows asking the same
 * thing share one subscription; the records come from the type's one collection.
 */
export function useCollectionView(rt: { runtime: CollectionRuntime; stores: LibraryStores }, spec: QuerySpec): LiveView {
  const specKey = JSON.stringify(spec);
  const handle = useRef<ReturnType<CollectionRuntime['view']> | null>(null);
  const listeners = useRef(new Set<() => void>());
  const view = useMemo(() => {
    const h = rt.runtime.view(spec, () => { for (const f of listeners.current) f(); });
    handle.current = h;
    return h;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rt, specKey]);
  useEffect(() => () => view.close(), [view]);
  const state = useSyncExternalStore((f) => { listeners.current.add(f); return () => listeners.current.delete(f); }, view.state, view.state);
  const coll = rt.stores.collection(spec.type);
  const live = useLiveQuery((q) => q.from({ r: coll }));
  const byKey = live.state as Map<string | number, Rec> | undefined;
  const rows = state.keys.flatMap((k) => { const r = byKey?.get(k); return r ? [r] : []; });
  return { ...state, rows, loadMore: view.more };
}
