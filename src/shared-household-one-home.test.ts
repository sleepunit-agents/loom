/** Who is in the household is in the household database and nowhere else: an agent added while the program
 * runs has Memory at once and after a restart, and local sign-in is for whoever owns the household now. */
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import Database from 'better-sqlite3';
import {randomUUID} from 'node:crypto';
import {existsSync,mkdirSync,mkdtempSync,readFileSync,readdirSync,renameSync,rmSync,statSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {FakeClock} from './core/clock.js';
import {dataDatabase} from './core/data/database.js';
import {sharedTokens} from './core/signin/shared-tokens.js';
import {notesDbPath} from './notes.js';
import {hasTouchedListener} from './core/touched/index.js';
import {startSharedHome} from './shared-startup.js';
vi.mock('./shared-holder-process.js',async()=>({startSharedHolder:vi.fn((await import('../test/fixtures/shared-holder.js')).inProcessSharedHolder)}));
vi.mock('./backends/fastembed.js',()=>({FastEmbedProvider:class{
 readonly dimensions=4;
 async embed(text:string){const v=['alpha','beta','gamma','delta'].map(word=>text.toLowerCase().includes(word)?1:0);if(!v.some(Boolean))v[3]=1;const size=Math.hypot(...v);return v.map(n=>n/size);}
 async embedBatch(texts:string[]){return Promise.all(texts.map(text=>this.embed(text)));}
}}));
beforeEach(()=>{vi.stubEnv('LOOM_PUBLIC_URL',undefined);vi.stubEnv('LOOM_WORKER_SOCKET',undefined);});
const clean:Array<()=>void|Promise<void>>=[];
afterEach(async()=>{for(const close of clean.splice(0).reverse())await close();vi.unstubAllEnvs();});
type App=Awaited<ReturnType<typeof startSharedHome>>;
function fixture(){
 const root=mkdtempSync(join(tmpdir(),'one-home-')),home=join(root,'home'),webRoot=join(root,'web');mkdirSync(home);mkdirSync(webRoot);writeFileSync(join(webRoot,'next.html'),'Shared app');
 clean.push(()=>rmSync(root,{recursive:true,force:true}));
 const clock=new FakeClock(),config=join(home,'program.json');
 let app:App|undefined;
 const start=async()=>{app=await startSharedHome({home,webRoot,port:0,clock,stdout:()=>{}});const started=app;clean.push(()=>started.close());return started;};
 const stop=async()=>{await app?.close();app=undefined;};
 // A bearer for an agent, made by the program's own token service on a second connection to its database.
 const agentToken=(agent:string)=>{const client=new Database(join(home,'loom.db'));try{return sharedTokens(dataDatabase(client,()=>new Date(clock.now()).toISOString()),clock).issue({kind:'agent',agent,label:'Terminal '+randomUUID()}).token;}finally{client.close();}};
 const signIn=async(member?:string)=>{const response=await fetch(app!.signinLink(member),{method:'POST',redirect:'manual'});expect(response.status).toBe(303);const cookie=response.headers.get('set-cookie')!.split(';')[0];
  return {cookie,viewer:(await (await fetch(app!.url+'/auth/session',{headers:{cookie}})).json()).viewer as {kind:string;id:string}};};
 const call=async(path:string,input:unknown,who:{token:string}|{cookie:string})=>{
  const response=await fetch(app!.url+'/api/'+path,{method:'POST',headers:{...('token' in who?{authorization:'Bearer '+who.token}:{cookie:who.cookie}),origin:app!.url,'content-type':'application/json'},body:JSON.stringify({id:randomUUID(),input})});
  return {status:response.status,result:await response.json() as {ok:boolean;value?:any;error?:unknown}};
 };
 /** The household change path: an agent files the card, a household owner allows it. */
 const change=async(asker:string,owner:{cookie:string},value:{change:string;input:unknown})=>{
  const filed=await call('household/propose',{...value,why:'Asked for in a test'},{token:asker});expect(filed.result).toMatchObject({ok:true,value:{state:'pending'}});
  const allowed=await call('approvals/answer',{id:filed.result.value.id,answer:'allow'},owner);expect(allowed.result).toMatchObject({ok:true});
 };
 return {home,config,clock,url:()=>app!.url,start,stop,agentToken,signIn,call,change};
}
const second={id:'second',about:'A second agent.',markBg:'#112233',markFg:'#ffffff',faceShape:'pebble',faceEyes:'dot'};

it('gives an agent added to a running household its Memory, notes and cards at once, and again after a restart',async()=>{
 const f=fixture();await f.start();
 const program=readFileSync(f.config);
 // First install names nobody: no sign-in member and no list of agents to fall behind the household.
 expect(Object.keys(JSON.parse(program.toString()))).not.toContain('signinMember');
 expect(JSON.parse(program.toString()).memory.sources).not.toHaveProperty('agents');
 const owner=await f.signIn(),assistant=f.agentToken('assistant'),directory=join(f.home,'agents/second');
 expect(existsSync(directory)).toBe(false);
 await f.change(assistant,owner,{change:'agent',input:second});
 const token=f.agentToken('second');
 const remembered=await f.call('memory/remember',{category:'project',title:'First of second',content:'alpha words of the second agent'},{token});
 expect(remembered.result,JSON.stringify(remembered.result)).toMatchObject({ok:true});expect(remembered.result.value.ids[0]).toMatch(/^second:[a-f0-9-]{36}$/);
 const recalled=await f.call('memory/recall',{query:'alpha'},{token});
 expect(recalled.result).toMatchObject({ok:true,value:{ids:remembered.result.value.ids}});
 expect((await f.call('memory/noteWrite',{path:'plans/first',body:'A note of the second agent',lifespan:'keep'},{token})).result).toEqual({ok:true,value:{saved:true}});
 const card=await f.call('memory/projectWrite',{slug:'pond',name:'Pond'},{token});expect(card.result).toMatchObject({ok:true});expect(card.result.value.ids[0]).toMatch(/^second:project:/);
 // Both files were made whole: under their real names, private, with nothing left beside them. Outside
 // writers in the new directory are heard from now on too.
 for(const file of [join(directory,'memories.db'),notesDbPath(directory)])expect(statSync(file).mode&0o777,file).toBe(0o600);
 expect(readdirSync(directory).filter(name=>name.endsWith('.preparing'))).toEqual([]);
 await vi.waitFor(()=>expect(hasTouchedListener(directory)).toBe(true));
 // The owner reads what the new agent wrote, through the same readers that were opened before it existed.
 const seen=await fetch(f.url()+'/graphql',{method:'POST',headers:{cookie:owner.cookie,'content-type':'application/json'},body:JSON.stringify({query:`{memoryProject(id:"${card.result.value.ids[0]}"){id card{name}} memoryNote(agent:"second",path:"plans/first"){body}}`})});
 expect(await seen.json()).toEqual({data:{memoryProject:{id:'second:pond',card:{name:'Pond'}},memoryNote:{body:'A note of the second agent'}}});
 // The household's default agent is asked each time too: made the default, the new agent is the one a
 // new person's relationship card goes to, with no restart.
 const slugs=(agent:string)=>{const db=new Database(join(f.home,'agents',agent,'memories.db'),{readonly:true});try{return (db.prepare('SELECT slug FROM people').all() as {slug:string}[]).map(row=>row.slug);}finally{db.close();}};
 expect((await f.call('mind/personAdd',{name:'Early Friend'},owner)).result).toMatchObject({ok:true,value:{slug:'early-friend'}});
 await f.change(assistant,owner,{change:'settings',input:{defaultAgent:'second'}});
 expect((await f.call('mind/personAdd',{name:'Later Friend'},owner)).result).toMatchObject({ok:true,value:{slug:'later-friend'}});
 expect([slugs('assistant'),slugs('second')]).toEqual([['early-friend'],['later-friend']]);
 await f.change(assistant,owner,{change:'settings',input:{defaultAgent:'assistant'}});
 // The first agent is untouched by any of this.
 const own=await f.call('memory/remember',{category:'project',title:'First of assistant',content:'beta words of the first agent'},{token:assistant});expect(own.result).toMatchObject({ok:true});
 expect((await f.call('memory/recall',{query:'alpha beta'},{token:assistant})).result.value.ids).toEqual(own.result.value.ids);

 await f.stop();
 // Nothing rewrote program.json: the household database alone says there is a second agent.
 expect(readFileSync(f.config)).toEqual(program);
 await f.start();
 const again=f.agentToken('second');
 const more=await f.call('memory/remember',{category:'project',title:'Second of second',content:'alpha gamma words after a restart'},{token:again});expect(more.result).toMatchObject({ok:true});
 const both=await f.call('memory/recall',{query:'alpha'},{token:again});
 expect(new Set(both.result.value.ids)).toEqual(new Set([...remembered.result.value.ids,...more.result.value.ids]));
 expect((await f.call('memory/noteWrite',{path:'plans/second',body:'Another note',lifespan:'keep'},{token:again})).result).toEqual({ok:true,value:{saved:true}});

 // A removed agent stops being served and keeps every file.
 const ownerAgain=await f.signIn();
 await f.change(f.agentToken('assistant'),ownerAgain,{change:'remove',input:{of:'agent',id:'second'}});
 expect((await f.call('memory/recall',{query:'alpha'},{token:again})).result.ok).toBe(false);
 const kept=new Database(join(directory,'memories.db'),{readonly:true});
 try{expect(kept.prepare('SELECT count(*) AS n FROM memories').get()).toEqual({n:2});}finally{kept.close();}
 expect(existsSync(notesDbPath(directory))).toBe(true);
 await f.stop();await f.start();
 expect(existsSync(join(directory,'memories.db'))).toBe(true);expect(existsSync(notesDbPath(directory))).toBe(true);
});

it('still reads a program.json from before, and takes neither its agents nor its sign-in member from it',async()=>{
 const f=fixture();await f.start();
 const owner=await f.signIn();
 await f.change(f.agentToken('assistant'),owner,{change:'agent',input:second});
 const token=f.agentToken('second');
 const first=await f.call('memory/remember',{category:'project',title:'Before',content:'alpha before the old file'},{token});expect(first.result).toMatchObject({ok:true});
 await f.stop();
 // The file as an earlier build wrote it: one agent listed, and a sign-in member who is not in the household.
 const program=JSON.parse(readFileSync(f.config,'utf8')),agents=join(f.home,'agents');
 const older={...program,signinMember:'nobody-now',memory:{...program.memory,sources:{...program.memory.sources,agents:[{agent:'assistant',directory:join(agents,'assistant'),memories:join(agents,'assistant/memories.db')}]}}};
 writeFileSync(f.config,JSON.stringify(older)+'\n',{mode:0o600});
 await f.start();
 expect((await f.signIn()).viewer).toEqual(owner.viewer);
 const after=await f.call('memory/recall',{query:'alpha'},{token:f.agentToken('second')});
 expect(after.result).toMatchObject({ok:true,value:{ids:first.result.value.ids}});
 await f.stop();
 // An old file that keeps an agent's Memory somewhere else is refused, not answered with an empty Memory.
 const elsewhere=join(f.home,'elsewhere');renameSync(join(agents,'assistant'),elsewhere);
 writeFileSync(f.config,JSON.stringify({...older,memory:{...older.memory,sources:{...older.memory.sources,agents:[{agent:'assistant',directory:elsewhere,memories:join(elsewhere,'memories.db')}]}}})+'\n',{mode:0o600});
 await expect(f.start()).rejects.toThrow(`move that directory to ${join(agents,'assistant')}`);
 expect(existsSync(join(agents,'assistant'))).toBe(false);
});

it('signs in whoever owns the household now, while it runs and at the next start',async()=>{
 const f=fixture();await f.start();
 const first=await f.signIn(),assistant=f.agentToken('assistant');
 expect(first.viewer.kind).toBe('member');
 // A second owner joins, then allows a card that makes the first owner a member.
 await f.change(assistant,first,{change:'member',input:{id:'zed',role:'owner',fullOwner:true,agents:[]}});
 const zed=await f.signIn('zed');expect(zed.viewer).toEqual({kind:'member',id:'zed'});
 await f.change(assistant,zed,{change:'member',input:{id:first.viewer.id,role:'member',fullOwner:false,agents:[]}});
 expect((await f.signIn()).viewer).toEqual({kind:'member',id:'zed'});
 await f.stop();await f.start();
 expect((await f.signIn()).viewer).toEqual({kind:'member',id:'zed'});
 // Removed altogether, the first owner changes nothing either.
 await f.change(f.agentToken('assistant'),await f.signIn(),{change:'remove',input:{of:'member',id:first.viewer.id}});
 await f.stop();await f.start();
 expect((await f.signIn()).viewer).toEqual({kind:'member',id:'zed'});
});
