import { useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { usePendingRead } from '../loading';
import { createRequest, type AnyVariables, type TypedDocumentNode } from '@urql/core';
import type { DocumentNode } from 'graphql';
import type { generatedDataClient } from './client';
import { Remembered, RememberedWatch } from './remembered';
import { answerArrived, Pace, paceSender, relaxedKey, stampAnswer } from './pace';
import type { LivePace } from '../../../../src/core/data/live-pace';

/** `settling` is set only on a kept snapshot (`data` answers this hook's previous
 * variables while the current ones load) or a remembered one (`data` is the last
 * answer this page had to the same selection: ./remembered.ts). It is never set
 * on a current answer. */
export type DataQuerySnapshot<T> = { status: 'loading' | 'live' | 'offline' | 'denied'; data?: T; settling?: boolean };
export interface DataQueryOptions {
  /** While new variables load, keep showing the last answer this mounted hook
   * showed for the same document, marked `settling`. Off: `loading`, as ever. */
  keep?: boolean;
  /** Open nothing and report `loading` (a by-id selection with nothing selected). */
  pause?: boolean;
  /** How often loom reads the selection again (./pace.ts). Left out, a hook under a `Pace` scope is relaxed and
   * every other hook is eager, as ever. Said, it is what was said: a brick's one read that must keep up with its
   * record (a running session's steps) says `eager`. */
  pace?: LivePace;
}
let shared: Promise<ReturnType<typeof generatedDataClient>> | undefined;
let now: ((keys: string[]) => Promise<string[]>) | undefined;
function client() {
  // The shell may read preferences before any tile loads. Keep the socket and
  // cache implementation off that initial import graph, but share one client.
  return shared ??= import('./client').then(({ generatedDataClient, browserQueryTransport }) => {
    const transport = browserQueryTransport(`${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/graphql`);
    now = keys => transport.now?.(keys) ?? Promise.resolve([]);
    return generatedDataClient(transport);
  }).catch(error => { shared = undefined; now = undefined; throw error; });
}
// Asking for selections now goes over the socket that holds them, and never opens one to ask.
paceSender(keys => (shared ? shared.then(() => now?.(keys) ?? []) : Promise.resolve([])));
type Client = Awaited<ReturnType<typeof client>>;
interface Held<T> { key: number; doc: number; snapshot: DataQuerySnapshot<T>; from?: Client; /** The snapshot is a remembered answer, not yet replaced. */ remembered?: boolean }
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
 * request stays network-only, so access is decided by the server each time.
 *
 * Under a `Remembered` provider (./remembered.ts; the boards page, and nothing of
 * the desktop) a hook also starts from the last live answer this page had to
 * the same selection, marked `settling`, whatever `keep` says, and drops it on
 * the same occasions.
 *
 * Under a `Pace` scope (./pace.ts; a placement on the boards page, and nothing of
 * the desktop) the selection is opened relaxed and can be asked for now. */
export function useDataQuery<T, V extends AnyVariables = AnyVariables>(document: DocumentNode | TypedDocumentNode<T, V> | string, variables?: V, options?: DataQueryOptions): DataQuerySnapshot<T> {
  const keep = options?.keep === true, pause = options?.pause === true;
  const request = createRequest(document, variables as V);
  const key = request.key;
  const stable = useMemo(() => request, [key]);
  // The same number for the same document, whatever the variables.
  const doc = useMemo(() => createRequest(document, undefined as V).key, [document]);
  const memory = useContext(Remembered), watch = useContext(RememberedWatch), scope = useContext(Pace);
  const relaxed = (options?.pace ?? (scope ? 'relaxed' : 'eager')) === 'relaxed';
  const recalled = (): Held<T> | undefined => {
    const found = pause ? undefined : memory?.get(key);
    return found && found.data !== undefined ? { key, doc, snapshot: { status: 'live', data: found.data as T, settling: true }, from: found.from as Client, remembered: true } : undefined;
  };
  const [state, setState] = useState<Held<T>>(() => recalled() ?? { key, doc, snapshot: { status: 'loading' } });
  useEffect(() => {
    setState(held => (held.key === key && held.remembered && !pause ? held : recalled() ?? { key, doc, snapshot: pause ? { status: 'loading' } : between(held, doc, keep), from: held.from }));
    if (pause) return;
    let stopped = false, unsubscribe: (() => void) | undefined;
    void client().then(value => {
      if (stopped) return;
      // A kept answer must not outlive the client that gave it.
      setState(held => held.key === key && held.snapshot.settling && held.from !== value ? { key, doc, snapshot: { status: 'loading' } } : held);
      // A relaxed selection is its own operation, named on the socket by its number so that it can be asked for.
      const wire = relaxedKey(key), read = relaxed ? scope?.open(String(wire), answerArrived(memory?.get(key)?.data)) : undefined;
      const source = relaxed ? value.executeQuery<T, V>({ ...stable, key: wire } as typeof stable, { requestPolicy: 'network-only', pace: 'relaxed' })
        : value.query<T, V>(stable.query, stable.variables as V, { requestPolicy: 'network-only' });
      const sub = source.subscribe(result => {
        if (stopped) return;
        // What the page remembers follows the feed: the newest live answer, and nothing once it fails.
        if (result.error) { memory?.drop(key); read?.failed(); } else if (result.data) { stampAnswer(result.data); memory?.set(key, result.data, value); read?.answered(); }
        setState({ key, doc, from: value, snapshot: result.error ? { status: 'offline' } : result.data ? { status: 'live', data: result.data } : { status: 'loading' } });
      });
      unsubscribe = () => { sub.unsubscribe(); read?.close(); };
    }).catch(() => { if (!stopped) { memory?.drop(key); setState({ key, doc, snapshot: { status: 'offline' } }); } });
    return () => { stopped = true; unsubscribe?.(); };
  }, [key, stable, doc, keep, pause, memory, relaxed, scope]);
  const current = state.key === key;
  const shown = current ? state.snapshot : between(state, doc, keep);
  const remembered = current && !pause && !!state.remembered && !!shown.settling;
  // Whoever draws this hook is told while it shows a remembered answer, before the frame is painted.
  const me = useRef({});
  useLayoutEffect(() => { if (!watch || !remembered) return; watch(me.current, true); return () => watch(me.current, false); }, [watch, remembered]);
  usePendingRead(!pause && (shown.status === 'loading' || !!shown.settling));
  if (pause) return { status: 'loading' };
  return shown.settling && !keep && !remembered ? { status: 'loading' } : shown;
}

/** A read asked once, by one POST to /graphql under the page's own sign-in, when the hook is drawn and again
 * whenever its variables change; never a live selection, so no write anywhere reads it again. For a read that goes
 * outside loom each time it is asked (a changed file's patch, from GitHub: docs/specs/boards.md). `pause` asks
 * nothing. A failed request or an answer with errors is `offline`; a refused sign-in is `denied`. */
export function useDataOnce<T>(document: string, variables: Record<string, unknown>, options?: { pause?: boolean }): DataQuerySnapshot<T> {
  const pause = options?.pause === true, key = JSON.stringify([document, variables]);
  const [state, setState] = useState<{ key: string; snapshot: DataQuerySnapshot<T> }>({ key, snapshot: { status: 'loading' } });
  useEffect(() => {
    if (pause) return;
    const stop = new AbortController();
    void fetch('/graphql', { method: 'POST', credentials: 'same-origin', signal: stop.signal, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ query: document, variables }) })
      .then(async (response) => {
        if (response.status === 401 || response.status === 403) return { status: 'denied' } as const;
        const body = (await response.json()) as { data?: T; errors?: unknown[] };
        return response.ok && !body.errors?.length && body.data ? { status: 'live', data: body.data } as const : { status: 'offline' } as const;
      })
      .catch(() => ({ status: 'offline' }) as const)
      .then((snapshot) => { if (!stop.signal.aborted) setState({ key, snapshot }); });
    return () => stop.abort();
    // The key is the document and variables, written out.
  }, [key, pause]);
  usePendingRead(!pause && (state.key !== key || state.snapshot.status === 'loading'));
  return pause || state.key !== key ? { status: 'loading' } : state.snapshot;
}
