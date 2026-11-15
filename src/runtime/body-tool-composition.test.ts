import {afterEach,expect,it,vi} from 'vitest';
import {z} from 'zod';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {bodySecretTools} from './body-secret-tools.js';
import type {BodyModelTool} from './body-model-tools.js';
const clean:(()=>void|Promise<void>)[]=[];afterEach(async()=>{for(const close of clean.splice(0).reverse())await close();});
async function fixture(extraTools:BodyModelTool[]){
 const abort=new AbortController(),root=vi.fn<typeof fetch>(),tools=await bodySecretTools({url:'https://root.invalid',token:'PRIVATE_ROOT_BEARER',job:'job',conversation:'cv',signal:abort.signal,fetch:root,extraTools});clean.push(()=>tools.close());
 const connection=JSON.parse(tools.config.toString()).mcpServers.loom_secrets,client=new Client({name:'composed-model',version:'1'},{capabilities:{}});await client.connect(new StreamableHTTPClientTransport(new URL(connection.url),{requestInit:{headers:connection.headers}}));clean.push(()=>client.close());return{abort,root,tools,client};
}
it('shares one authenticated MCP listener and exactly advertises the snapped extension names',async()=>{
 const execute=vi.fn(async(input:Record<string,unknown>)=>({content:[{type:'text' as const,text:JSON.stringify(input)}]})),tool={name:'command',description:'Canonical command',inputSchema:z.object({command:z.string()}).strict(),execute},f=await fixture([tool]);tool.name='changed';tool.execute=vi.fn();
 expect(f.tools.allowedTools).toEqual(['mcp__loom_secrets__request_secret','mcp__loom_secrets__use_secret','mcp__loom_secrets__command']);expect((await f.client.listTools()).tools.map(tool=>tool.name)).toEqual(['request_secret','use_secret','command']);
 expect(await f.client.callTool({name:'command',arguments:{command:'list'}})).toMatchObject({content:[{type:'text',text:'{"command":"list"}'}]});expect(execute).toHaveBeenCalledOnce();
 await f.client.callTool({name:'command',arguments:{command:'list',agent:'foreign'}}).catch(()=>undefined);expect(execute).toHaveBeenCalledOnce();expect(f.root).not.toHaveBeenCalled();expect(f.tools.config.includes(Buffer.from('PRIVATE_ROOT_BEARER'))).toBe(false);
});
it('sanitizes extension exceptions through the existing private tool wrapper',async()=>{
 const f=await fixture([{name:'command',description:'Canonical command',inputSchema:z.object({}).strict(),execute:async()=>{throw new Error('PRIVATE_ROOT_BEARER');}}]);
 const result=await f.client.callTool({name:'command',arguments:{}});expect(result.isError).toBe(true);expect(JSON.stringify(result)).not.toContain('PRIVATE_ROOT_BEARER');
});
it('cancels extension work under the same body lifetime and waits for it to settle',async()=>{
 let entered!:()=>void,ended!:()=>void;const started=new Promise<void>(resolve=>{entered=resolve;}),finished=new Promise<void>(resolve=>{ended=resolve;});
 const f=await fixture([{name:'command',description:'Canonical command',inputSchema:z.object({}).strict(),execute:async(_input,signal)=>{entered();await new Promise<void>(resolve=>signal.addEventListener('abort',()=>resolve(),{once:true}));ended();return{content:[{type:'text',text:'late'}]};}}]);
 const call=f.client.callTool({name:'command',arguments:{}}).catch(()=>undefined);await started;f.abort.abort();await f.tools.close();await finished;await call;expect(f.tools.config.every(byte=>byte===0)).toBe(true);expect(f.root).not.toHaveBeenCalled();
});
