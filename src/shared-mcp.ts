import {guardedResponse} from './core/data/guarded-response.js';
/** MCP is an adapter over the canonical shared HTTP operations and query door. */
import {McpServer,WebStandardStreamableHTTPServerTransport} from '@modelcontextprotocol/server';
import {bodyProgramTools} from './runtime/body-program-tools.js';
import {sameRequestOrigin} from './core/data/origin.js';
import type {Clock} from './core/clock.js';
export async function sharedMcpRequest(options:{request:Request;clock:Clock;fetch:typeof fetch;valid():boolean;version():number;publicOrigin?:string}){
 const {request}=options;
 if(!sameRequestOrigin(request,options.publicOrigin))return Response.json({error:'Cross-origin request refused'},{status:403});
 const token=/^Bearer ([^\s]{32,4096})$/i.exec(request.headers.get('authorization')??'')?.[1];
 if(!token||!options.valid())return Response.json({error:'Authentication required'},{status:401});
 if(request.method!=='POST')return new Response(null,{status:405,headers:{allow:'POST'}});
 const guards:Array<()=>boolean>=[];
 const guardedFetch:typeof fetch=async(input,init)=>{const response=await options.fetch(input,init);if(new URL(input instanceof Request?input.url:String(input)).pathname==='/graphql'){const version=options.version();guards.push(()=>version===options.version());}return response;};
 const tools=bodyProgramTools({url:new URL(request.url).origin,token,clock:options.clock,fetch:guardedFetch,signal:request.signal,onStop(){},onStatus(){}});
 const server=new McpServer({name:'loom',version:'1'}),transport=new WebStandardStreamableHTTPServerTransport({sessionIdGenerator:undefined,enableJsonResponse:true});
 for(const tool of tools.extensions)server.registerTool(tool.name,{description:tool.description,inputSchema:tool.inputSchema},(args:Record<string,unknown>,extra:{mcpReq:{signal:AbortSignal}})=>options.valid()?tool.execute(args,extra.mcpReq.signal):Promise.resolve({isError:true,content:[{type:'text' as const,text:'Authentication ended'}]}));
 try{await server.connect(transport);const response=await transport.handleRequest(request),body=await response.text();return guardedResponse(body,{status:response.status,headers:response.headers},()=>options.valid()&&guards.every(guard=>guard()));}
 finally{tools.close();await transport.close();await server.close();}
}
