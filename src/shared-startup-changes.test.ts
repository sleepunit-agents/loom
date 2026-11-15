/** Actual normal startup and holder protocol/store; fake GitHub HTTP only. */
import {afterEach,expect,it,vi} from 'vitest';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {once} from 'node:events';
import {WebSocket} from 'ws';
import {startSharedHome} from './shared-startup.js';
import {initializeSharedHome} from './shared-initialize.js';
import {FakeClock} from './core/clock.js';
const wire=vi.hoisted(()=>({start:vi.fn()}));
vi.mock('./shared-holder-process.js',async()=>{const {inProcessSharedHolder}=await import('../test/fixtures/shared-holder.js');return{startSharedHolder:wire.start.mockImplementation(inProcessSharedHolder)};});
const clean:Array<()=>void|Promise<void>>=[];
afterEach(async()=>{for(const close of clean.splice(0).reverse())await close();vi.unstubAllGlobals();vi.unstubAllEnvs();wire.start.mockClear();});
function files(){
 vi.stubEnv('LOOM_PUBLIC_URL',undefined);vi.stubEnv('LOOM_WORKER_SOCKET',undefined);
 const parent=mkdtempSync(join(tmpdir(),'loom-github-reader-')),home=join(parent,'home'),webRoot=join(parent,'web');mkdirSync(home);mkdirSync(webRoot);writeFileSync(join(webRoot,'next.html'),'<main>Fictitious home</main>');clean.push(()=>rmSync(parent,{recursive:true,force:true}));
 return{home,webRoot,clock:new FakeClock(Date.parse('2026-11-15T18:00:00Z'))};
}
async function signin(link:string){const response=await fetch(link,{method:'POST',redirect:'manual'});expect(response.status).toBe(303);return response.headers.get('set-cookie')!.split(';')[0];}
async function command(app:Awaited<ReturnType<typeof startSharedHome>>,cookie:string,path:string,input:unknown){const response=await fetch(app.url+'/api/'+path,{method:'POST',headers:{cookie,origin:app.url,'content-type':'application/json'},body:JSON.stringify({id:randomUUID(),input})});return response.json();}
const raw=JSON.parse(readFileSync(new URL('./pieces/changes/github.fixture.json',import.meta.url),'utf8')).data.repository.open.nodes[0];
it('reads Owner-written credentials on normal restart, rotates tokens, retains cache on failure and joins shutdown',async()=>{
 const {home,webRoot,clock}=files();let link='';
 let app=await startSharedHome({home,webRoot,clock,port:0,stdout:text=>{link=text.trim();}});clean.push(()=>app.close());let cookie=await signin(link);
 expect(app.refreshChanges).toBeUndefined();
 expect(await command(app,cookie,'secrets/set',{id:randomUUID(),name:'FORGE',value:'FICTITIOUS_GITHUB_TOKEN',mode:'add'})).toMatchObject({ok:true});
 const file=join(home,'program.json'),program=JSON.parse(readFileSync(file,'utf8'));
 expect(await command(app,cookie,'household/setProject',{id:'app',name:'App',members:[program.signinMember],agents:['assistant'],repositories:['github:acme/app']})).toMatchObject({ok:true});
 await app.close();program.githubBindings={ACME:'FORGE'};writeFileSync(file,JSON.stringify(program),{mode:0o600});
 let token='FICTITIOUS_GITHUB_TOKEN',fail=false,hold=false,release!:()=>void,began!:()=>void;
 const realFetch=globalThis.fetch,requests=vi.fn<typeof fetch>(async(input,init)=>{
  if(String(input).startsWith('http://127.0.0.1:'))return realFetch(input,init);
  expect(input).toBe('https://api.github.com/graphql');expect(init?.redirect).toBe('error');expect(new Headers(init?.headers).get('authorization')).toBe('Bearer '+token);
  if(hold){began();await new Promise<void>(yes=>{release=yes;});}
  if(fail)throw Error(token);
  const states=JSON.parse(String(init?.body)).variables.states;
  return Response.json({data:{repository:{pullRequests:{nodes:states.includes('OPEN')?[raw]:[],pageInfo:{hasNextPage:false,endCursor:null}}}}});
 });vi.stubGlobal('fetch',requests);
 app=await startSharedHome({home,webRoot,clock,port:0,stdout:text=>{link=text.trim();}});cookie=await signin(link);
 const socket=new WebSocket(app.url.replace('http:','ws:')+'/graphql','graphql-transport-ws',{headers:{cookie,origin:app.url}});clean.push(()=>socket.terminate());await once(socket,'open');
 let next=once(socket,'message');socket.send(JSON.stringify({type:'connection_init'}));await next;
 next=once(socket,'message');socket.send(JSON.stringify({type:'subscribe',id:'changes',payload:{query:'subscription { observe(query:"{ changes { id title project } }") { revision patches { path value removed } } }'}}));await next;
 next=once(socket,'message');
 clock.advance(0);expect(await command(app,cookie,'changes/refresh',{})).toMatchObject({ok:true});
 expect(JSON.parse(String((await next)[0])).payload.data.observe.patches).toContainEqual({path:['changes',0],value:{id:'github:acme/app#1',title:'Passing, approved',project:'app'},removed:false});
 const read=async()=>{const response=await fetch(app.url+'/graphql',{method:'POST',headers:{cookie,'content-type':'application/json'},body:JSON.stringify({query:'{ changes { id title project } changeSync { failed } }'})});return response.json();};
 expect((await read()).data).toMatchObject({changes:[{project:'app',title:'Passing, approved'}],changeSync:[{failed:false}]});
 token='FICTITIOUS_REPLACEMENT_TOKEN';expect(await command(app,cookie,'secrets/set',{id:randomUUID(),name:'FORGE',value:token,mode:'replace'})).toMatchObject({ok:true});
 expect(await command(app,cookie,'changes/refresh',{})).toMatchObject({ok:true});
 fail=true;await command(app,cookie,'changes/refresh',{});expect((await read()).data).toMatchObject({changes:[{title:'Passing, approved'}],changeSync:[{failed:true}]});
 const db=app.services.comms!.db;for(const value of ['FICTITIOUS_GITHUB_TOKEN',token])expect(db.$client.serialize().includes(Buffer.from(value))).toBe(false);
 expect(readFileSync(file,'utf8')).not.toContain(token);expect(db.$client.prepare("SELECT name FROM sqlite_master WHERE name='secrets_services'").get()).toBeUndefined();
 fail=false;hold=true;const started=new Promise<void>(yes=>{began=yes;});clean.push(()=>release?.());const pending=app.refreshChanges!();await started;
 let closed=false;const stopping=app.close().then(()=>{closed=true;});await new Promise<void>(yes=>setImmediate(yes));expect(closed).toBe(false);expect(db.$client.open).toBe(true);
 release();await pending.catch(()=>{});await stopping;expect(db.$client.open).toBe(false);
 const count=requests.mock.calls.length;clock.advance(120000);expect(requests).toHaveBeenCalledTimes(count);
});
it('preserves an explicit Changes adapter even when configured bindings have no holder source',async()=>{
 const {home,webRoot,clock}=files();await initializeSharedHome(home,clock);
 const file=join(home,'program.json'),program=JSON.parse(readFileSync(file,'utf8'));
 delete program.secretHolder;program.githubBindings={acme:'FORGE'};program.adapters=join(home,'adapter.mjs');
 writeFileSync(program.adapters,'export default ()=>({changes:{read:async()=>[],rule:()=>undefined}})',{mode:0o600});writeFileSync(file,JSON.stringify(program),{mode:0o600});
 const app=await startSharedHome({home,webRoot,clock,port:0,stdout:()=>{}});clean.push(()=>app.close());await app.refreshChanges!();expect(wire.start).not.toHaveBeenCalled();
});
it('fails closed when bindings have neither an explicit adapter nor a holder source',async()=>{
 const {home,webRoot,clock}=files();await initializeSharedHome(home,clock);const file=join(home,'program.json'),program=JSON.parse(readFileSync(file,'utf8'));
 delete program.secretHolder;program.githubBindings={acme:'FORGE'};writeFileSync(file,JSON.stringify(program),{mode:0o600});
 await expect(startSharedHome({home,webRoot,clock,port:0,stdout:()=>{}})).rejects.toThrow('GitHub credential source unavailable');expect(wire.start).not.toHaveBeenCalled();
});
it.each([{'bad/owner':'FORGE'},{acme:'bad/name'},{acme:'FORGE',ACME:'OTHER'}])('rejects invalid bindings before starting the holder: %j',async bindings=>{
 const {home,webRoot,clock}=files();await initializeSharedHome(home,clock);const file=join(home,'program.json'),program=JSON.parse(readFileSync(file,'utf8'));program.githubBindings=bindings;writeFileSync(file,JSON.stringify(program),{mode:0o600});
 await expect(startSharedHome({home,webRoot,clock,port:0,stdout:()=>{}})).rejects.toThrow('Invalid GitHub credential bindings');expect(wire.start).not.toHaveBeenCalled();
});
