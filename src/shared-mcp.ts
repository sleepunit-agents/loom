import {z} from 'zod';
import {bodyMemoryIdentity} from './runtime/body-memory-identity.js';
import {guardedResponse,responseAvailability} from './core/data/guarded-response.js';
/** MCP is an adapter over the canonical shared HTTP operations and query door. */
import {McpServer,WebStandardStreamableHTTPServerTransport} from '@modelcontextprotocol/server';
import {programToolDefinitions} from './runtime/body-program-tools.js';
import {bodyCommandClient} from './runtime/body-command-client.js';
import {randomUUID} from 'node:crypto';
import {sameRequestOrigin} from './core/data/origin.js';
import type {Clock} from './core/clock.js';
import {registerNamedTools} from './shared-mcp-named.js';
export async function sharedMcpRequest(options:{request:Request;clock:Clock;fetch:typeof fetch;valid():boolean;agent?:string;command(name:string,input:unknown,id?:string):Promise<unknown>;publicOrigin?:string}){
 const {request}=options;
 if(!sameRequestOrigin(request,options.publicOrigin))return Response.json({error:'Cross-origin request refused'},{status:403});
 const token=/^Bearer ([^\s]{32,4096})$/i.exec(request.headers.get('authorization')??'')?.[1];
 if(!token||!options.valid())return Response.json({error:'Authentication required'},{status:401});
 if(request.method!=='POST')return new Response(null,{status:405,headers:{allow:'POST'}});
 const guards:Array<()=>boolean>=[];
 const guardedFetch:typeof fetch=async(input,init)=>{
  const response=await options.fetch(input,init);
  if(new URL(input instanceof Request?input.url:String(input)).pathname==='/graphql'){
   const lease=responseAvailability(response);
   if(response.ok&&!lease){await response.body?.cancel();throw Error('Query release guard unavailable');}
   if(lease)guards.push(lease);
  }
  return response;
 };
 const client=bodyCommandClient({url:new URL(request.url).origin,token,clock:options.clock,fetch:guardedFetch,signal:request.signal});
 const server=new McpServer({name:'loom',version:'1'}),transport=new WebStandardStreamableHTTPServerTransport({sessionIdGenerator:undefined,enableJsonResponse:true});
 for(const [name,description,inputSchema] of programToolDefinitions)server.registerTool(name,{description,inputSchema},async(args:Record<string,unknown>)=>{
  if(!options.valid())return {isError:true,content:[{type:'text' as const,text:'Authentication ended'}]};
  try{
   let value;
   if(name==='loom_query')value=await client.query(programToolDefinitions[2][2].parse(args));
   else if(name==='loom_commands')value=await options.command('runtime.commandCatalog',programToolDefinitions[0][2].parse(args),randomUUID());
   else{const input=programToolDefinitions[1][2].parse(args);value=await options.command(input.operation,input.input,input.id);}
   return {content:[{type:'text' as const,text:JSON.stringify(value)}],...(value&&typeof value==='object'&&'ok'in value&&value.ok===false?{isError:true}:{})};
  }catch{return {isError:true,content:[{type:'text' as const,text:'Tool unavailable; outcome may be uncertain'}]};}
 });
 server.registerTool('identity',{description:'Load your own declared Identity and retained context. Hints never select another caller or grant authority.',inputSchema:z.object({agent:z.string().optional(),client:z.string().max(200).optional(),model:z.string().max(200).optional(),conversation:z.string().max(200).optional(),run:z.string().max(200).optional()}).strict()},async(args:{agent?:string})=>{
  try{if(!options.valid()||!options.agent||args.agent&&args.agent!==options.agent)throw Error('Identity unavailable');const identity=await bodyMemoryIdentity(client,options.agent);return {content:[{type:'text' as const,text:'Agent: '+options.agent+'\n\n'+(identity??'No Identity has been written.')}]};}
  catch{return {isError:true,content:[{type:'text' as const,text:'Identity unavailable'}]};}
 });
 registerNamedTools(server,{agent:options.agent,valid:options.valid,query:input=>client.query(input),command:options.command});
 try{await server.connect(transport);const response=await transport.handleRequest(request),body=await response.text();return guardedResponse(body,{status:response.status,headers:response.headers},()=>options.valid()&&guards.every(guard=>guard()));}
 finally{client.close();await transport.close();await server.close();}
}
