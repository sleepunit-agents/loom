import { useSyncExternalStore } from 'react';
import { call, type Call } from '../../data';
// A transport retry survives a reader or tile being unmounted. Keep the mutation
// lock for this window alongside it, and expose the same receipt on reopening.
let request: Call | undefined;
const listeners = new Set<() => void>();
const notify = () => listeners.forEach(fn => fn());
export function send(operation: string, input: unknown) {
  if (request?.getSnapshot().pending) return;
  request = call(`clock.${operation}`, input);
  const stop = request.subscribe(() => { notify(); if (!request?.getSnapshot().pending) stop(); });
  notify();
}
export function useRequest() {
  useSyncExternalStore(fn => { listeners.add(fn); return () => { listeners.delete(fn); }; }, () => request?.getSnapshot());
  return request?.getSnapshot();
}
