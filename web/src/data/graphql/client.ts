import {reconnectDelay,checkSessionEvent,deskConnectionParams} from '../connection';
import { createClient, CombinedError, type Exchange, type OperationResult } from '@urql/core';
import { cacheExchange, type KeyingConfig } from '@urql/exchange-graphcache';
import { print, type FormattedExecutionResult } from 'graphql';
import { createClient as createSocket, type Sink, type SubscribePayload } from 'graphql-ws';
import { filter, make, mergeMap, pipe, share, takeUntil } from 'wonka';

interface Patch { path: (string | number)[]; removed: boolean; value?: unknown }
interface Delta { revision: number; patches: Patch[] }
export interface QueryTransport {
  subscribe(request: SubscribePayload, sink: Sink<FormattedExecutionResult>): () => void;
  disconnected(listener: () => void): () => void;
  close(): void;
}
const envelope = 'subscription LoomData($query: String!, $variables: DataValue, $operationName: String) { observe(query: $query, variables: $variables, operationName: $operationName) { revision patches { path removed value } } }';

/** Apply ordered result patches without mutating values retained by Graphcache
 * or React. A protocol gap clears the stream instead of guessing its base. */
export function applyDataPatch(current: unknown, patch: Patch): unknown {
  function apply(value: unknown, offset: number): unknown {
    if (offset === patch.path.length) return patch.value;
    const key = patch.path[offset];
    if (!value || typeof value !== 'object' || (typeof key !== 'string' && typeof key !== 'number')) throw new Error('Invalid data patch path');
    const last = offset === patch.path.length - 1;
    if (Array.isArray(value)) {
      if (typeof key !== 'number' || !Number.isInteger(key) || key < 0 || key > value.length || (patch.removed && key >= value.length)) throw new Error('Invalid array patch');
      const copy = [...value];
      if (last && patch.removed) copy.splice(key, 1);
      else copy[key] = apply(value[key], offset + 1);
      return copy;
    }
    const record = value as Record<string, unknown>;
    if (!last && !Object.hasOwn(record, key)) throw new Error('Invalid object patch');
    const copy = { ...record };
    if (last && patch.removed) delete copy[key];
    else Object.defineProperty(copy, key, { value: apply(record[key], offset + 1), enumerable: true, configurable: true, writable: true });
    return copy;
  }
  if (!patch.path.length && patch.removed) throw new Error('Cannot remove result root');
  return apply(current, 0);
}

/** Every urql query is a live generated selection over the one socket. Only
 * patch bytes cross the wire; reconstructed results enter normal Graphcache
 * normalization. No tile invents a data shape or owns another connection. */
export function liveQueryExchange(transport: QueryTransport): Exchange {
  return () => operations => {
    const shared = share(operations), active = new Set<number>();
    return pipe(shared, filter(operation => operation.kind === 'query' && !active.has(operation.key)), mergeMap(operation => {
      active.add(operation.key);
      return pipe(make<OperationResult>(observer => {
        let current: unknown, revision = 0, stopped = false;
        const unavailable = (message: string) => {
          current = undefined; revision = 0;
          observer.next({ operation, error: new CombinedError({ networkError: new Error(message) }), hasNext: true, stale: false });
        };
        const stopDisconnect = transport.disconnected(() => unavailable('Connection closed'));
        const stop = transport.subscribe({ query: envelope, variables: { query: print(operation.query), variables: operation.variables, operationName: operation.query.definitions.find(def => def.kind === 'OperationDefinition')?.name?.value } }, {
          next(result) {
            if (stopped) return;
            try {
              if (result.errors?.length) throw new Error('Data selection refused');
              const delta = (result.data as { observe?: Delta } | undefined)?.observe;
              if (!delta || !Number.isInteger(delta.revision) || delta.revision < 1 || !Array.isArray(delta.patches)) throw new Error('Invalid data revision');
              if (delta.revision === 1) {
                if (delta.patches.length !== 1 || delta.patches[0].path.length || delta.patches[0].removed) throw new Error('Missing initial result');
                current = undefined; revision = 0;
              }
              if (delta.revision !== revision + 1) throw new Error('Data revision gap');
              for (const patch of delta.patches) current = applyDataPatch(current, patch);
              revision = delta.revision;
              observer.next({ operation, data: current, hasNext: true, stale: false });
            } catch { unavailable('Data subscription could not complete'); }
          },
          error() { unavailable('Data subscription could not complete'); },
          complete() { if (!stopped) unavailable('Data subscription ended'); },
        });
        return () => { stopped = true; active.delete(operation.key); stopDisconnect(); stop(); };
      }), takeUntil(pipe(shared, filter(other => other.kind === 'teardown' && other.key === operation.key))));
    }));
  };
}

export function browserQueryTransport(url: string): QueryTransport {
  const listeners = new Set<() => void>();
  let watchdog:ReturnType<typeof setTimeout>|undefined;
  const subscriptions=new Set<()=>void>();
  let disposed=false;
  let wakeRetry:(()=>void)|undefined;
  const clearWatchdog=()=>{clearTimeout(watchdog);watchdog=undefined;};
  const armWatchdog=()=>{clearWatchdog();watchdog=setTimeout(()=>socket.terminate(),15_000);};
  const offline=()=>{clearWatchdog();for(const listener of listeners)listener();};
  const socket = createSocket({
    url,lazy:true,retryAttempts:Infinity,keepAlive:20_000,connectionAckWaitTimeout:15_000,
    connectionParams:deskConnectionParams,
    // Browsers report a failed upgrade with an error Event before the close
    // code. graphql-ws defaults to retrying only CloseEvent-shaped failures.
    shouldRetry:event=>(event instanceof Event && event.type==='error') ||
      (!!event && typeof event==='object' && 'code' in event && 'reason' in event),
    retryWait:attempt=>new Promise<void>(resolve=>{
      const finish=()=>{clearTimeout(timer);globalThis.window?.removeEventListener('online',finish);globalThis.document?.removeEventListener('visibilitychange',visible);wakeRetry=undefined;resolve();};
      const visible=()=>{if(document.visibilityState==='visible')finish();};
      const timer=setTimeout(finish,reconnectDelay(attempt));
      wakeRetry=finish;
      globalThis.window?.addEventListener('online',finish);
      globalThis.document?.addEventListener('visibilitychange',visible);
    }),
    on:{connecting:armWatchdog,connected:clearWatchdog,
      ping:received=>{if(!received)armWatchdog();},pong:received=>{if(received)clearWatchdog();},
      closed:event=>{offline();if((event as CloseEvent).code===4403)globalThis.window?.dispatchEvent(new Event(checkSessionEvent));},
      error:()=>{offline();globalThis.window?.dispatchEvent(new Event(checkSessionEvent));}},
  });
  return {subscribe(request,sink){
      if(disposed){sink.complete();return ()=>{};}
      const stop=socket.subscribe<Record<string,unknown>,Record<string,unknown>>(request,{
        next:value=>sink.next(value),
        error:error=>{subscriptions.delete(stop);sink.error(error);},
        complete:()=>{subscriptions.delete(stop);sink.complete();},
      });
      subscriptions.add(stop);
      return ()=>{subscriptions.delete(stop);stop();};
    },
    disconnected(listener){listeners.add(listener);return ()=>{listeners.delete(listener);};},
    close(){
      disposed=true;listeners.clear();clearWatchdog();
      for(const stop of subscriptions)stop();
      subscriptions.clear();
      // dispose marks the client closed but waits for an unacknowledged handshake.
      // terminate rejects that wait, and waking a backoff releases its timer.
      void Promise.resolve(socket.dispose()).catch(()=>{});
      socket.terminate();wakeRetry?.();
    }};

}
export const dataCacheKeys: KeyingConfig = {
  // Sequence numbers are local to a thread. Encode the complete tuple so
  // messages from different threads cannot share a normalized entity.
  CommsMessageView: row =>
    typeof row.thread === 'string' && typeof row.seq === 'number'
      ? JSON.stringify([row.thread, row.seq]) : null,
};
export function generatedDataClient(transport: QueryTransport) {
  return createClient({ url: '/graphql', requestPolicy: 'network-only', exchanges: [cacheExchange({ keys: dataCacheKeys }), liveQueryExchange(transport)] });
}
