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

/** Ephemeral result: no queue, reconnect replay or manual retry. */
export function callOnce<T = unknown>(operation: string, input: unknown) { return store().call<T>(operation, input, false); }
