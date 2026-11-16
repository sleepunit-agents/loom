/** A stdio session proxies the running shared door; it never opens household stores. */
import {readFileSync} from 'node:fs';
import {parseArgs} from 'node:util';
import {Server} from '@modelcontextprotocol/sdk/server/index.js';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {ListToolsRequestSchema,CallToolRequestSchema} from '@modelcontextprotocol/sdk/types.js';
import {bodyOrigin} from './runtime/body-bootstrap.js';
export function sharedStdioConfig(args:string[],env:NodeJS.ProcessEnv=process.env){
 const {values}=parseArgs({args:args[0]==='mcp'?args.slice(1):args,options:{next:{type:'boolean'},url:{type:'string'},'token-file':{type:'string'},home:{type:'string'},agent:{type:'string'}},strict:true,allowPositionals:false});
 if(!values.next)throw Error('Shared stdio requires --next');
 if(values.home)throw Error('--home cannot select a shared MCP server; use --url and --token-file for the running program');
 const url=values.url??env.LOOM_URL,file=values['token-file']??env.LOOM_TOKEN_FILE;
 if(!url||!file)throw Error('Shared stdio needs --url and --token-file (or LOOM_URL and LOOM_TOKEN_FILE) for the running program');
 const origin=bodyOrigin(url),token=readFileSync(file,'utf8').trim();
 if(!/^[^\s]{32,4096}$/.test(token))throw Error('Invalid MCP credential file');
 return {url:new URL('/mcp',origin),token,agent:values.agent};
}
export function createSharedStdioServer(args:string[]){
 const config=sharedStdioConfig(args),server=new Server({name:'loom',version:'1'},{capabilities:{tools:{}}});
 const client=new Client({name:'loom-stdio',version:'1'}),transport=new StreamableHTTPClientTransport(config.url,{requestInit:{headers:{authorization:'Bearer '+config.token,...(config.agent?{'x-loom-agent':config.agent}:{})}},reconnectionOptions:{maxRetries:0,maxReconnectionDelay:1000,initialReconnectionDelay:1000,reconnectionDelayGrowFactor:1}});
 let connecting:Promise<void>|undefined;
 const connect=()=>connecting??=client.connect(transport);
 server.setRequestHandler(ListToolsRequestSchema,async()=>{await connect();return client.listTools();});
 server.setRequestHandler(CallToolRequestSchema,async(request,extra)=>{await connect();return client.callTool(request.params,undefined,{signal:extra.signal});});
 server.onclose=()=>{void client.close();};
 const close=server.close.bind(server);server.close=async()=>{try{await client.close();}finally{await close();}};
 return {server};
}
