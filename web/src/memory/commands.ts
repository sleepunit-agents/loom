/** Memory's existing commands on the shared outside door. No socket, queue,
 * reconnect replay or read cache; an uncertain attempt keeps its retry ID. */
import {newId} from '../data/id';
import type {Call,CallState,Result,Failure} from '../data/store';
type Operation='mind.knowledgeAdd'|'mind.knowledgeVerify'|'mind.knowledgeRecheck'|'mind.personAdd';
type Send=(url:string,init:RequestInit)=>Promise<Response>;
const unavailable:Failure={ok:false,code:'unavailable',message:'Memory could not save this change'};
const denied:Failure={ok:false,code:'denied',message:'Memory access ended'};
export function memoryCall<T=unknown>(operation:Operation,input:unknown,send:Send=fetch):Call<T>{
 const id=newId(),[piece,name]=operation.split('.'),body=JSON.stringify({input,id}),listeners=new Set<()=>void>();
 let state:CallState<T>={pending:true,status:'pending'},finish!:(answer:Result<T>)=>void;
 const result=new Promise<Result<T>>(resolve=>{finish=resolve;});
 const publish=()=>{for(const listener of listeners)listener();};
 const run=async()=>{
  state={pending:true,status:'pending'};publish();let answer:Result<T>=unavailable;
  try{
   const response=await send(`/api/${piece}/${name}`,{method:'POST',credentials:'same-origin',cache:'no-store',headers:{'content-type':'application/json'},body});
   if(response.status===401||response.status===403)answer=denied;
   else{
    const value=await response.json();
    if(response.ok&&value?.ok===true&&Object.hasOwn(value,'value'))answer={ok:true,value:value.value};
    else if(value?.ok===false&&typeof value.message==='string'){
     if(value.code==='denied')answer=denied;
     else if(['not-found','invalid','conflict'].includes(value.code))answer={ok:false,code:value.code,message:value.message};
    }
   }
  }catch{/* An ambiguous transport result must not start a fresh write. */}
  state={pending:false,status:'done',result:answer};finish(answer);publish();
 };
 void run();
 return {id,result,getSnapshot:()=>state,subscribe(listener){listeners.add(listener);return()=>{listeners.delete(listener);};},retry(){if(!state.pending&&state.result?.ok===false&&state.result.code==='unavailable')void run();}};
}
