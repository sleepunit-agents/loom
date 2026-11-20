import { useEffect, useMemo, useState } from 'react';
import { createRequest, type AnyVariables, type TypedDocumentNode } from '@urql/core';
import type { DocumentNode } from 'graphql';
import type { generatedDataClient } from './client';

/** `settling` is set only on a kept snapshot: `data` answers this hook's previous
 * variables while the current ones load. It is never set on a current answer. */
export type DataQuerySnapshot<T> = { status: 'loading' | 'live' | 'offline' | 'denied'; data?: T; settling?: boolean };
export interface DataQueryOptions {
  /** While new variables load, keep showing the last answer this mounted hook
   * showed for the same document, marked `settling`. Off: `loading`, as ever. */
  keep?: boolean;
  /** Open nothing and report `loading` (a by-id selection with nothing selected). */
  pause?: boolean;
}
let shared: Promise<ReturnType<typeof generatedDataClient>> | undefined;
function client() {
  // The shell may read preferences before any tile loads. Keep the socket and
  // cache implementation off that initial import graph, but share one client.
  return shared ??= import('./client').then(({ generatedDataClient, browserQueryTransport }) =>
    generatedDataClient(browserQueryTransport(`${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/graphql`)),
  ).catch(error => { shared = undefined; throw error; });
}
type Client = Awaited<ReturnType<typeof client>>;
interface Held<T> { key: number; doc: number; snapshot: DataQuerySnapshot<T>; from?: Client }
/** What a hook shows between a change of variables and the first answer to it. */
function between<T>(held: Held<T>, doc: number, keep: boolean): DataQuerySnapshot<T> {
  return keep && held.doc === doc && held.snapshot.status === 'live' && held.snapshot.data !== undefined
    ? { status: 'live', data: held.snapshot.data, settling: true } : { status: 'loading' };
}
/** Stable browser feed seam for every tile. Queries are against the generated
 * schema; Graphcache supplies shared normalized entities and graphql-ws shares
 * one reconnecting connection. Hide retained data as soon as a feed fails.
 *
 * `keep` holds one thing only: the last live answer in this hook's own React
 * state, for the same document, until the next variables answer. It is dropped
 * the moment that request errors or the feed closes, when the document changes,
 * when the option goes off, on unmount, and if the shared client is ever not
 * the one that produced it. Nothing is read from Graphcache or from disk: every
 * request stays network-only, so access is decided by the server each time. */
export function useDataQuery<T, V extends AnyVariables = AnyVariables>(document: DocumentNode | TypedDocumentNode<T, V> | string, variables?: V, options?: DataQueryOptions): DataQuerySnapshot<T> {
  const keep = options?.keep === true, pause = options?.pause === true;
  const request = createRequest(document, variables as V);
  const key = request.key;
  const stable = useMemo(() => request, [key]);
  // The same number for the same document, whatever the variables.
  const doc = useMemo(() => createRequest(document, undefined as V).key, [document]);
  const [state, setState] = useState<Held<T>>({ key, doc, snapshot: { status: 'loading' } });
  useEffect(() => {
    setState(held => ({ key, doc, snapshot: pause ? { status: 'loading' } : between(held, doc, keep), from: held.from }));
    if (pause) return;
    let stopped = false, unsubscribe: (() => void) | undefined;
    void client().then(value => {
      if (stopped) return;
      // A kept answer must not outlive the client that gave it.
      setState(held => held.key === key && held.snapshot.settling && held.from !== value ? { key, doc, snapshot: { status: 'loading' } } : held);
      const sub = value.query<T, V>(stable.query, stable.variables as V, { requestPolicy: 'network-only' }).subscribe(result => {
        if (!stopped) setState({ key, doc, from: value, snapshot: result.error ? { status: 'offline' } : result.data ? { status: 'live', data: result.data } : { status: 'loading' } });
      });
      unsubscribe = () => sub.unsubscribe();
    }).catch(() => { if (!stopped) setState({ key, doc, snapshot: { status: 'offline' } }); });
    return () => { stopped = true; unsubscribe?.(); };
  }, [key, stable, doc, keep, pause]);
  if (pause) return { status: 'loading' };
  const shown = state.key === key ? state.snapshot : between(state, doc, keep);
  return shown.settling && !keep ? { status: 'loading' } : shown;
}
