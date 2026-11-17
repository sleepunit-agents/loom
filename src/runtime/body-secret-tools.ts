/** The receiving body's private model tools. Root credentials never leave this
 * process; only a lifetime-bound local capability enters native MCP config.
 *
 * The bearer checked here is that local capability and nothing more: it is made in this process, lives
 * only in memory and in the harness's tools configuration, is accepted only on this loopback listener,
 * and dies with the body. It is deliberately not a household credential and does not go through loom's
 * sign-in: every tool forwards to loom with the body's own token, and loom's door is where a revoked
 * machine or an ended job is refused. */
import {createServer} from 'node:http';
import {randomBytes,timingSafeEqual} from 'node:crypto';
import {getRequestListener} from '@hono/node-server';
import {McpServer,WebStandardStreamableHTTPServerTransport} from '@modelcontextprotocol/server';
import {z} from 'zod';
import {clock as systemClock,type Clock} from '../core/clock.js';
import {secretName,requestReason} from '../pieces/secrets/input.js';
import {privateSecretClient} from '../pieces/secrets/private-client.js';
import {bodyModelTools,type BodyModelTool} from './body-model-tools.js';
import {harnessToolPrefix} from './body-harness.js';
import {bodyConversationClient} from './conversation-client.js';
/** The most one request to these local tools may carry, and the most secret bytes they keep to erase. */
const TOOL_REQUEST_BYTES=1024*1024,RETAINED_SECRET_BYTES=1024*1024;
const unavailable=()=>new Error('Private Secret tool unavailable; do not retry an uncertain value with a new attempt');
const failed=()=>({isError:true,content:[{type:'text' as const,text:unavailable().message}]});
export async function bodySecretTools(input:{url:string;token:string;job:string;conversation:string;signal:AbortSignal;clock?:Clock;fetch?:typeof fetch;waiting?(value:boolean):void;extraTools?:readonly BodyModelTool[]}){
 const extensions=bodyModelTools(input.extraTools),allowedTools=Object.freeze(['request_secret','use_secret',...extensions.map(tool=>tool.name)].map(name=>harnessToolPrefix+name));
 const clock=input.clock??systemClock,stop=new AbortController(),signal=AbortSignal.any([input.signal,stop.signal]);
 const entropy=randomBytes(32);let bearer:string;try{bearer='Bearer local_secret_'+entropy.toString('hex');}finally{entropy.fill(0);}
 const expected=Buffer.from(bearer),active=new Set<Promise<Response>>();
 let authority:string|undefined,closed=false,waiting=0,retained=0,closing:Promise<void>|undefined,config:Buffer|undefined;
 const exposed:Buffer[]=[];
 const allowsReply=(text:string)=>{const bytes=Buffer.from(text);try{return !exposed.some(value=>bytes.includes(value));}finally{bytes.fill(0);}};
 const metadata=(signal:AbortSignal)=>bodyConversationClient({...input,clock,signal});
 // Validate the fixed Root origin/identity before binding a local listener.
 const check=metadata(signal);check.close();if(signal.aborted)throw unavailable();
 async function pause(signal:AbortSignal){
  if(signal.aborted)throw unavailable();let cancel=()=>{},abort=()=>{};
  try{await new Promise<void>((resolve,reject)=>{abort=()=>reject(unavailable());signal.addEventListener('abort',abort,{once:true});cancel=clock.at(clock.now()+1000,resolve);if(signal.aborted)abort();});if(signal.aborted)throw unavailable();}
  finally{cancel();signal.removeEventListener('abort',abort);}
 }
 async function request(request:Request):Promise<Response>{
  const supplied=Buffer.from(request.headers.get('authorization')??'');
  let authenticated=false;try{authenticated=!closed&&!signal.aborted&&supplied.length===expected.length&&timingSafeEqual(supplied,expected)&&!request.headers.has('origin')&&new URL(request.url).host===authority&&request.headers.get('host')===authority;}finally{supplied.fill(0);}
  if(!authenticated)return new Response(null,{status:403});
  if(active.size>=16)return new Response(null,{status:429});
  if(request.method!=='POST')return new Response(null,{status:405});
  let size=0;
  const bounded=request.body?new Request(request,{body:request.body.pipeThrough(new TransformStream<Uint8Array,Uint8Array>({transform(bytes,target){size+=bytes.byteLength;if(size>TOOL_REQUEST_BYTES)throw unavailable();target.enqueue(bytes);}})),duplex:'half'} as RequestInit):request;
  const server=new McpServer({name:'loom-secrets',version:'1'});
  const transport=new WebStandardStreamableHTTPServerTransport({sessionIdGenerator:undefined,enableJsonResponse:true});
  const run=async(work:(signal:AbortSignal)=>Promise<{content:{type:'text';text:string}[]}>,callSignal:AbortSignal)=>{
   if(closed||signal.aborted)return failed();
   try{const current=AbortSignal.any([signal,request.signal,callSignal]);if(current.aborted)throw unavailable();const result=await work(current);if(current.aborted||closed)throw unavailable();return result;}
   catch{return failed();}
  };
  server.registerTool('request_secret',{description:'Request a credential for this agent/job with a reason and duration. Reuse the UUID when retrying this same request. A pending result waits in the owner Inbox; pass its id to use_secret to wait for the decision.',inputSchema:z.object({id:z.uuid(),secret:secretName,why:requestReason,minutes:z.number().int().min(1).max(525600),scope:z.enum(['agent','job']).default('job')}).strict()},(args,extra)=>run(async signal=>{
   const client=metadata(signal);try{return{content:[{type:'text',text:JSON.stringify(await client.requestSecret(args))}]};}finally{client.close();}
  },extra.mcpReq.signal));
  server.registerTool('use_secret',{description:'Acquire a granted private credential for this body. Optional request waits for that request to be answered. The value is base64, not text. Never repeat the value in a conversation reply. Reuse the attempt UUID after uncertainty; do not silently create another attempt.',inputSchema:z.object({id:z.uuid(),secret:secretName,request:z.uuid().optional()}).strict(),_meta:{'anthropic/maxResultSizeChars':131072}},(args,extra)=>run(async signal=>{
   const client=metadata(signal),privateInput=privateSecretClient({...input,clock,signal});let value:Buffer|undefined,waitingHere=false;
   try{
    if(args.request){
     let state=await client.secretRequestStatus(args.request);
     if(state.state==='pending'){waitingHere=true;waiting++;input.waiting?.(true);}
     while(state.state==='pending'){await pause(signal);state=await client.secretRequestStatus(args.request);}
     if(state.state!=='allowed')throw unavailable();
    }
    value=await privateInput.granted(args.secret,args.id);
    if(signal.aborted||closed)throw unavailable();
    const encoded=value.toString('base64'),representations=[Buffer.from(value),Buffer.from(encoded)];
    if(retained+representations.reduce((n,value)=>n+value.length,0)>RETAINED_SECRET_BYTES){for(const value of representations)value.fill(0);throw unavailable();}
    exposed.push(...representations);retained+=representations.reduce((n,value)=>n+value.length,0);
    return{content:[{type:'text',text:JSON.stringify({encoding:'base64',value:encoded})}]};
   }finally{value?.fill(0);privateInput.close();client.close();if(waitingHere){waiting--;input.waiting?.(waiting>0);}}
  },extra.mcpReq.signal));
  for(const tool of extensions)server.registerTool(tool.name,{description:tool.description,inputSchema:tool.inputSchema},(args,extra)=>run(signal=>tool.execute(args,signal),extra.mcpReq.signal));
  try{await server.connect(transport);if(closed||signal.aborted)throw unavailable();const response=await transport.handleRequest(bounded);if(closed||signal.aborted){await response.body?.cancel();return new Response(null,{status:403});}return response;}
  catch{return new Response(null,{status:503});}
  finally{await transport.close();await server.close();}
 }
 const listener=createServer(getRequestListener((incoming,env)=>{
  const disconnected=new AbortController(),onClose=()=>disconnected.abort();env.outgoing.once('close',onClose);
  const pending=request(new Request(incoming,{signal:AbortSignal.any([incoming.signal,disconnected.signal])}));active.add(pending);
  void pending.finally(()=>{active.delete(pending);env.outgoing.off('close',onClose);}).catch(()=>{});return pending;
 }));
 const onAbort=()=>{void close().catch(()=>{});};
 function close(){
  if(closing)return closing;closed=true;stop.abort();expected.fill(0);config?.fill(0);for(const value of exposed)value.fill(0);exposed.length=0;input.signal.removeEventListener('abort',onAbort);
  const stopped=new Promise<void>(resolve=>listener.close(()=>resolve()));listener.closeAllConnections();
  return closing=Promise.allSettled([...active]).then(async()=>{await stopped;});
 }
 try{
  await new Promise<void>((resolve,reject)=>{listener.once('error',reject);listener.listen(0,'127.0.0.1',()=>{listener.off('error',reject);resolve();});});
  listener.on('error',onAbort);input.signal.addEventListener('abort',onAbort,{once:true});
  if(signal.aborted)throw unavailable();const address=listener.address();if(!address||typeof address==='string')throw unavailable();
  authority=`127.0.0.1:${address.port}`;
  config=Buffer.from(JSON.stringify({mcpServers:{loom_secrets:{type:'http',url:`http://127.0.0.1:${address.port}`,headers:{Authorization:bearer},timeout:86_400_000}}}));
  return{config,close,allowsReply,allowedTools};
 }catch{await close();throw unavailable();}
}
