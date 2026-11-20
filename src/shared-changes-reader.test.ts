import Database from 'better-sqlite3';
import {afterEach,expect,it,vi} from 'vitest';
import {readFileSync} from 'node:fs';
import {FakeClock} from './core/clock.js';
import {createDataSchema} from './core/data/database.js';
import {projects,projectRepositories} from './core/data/schema.js';
import {sharedRoot} from './shared-root.js';
import {sharedChangesReader} from './shared-changes-reader.js';
const clean:(()=>unknown|Promise<unknown>)[]=[];
afterEach(async()=>{for(const close of clean.splice(0).reverse())await close();});
const raw=JSON.parse(readFileSync(new URL('./pieces/changes/github.fixture.json',import.meta.url),'utf8')).data.repository.open.nodes[0];
function request(token:string){return vi.fn<typeof fetch>(async(url,init)=>{
 expect(url).toBe('https://api.github.com/graphql');expect(init?.redirect).toBe('error');expect(init?.headers).toMatchObject({authorization:`Bearer ${token}`});
 const states=JSON.parse(String(init?.body)).variables.states;
 return new Response(JSON.stringify({data:{repository:{pullRequests:{nodes:states.includes('OPEN')?[raw]:[],pageInfo:{hasNextPage:false,endCursor:null}}}}}));
});}
it('uses the actual shared root scheduled/manual reader with erased holder bytes and no legacy service-grant tables',async()=>{
 const client=new Database(':memory:');clean.push(()=>client.close());const clock=new FakeClock(Date.parse('2026-11-05T12:00:00Z')),db=createDataSchema(client,()=>new Date(clock.now()).toISOString());
 db.insert(projects).values({id:'app',name:'App'}).run();db.insert(projectRepositories).values({project:'app',repository:'acme/app'}).run();
 const bytes=Buffer.from('SYNTHETIC_FORGE_TOKEN'),read=vi.fn(async()=>Buffer.from(bytes));const copies:Uint8Array[]=[];
 const fetcher=request(bytes.toString());
 const root=sharedRoot({db,clock,originAllowed:()=>true,reportError:()=>{},changes:{rule:()=>undefined,github:{source:{async read(name){expect(name).toBe('forge');const value=await read();copies.push(value);return value;}},bindings:{ACME:'forge'},request:async(...args)=>{expect(copies.every(value=>value.every(byte=>byte===0))).toBe(true);return fetcher(...args);}}}});clean.push(()=>root.close());
 clock.advance(0);await root.refreshChanges!();expect(fetcher).toHaveBeenCalledTimes(2);expect(read).toHaveBeenCalledTimes(1);
 expect(root.services.changes.list()).toMatchObject([{id:'github:acme/app#1',project:'app',title:'Passing, approved'}]);
 expect(JSON.stringify(root.services.changes.list())).not.toContain(bytes.toString());
 expect(client.prepare("select name from sqlite_master where name='secrets_services'").get()).toBeUndefined();
 await root.close();clock.advance(120000);expect(read).toHaveBeenCalledTimes(1);
});
it('never exposes holder failures, invalid bytes, missing binding or an upstream token echo',async()=>{
 const bytes=Buffer.from('SYNTHETIC_ECHO_TOKEN');
 const read=sharedChangesReader({source:{read:async()=>bytes},bindings:{acme:'forge'},request:async()=>new Response(JSON.stringify({errors:[{message:'SYNTHETIC_ECHO_TOKEN'}]}))});
 await expect(read('acme/app',Date.now())).rejects.toThrow(/^GitHub read unavailable$/);expect(bytes.every(byte=>byte===0)).toBe(true);
 for(const value of [Buffer.from([0xff]),Buffer.from([0]),Buffer.alloc(0)]){
  const fetcher=vi.fn(),bad=sharedChangesReader({source:{read:async()=>value},bindings:{acme:'forge'},request:fetcher});
  await expect(bad('acme/app',Date.now())).rejects.toThrow(/^GitHub read unavailable$/);expect(fetcher).not.toHaveBeenCalled();expect(value.every(byte=>byte===0)).toBe(true);
 }
 const source=vi.fn(async()=>{throw Error('PRIVATE HOLDER FAILURE');}),missing=sharedChangesReader({source:{read:source},bindings:{acme:'forge'}});
 await expect(missing('other/app',0)).rejects.toThrow(/^GitHub read unavailable$/);expect(source).not.toHaveBeenCalled();
 await expect(missing('acme/app',0)).rejects.toThrow(/^GitHub read unavailable$/);
});
it('validates configured bindings at startup',()=>{
 expect(()=>sharedChangesReader({source:{read:vi.fn()},bindings:{'bad/owner':'forge'}})).toThrow();
});

it('refuses a repository redirect before returning any wake baseline', async () => {
 const fetcher = vi.fn<typeof fetch>(async (_url, init) => {
  expect(JSON.parse(String(init?.body)).query).toContain('nameWithOwner');
  return Response.json({ data: { repository: { nameWithOwner: 'renamed/app', pullRequests: { nodes: [raw], pageInfo: { hasNextPage: false, endCursor: null } } } } });
 });
 const read = sharedChangesReader({ source: { read: async () => Buffer.from('SYNTHETIC_TOKEN') }, bindings: { acme: 'forge' }, request: fetcher }, true);
 await expect(read('acme/app', Date.parse('2026-11-05T12:00:00Z'))).rejects.toThrow('GitHub read unavailable');
 expect(fetcher).toHaveBeenCalledTimes(1);
});
