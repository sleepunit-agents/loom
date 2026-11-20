/** The only mount a kit adds is a job-specific UNIX socket. Its containing
 * directory is private to the worker, and only this socket enters the body. */
import {KitRefused,KitCapacity} from './kit-refused.js';
import {createServer} from 'node:http';
import {chmod,mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {z} from 'zod';
import type {KitUnavailable,kitTransport} from './kit-availability.js';
import type {kitBroker} from './kit-broker.js';

// Sixteen 4096-code-unit strings may each need six JSON bytes per code unit.
const REQUEST_BYTES=512*1024;
const call=z.strictObject({name:z.string().max(64),args:z.record(z.string(),z.unknown())});
export async function kitSocket(directory:string,broker:()=>Pick<ReturnType<typeof kitBroker>,'list'|'call'>|undefined,lifetime:AbortSignal,
  availability?:(transport:z.infer<typeof kitTransport>,signal:AbortSignal)=>Promise<KitUnavailable[]>){
  const dir=await mkdtemp(join(directory,'kit-'));
  const path=join(dir,'s');
  const stop=new AbortController(),pending=new Set<Promise<void>>();
  const server=createServer({maxHeaderSize:2048,requestTimeout:5000},(request,response)=>{
    const dropped=new AbortController();
    const signal=AbortSignal.any([lifetime,stop.signal,dropped.signal,AbortSignal.timeout(60_000)]);
    response.once('close',()=>dropped.abort());
    const serve=async()=>{
      try{
        const active=broker();
        if(!active||signal.aborted||pending.size||request.method!=='POST'||request.headers.origin)throw Error();
        const chunks:Buffer[]=[];let size=0;
        for await(const chunk of request){size+=chunk.length;if(size>REQUEST_BYTES)throw Error();chunks.push(chunk);}
        const body:unknown=JSON.parse(Buffer.concat(chunks).toString());
        let result:unknown;
        if(request.url==='/list'){
          z.strictObject({}).parse(body);
          if(!availability)result=await active.list(signal);
          else {
            let transport:z.infer<typeof kitTransport>='ready';
            const tools=await active.list(signal).catch((error:unknown)=>{
              transport=error instanceof KitCapacity?'capacity':'catalog';
              return [];
            });
            result={tools,unavailable:await availability(transport,signal)};
          }
        }
        else if(request.url==='/call'){const {name,args}=call.parse(body);result=await active.call(name,args,signal);}
        else throw Error();
        response.writeHead(200,{'content-type':'application/json','cache-control':'no-store'}).end(JSON.stringify(result));
      }catch(error){response.writeHead(error instanceof KitRefused?409:error instanceof KitCapacity?422:403,{'cache-control':'no-store'}).end();}
    };
    const work=serve();pending.add(work);void work.finally(()=>pending.delete(work));
  });
  server.maxConnections=4;
  try{
    if(Buffer.byteLength(path)>103)throw Error('Worker socket path too long');
    await new Promise<void>((resolve,reject)=>server.once('error',reject).listen(path,resolve));
    // The host directory is 0700; inside its assigned mount any image user may call.
    await chmod(path,0o666);
  }catch(error){server.close();await rm(dir,{recursive:true,force:true});throw error;}
  return {path,async close(){
    stop.abort();server.closeAllConnections();
    await new Promise<void>(resolve=>server.close(()=>resolve()));
    await Promise.allSettled(pending);await rm(dir,{recursive:true,force:true});
  }};
}
