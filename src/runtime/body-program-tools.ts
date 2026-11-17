/** Portable tools composed into the receiving body's single local MCP server. */
import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import type {Tool} from '@modelcontextprotocol/sdk/types.js';
import {bodyCommandClient} from './body-command-client.js';
import type {Clock} from '../core/clock.js';
import {BodyFileRefused,type BodyFileReader} from './body-files.js';
const json=z.json();
const catalogue=z.object({name:z.string().min(1).optional()}).strict();
const command=z.object({operation:z.string().min(1),input:json,id:z.string().min(1).max(200)}).strict();
const query=z.object({query:z.string().min(1),variables:z.record(z.string(),json).nullable().optional(),operationName:z.string().min(1).nullable().optional()}).strict();
export const programToolDefinitions=[
 ['loom_commands','Discover current Root command names or structural input schema. Discovery grants no permission.',catalogue],
 ['loom_command','Call a registered Root command. Choose one stable id per intended write; do not automatically retry uncertain outcomes.',command],
 ['loom_query','Read through the existing generated GraphQL schema with this body’s current permissions.',query],
]as const;
export type BodyProgramToolResult={content:{type:'text';text:string}[];isError?:boolean};
const unavailable=():BodyProgramToolResult=>({isError:true,content:[{type:'text',text:'Body tool unavailable; outcome may be uncertain'}]});
const object=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==='object'&&!Array.isArray(value);
export function bodyProgramTools(options:{url:string;token:string;signal:AbortSignal;fetch?:typeof globalThis.fetch;clock?:Clock;
 onStop:()=>void;onStatus:(value:{state:'working'|'waiting'|'idle'|'offline';work:string})=>void;
 /** Reads the files a post names from the body's own working area (body-files.ts). Without it a post carries none. */
 readFiles?:BodyFileReader}){
 const {url,token,signal,fetch,clock,onStop,onStatus,readFiles}=options;
 const abort=new AbortController(),lifetime=AbortSignal.any([signal,abort.signal]),active=new Set<ReturnType<typeof bodyCommandClient>>();
 const tools:Tool[]=programToolDefinitions.map(([name,description,input])=>({name,description,inputSchema:z.toJSONSchema(input,{target:'draft-7'})as Tool['inputSchema']}));
 const port={tools,
  async call(name:string,args:unknown,requestSignal?:AbortSignal):Promise<BodyProgramToolResult>{
   let client:ReturnType<typeof bodyCommandClient>|undefined;
   try{
    const current=AbortSignal.any([lifetime,...(requestSignal?[requestSignal]:[])]);if(current.aborted)return unavailable();
    client=bodyCommandClient({url,token,signal:current,fetch,clock});active.add(client);
    let value:unknown;
    if(name==='loom_commands')value=await client.command('runtime.commandCatalog',catalogue.parse(args),randomUUID());
    else if(name==='loom_query')value=await client.query(query.parse(args));
    else if(name==='loom_command'){
     const input=command.parse(args),body=input.input;
     // Acceptance, observed provider facts, and Stop acknowledgement belong to
     // the receiving runtime. The model cannot fabricate these observations.
     // Nor its kept harness session: the body program hands that over and takes it back (body-session.ts). A
     // model that could store a session of its own making would choose what the next body remembers.
     if(['conversation.accept','conversation.confirm','conversation.turn','conversation.session','conversation.sessionSave'].includes(input.operation))return unavailable();
     if(input.operation==='conversation.status'&&object(body)&&(body.state==='idle'||body.state==='offline'))return unavailable();
     if(['conversation.message','bridges.reply'].includes(input.operation)&&object(body)&&('model'in body||'latencyMs'in body))return unavailable();
     const known=await client.command('runtime.commandCatalog',{name:input.operation},randomUUID());
     if(!known.ok)return{isError:true,content:[{type:'text',text:JSON.stringify(known)}]};
     const metadata=z.object({commands:z.array(z.object({name:z.string()}).passthrough()).length(1)}).passthrough().parse(known.value);
     if(metadata.commands[0].name!==input.operation)return unavailable();
     // A post's files are named by path and read here, from the body's own working area and nowhere else.
     // The model cannot hand over bytes of its own making under a file's name, nor a path outside that area.
     let sent=input.input,read:{name:string;contents:Buffer}[]=[];
     if(input.operation==='bridges.say'&&object(body)&&'files'in body){
      const named=z.array(z.object({path:z.string().min(1)}).strict()).min(1).safeParse(body.files);
      if(!named.success||!readFiles)return{isError:true,content:[{type:'text',text:'A post\'s files are given as [{"path": "..."}], each a file inside this body\'s working directory'}]};
      try{read=readFiles(named.data.map(file=>file.path));}
      catch(error){return{isError:true,content:[{type:'text',text:error instanceof BodyFileRefused?error.message:'File not available'}]};}
      sent={...body,files:read.map(file=>({name:file.name,contents:file.contents.toString('base64')}))} as typeof input.input;
     }
     try{value=await client.command(input.operation,sent,input.id);}finally{for(const file of read)file.contents.fill(0);}
     if(input.operation==='conversation.status'&&object(value)&&value.ok===true){
      const status=z.object({state:z.enum(['working','waiting','idle','offline']),work:z.string()}).passthrough().parse(body);
      if(object(value.value)&&value.value.stopRequested===true){try{onStatus(status);}finally{onStop();}return unavailable();}
      onStatus(status);
     }
    }else return unavailable();
    if(current.aborted)return unavailable();
    return{...(object(value)&&value.ok===false?{isError:true}:{}),content:[{type:'text',text:JSON.stringify(value)}]};
   }catch{return unavailable();}finally{if(client){client.close();active.delete(client);}}
  },
  close(){abort.abort();for(const client of active)client.close();active.clear();},
 };
 return {...port,extensions:programToolDefinitions.map(([name,description,inputSchema])=>({name,description,inputSchema,execute:(args:Record<string,unknown>,signal:AbortSignal)=>port.call(name,args,signal)}))};
}
