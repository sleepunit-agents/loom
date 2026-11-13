import { useCallback, useSyncExternalStore } from 'react';
import { DataStore, type LiveRecord, type Snapshot, type Socket } from './store';
export * from './store';
let windowStore: DataStore | undefined;
function store() {
  return windowStore ??= new DataStore({
    socket: () => new WebSocket(`${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/live`) as unknown as Socket,
    id: () => crypto.randomUUID(),
    after: (ms, fn) => { const timer = setTimeout(fn, ms); return () => clearTimeout(timer); },
  });
}
export function useRecords<T extends LiveRecord = LiveRecord>(type: string, scope?: string): Snapshot<T> {
  const data = store();
  return useSyncExternalStore(
    useCallback(fn => data.subscribe(type, scope, fn), [data, type, scope]),
    useCallback(() => data.getSnapshot(type, scope) as Snapshot<T>, [data, type, scope]),
  );
}
export function call<T = unknown>(operation: string, input: unknown) { return store().call<T>(operation, input); }
/** Compatibility consumers share the same socket and records as React apps. */
export function recordsSnapshot<T extends LiveRecord = LiveRecord>(type: string, scope?: string): Snapshot<T> { return store().getSnapshot(type, scope) as Snapshot<T>; }
export function watchRecords<T extends LiveRecord = LiveRecord>(type: string, scope: string | undefined, changed: (snapshot: Snapshot<T>) => void) {
  const data = store();
  const publish = () => changed(data.getSnapshot(type,scope) as Snapshot<T>);
  const stop = data.subscribe(type,scope,publish); publish(); return stop;
}
