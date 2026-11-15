/** Real CLI/default listener, with only fictional prepared stores and keys. */
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import Database from 'better-sqlite3';
import {generateX25519Identity} from 'age-encryption';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync,existsSync,chmodSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {Readable} from 'node:stream';
import {createServer} from 'node:http';
import {createDataSchema} from './core/data/database.js';
import {members,agents,memberAgents,household} from './core/data/schema.js';
import {requestLocalLink} from './core/signin/operator.js';
import {FakeClock} from './core/clock.js';
import {startSharedHome} from './shared-startup.js';
import {run} from './cli/serve.js';
const cleanups:Array<()=>unknown|Promise<unknown>>=[];
beforeEach(()=>{vi.stubEnv('LOOM_WORKER_SOCKET',undefined);vi.stubEnv('LOOM_PUBLIC_URL',undefined);});
afterEach(async()=>{for(const close of cleanups.splice(0).reverse())await close();vi.unstubAllEnvs();});
async function fixture(){
 const home=mkdtempSync(join(tmpdir(),'loom-default-fiction-'));cleanups.push(()=>rmSync(home,{recursive:true,force:true}));
 const database=join(home,'app.db'),client=new Database(database),db=createDataSchema(client);
 const at='2026-11-15T12:00:00.000Z';
 db.insert(members).values([{id:'owner',role:'owner',joinedAt:at},{id:'peer',role:'member',joinedAt:at}]).run();
 db.insert(agents).values({id:'fiction',about:'',markBg:'',markFg:'',faceShape:'pebble',faceEyes:'dot'}).run();
 db.insert(memberAgents).values({member:'owner',agent:'fiction'}).run();
 db.insert(household).values({defaultAgent:'fiction',timezone:'Asia/Tokyo'}).run();client.close();
 const webRoot=join(home,'public');mkdirSync(webRoot);writeFileSync(join(webRoot,'next.html'),'<main>SHARED FICTIONAL ENTRY</main>');
 const commsKey=join(home,'comms.key');writeFileSync(commsKey,await generateX25519Identity(),{mode:0o600});
 const common=join(home,'commons'),agent=join(home,'agents/fiction');
 const program={database,commsKey,signinMember:'owner',webRoot,memory:{checkingAgent:'fiction',sources:{commons:{directory:common,knowledge:join(common,'knowledge.db'),people:join(common,'people.db')},agents:[{agent:'fiction',directory:agent,memories:join(agent,'memories.db')}]}}};
 const config=join(home,'program.json');writeFileSync(config,JSON.stringify(program),{mode:0o600});
 return {home,config,program};
}
async function signedIn(home:string,url:string,member='owner'){
 const link=await requestLocalLink(home,{request:'link',member,label:'Fictional local sign-in',ttl:30});expect(link.url).toBe(url);
 const response=await fetch(url+link.path,{method:'POST',redirect:'manual',headers:{origin:url,'user-agent':'Fictional browser'}});
 expect(response.status).toBe(303);return response.headers.get('set-cookie')!.split(';',1)[0];
}
it('normal serve --http installs public assets, current sign-in, Memory, Comms and Tempo on the same real door',async()=>{
 const f=await fixture(),errors:string[]=[],printed:string[]=[];let ready!:(url:string)=>void;
 const started=new Promise<string>(resolve=>{ready=resolve;});
 const pending=run(['--http','--home',f.home,'--host','127.0.0.1','--port','0'],{stdin:Readable.from([]),stdinIsTTY:false,env:{},stdout:text=>printed.push(text),stderr:text=>{errors.push(text);const match=/shared app on (\S+)/.exec(text);if(match)ready(match[1]);}});
 cleanups.push(async()=>{process.emit('SIGTERM');expect(await pending).toBe(0);});
 const url=await Promise.race([started,pending.then(code=>{throw Error(`CLI stopped (${code}): ${errors.join('')}`);})]);
 expect(await (await fetch(url+'/p/knowledge-preview')).text()).toBe('<main>SHARED FICTIONAL ENTRY</main>');
 expect(await (await fetch(url+'/auth/session')).json()).toEqual({viewer:null});
 expect(printed).toHaveLength(1);
 const bootstrap=await fetch(printed[0].trim(),{method:'POST',redirect:'manual',headers:{origin:url}});expect(bootstrap.status).toBe(303);
 const cookie=bootstrap.headers.get('set-cookie')!.split(';',1)[0];
 expect(await (await fetch(url+'/auth/session',{headers:{cookie}})).json()).toMatchObject({viewer:{kind:'member',id:'owner'}});
 const query=async(cookie:string)=>{const response=await fetch(url+'/graphql',{method:'POST',headers:{cookie,origin:url,'content-type':'application/json'},body:JSON.stringify({query:'{ deskTime { timezone } homeComms { agents } memoryKnowledge { pages { title } } memoryPeople { id } memoryProjects { id } memoryActivity { entries { title } } triggers { id } }'})});expect(response.status).toBe(200);const result=await response.json();expect(result.errors).toBeUndefined();return result.data;};
 expect(await query(cookie)).toMatchObject({deskTime:{timezone:'Asia/Tokyo'},homeComms:{agents:['fiction']},memoryKnowledge:{pages:[]},memoryPeople:[],memoryProjects:[],memoryActivity:{entries:[]},triggers:expect.arrayContaining([{id:'knowledge-sweep:fiction'}])});
 const peer=await signedIn(f.home,url,'peer');expect((await query(peer)).memoryKnowledge).toBeNull();
 expect((await fetch(url+'/live')).status).toBe(404);expect(errors).toEqual([`loom: shared app on ${url}\n`]);
});
it('refuses an old SQLite store before preparing Memory files and preserves its exact bytes',async()=>{
 const f=await fixture(),old=join(f.home,'old.db'),client=new Database(old);client.exec("CREATE TABLE precious(words TEXT);INSERT INTO precious VALUES('FICTIONAL PRECIOUS WORDS')");client.close();
 const before=readFileSync(old);writeFileSync(f.config,JSON.stringify({...f.program,database:old}),{mode:0o600});
 await expect(startSharedHome({home:f.home,port:0})).rejects.toThrow('separate move');
 expect(readFileSync(old)).toEqual(before);expect(existsSync(f.program.memory.sources.commons.knowledge)).toBe(false);expect(existsSync(join(f.home,'operator.sock'))).toBe(false);
});
it('releases the adapter, database, source listeners and home ownership after bind failure and on repeated close',async()=>{
 const f=await fixture(),module=join(f.home,'adapters.mjs');
 writeFileSync(module,"import {writeFileSync} from 'node:fs';import {join} from 'node:path';export default ({db,home})=>({close(){writeFileSync(join(home,'adapter-closed'),String(db.$client.prepare('SELECT count(*) AS n FROM members').get().n));}});",{mode:0o600});
 writeFileSync(f.config,JSON.stringify({...f.program,adapters:module}),{mode:0o600});
 const blocked=createServer();await new Promise<void>(ok=>blocked.listen(0,'127.0.0.1',ok));cleanups.push(()=>new Promise<void>(ok=>blocked.close(()=>ok())));
 const address=blocked.address();if(!address||typeof address==='string')throw Error('No port');
 const clock=new FakeClock(),scheduled=vi.spyOn(clock,'at');
 await expect(startSharedHome({home:f.home,port:address.port,clock})).rejects.toThrow();
 expect(readFileSync(join(f.home,'adapter-closed'),'utf8')).toBe('2');const calls=scheduled.mock.calls.length;clock.advance(86400000);expect(scheduled).toHaveBeenCalledTimes(calls);
 const app=await startSharedHome({home:f.home,port:0,clock,stdout:()=>{}});await Promise.all([app.close(),app.close()]);
 const reopened=new Database(f.program.database,{readonly:true});expect(reopened.prepare('SELECT count(*) AS n FROM members').get()).toEqual({n:2});reopened.close();
});
it('refuses a public startup inventory without starting a listener',async()=>{
 const f=await fixture();chmodSync(f.config,0o644);
 await expect(startSharedHome({home:f.home,port:0})).rejects.toThrow();expect(existsSync(join(f.home,'operator.sock'))).toBe(false);
});
it('refuses public assets overlapping private files or a startup owner who is not an owner',async()=>{
 const f=await fixture();
 writeFileSync(f.config,JSON.stringify({...f.program,webRoot:f.home}),{mode:0o600});
 await expect(startSharedHome({home:f.home,port:0})).rejects.toThrow('overlap');
 writeFileSync(f.config,JSON.stringify({...f.program,signinMember:'peer'}),{mode:0o600});
 await expect(startSharedHome({home:f.home,port:0})).rejects.toThrow('existing household owner');
 expect(existsSync(f.program.memory.sources.commons.knowledge)).toBe(false);
});
