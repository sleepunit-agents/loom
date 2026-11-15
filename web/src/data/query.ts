import { useCallback, useMemo, useSyncExternalStore } from 'react';
import { createClient } from 'graphql-ws';
import { QueryStore, queryKey, type QueryRequest, type QueryStatus, type QueryTransport } from './query-store';
export { QueryStore } from './query-store';
export interface QuerySelection<T> extends QueryRequest { decode(data:Record<string,unknown>):T }
export interface SelectionSnapshot<T> {status:QueryStatus;data?:T}
/** One lazy transport for the window. Reconnect starts each query at revision 1. */
export function queryTransport(lost:(denied:boolean)=>void):QueryTransport {
  const client=createClient({url:`${location.protocol==='https:'?'wss:':'ws:'}//${location.host}/graphql`,lazy:true,retryAttempts:Infinity,
    on:{closed:event=>{const code=(event as {code?:number}).code;lost(code===4401||code===4403);}},
  });
  return {subscribe:(request,next,error,complete)=>client.subscribe(request,{next,error,complete}),close:()=>{void client.dispose();}};
}
let windowQueries:QueryStore|undefined;
export function useQuery<T>(selection:QuerySelection<T>):SelectionSnapshot<T>{
  const store=windowQueries??=new QueryStore(queryTransport),key=queryKey(selection);
  const request=useMemo(()=>JSON.parse(key) as QueryRequest,[key]);
  const raw=useSyncExternalStore(useCallback(fn=>store.subscribe(request,fn),[store,request]),useCallback(()=>store.getSnapshot(request),[store,request]));
  return useMemo(()=>{
    if(raw.status!=='live'||!raw.data)return {status:raw.status};
    try{return {status:'live' as const,data:selection.decode(raw.data)};}catch{return {status:'error' as const};}
  },[raw,selection]);
}
