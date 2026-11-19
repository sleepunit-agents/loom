/** The worker binds one job's socket to its actual immutable house image. The
 * body can name an advertised tool and supply its typed fields. Credentials,
 * executable and environment are entirely the worker's side of the socket. */
import {SHA256_HEX} from '../core/sha256-hex.js';
import {KitCapacity} from './kit-refused.js';
import {isDeepStrictEqual} from 'node:util';
import {z} from 'zod';
import {SECRET_VALUE_BYTES} from '../pieces/secrets/input.js';
import {kitTool,kitArguments,kitModelName,qualifiedKitName,kitToolDenied,type KitTool} from './kit-manifest.js';
import {BODY_EXTENSION_TOOLS_MAX} from './body-model-tools.js';
import {bodyNamedToolNames} from './body-named-tools.js';
import {programToolDefinitions} from './body-program-tools.js';
import {HOUSE_REPOSITORY} from './house-layout.js';

const unavailable=()=>new Error('Kit tool unavailable');
const item=z.strictObject({reasons:z.array(z.string()).optional(),kit:z.string().min(1).max(200),definition:z.string().regex(SHA256_HEX),tool:kitTool});
const cursor=z.strictObject({kit:z.string().min(1).max(200),tool:z.string().min(1).max(32)});
const catalog=z.strictObject({tools:z.array(item).max(1),next:cursor.optional()});
const authorization=z.strictObject({use:z.string().min(1).max(200),tool:kitTool,secrets:z.record(z.string(),z.base64().max(Math.ceil(SECRET_VALUE_BYTES/3)*4))});
export type KitPost=(verb:'list'|'authorize'|'refuse'|'finish',input:object,signal:AbortSignal)=>Promise<unknown>;
export type KitRun=(input:{image:string;entrypoint:string;argv:string[];secrets:Record<string,Buffer>;signal:AbortSignal;onStarted:()=>void})=>Promise<Buffer>;
export type KitDescriptor=Pick<KitTool,'name'|'description'|'parameters'>;
export function kitBroker(input:{repository:string;commit:string;image:string;denials:string[];post:KitPost;run:KitRun}){
  const entries=new Map<string,z.infer<typeof item>>();
  let listed:Promise<KitDescriptor[]>|undefined;
  const list=async(signal:AbortSignal)=>{
    const capacity=BODY_EXTENSION_TOOLS_MAX-bodyNamedToolNames().length-programToolDefinitions.length;
    const eligible:z.infer<typeof item>[]=[];
    const seen=new Set<string>();
    let after:z.infer<typeof cursor>|undefined;
    do{
      const page=catalog.parse(await input.post('list',{repository:input.repository,commit:input.commit,image:input.image,...(after?{after}:{})},signal));
      for(const entry of page.tools){
        const {tool,kit}=entry;
        if(tool.repository===input.repository&&tool.commit===input.commit&&tool.image===input.image&&!kitToolDenied(tool.name,input.denials,kit))eligible.push(entry);
      }
      if(eligible.length>capacity)throw new KitCapacity();
      after=page.next;
      if(after){
        const key=JSON.stringify(after);
        if(!page.tools.length||seen.has(key))throw unavailable();
        seen.add(key);
      }
    }while(after);
    const names=new Map<string,number>();
    for(const {tool} of eligible)names.set(tool.name,(names.get(tool.name)??0)+1);
    const selected=new Map<string,z.infer<typeof item>>();
    for(const entry of eligible){
      const name=names.get(entry.tool.name)===1?kitModelName(entry.tool.name):qualifiedKitName(entry.tool.name,entry.kit);
      if(selected.has(name))throw unavailable();
      selected.set(name,entry);
    }
    for(const [name,entry] of selected)entries.set(name,entry);
    return [...entries].map(([name,{tool}])=>({name,description:tool.description,parameters:tool.parameters}));
  };
  return {
    list:(signal:AbortSignal)=>listed??=list(signal).catch(error=>{listed=undefined;throw error;}),
    async call(name:string,args:unknown,signal:AbortSignal){
      const entry=entries.get(name);
      if(!entry||signal.aborted)throw unavailable();
      const target={kit:entry.kit,tool:entry.tool.name,definition:entry.definition};
      let argv:string[];
      try{argv=kitArguments(entry.tool,args);}catch{
        await input.post('refuse',target,signal);throw unavailable();
      }
      const receipt=authorization.parse(await input.post('authorize',target,signal));
      let outcome:'refused'|'failed'|'ran'='refused';
      const secrets:Record<string,Buffer>={};
      let stdout:Buffer|undefined;
      try{
        if(!isDeepStrictEqual(receipt.tool,entry.tool)||!isDeepStrictEqual(Object.keys(receipt.secrets).sort(),Object.keys(entry.tool.secrets).sort()))throw unavailable();
        for(const [alias,encoded] of Object.entries(receipt.secrets)){
          const bytes=Buffer.from(encoded,'base64');secrets[alias]=bytes;
          if(!bytes.length||bytes.length>SECRET_VALUE_BYTES||bytes.includes(0)||bytes.toString('base64')!==encoded)throw unavailable();
        }
        if(signal.aborted)throw unavailable();
        stdout=await input.run({image:input.image,entrypoint:HOUSE_REPOSITORY+'/'+entry.tool.program,argv,secrets,signal,onStarted:()=>{outcome='failed';}});
        const result=new TextDecoder('utf8',{fatal:true}).decode(stdout);
        outcome='ran';return result;
      }finally{
        stdout?.fill(0);for(const value of Object.values(secrets))value.fill(0);
        await input.post('finish',{use:receipt.use,outcome},AbortSignal.timeout(5000));
      }
    },
  };
}
