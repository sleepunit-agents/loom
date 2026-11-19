import {KitRefused,KitCapacity} from './kit-refused.js';
import {request} from 'node:http';
import {z} from 'zod';
import {kitInputSchema,kitParameter} from './kit-manifest.js';
import type {BodyModelTool} from './body-model-tools.js';

export const KIT_SOCKET='/run/loom/kit.sock';
const descriptors=z.array(z.strictObject({name:z.string().regex(/^kit_[a-z][a-zA-Z0-9_-]{0,59}$/),description:z.string().max(512),parameters:z.record(z.string(),kitParameter)})).max(512);
function post(socketPath:string,path:'/list'|'/call',input:object,signal:AbortSignal):Promise<unknown>{
  return new Promise((resolve,reject)=>{
    const req=request({socketPath,path,method:'POST',signal:AbortSignal.any([signal,AbortSignal.timeout(60_000)]),agent:false},res=>{
      res.on('error',reject);
      res.once('aborted',()=>reject(Error('Kit response interrupted')));
      res.once('close',()=>{if(!res.complete)reject(Error('Kit response interrupted'));});
      if(res.statusCode!==200){res.resume();reject(res.statusCode===409?new KitRefused():res.statusCode===422?new KitCapacity():Error('Kit unavailable'));return;}
      const chunks:Buffer[]=[];let size=0;
      res.on('data',(chunk:Buffer)=>{size+=chunk.length;if(size>2*1024*1024)res.destroy(Error('Kit response too large'));else chunks.push(chunk);});
      res.on('end',()=>{try{resolve(JSON.parse(Buffer.concat(chunks).toString()));}catch{reject(Error('Kit unavailable'));}});
    });
    req.on('error',reject);req.end(JSON.stringify(input));
  });
}
export async function bodyKitTools(path:string,signal:AbortSignal):Promise<BodyModelTool[]>{
  const list=descriptors.parse(await post(path,'/list',{},signal));
  return list.map(({name,description,parameters})=>({name,description,inputSchema:kitInputSchema(parameters),
    async execute(args,current){
      try{const words=z.string().parse(await post(path,'/call',{name,args},current));return {content:[{type:'text',text:words}]};}
      catch(error){return {isError:true,content:[{type:'text',text:error instanceof KitRefused?error.message:'Kit tool unavailable; outcome may be uncertain'}]};}
    }}));
}
