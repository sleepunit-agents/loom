import { useEffect, useMemo, useState } from 'react';
import { createRequest, type AnyVariables, type TypedDocumentNode } from '@urql/core';
import type { DocumentNode } from 'graphql';
import type { generatedDataClient } from './client';

export type DataQuerySnapshot<T> = { status: 'loading' | 'live' | 'offline' | 'denied'; data?: T };
let shared: Promise<ReturnType<typeof generatedDataClient>> | undefined;
function client() {
  // The shell may read preferences before any tile loads. Keep the socket and
  // cache implementation off that initial import graph, but share one client.
  return shared ??= import('./client').then(({ generatedDataClient, browserQueryTransport }) =>
    generatedDataClient(browserQueryTransport(`${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/graphql`)),
  ).catch(error => { shared = undefined; throw error; });
}
/** Stable browser feed seam for every tile. Queries are against the generated
 * schema; Graphcache supplies shared normalized entities and graphql-ws shares
 * one reconnecting connection. Hide retained data as soon as a feed fails. */
export function useDataQuery<T, V extends AnyVariables = AnyVariables>(document: DocumentNode | TypedDocumentNode<T, V> | string, variables?: V): DataQuerySnapshot<T> {
  const request = createRequest(document, variables as V);
  const key = request.key;
  const stable = useMemo(() => request, [key]);
  const [state, setState] = useState<{ key: number; snapshot: DataQuerySnapshot<T> }>({ key, snapshot: { status: 'loading' } });
  useEffect(() => {
    setState({ key, snapshot: { status: 'loading' } });
    let stopped = false, unsubscribe: (() => void) | undefined;
    void client().then(value => {
      if (stopped) return;
      const sub = value.query<T, V>(stable.query, stable.variables as V, { requestPolicy: 'network-only' }).subscribe(result => {
        if (!stopped) setState({ key, snapshot: result.error ? { status: 'offline' } : result.data ? { status: 'live', data: result.data } : { status: 'loading' } });
      });
      unsubscribe = () => sub.unsubscribe();
    }).catch(() => { if (!stopped) setState({ key, snapshot: { status: 'offline' } }); });
    return () => { stopped = true; unsubscribe?.(); };
  }, [key, stable]);
  return state.key === key ? state.snapshot : { status: 'loading' };
}
