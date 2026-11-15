/** Shared, ephemeral GraphQL selections. Records never outlive their connection. */
export type QueryStatus = 'loading' | 'live' | 'offline' | 'denied' | 'error';
export interface QuerySnapshot { status: QueryStatus; data?: Record<string, unknown> }
export interface QueryRequest { query: string; variables?: Record<string, unknown>; operationName?: string }
export interface QueryTransport {
  subscribe(request: QueryRequest, next: (value: unknown) => void, error: () => void, complete: () => void): () => void;
  close(): void;
}
interface Entry { request: QueryRequest; snapshot: QuerySnapshot; revision: number; listeners: Set<() => void>; stop?: () => void }
const observe = 'subscription LiveSelection($query:String!,$variables:DataValue,$operationName:String){ observe(query:$query,variables:$variables,operationName:$operationName){ revision patches { path removed value } } }';
const forbidden = new Set(['__proto__', 'constructor', 'prototype']);
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>[k,canonical(v)]));
  return value;
}
export const queryKey = (request: QueryRequest) => JSON.stringify(canonical(request));
/** Copy on write: a patch must never mutate a snapshot a screen already read. */
function patchAt(before: unknown, path: (string|number)[], removed: boolean, value: unknown): unknown {
  if (!path.length) { if(removed)throw Error();return value; }
  const [key,...rest]=path;
  if (typeof key==='string' && forbidden.has(key)) throw Error();
  if (Array.isArray(before)) {
    if(typeof key!=='number'||!Number.isSafeInteger(key)||key<0||key>before.length)throw Error();
    const copy=before.slice();
    if(!rest.length&&removed){if(key===copy.length)throw Error();copy.splice(key,1);}
    else copy[key]=patchAt(copy[key],rest,removed,value);
    return copy;
  }
  if(!before||typeof before!=='object'||typeof key!=='string')throw Error();
  const copy={...before} as Record<string,unknown>;
  if(!rest.length&&removed){if(!Object.hasOwn(copy,key))throw Error();delete copy[key];}
  else copy[key]=patchAt(copy[key],rest,removed,value);
  return copy;
}
export class QueryStore {
  private entries=new Map<string,Entry>();
  private transport?:QueryTransport;
  private stopped=false;
  private denied=false;
  constructor(private factory:(lost:(denied:boolean)=>void)=>QueryTransport){}
  private entry(request:QueryRequest) {
    const key=queryKey(request);let entry=this.entries.get(key);
    if(!entry){entry={request:JSON.parse(key),snapshot:{status:this.denied?'denied':this.stopped?'offline':'loading'},revision:0,listeners:new Set()};this.entries.set(key,entry);}
    return entry;
  }
  getSnapshot=(request:QueryRequest)=>this.entry(request).snapshot;
  private publish(entry:Entry,snapshot:QuerySnapshot){entry.snapshot=snapshot;for(const fn of entry.listeners)fn();}
  private lost=(denied:boolean)=>{
    this.denied ||= denied;
    for(const entry of this.entries.values()){entry.revision=0;this.publish(entry,{status:this.denied?'denied':'offline'});}
  };
  subscribe=(request:QueryRequest,listener:()=>void)=>{
    const entry=this.entry(request);entry.listeners.add(listener);
    if(!entry.stop&&!this.stopped&&!this.denied){
      this.transport??=this.factory(this.lost);
      let ended=false;
      const active=()=>!ended&&!this.stopped&&!this.denied&&entry.listeners.size>0;
      entry.stop=this.transport.subscribe({query:observe,variables:{query:entry.request.query,variables:entry.request.variables,operationName:entry.request.operationName}},raw=>{
        if(!active())return;
        try{
          const result=raw as {data?:{observe?:{revision:number;patches:Array<{path:(string|number)[];removed:boolean;value?:unknown}>}};errors?:unknown[]};
          const delta=result.data?.observe;
          if(result.errors?.length||!delta||!Number.isSafeInteger(delta.revision)||delta.revision!==entry.revision+1||!Array.isArray(delta.patches))throw Error();
          if(entry.revision===0&&(delta.patches.length!==1||delta.patches[0].path.length!==0||delta.patches[0].removed))throw Error();
          let data:unknown=entry.snapshot.data;
          for(const patch of delta.patches){
            if(!Array.isArray(patch.path)||typeof patch.removed!=='boolean'||!patch.path.every(p=>typeof p==='string'||typeof p==='number'))throw Error();
            data=patchAt(data,patch.path,patch.removed,patch.value);
          }
          if(!data||typeof data!=='object'||Array.isArray(data))throw Error();
          entry.revision=delta.revision;this.publish(entry,{status:'live',data:data as Record<string,unknown>});
        }catch{ended=true;this.publish(entry,{status:'error'});entry.stop?.();}
      },()=>{if(active()){ended=true;this.publish(entry,{status:'error'});}},()=>{if(active()){ended=true;this.publish(entry,{status:'offline'});}});
    }
    return()=>{entry.listeners.delete(listener);if(!entry.listeners.size){entry.stop?.();entry.stop=undefined;entry.revision=0;entry.snapshot={status:this.denied?'denied':'loading'};this.entries.delete(queryKey(request));}};
  };
  close(){this.stopped=true;for(const entry of this.entries.values()){entry.stop?.();entry.stop=undefined;}this.transport?.close();this.transport=undefined;this.lost(false);}
}
