/** Decode Memory documents on the window's canonical GraphQL client. */
import {useDataQuery,type DataQuerySnapshot} from '../data/graphql';
import type {MemorySelection} from './queries';
export type MemorySnapshot<T>={status:DataQuerySnapshot<unknown>['status'];value?:T};
const idle='query MemoryIdle { __typename }';
/** Inactive selections share one word-free query until the canonical hook has
 * a pause seam. No connection, cache, replay or retained result lives here. */
export function useMemoryQuery<T>(selection:MemorySelection<T>|undefined):MemorySnapshot<T>{
 const result=useDataQuery<Record<string,unknown>>(selection?.query??idle,selection?.variables);
 if(!selection)return {status:'live'};
 if(result.status!=='live')return {status:result.status};
 try{return {status:'live',value:selection.decode(result.data??{})};}
 catch{return {status:'offline'};}
}
/** Local view adapters only; result ownership stays with the canonical client. */
export function useMemoryRecord<T>(selection:MemorySelection<T|null>|undefined){
 const result=useMemoryQuery(selection);return {status:result.status,records:result.value?[result.value]:[]};
}
export function useMemoryList<T>(selection:MemorySelection<T[]>){
 const result=useMemoryQuery(selection);return {status:result.status,records:result.value??[]};
}
