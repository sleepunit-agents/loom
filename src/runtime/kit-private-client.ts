import {KitRefused} from './kit-refused.js';
import {PRIVATE_SECRET_TIMEOUT_MS} from '../pieces/secrets/private-client.js';
import {privateOrigin} from '../core/private-origin.js';
import type {KitPost} from './kit-broker.js';

/** Neither proof alone authorizes the worker's kit door. Ignore every error
 * body, never follow a redirect, and never automatically replay a call. */
export function kitPrivateClient(input:{url:string;runner:string;body:string;job:string}):KitPost{
  const origin=privateOrigin(input.url);
  return async(verb,payload,signal)=>{
    const response=await fetch(new URL('/api/kits/private/'+verb,origin),{method:'POST',redirect:'error',cache:'no-store',
      headers:{authorization:'Bearer '+input.runner,'x-loom-body-credential':input.body,'x-loom-kit-job':input.job,'content-type':'application/json'},
      signal:AbortSignal.any([signal,AbortSignal.timeout(PRIVATE_SECRET_TIMEOUT_MS)]),body:JSON.stringify(payload)});
    if(!response.ok||!response.body){await response.body?.cancel();if(verb==='authorize'&&[401,403,409].includes(response.status))throw new KitRefused();throw Error('Kit unavailable');}
    const reader=response.body.getReader(),chunks:Buffer[]=[];
    let size=0,bytes:Buffer|undefined;
    try{
      for(;;){const part=await reader.read();if(part.done)break;size+=part.value.length;if(size>2*1024*1024)throw Error('Kit response too large');chunks.push(Buffer.from(part.value));}
      bytes=Buffer.concat(chunks);return JSON.parse(bytes.toString());
    }finally{await reader.cancel().catch(()=>{});bytes?.fill(0);for(const chunk of chunks)chunk.fill(0);}
  };
}
