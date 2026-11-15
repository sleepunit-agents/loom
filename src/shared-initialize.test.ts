import {afterEach,expect,it,vi} from 'vitest';
import Database from 'better-sqlite3';
import * as fs from 'node:fs';
import * as age from 'age-encryption';
import {ownHome} from './core/daemon-home.js';
import {mkdtempSync,rmSync,writeFileSync,readFileSync,readdirSync,statSync,renameSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {once} from 'node:events';
import {WebSocket} from 'ws';
import * as schema from './core/data/database.js';
import {FakeClock} from './core/clock.js';
import {initializeSharedHome} from './shared-initialize.js';
import {startSharedHome} from './shared-startup.js';
vi.mock('node:fs',async original=>{const real=await original<typeof import('node:fs')>();return {...real,unlinkSync:vi.fn(real.unlinkSync)};});
vi.mock('age-encryption',async original=>{const real=await original<typeof import('age-encryption')>();return {...real,generateX25519Identity:vi.fn(real.generateX25519Identity)};});
const clean:Array<()=>void|Promise<void>>=[];
afterEach(async()=>{vi.restoreAllMocks();vi.mocked(fs.unlinkSync).mockImplementation((await vi.importActual<typeof import('node:fs')>('node:fs')).unlinkSync);for(const close of clean.splice(0).reverse())await close();});
function fixture(){const home=mkdtempSync(join(tmpdir(),'empty-shared-'));clean.push(()=>rmSync(home,{recursive:true,force:true}));return home;}
it('first install publishes a private prepared inventory and the ordinary startup link admits HTTP and GraphQL',async()=>{
 const home=fixture(),webRoot=fixture(),clock=new FakeClock();writeFileSync(join(webRoot,'next.html'),'Shared app');let link='';
 const app=await startSharedHome({home,webRoot,port:0,clock,stdout:text=>{link=text.trim();}});clean.push(()=>app.close());
 const program=JSON.parse(readFileSync(join(home,'program.json'),'utf8'));
 for(const name of ['program.json','comms.key','loom.db'])expect(statSync(join(home,name)).mode&0o777).toBe(0o600);
 expect(program.memory.sources.agents[0].agent).toBe('assistant');
 const audit=new Database(program.database,{readonly:true});try{expect(audit.prepare('SELECT count(*) AS n FROM members').get()).toEqual({n:1});expect(audit.prepare('SELECT count(*) AS n FROM agents').get()).toEqual({n:1});}finally{audit.close();}
 const response=await fetch(link,{method:'POST',redirect:'manual'});expect(response.status).toBe(303);const cookie=response.headers.get('set-cookie')!.split(';')[0];
 const query='{ tasks { id title } }';
 const http=await fetch(app.url+'/graphql',{method:'POST',headers:{cookie,'content-type':'application/json'},body:JSON.stringify({query})});expect((await http.json()).data.tasks).toEqual([]);
 const ws=new WebSocket(app.url.replace('http:','ws:')+'/graphql','graphql-transport-ws',{headers:{cookie,origin:app.url}});clean.push(()=>{ws.terminate();});await once(ws,'open');
 const frame=async(send:unknown)=>{const incoming=once(ws,'message');ws.send(JSON.stringify(send));return JSON.parse(String((await incoming)[0]));};
 expect(await frame({type:'connection_init'})).toEqual({type:'connection_ack'});
 const initial=await frame({type:'subscribe',id:'tasks',payload:{query:'subscription($query:String!){observe(query:$query){revision patches{path removed value}}}',variables:{query}}});expect(initial.payload.data.observe.revision).toBe(1);
 const {viewer}=await (await fetch(app.url+'/auth/session',{headers:{cookie}})).json(),next=once(ws,'message');
 app.writes.run(()=>app.services.tasks.create({title:'Fresh live task',goal:'Water flows',why:'Exercise the initial credential',owner:{kind:'household'}},{kind:'member',id:viewer.id}));
 expect(String((await next)[0])).toContain('Fresh live task');
 await app.close();const before=readFileSync(join(home,'program.json'));await initializeSharedHome(home,clock);expect(readFileSync(join(home,'program.json'))).toEqual(before);
});
it.each(['precious-memory.md','loom.db'])('never initializes a nonempty home containing %s',async name=>{
 const home=fixture();writeFileSync(join(home,name),name==='loom.db'?'':'Precious words');const before=readFileSync(join(home,name));
 await expect(initializeSharedHome(home,new FakeClock())).rejects.toThrow('separate data move');expect(readdirSync(home)).toEqual([name]);expect(readFileSync(join(home,name))).toEqual(before);
});
it('rolls back only newly generated unpublished files after schema failure and releases the home for retry',async()=>{
 const home=fixture(),failing=vi.spyOn(schema,'createDataSchema').mockImplementationOnce(client=>client.transaction(()=>{client.exec('CREATE TABLE unfinished (id TEXT)');throw Error('Synthetic initialization failure');})());
 try{await expect(initializeSharedHome(home,new FakeClock())).rejects.toThrow('Synthetic initialization failure');}finally{failing.mockRestore();}
 expect(readdirSync(home)).toEqual([]);await initializeSharedHome(home,new FakeClock());expect(readdirSync(home).sort()).toEqual(['comms.key','loom.db','program.json']);
});

it('holds home ownership while initialization is suspended and until rollback removes its unpublished files',async()=>{
 const home=fixture();let entered!:()=>void,reject!:()=>void;const began=new Promise<void>(ok=>{entered=ok;}),held=new Promise<string>((_ok,no)=>{reject=()=>no(Error('Synthetic key failure'));});
 vi.mocked(age.generateX25519Identity).mockImplementationOnce(()=>{entered();return held;});
 const pending=initializeSharedHome(home,new FakeClock()),failed=expect(pending).rejects.toThrow('Synthetic key failure');await began;
 await expect(ownHome(home)).rejects.toThrow('already running');
 const actual=(await vi.importActual<typeof import('node:fs')>('node:fs')).unlinkSync;let during:Promise<boolean>|undefined;
 vi.mocked(fs.unlinkSync).mockImplementation(path=>{during=ownHome(home).then(async release=>{await release();return false;},()=>true);return actual(path);});
 reject();await failed;expect(await during).toBe(true);expect(readdirSync(home)).toEqual([]);
 const release=await ownHome(home);await release();
});
it('rollback preserves unrelated files and a replacement for a generated database',async()=>{
 const home=fixture();let entered!:()=>void,reject!:()=>void;const began=new Promise<void>(ok=>{entered=ok;}),held=new Promise<string>((_ok,no)=>{reject=()=>no(Error('Synthetic key failure'));});
 vi.mocked(age.generateX25519Identity).mockImplementationOnce(()=>{entered();return held;});
 const pending=initializeSharedHome(home,new FakeClock()),failed=expect(pending).rejects.toThrow('Synthetic key failure');await began;
 renameSync(join(home,'loom.db'),join(home,'retained.db'));writeFileSync(join(home,'loom.db'),'REPLACEMENT BYTES');writeFileSync(join(home,'unrelated-memory.md'),'UNRELATED PRECIOUS WORDS');
 const before=readFileSync(join(home,'retained.db'));reject();await failed;
 expect(readFileSync(join(home,'loom.db'),'utf8')).toBe('REPLACEMENT BYTES');expect(readFileSync(join(home,'unrelated-memory.md'),'utf8')).toBe('UNRELATED PRECIOUS WORDS');expect(readFileSync(join(home,'retained.db'))).toEqual(before);
});
