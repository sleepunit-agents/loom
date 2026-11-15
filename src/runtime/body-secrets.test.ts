import {afterEach,expect,it,vi} from 'vitest';
import {FakeClock} from '../core/clock.js';
import {bodyStartupSecrets} from './body-secrets.js';
import type {WorkerAssignment} from './worker.js';
const job:WorkerAssignment={id:'job',agent:'art',box:'box',conversation:'cv',model:'model',account:'account',harness:'claude',brief:'',house:{repository:'r',file:'f',branch:'next'}};
const clean:(()=>void)[]=[];afterEach(()=>{for(const close of clean.splice(0).reverse())close();vi.restoreAllMocks();});
function fixture(values=new Map([['GITHUB_TOKEN',Buffer.from('PRIVATE_STARTUP')]]),base:NodeJS.ProcessEnv={PATH:'/usr/bin',ACCOUNT_PROFILE:'/account'}){
 const clock=new FakeClock(),abort=new AbortController(),environment={...base},calls:string[]=[];let pending=false;
 const fetch=vi.fn<typeof globalThis.fetch>(async(url,options)=>{const path=String(url).split('/').at(-1)!;calls.push(path);const input=JSON.parse(String(options?.body));if(path==='startup')return Response.json({aliases:[...values.keys()].map(alias=>({alias})),...(pending?{pending:true}:{})});if(path==='confirm')return Response.json({confirmed:true});const bytes=values.get(input.alias)!;return new Response(new Blob([Uint8Array.from(bytes)]),{headers:{'content-type':'application/octet-stream','x-loom-secret-use':'use-input-'+'a'.repeat(64)}});});
 const hook=bodyStartupSecrets(environment,{clock,fetch});clean.push(hook.close);const bootstrap={origin:'https://loom.example',job:'job',token:Buffer.from('body_'+'a'.repeat(64))};
 return{environment,base,hook,fetch,clock,abort,bootstrap,calls,pending:(value:boolean)=>{pending=value;},start:()=>hook.startup(job,bootstrap,abort.signal)};
}
it('injects confirmed aliases into only the private environment, erases byte buffers, and removes fields on close',async()=>{
 const f=fixture(),copies:Buffer[]=[],concat=Buffer.concat;vi.spyOn(Buffer,'concat').mockImplementation((list,total)=>{const bytes=concat(list,total);if(bytes.toString()==='PRIVATE_STARTUP')copies.push(bytes);return bytes;});
 await f.start();expect(f.environment).toEqual({...f.base,GITHUB_TOKEN:'PRIVATE_STARTUP'});expect(f.base).toEqual({PATH:'/usr/bin',ACCOUNT_PROFILE:'/account'});expect(f.calls).toEqual(['startup','read','confirm']);expect(copies.length).toBeGreaterThan(0);expect(copies.every(bytes=>bytes.every(byte=>byte===0))).toBe(true);f.hook.close();expect(f.environment).toEqual(f.base);await expect(f.start()).rejects.toThrow(/^Startup secret environment unavailable$/);
});
it('preserves Unicode and a leading BOM instead of changing credential text',async()=>{
 const value='\uFEFF clé\nvalue',f=fixture(new Map([['API_TOKEN',Buffer.from(value)]]));await f.start();expect(f.environment.API_TOKEN).toBe(value);f.abort.abort();expect(f.environment.API_TOKEN).toBeUndefined();
});
it.each(['bad-name','VALUE=OTHER','PATH','HOME','ACCOUNT_PROFILE','NODE_OPTIONS','ANTHROPIC_API_KEY','CLAUDE_CONFIG_DIR','OPENAI_API_KEY','CODEX_HOME','HTTPS_PROXY','MCP_TOOL_TIMEOUT','MAX_MCP_OUTPUT_TOKENS'])('refuses %s without partially modifying the environment',async alias=>{
 const f=fixture(new Map([['GOOD_TOKEN',Buffer.from('FIRST_PRIVATE')],[alias,Buffer.from('SECOND_PRIVATE')]]));await expect(f.start()).rejects.toThrow(/^Startup secret environment unavailable$/);expect(f.environment).toEqual(f.base);expect(JSON.stringify(f.environment)).not.toContain('PRIVATE');
});
it.each([Buffer.from([255]),Buffer.from('before\0after')])('refuses an unrepresentable environment value %j',async value=>{
 const f=fixture(new Map([['GOOD_TOKEN',Buffer.from('FIRST_PRIVATE')],['BINARY_TOKEN',value]]));await expect(f.start()).rejects.toThrow(/^Startup secret environment unavailable$/);expect(f.environment).toEqual(f.base);
});
it('treats __proto__ as an ordinary owned environment key',async()=>{
 const f=fixture(new Map([['__proto__',Buffer.from('PRIVATE_STARTUP')]])),prototype=Object.getPrototypeOf(f.environment);await f.start();expect(Object.getPrototypeOf(f.environment)).toBe(prototype);expect(Object.getOwnPropertyDescriptor(f.environment,'__proto__')?.value).toBe('PRIVATE_STARTUP');f.hook.close();expect(Object.hasOwn(f.environment,'__proto__')).toBe(false);
});
it.each(['abort','close'])('cancels pending consent on %s with no late environment injection',async how=>{
 const f=fixture();f.pending(true);const waiting=f.start(),refused=expect(waiting).rejects.toThrow(/^Startup secret environment unavailable$/);for(let i=0;i<32;i++)await Promise.resolve();expect(f.calls).toEqual(['startup']);if(how==='abort')f.abort.abort();else f.hook.close();await refused;f.pending(false);f.clock.advance(10000);for(let i=0;i<8;i++)await Promise.resolve();expect(f.calls).toEqual(['startup']);expect(f.environment).toEqual(f.base);
});
it('waits for permission before injection and keeps the original account profile intact',async()=>{
 const f=fixture();f.pending(true);const waiting=f.start();for(let i=0;i<32;i++)await Promise.resolve();expect(f.environment).toEqual(f.base);f.pending(false);f.clock.advance(1000);await waiting;expect(f.environment.GITHUB_TOKEN).toBe('PRIVATE_STARTUP');expect(f.environment.ACCOUNT_PROFILE).toBe('/account');
});
it('does not pass a mismatched bootstrap or repeat a startup read',async()=>{
 const f=fixture();f.bootstrap.job='other';await expect(f.start()).rejects.toThrow(/^Startup secret environment unavailable$/);expect(f.fetch).not.toHaveBeenCalled();f.bootstrap.job='job';await expect(f.start()).rejects.toThrow(/^Startup secret environment unavailable$/);expect(f.fetch).not.toHaveBeenCalled();
});
it.each([['CLAUDE_CODE_USE_BEDROCK','AWS_ACCESS_KEY_ID'],['CLAUDE_CODE_USE_VERTEX','GOOGLE_APPLICATION_CREDENTIALS'],['CLAUDE_CODE_USE_FOUNDRY','AZURE_CLIENT_SECRET']])('preserves selected provider profile %s',async(selector,alias)=>{
 const f=fixture(new Map([[alias,Buffer.from('PRIVATE_STARTUP')]]),{PATH:'/bin',[selector]:'1'});await expect(f.start()).rejects.toThrow(/^Startup secret environment unavailable$/);expect(f.environment).toEqual(f.base);
});
it.each(['failure','abort','close'])('erases already acquired buffers when a later alias ends in %s',async mode=>{
 const f=fixture(new Map([['FIRST_TOKEN',Buffer.from('PRIVATE_FIRST')],['SECOND_TOKEN',Buffer.from('PRIVATE_SECOND')]])),fetcher=f.fetch.getMockImplementation()!,copies:Buffer[]=[],concat=Buffer.concat;
 vi.spyOn(Buffer,'concat').mockImplementation((list,total)=>{const bytes=concat(list,total);if(bytes.toString().startsWith('PRIVATE_'))copies.push(bytes);return bytes;});
 let entered!:()=>void,release!:(response:Response)=>void;const started=new Promise<void>(resolve=>{entered=resolve;});
 f.fetch.mockImplementation(async(url,options)=>{if(String(url).endsWith('/read')&&JSON.parse(String(options?.body)).alias==='SECOND_TOKEN'){entered();return new Promise<Response>(resolve=>{release=resolve;});}return fetcher(url,options);});
 const running=f.start(),refused=expect(running).rejects.toThrow(/^Startup secret environment unavailable$/);await started;
 expect(copies.some(bytes=>bytes.toString()==='PRIVATE_FIRST')).toBe(true);
 if(mode==='failure')release(new Response(null,{status:503}));else if(mode==='abort')f.abort.abort();else f.hook.close();
 if(mode!=='failure')expect(copies.every(bytes=>bytes.every(byte=>byte===0))).toBe(true);
 await refused;expect(copies.every(bytes=>bytes.every(byte=>byte===0))).toBe(true);expect(f.environment).toEqual(f.base);
 if(mode!=='failure')release(new Response(new Blob(['PRIVATE_SECOND'])));
});
it('erases the completed SDK batch when environment validation rejects it',async()=>{
 const f=fixture(new Map([['FIRST_TOKEN',Buffer.from('PRIVATE_FIRST')],['bad-name',Buffer.from('PRIVATE_SECOND')]])),copies:Buffer[]=[],concat=Buffer.concat;
 vi.spyOn(Buffer,'concat').mockImplementation((list,total)=>{const bytes=concat(list,total);if(bytes.toString().startsWith('PRIVATE_'))copies.push(bytes);return bytes;});
 await expect(f.start()).rejects.toThrow();expect(copies.length).toBeGreaterThan(0);expect(copies.every(bytes=>bytes.every(byte=>byte===0))).toBe(true);expect(f.environment).toEqual(f.base);
});
