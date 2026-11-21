import { useCallback, useRef, useSyncExternalStore } from 'react';
import { usePendingRead } from './loading';
import { DataStore, type LiveRecord, type Snapshot, type Socket } from './store';
export * from './store';
export { newId } from './id';
import { newId } from './id';
let windowStore: DataStore | undefined;
function store() {
  return windowStore ??= new DataStore({
    socket: () => new WebSocket(`${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/live`) as unknown as Socket,
    id: () => newId(),
    after: (ms, fn) => { const timer = setTimeout(fn, ms); return () => clearTimeout(timer); },
  });
}
export function useRecords<T extends LiveRecord = LiveRecord>(type: string, scope?: string): Snapshot<T> {
  const data = store();
  const reading = useSyncExternalStore(
    useCallback(fn => data.subscribe(type, scope, fn), [data, type, scope]),
    useCallback(() => data.getSnapshot(type, scope) as Snapshot<T>, [data, type, scope]),
  );
  usePendingRead(reading.status === 'loading');
  return reading;
}
/** Several exact scopes with one stable snapshot; changing scopes never reparents a reader. */
export function useRecordScopes<T extends LiveRecord = LiveRecord>(type:string,scopes:readonly string[]):readonly Snapshot<T>[] {
 const data=store(),key=JSON.stringify(scopes),cache=useRef<readonly Snapshot<T>[]>([]);
 const reading = useSyncExternalStore(
  useCallback(fn=>{const cleanups=(JSON.parse(key) as string[]).map(scope=>data.subscribe(type,scope,fn));return()=>cleanups.forEach(close=>close());},[data,type,key]),
  useCallback(()=>{const next=(JSON.parse(key) as string[]).map(scope=>data.getSnapshot(type,scope) as Snapshot<T>);if(next.length!==cache.current.length||next.some((snapshot,i)=>snapshot!==cache.current[i]))cache.current=next;return cache.current;},[data,type,key]),
 );
 usePendingRead(reading.some(s => s.status === 'loading'));
 return reading;
}
export function call<T = unknown>(operation: string, input: unknown) { return store().call<T>(operation, input); }

/** Ephemeral result: no queue, reconnect replay or manual retry. */
export function callOnce<T = unknown>(operation: string, input: unknown) { return store().call<T>(operation, input, false); }
