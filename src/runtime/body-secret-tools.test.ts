import {afterEach,expect,it,vi} from 'vitest';
import {randomUUID} from 'node:crypto';
import {eq} from 'drizzle-orm';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {bodyFixture,bodyCredentials as raw} from '../../test/fixtures/conversation-body.js';
import * as s from '../core/data/schema.js';
import {bodySecretTools} from './body-secret-tools.js';
const clean:(()=>void|Promise<void>)[]=[];afterEach(async()=>{for(const close of clean.splice(0).reverse())await close();vi.restoreAllMocks();});
const privateValue='PRIVATE_TOOL_CREDENTIAL';
async function fixture(answer:'auto'|'ask'|'never'='auto'){
 const buffers:Buffer[]=[],source=vi.fn(async()=>{const value=Buffer.from(privateValue);buffers.push(value);return value;});
 const f=await bodyFixture(clean,{secretInputs:{source:{read:source}}});
 f.root.writes.run(()=>{
  f.db.update(s.members).set({role:'owner'}).where(eq(s.members.id,'alice')).run();
  f.db.insert(s.secrets).values({name:'TOKEN',description:'Synthetic',changedAt:new Date(f.clock.now()).toISOString(),changedBy:'alice'}).run();f.db.insert(s.secretChanges).values({id:'baseline',secret:'TOKEN',action:'add',by:'alice',at:new Date(f.clock.now()).toISOString()}).run();
  f.root.services.secrets.requests.setRule({secret:'TOKEN',answer,minutes:5,agents:[{agent:'art',when:'on_request'}]});
 });
 const abort=new AbortController(),waiting=vi.fn(),fetcher=vi.fn<typeof fetch>(async(url,init)=>f.root.http.request(new Request(url,init)));
 const tools=await bodySecretTools({url:'https://loom.invalid',token:raw.body,job:'job',conversation:f.thread.conversation,signal:abort.signal,clock:f.clock,fetch:fetcher,waiting});clean.push(()=>tools.close());
 const config=JSON.parse(tools.config.toString()).mcpServers.loom_secrets as {url:string;headers:Record<string,string>};
 const client=new Client({name:'fictitious-native',version:'1'},{capabilities:{}});await client.connect(new StreamableHTTPClientTransport(new URL(config.url),{requestInit:{headers:config.headers}}));clean.push(()=>client.close());
 const request=(id=randomUUID())=>client.callTool({name:'request_secret',arguments:{id,secret:'TOKEN',why:'Synthetic credential use',minutes:5}});
 const use=(request?:string,id=randomUUID())=>client.callTool({name:'use_secret',arguments:{id,secret:'TOKEN',...(request?{request}:{})}});
 return{...f,buffers,source,abort,waiting,fetcher,tools,config,client,request,use};
}
function text(result:Awaited<ReturnType<Client['callTool']>>){const block=result.content?.[0];if(block?.type!=='text')throw Error('Expected text');return block.text as string;}
it('exposes only two private tools and acquires a grant-backed value through the real Root SDK, confirming before return',async()=>{
 const f=await fixture();expect((await f.client.listTools()).tools.map(tool=>tool.name)).toEqual(['request_secret','use_secret']);expect(f.tools.config.includes(Buffer.from(raw.body))).toBe(false);expect(f.source).not.toHaveBeenCalled();
 const id=randomUUID(),request=await f.request(id);expect(JSON.parse(text(request))).toEqual({id,state:'allowed'});
 const value=await f.use(id);expect(JSON.parse(text(value))).toEqual({encoding:'base64',value:Buffer.from(privateValue).toString('base64')});expect(f.source).toHaveBeenCalledOnce();expect(f.buffers.every(bytes=>bytes.every(byte=>byte===0))).toBe(true);expect(f.db.select().from(s.secretUses).get()).toMatchObject({agent:'art',job:'job',state:'released'});
 expect(f.db.$client.serialize().includes(Buffer.from(privateValue))).toBe(false);expect(f.db.$client.serialize().includes(Buffer.from(raw.body))).toBe(false);
});
it('waits on owner consent using metadata, then returns only after the existing private confirmation',async()=>{
 const f=await fixture('ask'),id=randomUUID();expect(JSON.parse(text(await f.request(id))).state).toBe('pending');let armed!:()=>void;const scheduled=new Promise<void>(resolve=>{armed=resolve;}),at=f.clock.at.bind(f.clock);
 vi.spyOn(f.clock,'at').mockImplementation((time,work)=>{if(time===f.clock.now()+1000)armed();return at(time,work);});
 const pending=f.use(id);await scheduled;expect(f.source).not.toHaveBeenCalled();expect(f.waiting).toHaveBeenLastCalledWith(true);
 f.root.writes.run(()=>f.root.services.secrets.requests.answer(id,'alice',true));f.clock.advance(1000);expect(JSON.parse(text(await pending)).encoding).toBe('base64');expect(f.waiting).toHaveBeenLastCalledWith(false);expect(f.db.select().from(s.secretUses).get()?.state).toBe('released');
});
it('does not acquire a value after a Never decision and sanitizes tool errors',async()=>{
 const f=await fixture('never'),id=randomUUID();expect(JSON.parse(text(await f.request(id))).state).toBe('denied');const result=await f.use(id);expect(result.isError).toBe(true);expect(text(result)).not.toContain(privateValue);expect(text(result)).not.toContain(raw.body);expect(f.source).not.toHaveBeenCalled();expect(f.db.select().from(s.secretUses).all()).toEqual([]);
});
it('refuses unauthenticated local calls and does not accept the Root bearer as its local capability',async()=>{
 const f=await fixture();for(const token of ['',raw.body]){const response=await fetch(f.config.url,{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json',accept:'application/json, text/event-stream'},body:JSON.stringify({jsonrpc:'2.0',id:7,method:'tools/list'})});expect(response.status).toBe(403);}expect(f.fetcher).not.toHaveBeenCalled();expect(f.source).not.toHaveBeenCalled();
});
it('does not redispatch a value when the same handoff attempt is repeated',async()=>{
 const f=await fixture(),request=randomUUID(),attempt=randomUUID();await f.request(request);expect((await f.use(request,attempt)).isError).not.toBe(true);expect((await f.use(request,attempt)).isError).toBe(true);expect(f.source).toHaveBeenCalledOnce();expect(f.db.select().from(s.secretUses).all()).toHaveLength(1);
});
it('cancels a pending decision at body shutdown without a value read or a live local capability',async()=>{
 const f=await fixture('ask'),id=randomUUID();await f.request(id);let armed!:()=>void;const scheduled=new Promise<void>(resolve=>{armed=resolve;}),at=f.clock.at.bind(f.clock);vi.spyOn(f.clock,'at').mockImplementation((time,work)=>{if(time===f.clock.now()+1000)armed();return at(time,work);});
 const pending=f.use(id),ended=pending.catch(()=>undefined);await scheduled;f.abort.abort();await f.tools.close();await ended;expect(f.source).not.toHaveBeenCalled();expect(f.tools.config.every(byte=>byte===0)).toBe(true);expect(f.waiting).toHaveBeenLastCalledWith(false);
});
