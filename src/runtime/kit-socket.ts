/** The only mount a kit adds is a job-specific UNIX socket. Its containing
 * directory is private to the worker, and only this socket enters the body. */
import {KitRefused,KitCapacity} from './kit-refused.js';
import {createServer} from 'node:http';
import {chmod,mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {z} from 'zod';
import type {kitBroker} from './kit-broker.js';

const call=z.strictObject({name:z.string().max(64),args:z.record(z.string(),z.unknown())});
export async function kitSocket(directory:string,broker:()=>ReturnType<typeof kitBroker>|undefined,lifetime:AbortSignal){
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
        for await(const chunk of request){size+=chunk.length;if(size>96*1024)throw Error();chunks.push(chunk);}
        const body:unknown=JSON.parse(Buffer.concat(chunks).toString());
        let result:unknown;
        if(request.url==='/list'){z.strictObject({}).parse(body);result=await active.list(signal);}
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
